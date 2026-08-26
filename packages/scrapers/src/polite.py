"""Being a well-behaved client on the generic career-page path.

WHY THIS EXISTS
    The ATS adapters on the TypeScript side (Greenhouse, Lever, Ashby, ...) talk
    to public JSON APIs behind CDNs that do not block. This package does not:
    it fetches ORDINARY COMPANY WEB SERVERS, one career page at a time, for
    hundreds of companies on an hourly schedule, and it escalates some of them
    to a real headless browser. That is the traffic that gets a client blocked,
    and blocked here does not mean a slow scrape — it means the 303 of 436
    watched companies with no detectable ATS board become permanently invisible
    to the user.

    So this module is the thing that keeps us welcome: read robots.txt and obey
    it, keep a real gap between requests to the same domain, and remember which
    domains have already refused us so we stop asking.

RESILIENCE AND POLITENESS, NOT EVASION
    This module exists so a site never has a REASON to refuse us. It is
    explicitly NOT here to get past a site that already has. Out of scope, and
    not an oversight:

      * Solving, bypassing or fingerprint-dodging CAPTCHAs and bot-detection
        challenges.
      * Rotating or disguising our identity. There is one USER_AGENT, it names
        the product and a contact URL, and it is the string a site operator
        would use to rate-limit or block us — which is the deal that keeps us
        welcome, and the only reason a 403 in their log is attributable to us.
      * Anything whose purpose is to defeat a site that has decided to refuse
        automation.

    When a site says no — by robots.txt, by 403, or by 429 — we record it and
    back off. We do not fight it. A page that does not want to be read is a page
    we do not read, and the job it holds becomes a link the human opens.

HOW render.py SHOULD USE THIS
    A headless browser is by far the most expensive and most bot-shaped request
    this package makes, so it is the one that must be gated hardest. The seam is
    may_render(); the intended call site is the top of
    render.fetch_with_render_fallback, before it escalates:

        from .polite import may_render

        verdict = looks_like_unrendered_shell(static_html)
        if not verdict.is_shell:
            return static_html or "", False

        permission = may_render(url)
        if not permission.allowed:
            logger.info("not rendering %s: %s", url, permission.reason)
            return static_html or "", False

    Nothing in this module imports render.py, and render.py works unchanged
    without it — the dependency runs one way only.

EVERYTHING HERE IS OFFLINE-TESTABLE
    The robots parser, the limiter, the backoff record and the retry-after
    parser are pure given an injected clock; only RobotsCache touches the
    network, through an injectable fetcher that lazily imports httpx exactly the
    way render.py lazily imports Scrapling.
"""

from __future__ import annotations

import calendar
import logging
import random as _random
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------

# The product token a site operator would write in their robots.txt to address
# us, and the full header we send. Kept byte-identical in spirit to
# CELLO_USER_AGENT in apps/web/lib/ats/http.ts so that one rule in one
# robots.txt governs everything Cello does.
#
# Never rotate this, never randomise it, and never impersonate a browser. Note
# that src/base.py and src/intelligent.py currently send a fake Chrome
# User-Agent; that is the opposite of this policy and should be replaced with
# USER_AGENT (see the report accompanying this module).
USER_AGENT_TOKEN = "cello-job-tracker"
USER_AGENT = f"{USER_AGENT_TOKEN}/1.0 (+https://cello-two.vercel.app)"

# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------

#: Minimum gap between two requests to the SAME domain, when robots.txt does not
#: state a Crawl-delay. Two seconds is the conventional courtesy interval for a
#: general-purpose crawler and is invisible to us: the run is bounded by the
#: number of companies, not by one domain.
DEFAULT_MIN_INTERVAL_SEC = 2.0

#: Longest we will hold a worker waiting to be polite to one domain. Beyond
#: this we SKIP the domain for this run rather than hammer it or stall the
#: whole schedule — a site asking for a 10-minute crawl-delay is a site we
#: visit next hour, not one we ignore.
MAX_WAIT_SEC = 30.0

#: How long a parsed robots.txt is trusted before we ask for it again.
ROBOTS_TTL_SEC = 6 * 60 * 60
#: Much shorter TTL when robots.txt could not be read, because that state means
#: "disallow everything" (see RobotsCache.for_url) and a blip must not lock a
#: domain out for the rest of the day.
ROBOTS_ERROR_TTL_SEC = 5 * 60

