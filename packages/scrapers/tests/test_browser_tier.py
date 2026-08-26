"""Tests for the Tier-3 browser escalation — the last rung of the ladder.

ZERO NETWORK, NO REAL BROWSER: Playwright and browser-use are never installed
in this environment, so browser_use_available()/_playwright_available() are
False here exactly as they will be in a bare `pip install -e .`. Escalation
order and discard-unless-better are proven by monkeypatching the module's own
seams (_deterministic_click_through, _llm_navigate_and_fetch), the same style
test_render.py uses for fetch_rendered.
"""

import inspect

from src import browser_tier
from src.browser_tier import (
    _EXCLUDED_AGENT_ACTIONS,
    _MAX_ACTIONS_PER_STEP,
    _MAX_HISTORY_ITEMS,
    _MAX_LLM_STEPS,
    _NAV_TASK_TEMPLATE,
    _same_site,
    fetch_with_browser_fallback,
)

# A real-shaped SPA shell, same fixture shape as test_render.py's.
SPA_SHELL = """
<!doctype html><html><head><title>Careers</title>
<script src="/static/bundle.js"></script></head>
<body><div id="root"></div></body></html>
"""

# A static board that already carries its postings — no escalation needed.
STATIC_BOARD = """
<!doctype html><html><body>
<h1>Open roles at Example</h1>
<p>We are hiring across engineering, design and operations. Come build with us.</p>
<ul>
  <li><a href="/careers/senior-engineer-123">Senior Engineer</a></li>
  <li><a href="/careers/product-designer-456">Product Designer</a></li>
  <li><a href="/jobs/data-analyst-789">Data Analyst</a></li>
</ul>
</body></html>
"""

# What a click-through to a real board might land on.
CLICKED_BOARD = STATIC_BOARD.replace("Example", "Example (clicked)")


class TestEscalationOrder:
    def test_not_invoked_when_the_render_tier_html_already_has_jobs(self, monkeypatch):
        calls = []

        def record(url):
            calls.append(url)
            return None

        monkeypatch.setattr(browser_tier, "_deterministic_click_through", record)
        monkeypatch.setattr(browser_tier, "_llm_navigate_and_fetch", record)

        html, used = fetch_with_browser_fallback("https://example.com/careers", STATIC_BOARD)

        assert used is False
        assert html == STATIC_BOARD
        assert calls == []  # neither rung was ever invoked

    def test_llm_rung_not_invoked_when_the_deterministic_rung_already_found_jobs(self, monkeypatch):
        llm_calls = []

        def record(url):
            llm_calls.append(url)
            return None

        monkeypatch.setattr(browser_tier, "_deterministic_click_through", lambda url: CLICKED_BOARD)
        monkeypatch.setattr(browser_tier, "_llm_navigate_and_fetch", record)

        html, used = fetch_with_browser_fallback("https://example.com/careers", SPA_SHELL)

        assert used is True
        assert html == CLICKED_BOARD
        assert llm_calls == []  # the deterministic rung already found postings

    def test_llm_rung_only_runs_when_env_flag_is_set(self, monkeypatch):
        monkeypatch.delenv("SCRAPER_BROWSER_USE_AGENT", raising=False)
        llm_calls = []

        def record(url):
            llm_calls.append(url)
            return CLICKED_BOARD

        # Deterministic rung result: None, i.e. still a shell after the click.
        monkeypatch.setattr(browser_tier, "_deterministic_click_through", lambda url: None)
        monkeypatch.setattr(browser_tier, "_llm_navigate_and_fetch", record)

        html, used = fetch_with_browser_fallback("https://example.com/careers", SPA_SHELL)

        assert used is False
        assert html == SPA_SHELL
        assert llm_calls == []  # gated off by default

    def test_llm_rung_runs_as_the_last_resort_when_opted_in(self, monkeypatch):
        monkeypatch.setenv("SCRAPER_BROWSER_USE_AGENT", "true")
        # Deterministic rung result: None, i.e. still a shell after the click.
        monkeypatch.setattr(browser_tier, "_deterministic_click_through", lambda url: None)
        monkeypatch.setattr(browser_tier, "_llm_navigate_and_fetch", lambda url: CLICKED_BOARD)

        html, used = fetch_with_browser_fallback("https://example.com/careers", SPA_SHELL)

        assert used is True
        assert html == CLICKED_BOARD


class TestDiscardUnlessBetter:
    def test_a_click_through_that_adds_no_postings_is_discarded(self, monkeypatch):
        no_gain = "<html><body>still empty</body></html>"
        monkeypatch.setattr(browser_tier, "_deterministic_click_through", lambda url: no_gain)
        monkeypatch.setattr(browser_tier, "_llm_navigate_and_fetch", lambda url: None)

        html, used = fetch_with_browser_fallback("https://example.com/careers", SPA_SHELL)

        assert used is False
        assert html == SPA_SHELL

    def test_a_failed_click_through_degrades_to_the_prior_best_html(self, monkeypatch):
        monkeypatch.setattr(browser_tier, "_deterministic_click_through", lambda url: None)
        monkeypatch.setenv("SCRAPER_BROWSER_USE_AGENT", "")

        html, used = fetch_with_browser_fallback("https://example.com/careers", SPA_SHELL)

        assert used is False
        assert html == SPA_SHELL

    def test_an_llm_result_that_adds_no_postings_is_also_discarded(self, monkeypatch):
        monkeypatch.setenv("SCRAPER_BROWSER_USE_AGENT", "true")
        no_gain = "<html><body>bot wall</body></html>"
        monkeypatch.setattr(browser_tier, "_deterministic_click_through", lambda url: None)
        monkeypatch.setattr(browser_tier, "_llm_navigate_and_fetch", lambda url: no_gain)

        html, used = fetch_with_browser_fallback("https://example.com/careers", SPA_SHELL)

        assert used is False
        assert html == SPA_SHELL


