"""A real browser, for the career pages a rendered fetch still cannot reach.

WHY THIS EXISTS
    render.py escalates a plain-HTTP shell to Scrapling's single rendered fetch
    of the SAME url. That closes most of the gap (see render.py's docstring for
    the 69.5%-of-watchlist numbers), but it still misses boards that sit behind
    a click: a homepage whose "Careers" link leads to the real listings, or a
    listings page that only populates after a "View all openings" button is
    pressed. Neither is visible to a single `page.goto()`.

THE LADDER, AND WHY IT IS DETERMINISTIC-FIRST
    Per the owner's mandate — "crawlers should not need AI, deterministic stuff
    should not be AI-based" — this tier tries a plain, unassisted browser click
    BEFORE it ever asks an LLM to do anything:

        1. Load the url in a real (Playwright) browser. If that already looks
           rendered, we are done — this step alone recovers most "the SPA just
           needed a browser and a beat to hydrate" cases render.py's single
           fetch already handles, so it usually returns the same shell.
        2. If it is still a shell, look for one in-page link whose text reads
           like "Careers"/"Jobs"/"Join us" and click it once. No AI: a fixed
           regex over anchor text, the same style of heuristic render.py's
           consumers already use for postings (see _JOB_HREF_RE there).
        3. Only if THAT is still a shell, and the env flag below opts in, does
           a browser-use LLM agent get a turn — and its job is NAVIGATION
           ONLY: find the listings page and report its URL. It never reads
           job data back to us. Whatever URL it lands on is re-fetched and
           handed to the exact same deterministic extractors as every other
           tier (count_job_links / FallbackExtractor) — the LLM finds the
           page, the parser reads it.

SCOPE — SCRAPING ONLY
    No login, no form fill, no submit: the agent task string below asks for
    navigation and nothing else, and this module never passes browser-use's
    `sensitive_data` (its credential-injection parameter) to `Agent(...)`.
    That prose instruction is backstopped by two technical boundaries, since
    the agent forms its plan from an untrusted third-party page's content
    (indirect prompt injection is a live threat here, not a theoretical one):
    the agent's own action set excludes every form-input/keystroke/upload/
    eval/file-write action (_EXCLUDED_AGENT_ACTIONS), and the URL it reports
    is only ever navigated to when _same_site() confirms it did not leave the
    company's own site. test_browser_tier.py asserts all of this structurally.
    Same public-career-pages-only boundary as render.py.

WHY ESCALATION RATHER THAN A THIRD ALWAYS-ON FETCH
    A full browser-use run costs an LLM call plus several more browser actions
    on top of an already-expensive headless render. It is worth that cost only
    for the sliver of companies still invisible after step 2, so it is gated
    behind SCRAPER_BROWSER_USE_AGENT and gets called only when Tier 2's result
    still verdicts as a shell.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any
from urllib.parse import urlparse

from pydantic import BaseModel

from .render import count_job_links, looks_like_unrendered_shell

logger = logging.getLogger(__name__)

# ponytail: fixed ceilings rather than a config surface nobody asked for yet.
# Raise these here, in one place, if a real run proves them too tight.
_PAGE_LOAD_TIMEOUT_MS = 30_000
_MAX_LLM_STEPS = 8  # browser-use Agent.run_sync(max_steps=...) — the step budget
_MAX_ACTIONS_PER_STEP = 3  # bounds actions-per-step alongside max_steps
# Bounds the agent-history text that gets re-fed into the prompt every step —
# the actual source of unbounded context/token growth across a multi-step
# run. browser-use 0.13.8 has no token/cost cap (only post-hoc usage
# reporting via Agent.token_cost_service), so this is the closest real lever.
# browser-use asserts max_history_items must be None or > 5; 6 is the
# tightest ceiling the library allows, and it is < _MAX_LLM_STEPS so it
# actually binds instead of being a no-op.
_MAX_HISTORY_ITEMS = 6
_LLM_NAV_MODEL = "google/gemini-2.0-flash-001"  # intelligent.py's OpenRouterProvider default

# Actions the agent must never be able to invoke: anything that writes data
# into a page (form fields, keystrokes, dropdown selection, file upload) or
# runs arbitrary code/writes files. This is the technical backstop for the
# "no login, no form interaction" rule _NAV_TASK_TEMPLATE states in prose —
# prompt text alone is not a boundary against a page whose own content the
# agent is reading (indirect prompt injection). navigate/click/scroll/go_back
# stay available: the task requires clicking through nav links such as
# "Careers" to reach the listings page.
_EXCLUDED_AGENT_ACTIONS = (
    "input",
    "upload_file",
    "send_keys",
    "select_dropdown",
    "evaluate",
    "write_file",
    "replace_file",
)

# Nav-link text that plausibly leads from a homepage/shell to the real job
# board. Deliberately narrower than render.py's _JOB_HREF_RE, which matches a
# link to an individual POSTING — this one matches the link to the board
# itself.
_CAREERS_NAV_RE = re.compile(
    r"careers?|jobs?|join.?us|open.?(positions|roles)|current.?openings", re.IGNORECASE
)

# The browser-use agent's ONLY task: find the listings page and say where it
# is. No credential, no login, no form field, no submit — see module
# docstring and test_browser_tier.py's structural assertion on this string.
_NAV_TASK_TEMPLATE = (
    "Open {url} and find the page that lists this company's current open job "
    "postings (a careers or jobs board). If the roles are not already listed, "
    "click through navigation links such as 'Careers' or 'Jobs', or a 'View "
    "all openings' button. Do not log in, do not fill in or submit any form, "
    "and do not open an individual job application. Stop as soon as the job "
    "listings are visible and report the URL of that page."
)


class JobsPageResult(BaseModel):
    """The agent's entire output: a URL, never job content."""

    jobs_url: str