#: Consecutive refusals from one domain before we stop calling it entirely.
REFUSAL_THRESHOLD = 3
#: First cool-down after that, doubled on each further trip, and its ceiling.
BASE_COOLDOWN_SEC = 5 * 60.0
MAX_COOLDOWN_SEC = 60 * 60.0

#: Statuses that mean "we are refusing you", as opposed to "no such page".
#: A 404 is a server talking to us perfectly happily and never counts.
REFUSAL_STATUSES = frozenset({403, 429, 451, 503})

Clock = Callable[[], float]
Fetcher = Callable[[str], tuple[int, str]]

# ---------------------------------------------------------------------------
# Retry-After
# ---------------------------------------------------------------------------


def parse_retry_after(value: str | None, now: float | None = None) -> float | None:
    """Parse a Retry-After header into seconds.

    RFC 9110 allows both `Retry-After: 120` (delta-seconds) and
    `Retry-After: Wed, 21 Oct 2015 07:28:00 GMT` (HTTP-date), and real servers
    send both. A date already in the past yields 0.0 ("you may retry now"), not
    a negative number. Anything unparseable yields None, so the caller falls
    back to its own backoff instead of treating garbage as "go immediately".
    """
    if value is None:
        return None
    raw = value.strip()
    if not raw:
        return None

    if raw.isdigit():
        return float(raw)

    # All three HTTP-date forms RFC 9110 permits begin with a day name, so a
    # leading letter is a cheap and sufficient guard. It is also a necessary
    # one: date parsers are far too willing, and "-5" must read as "I cannot
    # parse this", not as a moment in the past.
    if not raw[:1].isalpha():
        return None

    try:
        when = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return None
    # The obsolete asctime form carries no zone. HTTP dates are UTC by
    # definition, so a naive one is read as UTC via timegm rather than through
    # .timestamp(), which would silently apply this machine's local offset.
    epoch = when.timestamp() if when.tzinfo is not None else calendar.timegm(when.timetuple())

    reference = time.time() if now is None else now
    return max(0.0, epoch - reference)


# ---------------------------------------------------------------------------
# Backoff schedule
# ---------------------------------------------------------------------------

#: Extra spread added on top of a server-stated Retry-After. Obeying it to the
#: millisecond is what turns a fleet into a thundering herd: every client told
#: "wait 5" comes back at exactly +5s and re-triggers the same limit.
RETRY_AFTER_JITTER_SEC = 0.5


def backoff_delay(
    attempt: int,
    base_sec: float = 1.0,
    cap_sec: float = 60.0,
    retry_after_sec: float | None = None,
    rand: Callable[[], float] = _random.random,
) -> float:
    """Seconds to wait before attempt number `attempt` (1 = the first retry).

    SHAPE: "equal jitter" — half the exponential term plus a uniform draw over
    the other half, so the delay lands in [exp/2, exp).

    Plain exponential backoff has every client that failed at the same instant
    retry at the same instant, which is how one provider hiccup becomes a
    self-inflicted flood. Full jitter ([0, exp)) spreads better but lets some
    clients retry almost immediately, which is not what "back off" means. Equal
    jitter keeps a guaranteed floor and still spreads over a 2x window.

    A server-stated Retry-After is an instruction, not a hint, so it overrides
    the schedule and the cap alike — the only thing we add is jitter.
    """
    step = max(1, int(attempt))
    base = max(0.0, base_sec)
    cap = max(0.0, cap_sec)

    exponential = min(cap, base * (2 ** (step - 1)))
    jittered = exponential / 2 + rand() * (exponential / 2)

    if retry_after_sec is not None and retry_after_sec >= 0:
        return max(jittered, retry_after_sec + rand() * RETRY_AFTER_JITTER_SEC)
    return jittered


# ---------------------------------------------------------------------------
# robots.txt
# ---------------------------------------------------------------------------


def _compile_rule(pattern: str) -> re.Pattern[str]:
    """Translate a robots.txt path pattern into an anchored regex.

    Two wildcards are defined for robots.txt and both are in wide real use:
    `*` matches any run of characters, and a trailing `$` anchors the end of the
    path. Everything else is a literal prefix match — `Disallow: /admin` blocks
    /admin, /admin/, and /administration alike, which is the documented (if
    surprising) behaviour and the one site operators write against.
    """
    out = [r"\A"]
    for index, char in enumerate(pattern):
        if char == "*":
            out.append(".*")
        elif char == "$" and index == len(pattern) - 1:
            out.append(r"\Z")
        else:
            out.append(re.escape(char))
    return re.compile("".join(out))