class TestBudgetBounds:
    def test_step_and_action_budgets_are_small_and_positive(self):
        # Not zero (the agent must get to do something), not open-ended (a
        # runaway agent must not burn an unbounded number of LLM calls on one
        # company in an hourly cron).
        assert 0 < _MAX_LLM_STEPS <= 20
        assert 0 < _MAX_ACTIONS_PER_STEP <= 10

    def test_history_budget_is_valid_for_browser_use_and_actually_binds(self):
        # browser-use asserts max_history_items must be None or > 5; anything
        # <= 5 would crash the agent outright. It must also be smaller than
        # the step budget, or it never truncates anything across one run.
        assert _MAX_HISTORY_ITEMS > 5
        assert _MAX_HISTORY_ITEMS < _MAX_LLM_STEPS

    def test_agent_is_constructed_with_the_history_budget(self):
        source = inspect.getsource(browser_tier._llm_navigate_and_fetch)
        assert "max_history_items=_MAX_HISTORY_ITEMS" in source


class TestNavigationGuard:
    def test_same_host_is_allowed(self):
        assert _same_site("https://example.com/careers", "https://example.com") is True

    def test_subdomain_of_the_origin_is_allowed(self):
        assert _same_site("https://boards.example.com/jobs", "https://example.com") is True

    def test_www_is_normalized_on_both_sides(self):
        assert _same_site("https://www.example.com/careers", "https://example.com") is True
        assert _same_site("https://example.com/careers", "https://www.example.com") is True

    def test_a_different_domain_is_rejected(self):
        assert _same_site("https://evil-example.com/careers", "https://example.com") is False
        assert _same_site("https://example.com.attacker.net", "https://example.com") is False

    def test_non_http_schemes_are_rejected(self):
        assert _same_site("javascript:alert(1)", "https://example.com") is False
        assert _same_site("file:///etc/passwd", "https://example.com") is False
        assert _same_site("ftp://example.com/careers", "https://example.com") is False

    def test_a_hostless_or_malformed_url_is_rejected(self):
        assert _same_site("/relative/path", "https://example.com") is False
        assert _same_site("https://", "https://example.com") is False

    def test_llm_navigate_and_fetch_checks_same_site_before_the_second_navigation(self):
        # The LLM-reported jobs_url must be validated before it is ever
        # handed to _deterministic_click_through's real page.goto() — proven
        # structurally since browser-use is not installed in this sandbox.
        source = inspect.getsource(browser_tier._llm_navigate_and_fetch)
        guard_at = source.index("_same_site(jobs_url, url)")
        second_nav_at = source.index("_deterministic_click_through(jobs_url)")
        assert guard_at < second_nav_at


class TestAgentActionSpace:
    def test_form_input_and_code_execution_actions_are_excluded(self):
        # Structural backstop for "no form interaction": these are browser-use's
        # own action names (verified against the real 0.13.8 wheel) for
        # anything that writes into a page or runs arbitrary code/files.
        for action in ("input", "upload_file", "send_keys", "select_dropdown", "evaluate"):
            assert action in _EXCLUDED_AGENT_ACTIONS

    def test_navigation_actions_are_not_excluded(self):
        # The task requires clicking through nav links to reach the board.
        for action in ("click", "navigate", "go_back", "scroll"):
            assert action not in _EXCLUDED_AGENT_ACTIONS

    def test_agent_is_constructed_with_the_restricted_action_set(self):
        source = inspect.getsource(browser_tier._llm_navigate_and_fetch)
        assert "tools=Tools(exclude_actions=list(_EXCLUDED_AGENT_ACTIONS))" in source


class TestNoCredentialsInThisTier:
    def test_agent_task_string_names_no_credential(self):
        # No legitimate scraping-navigation instruction ever needs to mention
        # a password or a username, so these must be absent outright — unlike
        # "log in"/"submit"/"apply" below, which are expected in the negative.
        task = _NAV_TASK_TEMPLATE.lower()
        for banned in ("password", "username"):
            assert banned not in task, f"nav task must not mention {banned!r}"

    def test_agent_task_string_explicitly_forbids_login_and_form_interaction(self):
        # "log in"/"submit"/"apply" are expected here, in the negative: the
        # task must tell the agent NOT to do any of them.
        task = _NAV_TASK_TEMPLATE.lower()
        assert "do not log in" in task
        assert "do not" in task and "submit" in task
        assert "application" in task

    def test_module_never_wires_browser_uses_credential_injection_parameter(self):
        # sensitive_data= is browser-use's own mechanism for handing an agent
        # a login/credential — this tier must never pass it to Agent(...).
        # (The docstring mentions the name in prose, hence the `=`: that is
        # what distinguishes "documents the boundary" from "crosses it".)
        source = inspect.getsource(browser_tier)
        assert "sensitive_data=" not in source

    def test_module_imports_no_credential_or_secrets_code(self):
        for module in vars(browser_tier).values():
            if not inspect.ismodule(module):
                continue
            assert "credential" not in module.__name__
            assert "secret" not in module.__name__
