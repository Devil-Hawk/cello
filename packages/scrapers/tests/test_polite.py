"""Tests for the politeness policy on the generic career-page path.

Nothing here touches the network. RobotsCache takes an injected fetcher and
every clock is injected, so the robots parser, the per-domain limiter, the
backoff record and the retry-after parser are all exercised as pure logic.

These tests pin BEHAVIOUR WE OWE OTHER PEOPLE — that a Disallow is obeyed, that
a Crawl-delay is honoured, that a domain which has refused us is left alone.
Loosening one of them should be as deliberate as changing a security check.
"""

from src.polite import (
    ALLOW_ALL,
    DISALLOW_ALL,
    USER_AGENT,
    USER_AGENT_TOKEN,
    BackoffRecord,
    Decision,
    DomainLimiter,
    PolitePolicy,
    RobotsCache,
    backoff_delay,
    default_policy,
    domain_of,
    may_render,
    parse_retry_after,
    parse_robots,
    reset_default_policy,
)


class FakeClock:
    """A monotonic clock the tests move by hand."""

    def __init__(self, start: float = 0.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def fixed_fetcher(status: int, body: str):
    calls: list[str] = []

    def fetch(url: str) -> tuple[int, str]:
        calls.append(url)
        return (status, body)

    fetch.calls = calls  # type: ignore[attr-defined]
    return fetch


class TestIdentity:
    def test_user_agent_is_honest_identifiable_and_not_a_browser_disguise(self):
        assert USER_AGENT.startswith(USER_AGENT_TOKEN)
        # A contact URL, the way well-behaved crawlers identify themselves.
        assert "+https://" in USER_AGENT
        for disguise in ("Mozilla", "AppleWebKit", "Chrome", "Safari"):
            assert disguise not in USER_AGENT


class TestParseRetryAfter:
    def test_delta_seconds(self):
        assert parse_retry_after("120") == 120.0
        assert parse_retry_after("0") == 0.0
        assert parse_retry_after("  30  ") == 30.0

    def test_http_date(self):
        # 2015-10-21T07:28:00Z is 1445412480; 45 seconds earlier is the "now".
        assert parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT", 1445412435.0) == 45.0

    def test_http_date_already_past_clamps_to_zero(self):
        assert parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT", 1445500000.0) == 0.0

    def test_unreadable_values_are_none_not_zero(self):
        # None must mean "fall back to our own backoff". Returning 0.0 here
        # would read as "the server said retry immediately", which it did not.
        assert parse_retry_after(None) is None
        assert parse_retry_after("") is None
        assert parse_retry_after("   ") is None
        assert parse_retry_after("soon") is None
        # Date parsers happily read these as dates in 2001; the shape guard is
        # what stops a malformed header becoming "go now".
        assert parse_retry_after("-5") is None
        assert parse_retry_after("1.5") is None


class TestBackoffDelay:
    def test_equal_jitter_window_doubles_each_attempt(self):
        assert backoff_delay(1, base_sec=1.0, cap_sec=1000.0, rand=lambda: 0.0) == 0.5
        assert backoff_delay(1, base_sec=1.0, cap_sec=1000.0, rand=lambda: 1.0) == 1.0
        assert backoff_delay(2, base_sec=1.0, cap_sec=1000.0, rand=lambda: 0.0) == 1.0
        assert backoff_delay(4, base_sec=1.0, cap_sec=1000.0, rand=lambda: 0.0) == 4.0
        assert backoff_delay(4, base_sec=1.0, cap_sec=1000.0, rand=lambda: 1.0) == 8.0

    def test_never_exceeds_the_cap(self):
        for attempt in range(1, 21):
            assert backoff_delay(attempt, base_sec=1.0, cap_sec=30.0, rand=lambda: 1.0) <= 30.0

    def test_real_draws_spread_across_the_window(self):
        seen = set()
        for _ in range(300):
            delay = backoff_delay(3, base_sec=1.0, cap_sec=1000.0)
            # exp = 4s at attempt 3, so the window is [2, 4).
            assert 2.0 <= delay <= 4.0
            seen.add(round(delay, 6))
        # A fixed schedule would produce exactly one value, and every scraper
        # that failed together would come back together.
        assert len(seen) > 10

    def test_retry_after_overrides_the_schedule_and_the_cap(self):
        delay = backoff_delay(1, base_sec=1.0, cap_sec=5.0, retry_after_sec=60.0)
        assert delay >= 60.0
        assert delay < 60.5  # obeyed, plus only a small anti-herd sliver

    def test_retry_after_shorter_than_our_own_backoff_is_ignored(self):
        delay = backoff_delay(3, base_sec=4.0, cap_sec=100.0, retry_after_sec=0.1, rand=lambda: 0.0)
        assert delay == 8.0


class TestParseRobots:
    def test_disallow_blocks_matching_prefixes(self):
        rules = parse_robots("User-agent: *\nDisallow: /admin\n")
        assert rules.allows("/careers") is True
        assert rules.allows("/admin") is False
        assert rules.allows("/admin/users") is False

    def test_empty_disallow_means_allow_everything(self):
        # The documented way to say "no restrictions". Treating the empty value
        # as a rule matching every path would lock us out of the whole site.
        rules = parse_robots("User-agent: *\nDisallow:\n")
        assert rules.allows("/anything") is True

    def test_allow_wins_over_a_longer_disallow_by_specificity(self):
        rules = parse_robots("User-agent: *\nDisallow: /\nAllow: /careers\n")
        assert rules.allows("/careers/engineer") is True
        assert rules.allows("/internal") is False

    def test_wildcard_and_end_anchor(self):
        rules = parse_robots(
            "User-agent: *\nDisallow: /*/private\nDisallow: /search$\n"
        )
        assert rules.allows("/team/private/notes") is False
        assert rules.allows("/team/public") is True
        # "$" anchors, so only the exact path is blocked.
        assert rules.allows("/search") is False
        assert rules.allows("/search/jobs") is True

    def test_a_group_naming_us_beats_the_wildcard_group(self):
        text = (
            "User-agent: *\n"
            "Disallow: /\n"
            "\n"
            f"User-agent: {USER_AGENT_TOKEN}\n"
            "Disallow: /internal\n"
            "Crawl-delay: 7\n"
        )
        rules = parse_robots(text)
        assert rules.matched_group == USER_AGENT_TOKEN
        assert rules.allows("/careers") is True
        assert rules.allows("/internal") is False
        assert rules.crawl_delay == 7.0

    def test_crawl_delay_is_read_for_the_matching_group_only(self):
        text = (
            "User-agent: googlebot\n"
            "Crawl-delay: 60\n"
            "\n"
            "User-agent: *\n"
            "Crawl-delay: 3\n"
            "Disallow: /tmp\n"
        )
        rules = parse_robots(text)
        assert rules.matched_group == "*"
        assert rules.crawl_delay == 3.0

    def test_several_agents_share_one_block_of_rules(self):
        text = f"User-agent: bingbot\nUser-agent: {USER_AGENT_TOKEN}\nDisallow: /x\n"
        rules = parse_robots(text)
        assert rules.allows("/x") is False

    def test_comments_and_blank_lines_are_ignored(self):
        text = "# hello\nUser-agent: *   # everyone\n\nDisallow: /admin # not this\n"
        rules = parse_robots(text)
        assert rules.allows("/admin") is False
        assert rules.allows("/jobs") is True

    def test_no_group_addresses_us_means_no_restrictions(self):
        rules = parse_robots("User-agent: googlebot\nDisallow: /\n")
        assert rules.allows("/careers") is True

    def test_a_rule_before_any_user_agent_line_binds_nothing(self):
        rules = parse_robots("Disallow: /\nUser-agent: *\nDisallow: /admin\n")
        assert rules.allows("/careers") is True
        assert rules.allows("/admin") is False

    def test_case_insensitive_field_names_and_agent_names(self):
        rules = parse_robots("USER-AGENT: *\nDISALLOW: /Admin\n")
        assert rules.allows("/Admin") is False


class TestRobotsCache:
    def test_fetches_once_per_origin_and_caches(self):
        clock = FakeClock()
        fetch = fixed_fetcher(200, "User-agent: *\nDisallow: /admin\n")
        cache = RobotsCache(fetcher=fetch, clock=clock)

        assert cache.for_url("https://acme.test/careers").allows("/careers") is True
        assert cache.for_url("https://acme.test/admin").allows("/admin") is False
        # Re-reading robots.txt for every page would itself be the impolite act.
        assert fetch.calls == ["https://acme.test/robots.txt"]

    def test_refetches_after_the_ttl(self):
        clock = FakeClock()
        fetch = fixed_fetcher(200, "User-agent: *\nDisallow: /admin\n")
        cache = RobotsCache(fetcher=fetch, ttl_sec=100.0, clock=clock)

        cache.for_url("https://acme.test/a")
        clock.advance(101)
        cache.for_url("https://acme.test/a")
        assert len(fetch.calls) == 2

    def test_missing_robots_txt_means_no_restrictions(self):
        cache = RobotsCache(fetcher=fixed_fetcher(404, ""), clock=FakeClock())
        assert cache.for_url("https://acme.test/careers") is ALLOW_ALL

    def test_unreadable_robots_txt_means_assume_disallow_briefly(self):
        # We cannot know what the site asked for, so we do not guess in our own
        # favour — but only for a short window, so an outage is not a ban.
        clock = FakeClock()
        fetch = fixed_fetcher(503, "")
        cache = RobotsCache(fetcher=fetch, error_ttl_sec=60.0, clock=clock)

        assert cache.for_url("https://acme.test/careers") is DISALLOW_ALL
        assert DISALLOW_ALL.allows("/careers") is False

        clock.advance(61)
        cache.for_url("https://acme.test/careers")
        assert len(fetch.calls) == 2

    def test_a_connection_failure_is_treated_like_a_server_error(self):
        cache = RobotsCache(fetcher=fixed_fetcher(0, ""), clock=FakeClock())
        assert cache.for_url("https://acme.test/careers") is DISALLOW_ALL


class TestDomainLimiter:
    def test_first_request_to_a_domain_goes_immediately(self):
        limiter = DomainLimiter(min_interval_sec=2.0, clock=FakeClock())
        assert limiter.wait_seconds("acme.test") == 0.0

    def test_second_request_waits_out_the_interval(self):
        clock = FakeClock()
        limiter = DomainLimiter(min_interval_sec=2.0, clock=clock)
        limiter.record("acme.test")

        assert limiter.wait_seconds("acme.test") == 2.0
        clock.advance(0.5)
        assert limiter.wait_seconds("acme.test") == 1.5
        clock.advance(2.0)
        assert limiter.wait_seconds("acme.test") == 0.0

    def test_domains_are_paced_independently(self):
        limiter = DomainLimiter(min_interval_sec=2.0, clock=FakeClock())
        limiter.record("acme.test")
        # 436 companies are 436 different servers; slowing the whole run to
        # protect one of them would help nobody.
        assert limiter.wait_seconds("other.test") == 0.0

    def test_a_sites_crawl_delay_wins_when_it_asks_for_more(self):
        clock = FakeClock()
        limiter = DomainLimiter(min_interval_sec=2.0, clock=clock)
        limiter.record("acme.test")
        assert limiter.wait_seconds("acme.test", crawl_delay=10.0) == 10.0
        # …but a crawl-delay SHORTER than our own courtesy interval does not
        # licence us to speed up.
        assert limiter.wait_seconds("acme.test", crawl_delay=0.1) == 2.0


class TestBackoffRecord:
    def test_a_streak_below_the_threshold_does_not_block(self):
        record = BackoffRecord(threshold=3, clock=FakeClock())
        record.note_refusal("acme.test")
        record.note_refusal("acme.test")
        assert record.blocked_for("acme.test") == 0.0

    def test_success_clears_the_streak(self):
        record = BackoffRecord(threshold=3, clock=FakeClock())
        record.note_refusal("acme.test")
        record.note_refusal("acme.test")
        record.note_success("acme.test")
        record.note_refusal("acme.test")
        assert record.blocked_for("acme.test") == 0.0
        assert record.state("acme.test").consecutive_refusals == 1

    def test_the_threshold_blocks_the_domain_for_the_cool_down(self):
        clock = FakeClock()
        record = BackoffRecord(threshold=3, base_cooldown_sec=300.0, clock=clock)
        for _ in range(3):
            record.note_refusal("acme.test", reason="HTTP 429")

        assert record.blocked_for("acme.test") == 300.0
        clock.advance(300)
        assert record.blocked_for("acme.test") == 0.0

    def test_refusals_already_in_flight_do_not_extend_the_block(self):
        clock = FakeClock()
        record = BackoffRecord(threshold=3, base_cooldown_sec=300.0, clock=clock)
        for _ in range(3):
            record.note_refusal("acme.test")
        for _ in range(5):
            record.note_refusal("acme.test")
        assert record.blocked_for("acme.test") == 300.0

    def test_a_second_trip_doubles_the_cool_down(self):
        clock = FakeClock()
        record = BackoffRecord(threshold=1, base_cooldown_sec=100.0, clock=clock)

        record.note_refusal("acme.test")
        assert record.blocked_for("acme.test") == 100.0

        clock.advance(100)
        record.note_refusal("acme.test")
        assert record.blocked_for("acme.test") == 200.0

    def test_retry_after_is_the_cool_down_floor_up_to_the_ceiling(self):
        clock = FakeClock()
        record = BackoffRecord(
            threshold=1, base_cooldown_sec=100.0, max_cooldown_sec=600.0, clock=clock
        )
        record.note_refusal("acme.test", retry_after_sec=400.0)
        assert record.blocked_for("acme.test") == 400.0

        other = BackoffRecord(
            threshold=1, base_cooldown_sec=100.0, max_cooldown_sec=600.0, clock=clock
        )
        other.note_refusal("other.test", retry_after_sec=86_400.0)
        assert other.blocked_for("other.test") == 600.0


class TestPolitePolicy:
    def build(self, robots_body: str = "User-agent: *\nDisallow: /admin\n", status: int = 200):
        clock = FakeClock()
        slept: list[float] = []
        policy = PolitePolicy(
            robots=RobotsCache(fetcher=fixed_fetcher(status, robots_body), clock=clock),
            limiter=DomainLimiter(min_interval_sec=2.0, clock=clock),
            backoff=BackoffRecord(threshold=2, base_cooldown_sec=300.0, clock=clock),
            sleeper=slept.append,
            clock=clock,
        )
        return policy, clock, slept

    def test_allows_a_permitted_page(self):
        policy, _, _ = self.build()
        decision = policy.check("https://acme.test/careers")
        assert decision.allowed is True
        assert bool(decision) is True

    def test_refuses_a_page_robots_txt_disallows(self):
        policy, _, _ = self.build()
        decision = policy.check("https://acme.test/admin/jobs")
        assert decision.allowed is False
        assert "robots.txt" in decision.reason

    def test_query_strings_are_part_of_the_path_robots_matches(self):
        policy, _, _ = self.build("User-agent: *\nDisallow: /*?print=1\n")
        assert policy.check("https://acme.test/careers").allowed is True
        assert policy.check("https://acme.test/careers?print=1").allowed is False

    def test_paces_repeat_visits_to_one_domain(self):
        policy, clock, slept = self.build()

        first = policy.wait("https://acme.test/careers")
        assert first.allowed is True
        assert slept == []  # nothing owed on the first visit

        second = policy.wait("https://acme.test/careers/2")
        assert second.allowed is True
        assert slept == [2.0]

    def test_a_skipped_domain_does_not_claim_its_next_slot(self):
        policy, clock, _ = self.build()
        policy.wait("https://acme.test/careers")
        clock.advance(1.0)
        # A disallowed URL must not reset the pacing window — otherwise a page
        # we never fetched would push back one we may. Half the interval has
        # elapsed, so half of it must remain.
        policy.wait("https://acme.test/admin")
        assert policy.limiter.wait_seconds("acme.test") == 1.0

    def test_an_absurd_crawl_delay_skips_the_domain_rather_than_stalling_the_run(self):
        policy, _, slept = self.build("User-agent: *\nCrawl-delay: 600\n")
        assert policy.wait("https://acme.test/careers").allowed is True
        decision = policy.wait("https://acme.test/careers/2")
        assert decision.allowed is False
        assert "skipping" in decision.reason
        # Emphatically not: sleep for ten minutes inside the run.
        assert slept == []

    def test_a_refusing_domain_is_left_alone(self):
        policy, clock, _ = self.build()
        policy.note_response("https://acme.test/careers", 429, retry_after="120")
        policy.note_response("https://acme.test/careers", 429, retry_after="120")

        decision = policy.check("https://acme.test/careers")
        assert decision.allowed is False
        assert "refused us" in decision.reason

        clock.advance(301)
        assert policy.check("https://acme.test/careers").allowed is True

    def test_a_404_is_not_a_refusal(self):
        policy, _, _ = self.build()
        for _ in range(6):
            policy.note_response("https://acme.test/careers", 404)
        # A server answering "no such page" is a server happy to talk to us.
        # Counting it would take a whole domain offline over one dead URL.
        assert policy.check("https://acme.test/careers").allowed is True

    def test_a_connection_failure_counts_toward_the_backoff(self):
        policy, _, _ = self.build()
        policy.note_network_error("https://acme.test/careers")
        policy.note_network_error("https://acme.test/careers")
        assert policy.check("https://acme.test/careers").allowed is False

    def test_an_unparseable_url_is_refused_rather_than_fetched(self):
        policy, _, _ = self.build()
        assert policy.check("not a url").allowed is False


class TestRenderSeam:
    def build(self):
        clock = FakeClock()
        return (
            PolitePolicy(
                robots=RobotsCache(
                    fetcher=fixed_fetcher(200, "User-agent: *\nDisallow: /admin\n"), clock=clock
                ),
                limiter=DomainLimiter(min_interval_sec=0.0, clock=clock),
                backoff=BackoffRecord(threshold=3, clock=clock),
                sleeper=lambda _s: None,
                clock=clock,
            ),
            clock,
        )

    def test_a_browser_is_allowed_on_a_healthy_permitted_page(self):
        policy, _ = self.build()
        assert policy.should_render("https://acme.test/careers").allowed is True

    def test_never_renders_a_page_robots_txt_disallows(self):
        policy, _ = self.build()
        decision = policy.should_render("https://acme.test/admin")
        assert decision.allowed is False
        assert "robots.txt" in decision.reason

    def test_one_refusal_is_enough_to_withhold_a_browser(self):
        policy, _ = self.build()
        policy.note_response("https://acme.test/careers", 403)
        # Below the threshold, so a plain HTTP fetch is still permitted…
        assert policy.check("https://acme.test/careers").allowed is True
        # …but a headless browser is the most expensive, most bot-shaped thing
        # we do, so any sign of being unwelcome withholds it.
        decision = policy.should_render("https://acme.test/careers")
        assert decision.allowed is False
        assert "browser" in decision.reason


class TestDefaultPolicy:
    def teardown_method(self):
        reset_default_policy()

    def test_the_default_policy_is_shared_so_the_memory_is_shared(self):
        reset_default_policy()
        assert default_policy() is default_policy()

    def test_reset_replaces_it(self):
        first = default_policy()
        reset_default_policy()
        assert default_policy() is not first

    def test_may_render_answers_through_the_shared_policy(self):
        reset_default_policy()
        policy = default_policy()
        # Stub the network-touching part only; the seam itself is real.
        policy.robots = RobotsCache(
            fetcher=fixed_fetcher(200, "User-agent: *\nDisallow: /\n"), clock=FakeClock()
        )
        decision = may_render("https://acme.test/careers")
        assert isinstance(decision, Decision)
        assert decision.allowed is False


class TestDomainOf:
    def test_extracts_and_lowercases_the_host(self):
        assert domain_of("https://Acme.TEST:8443/careers") == "acme.test"

    def test_returns_empty_for_junk(self):
        assert domain_of("not a url") == ""