@dataclass(frozen=True)
class _Rule:
    allow: bool
    pattern: str
    regex: re.Pattern[str]


@dataclass(frozen=True)
class RobotsRules:
    """The rules from one robots.txt that apply to US, already parsed."""

    rules: tuple[_Rule, ...] = ()
    crawl_delay: float | None = None
    #: Which User-agent group we obeyed ("*" or our own token), for logging.
    matched_group: str = "*"
    #: Why these rules are what they are, when there was no file to read.
    source: str = "parsed"

    def allows(self, path: str) -> bool:
        """Is `path` (the path+query part of a URL) crawlable?

        Precedence follows RFC 9309: the LONGEST matching rule wins, and when an
        Allow and a Disallow of equal length both match, Allow wins. That is
        what makes the common `Disallow: /` + `Allow: /careers` pattern work,
        and getting it backwards would have us skip exactly the pages a site
        went out of its way to open up.
        """
        target = path or "/"
        best: _Rule | None = None
        for rule in self.rules:
            if not rule.regex.match(target):
                continue
            if best is None:
                best = rule
                continue
            longer = len(rule.pattern) > len(best.pattern)
            ties_but_allows = (
                len(rule.pattern) == len(best.pattern) and rule.allow and not best.allow
            )
            if longer or ties_but_allows:
                best = rule
        # No rule mentions this path: robots.txt is a deny-list, so silence
        # means yes.
        if best is None:
            return True
        return best.allow


#: Used when there is no robots.txt at all (404), which RFC 9309 says means
#: "no restrictions".
ALLOW_ALL = RobotsRules(source="no robots.txt")
#: Used when robots.txt could not be read (5xx, connection failure). RFC 9309
#: says a crawler may assume complete disallow, and that is the reading we take:
#: we cannot know what the site asked for, so we do not guess in our own favour.
#: Cached only briefly — see ROBOTS_ERROR_TTL_SEC.
DISALLOW_ALL = RobotsRules(
    rules=(_Rule(allow=False, pattern="/", regex=_compile_rule("/")),),
    source="robots.txt unreadable",
)


def parse_robots(text: str, user_agent_token: str = USER_AGENT_TOKEN) -> RobotsRules:
    """Parse robots.txt and return only the rules that bind `user_agent_token`.

    Group selection: the most specific User-agent group that addresses us wins,
    and `*` is the fallback — so a site that writes a rule naming us by name is
    obeyed over its general rule, which is the whole point of naming us.
    """
    groups: dict[str, list[_Rule]] = {}
    delays: dict[str, float] = {}
    current_agents: list[str] = []
    # A directive line closes the current run of User-agent lines; the next
    # User-agent line after one starts a fresh group.
    agents_open = False

    for raw_line in text.splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        field_name, _, value = line.partition(":")
        key = field_name.strip().lower()
        val = value.strip()

        if key == "user-agent":
            if not agents_open:
                current_agents = []
                agents_open = True
            agent = val.lower()
            current_agents.append(agent)
            groups.setdefault(agent, [])
            continue

        if not current_agents:
            # A directive before any User-agent line binds nothing.
            continue
        agents_open = False

        if key in ("disallow", "allow"):
            # An EMPTY Disallow is the documented way to say "allow everything",
            # so it must not become a rule matching every path.
            if not val:
                continue
            rule = _Rule(allow=(key == "allow"), pattern=val, regex=_compile_rule(val))
            for agent in current_agents:
                groups[agent].append(rule)
        elif key == "crawl-delay":
            try:
                delay = float(val)
            except ValueError:
                continue
            if delay >= 0:
                for agent in current_agents:
                    delays[agent] = delay

    token = user_agent_token.lower()
    named = [name for name in groups if name != "*" and name and name in token]
    if named:
        chosen = max(named, key=len)
    elif "*" in groups:
        chosen = "*"
    else:
        return ALLOW_ALL

    return RobotsRules(
        rules=tuple(groups[chosen]),
        crawl_delay=delays.get(chosen),
        matched_group=chosen,
    )


def _default_fetcher(url: str, timeout: float = 10.0) -> tuple[int, str]:
    """Fetch a URL with httpx, lazily imported.

    Same lazy-import contract as render.scrapling_available(): this package must
    keep working wherever a dependency is not provisioned, and a fetch failure
    must degrade to a status code rather than an exception. Status 0 means "no
    answer at all".
    """
    try:
        import httpx
    except Exception:  # noqa: BLE001 — an unimportable client is just "no answer"
        logger.warning("httpx unavailable; cannot read %s", url)
        return (0, "")

    try:
        response = httpx.get(
            url,
            timeout=timeout,
            follow_redirects=True,
            headers={"User-Agent": USER_AGENT},
        )
    except Exception as exc:  # noqa: BLE001 — any failure degrades to "no answer"
        logger.info("could not read %s: %s", url, exc)
        return (0, "")
    return (response.status_code, response.text)