def browser_use_available() -> bool:
    """True when the browser-use package is importable in this environment.

    Checked at call time, never at import time — like render.py's
    scrapling_available(), this tier must keep degrading cleanly wherever the
    `[browser]` extra is not provisioned (CI without it, a bare dev install).
    """
    try:
        import browser_use  # noqa: F401
    except Exception:  # ImportError, or a broken/partial install
        return False
    return True


def _playwright_available() -> bool:
    """True when Playwright is importable — the deterministic rung's need."""
    try:
        import playwright.sync_api  # noqa: F401
    except Exception:
        return False
    return True


def _llm_agent_enabled() -> bool:
    """The LLM rung is env-gated on top of being importable — it is a real
    per-run LLM spend, so it stays opt-in even where the extra is installed.
    """
    return os.environ.get("SCRAPER_BROWSER_USE_AGENT", "").strip().lower() in ("1", "true", "yes")


def _same_site(candidate: str, origin: str) -> bool:
    """True when `candidate` is http(s) and on the same site as `origin`
    (same host, or a subdomain of it).

    This is the guard between an LLM-composed navigation target and a real
    page.goto(): jobs_url in _llm_navigate_and_fetch is text the agent wrote
    after reading an untrusted third-party page, not a URL this system chose.
    Without this check a compromised or adversarial career page could steer
    the agent's reported jobs_url anywhere (an internal address, a
    credential-phishing page, a non-http scheme) and this tier would
    navigate a real browser there.

    # ponytail: same-host-or-subdomain by string suffix, not a public-suffix
    # -list match or an IP-literal/link-local blocklist. `origin` is always
    # this system's own DB-sourced company URL, never attacker input, so the
    # only thing that has to be true is "candidate did not leave that site" —
    # a suffix check is enough for that. Add PSL-aware comparison or an
    # IP-literal/link-local check if this tier ever has to trust a `origin`
    # it did not already pick itself.
    """
    try:
        cand = urlparse(candidate)
        base = urlparse(origin)
    except ValueError:
        return False
    if cand.scheme not in ("http", "https") or not cand.hostname:
        return False
    base_host = (base.hostname or "").lower().removeprefix("www.")
    if not base_host:
        return False
    cand_host = cand.hostname.lower().removeprefix("www.")
    return cand_host == base_host or cand_host.endswith("." + base_host)


def _click_careers_link(page: Any) -> str | None:
    """Click the first nav-shaped link on `page` and return the HTML it lands
    on, or None if no such link exists or the click failed. `page` is a
    Playwright sync Page; typed as Any so this module stays importable (and
    typecheckable) without Playwright installed.
    """
    # ponytail: bounded scan, not every anchor on a huge page
    for link in page.locator("a").all()[:200]:
        try:
            text = link.inner_text(timeout=1_000).strip()
        except Exception:
            continue
        if text and _CAREERS_NAV_RE.search(text):
            try:
                link.click(timeout=5_000)
                page.wait_for_load_state("networkidle", timeout=_PAGE_LOAD_TIMEOUT_MS)
                return page.content()
            except Exception:
                continue
    return None