@dataclass
class _CachedRobots:
    rules: RobotsRules
    expires_at: float


class RobotsCache:
    """Fetches, caches and interprets robots.txt, one entry per origin.

    Cached because robots.txt is per-origin and a run touches the same origin
    several times (the career page, then its pagination links, then possibly a
    render) — re-fetching it each time would itself be the impolite thing.
    """

    def __init__(
        self,
        fetcher: Fetcher | None = None,
        ttl_sec: float = ROBOTS_TTL_SEC,
        error_ttl_sec: float = ROBOTS_ERROR_TTL_SEC,
        user_agent_token: str = USER_AGENT_TOKEN,
        clock: Clock = time.monotonic,
    ) -> None:
        self._fetcher = fetcher or _default_fetcher
        self._ttl_sec = ttl_sec
        self._error_ttl_sec = error_ttl_sec
        self._user_agent_token = user_agent_token
        self._clock = clock
        self._entries: dict[str, _CachedRobots] = {}

    def for_url(self, url: str) -> RobotsRules:
        """The rules governing `url`, fetching and caching robots.txt as needed."""
        parts = urlsplit(url)
        if not parts.scheme or not parts.netloc:
            # Nothing to ask permission of. Callers still gate on the limiter.
            return ALLOW_ALL
        origin = f"{parts.scheme}://{parts.netloc}"

        now = self._clock()
        cached = self._entries.get(origin)
        if cached is not None and now < cached.expires_at:
            return cached.rules

        status, body = self._fetcher(f"{origin}/robots.txt")
        if status == 200:
            rules = parse_robots(body, self._user_agent_token)
            ttl = self._ttl_sec
        elif 400 <= status < 500:
            # 404 (and 403 on the robots file itself) mean there are no stated
            # restrictions. RFC 9309 is explicit that this is "crawl allowed".
            rules = ALLOW_ALL
            ttl = self._ttl_sec
        else:
            # 5xx, or no answer at all. We cannot know what the site asked for,
            # so we assume the most restrictive reading rather than guessing in
            # our own favour — briefly, so an outage is not a permanent ban.
            rules = DISALLOW_ALL
            ttl = self._error_ttl_sec

        self._entries[origin] = _CachedRobots(rules=rules, expires_at=now + ttl)
        return rules

    def clear(self) -> None:
        self._entries.clear()


# ---------------------------------------------------------------------------
# Per-domain rate limiting
# ---------------------------------------------------------------------------


class DomainLimiter:
    """Keeps a minimum gap between consecutive requests to the same domain.

    Deliberately per-DOMAIN and not global: 436 companies are 436 different web
    servers, and slowing the whole run to protect one of them would help nobody.
    What matters is that no single server sees a burst from us.
    """

    def __init__(
        self,
        min_interval_sec: float = DEFAULT_MIN_INTERVAL_SEC,
        clock: Clock = time.monotonic,
    ) -> None:
        self._min_interval_sec = min_interval_sec
        self._clock = clock
        self._last_request: dict[str, float] = {}

    def interval_for(self, crawl_delay: float | None) -> float:
        """Our own courtesy interval, or the site's Crawl-delay if it asked for more."""
        if crawl_delay is None:
            return self._min_interval_sec
        return max(self._min_interval_sec, crawl_delay)

    def wait_seconds(self, domain: str, crawl_delay: float | None = None) -> float:
        """How long to wait before the next request to `domain`. 0 when it may go now."""
        last = self._last_request.get(domain)
        if last is None:
            return 0.0
        due = last + self.interval_for(crawl_delay)
        return max(0.0, due - self._clock())

    def record(self, domain: str) -> None:
        """Note that a request to `domain` is being sent right now."""
        self._last_request[domain] = self._clock()

    def clear(self) -> None:
        self._last_request.clear()


# ---------------------------------------------------------------------------
# Shared backoff record
# ---------------------------------------------------------------------------


@dataclass
class DomainHealth:
    """What we currently believe about one domain."""

    consecutive_refusals: int = 0
    blocked_until: float = 0.0
    #: How many times this domain has been blocked without an intervening
    #: success — each trip doubles the cool-down.
    trips: int = 0
    last_reason: str = ""


@dataclass
class BackoffRecord:
    """Remembers which domains have refused us, and stops us asking again.

    WHY A SHARED RECORD: the scraper, the pagination follower and the browser
    escalation are three different call sites that can each provoke the same
    domain. Without one record between them, a domain that just returned 429 to
    the HTTP fetch would immediately be visited again by a headless browser —
    which is precisely the escalation pattern that looks like an attack.

    A refusal is 403/429/451/503 or a connection failure. A 404 is not: a server
    answering "no such page" is a server perfectly happy to talk to us, and
    counting it would take a whole domain offline over one dead URL.
    """

    threshold: int = REFUSAL_THRESHOLD
    base_cooldown_sec: float = BASE_COOLDOWN_SEC
    max_cooldown_sec: float = MAX_COOLDOWN_SEC
    clock: Clock = time.monotonic
    _domains: dict[str, DomainHealth] = field(default_factory=dict)

    def state(self, domain: str) -> DomainHealth:
        return self._domains.setdefault(domain, DomainHealth())

    def note_success(self, domain: str) -> None:
        """The domain answered us. Clears the streak and any cool-down."""
        health = self.state(domain)
        health.consecutive_refusals = 0
        health.blocked_until = 0.0
        health.trips = 0
        health.last_reason = ""

    def note_refusal(
        self,
        domain: str,
        retry_after_sec: float | None = None,
        reason: str = "refused",
    ) -> None:
        """The domain refused us. Trips a cool-down once the streak is long enough."""
        health = self.state(domain)
        health.consecutive_refusals += 1
        health.last_reason = reason
        now = self.clock()

        if health.blocked_until > now:
            # Already cooling down. Requests that were already in flight when it
            # tripped land here and must NOT each extend the block — only an
            # explicit Retry-After reaching further out does.
            if retry_after_sec is not None:
                health.blocked_until = max(
                    health.blocked_until, now + min(self.max_cooldown_sec, retry_after_sec)
                )
            return

        if health.consecutive_refusals < self.threshold:
            return

        cooldown = self.base_cooldown_sec * (2 ** min(health.trips, 6))
        if retry_after_sec is not None:
            cooldown = max(cooldown, retry_after_sec)
        cooldown = min(self.max_cooldown_sec, cooldown)
        health.trips += 1
        health.blocked_until = now + cooldown

    def blocked_for(self, domain: str) -> float:
        """Seconds left on this domain's cool-down; 0.0 when it is not blocked."""
        health = self._domains.get(domain)
        if health is None:
            return 0.0
        return max(0.0, health.blocked_until - self.clock())

    def clear(self) -> None:
        self._domains.clear()


# ---------------------------------------------------------------------------
# The policy the rest of the package talks to
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Decision:
    """May we make this request, and how long must we wait first?"""

    allowed: bool
    reason: str
    wait_seconds: float = 0.0

    def __bool__(self) -> bool:
        return self.allowed


def domain_of(url: str) -> str:
    """Host of a URL, lowercased and without a port. Empty when unparseable."""
    try:
        host = urlsplit(url).hostname
    except ValueError:
        return ""
    return (host or "").lower()