def _deterministic_click_through(url: str) -> str | None:
    """Load `url` in a real browser and, if it still looks like a shell,
    click through to whatever looks like the jobs/careers nav link. No AI.

    Returns HTML, or None on any failure or when Playwright is unavailable.
    Never raises — a Tier 3 failure must degrade exactly like every other
    tier in this escalation chain, not abort the run.
    """
    if not _playwright_available():
        logger.info("playwright not installed; skipping browser-tier fetch of %s", url)
        return None
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                page.goto(url, timeout=_PAGE_LOAD_TIMEOUT_MS, wait_until="networkidle")
                html = page.content()
                if not looks_like_unrendered_shell(html).is_shell:
                    return html
                return _click_careers_link(page) or html
            finally:
                browser.close()
    except Exception as exc:  # noqa: BLE001 — any failure degrades to "no result"
        logger.warning("deterministic browser fetch failed for %s: %s", url, exc)
        return None


def _llm_navigate_and_fetch(url: str) -> str | None:
    """Last rung: an LLM agent navigates to find the listings page; this
    function then re-fetches whatever URL it reports deterministically, so
    the agent's output is a URL only — never job data.

    Returns None on any failure, when browser-use is unavailable, or when no
    OPENROUTER_API_KEY is configured. Never raises.
    """
    if not browser_use_available():
        logger.info("browser-use not installed; skipping LLM navigation for %s", url)
        return None
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        logger.info("SCRAPER_BROWSER_USE_AGENT set but OPENROUTER_API_KEY missing; skip %s", url)
        return None

    try:
        from browser_use import Agent, Tools
        from browser_use.llm import ChatOpenRouter

        agent = Agent(
            task=_NAV_TASK_TEMPLATE.format(url=url),
            llm=ChatOpenRouter(model=_LLM_NAV_MODEL, api_key=api_key),
            tools=Tools(exclude_actions=list(_EXCLUDED_AGENT_ACTIONS)),
            output_model_schema=JobsPageResult,
            use_vision=False,
            max_actions_per_step=_MAX_ACTIONS_PER_STEP,
            max_history_items=_MAX_HISTORY_ITEMS,
        )
        history = agent.run_sync(max_steps=_MAX_LLM_STEPS)
    except Exception as exc:  # noqa: BLE001 — any failure degrades to "no result"
        logger.warning("browser-use navigation failed for %s: %s", url, exc)
        return None

    usage = getattr(history, "usage", None)
    if usage is not None:
        logger.info("browser-use navigation for %s used %s", url, usage)

    jobs_url = None
    structured = getattr(history, "structured_output", None)
    if structured is not None:
        jobs_url = getattr(structured, "jobs_url", None)
    if not jobs_url:
        visited = [u for u in history.urls() if u]
        jobs_url = visited[-1] if visited else None
    if not jobs_url:
        return None
    if not _same_site(jobs_url, url):
        logger.warning(
            "LLM-reported jobs_url %s is off-site from %s; refusing to navigate", jobs_url, url
        )
        return None

    # The agent's job was navigation. The page it found is fetched and parsed
    # the exact same deterministic way as every other tier.
    return _deterministic_click_through(jobs_url)


def fetch_with_browser_fallback(url: str, best_html: str | None) -> tuple[str, bool]:
    """Return the best HTML available for `url`, escalating to a real browser
    when `best_html` — whatever fetch_with_render_fallback already produced —
    still looks like an unrendered shell.

    Call this ONLY after the render tier; it is the last, most expensive rung
    of the ladder (plain HTTP -> Scrapling render -> this). Same
    discard-unless-better contract as render.py: a browser result is only
    kept when it actually surfaced more job-shaped links than what came in.
    """
    verdict = looks_like_unrendered_shell(best_html)
    if not verdict.is_shell:
        return best_html or "", False

    best_html = best_html or ""
    best_links = verdict.job_links
    used_browser = False

    logger.info("escalating %s to the browser tier: %s", url, verdict.reason)
    clicked = _deterministic_click_through(url)
    if clicked is not None:
        clicked_links = count_job_links(clicked)
        if clicked_links > best_links:
            best_html, best_links, used_browser = clicked, clicked_links, True

    if looks_like_unrendered_shell(best_html).is_shell and _llm_agent_enabled():
        logger.info("browser navigation still looks like a shell; trying the LLM agent for %s", url)
        navigated = _llm_navigate_and_fetch(url)
        if navigated is not None:
            navigated_links = count_job_links(navigated)
            if navigated_links > best_links:
                best_html, best_links, used_browser = navigated, navigated_links, True

    if not used_browser:
        logger.info("browser tier of %s added no job links; keeping the prior best HTML", url)
    return best_html, used_browser