class PolitePolicy:
    """robots.txt + per-domain pacing + refusal memory, behind one question.

    The question is check(url): "may I fetch this, and how long should I wait
    first?" Everything else on this class either answers it or teaches it
    something. Callers that follow up with note_response() get the memory; ones
    that do not still get robots.txt and pacing.
    """

    def __init__(
        self,
        robots: RobotsCache | None = None,
        limiter: DomainLimiter | None = None,
        backoff: BackoffRecord | None = None,
        max_wait_sec: float = MAX_WAIT_SEC,
        sleeper: Callable[[float], None] = time.sleep,
        clock: Clock = time.monotonic,
    ) -> None:
        self.robots = robots or RobotsCache(clock=clock)
        self.limiter = limiter or DomainLimiter(clock=clock)
        self.backoff = backoff or BackoffRecord(clock=clock)
        self._max_wait_sec = max_wait_sec
        self._sleeper = sleeper

    # -- asking ------------------------------------------------------------

    def check(self, url: str) -> Decision:
        """May we fetch `url` right now, and how long must we wait first?"""
        domain = domain_of(url)
        if not domain:
            return Decision(False, f"unparseable URL: {url!r}")

        blocked = self.backoff.blocked_for(domain)
        if blocked > 0:
            health = self.backoff.state(domain)
            return Decision(
                False,
                f"{domain} refused us {health.consecutive_refusals}x "
                f"({health.last_reason}); not calling it for another {blocked:.0f}s",
            )

        rules = self.robots.for_url(url)
        parts = urlsplit(url)
        path = parts.path or "/"
        if parts.query:
            path = f"{path}?{parts.query}"
        if not rules.allows(path):
            return Decision(
                False,
                f"robots.txt ({rules.source}, group {rules.matched_group!r}) "
                f"disallows {path} on {domain}",
            )

        wait = self.limiter.wait_seconds(domain, rules.crawl_delay)
        if wait > self._max_wait_sec:
            # Honouring a very long Crawl-delay by sleeping through it would
            # spend the whole run on one company. Skipping is the polite
            # outcome: we simply come back next hour.
            return Decision(
                False,
                f"{domain} asks for a {self.limiter.interval_for(rules.crawl_delay):.0f}s "
                f"gap; skipping it this run",
                wait,
            )
        return Decision(True, f"allowed by robots.txt (group {rules.matched_group!r})", wait)

    def should_render(self, url: str) -> Decision:
        """May we spend a HEADLESS BROWSER on `url`?

        Everything check() requires, plus one extra bar: no recent refusal at
        all, not merely no active cool-down. A browser is the most expensive and
        most bot-shaped request this package makes, so a domain that has shown
        any sign of not wanting us does not get one.
        """
        decision = self.check(url)
        if not decision.allowed:
            return decision
        domain = domain_of(url)
        streak = self.backoff.state(domain).consecutive_refusals
        if streak > 0:
            return Decision(
                False,
                f"{domain} refused us {streak}x recently; not escalating to a browser",
                decision.wait_seconds,
            )
        return decision

    # -- doing -------------------------------------------------------------

    def wait(self, url: str) -> Decision:
        """check(), then actually sleep out the pacing gap and claim the slot.

        Returns the decision so the caller can log why it is not fetching. The
        slot is claimed (limiter.record) only when the request is really about
        to be made, so a skipped domain does not push its own next window out.
        """
        decision = self.check(url)
        if not decision.allowed:
            return decision
        if decision.wait_seconds > 0:
            self._sleeper(decision.wait_seconds)
        self.limiter.record(domain_of(url))
        return decision

    # -- learning ----------------------------------------------------------

    def note_response(
        self,
        url: str,
        status: int,
        retry_after: str | float | None = None,
    ) -> None:
        """Record what a domain answered, so the next call knows about it."""
        domain = domain_of(url)
        if not domain:
            return
        if status not in REFUSAL_STATUSES:
            self.backoff.note_success(domain)
            return

        seconds = parse_retry_after(retry_after) if isinstance(retry_after, str) else retry_after
        self.backoff.note_refusal(domain, seconds, reason=f"HTTP {status}")

    def note_network_error(self, url: str, detail: str = "connection failed") -> None:
        """A refused connection or a timeout. Not a refusal in the "we have
        decided to block you" sense, but repeating it is just as pointless."""
        domain = domain_of(url)
        if domain:
            self.backoff.note_refusal(domain, None, reason=detail)

    def clear(self) -> None:
        """Forget everything. A test seam — see reset_default_policy()."""
        self.robots.clear()
        self.limiter.clear()
        self.backoff.clear()


# ---------------------------------------------------------------------------
# Module-level default, so call sites need one import and no wiring
# ---------------------------------------------------------------------------

_default: PolitePolicy | None = None


def default_policy() -> PolitePolicy:
    """The process-wide policy. Shared ON PURPOSE: the pacing and the refusal
    memory are only worth anything if every call site consults the same one."""
    global _default
    if _default is None:
        _default = PolitePolicy()
    return _default


def reset_default_policy() -> None:
    """Drop the process-wide policy.

    A test seam. Do NOT call this between scrape runs in production: the value
    of the record is that it REMEMBERS which domains refused us, and a process
    that forgets each run re-learns "you are blocked" by getting blocked again.
    """
    global _default
    _default = None


def may_fetch(url: str) -> Decision:
    """Convenience wrapper over default_policy().check()."""
    return default_policy().check(url)


def may_render(url: str) -> Decision:
    """The seam render.py consults before escalating to a browser.

    See the module docstring for the intended call site inside
    render.fetch_with_render_fallback.
    """
    return default_policy().should_render(url)
