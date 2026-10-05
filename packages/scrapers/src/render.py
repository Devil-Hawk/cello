"""Browser-rendered fetching, for career pages that plain HTTP cannot read.

WHY THIS EXISTS
    The scrapers in this package fetch with httpx and parse with BeautifulSoup.
    That works only for career pages that ship their jobs in the initial HTML.
    A large share of modern career pages are single-page apps: httpx receives a
    near-empty shell plus a bundle reference, the parser finds no postings, and
    the company is silently recorded as having nothing open.

    The cost of that is measurable. Of one user's 436 watched companies, 303
    (69.5%) have no detectable Greenhouse/Lever/Ashby board, so this generic
    scraper is their ONLY route into the product — and across a 1000-row sample
    of stored jobs, exactly 3 carried source="scraper". The generic path is
    effectively not producing.

    Playwright closes that gap: it drives Chromium, so a rendered SPA yields the
    page the site builds in a browser, and the existing parsers work on it
    unchanged. It identifies itself as Cello (polite.USER_AGENT) and does
    nothing to look like a person.

WHY ESCALATION RATHER THAN REPLACEMENT
    A headless browser costs roughly two orders of magnitude more time and
    memory than an HTTP GET. Rendering every company to serve the fraction that
    needs it would make the hourly cron far slower and more fragile. So httpx
    stays the first attempt, and this module is consulted only when the cheap
    path came back with nothing job-shaped.

SCOPE
    Public career pages only. This module must never be pointed at login-walled
    or paid vendors, the same rule the TypeScript side states in
    apps/web/lib/dossier/comp.ts. robots.txt is checked by page.py before this
    is called.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

logger = logging.getLogger(__name__)


# Anchors that look like they lead to an individual posting. Deliberately broad:
# a false "this page has jobs" is cheap (we skip rendering a page that was fine),
# while a false "this page is empty" costs a needless browser launch.
_JOB_HREF_RE = re.compile(
    r"/(jobs?|careers?|positions?|openings?|opportunit(?:y|ies)|vacanc(?:y|ies)|"
    r"job-detail|job_posting|requisition|apply)(/|\?|#|$)",
    re.IGNORECASE,
)

# Markers of an app shell that renders its content client-side.
_SPA_MARKER_RE = re.compile(
    r'<div[^>]+id=["\'](root|app|__next|__nuxt|ember-app)["\']|'
    r"window\.__(INITIAL_STATE|NUXT|APOLLO_STATE)__|"
    r"<app-root|ng-version=",
    re.IGNORECASE,
)

# Below this much visible text, a career page is almost certainly a shell.
_MIN_TEXT_CHARS = 600
# At or above this many job-shaped links, the static HTML already has the goods.
_ENOUGH_JOB_LINKS = 3


@dataclass(frozen=True)
class ShellVerdict:
    """Why we did or did not decide the static HTML was an unrendered shell."""

    is_shell: bool
    reason: str
    job_links: int
    text_chars: int


def _visible_text_length(html: str) -> int:
    """Rough count of human-visible characters, without paying for a full parse."""
    stripped = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", html)
    stripped = re.sub(r"(?s)<[^>]+>", " ", stripped)
    return len(re.sub(r"\s+", " ", stripped).strip())


def count_job_links(html: str) -> int:
    """How many anchors in this HTML look like links to a specific posting."""
    hrefs = re.findall(r'href=["\']([^"\']+)["\']', html, re.IGNORECASE)
    return sum(1 for h in hrefs if _JOB_HREF_RE.search(h))


def looks_like_unrendered_shell(html: str | None) -> ShellVerdict:
    """Decide whether `html` is an app shell whose jobs never arrived.

    THE JUDGEMENT CALL THIS ENCODES
        Escalating too eagerly wastes a browser launch per company per hour.
        Escalating too rarely leaves the company invisible, which is the bug
        this module exists to fix. The rule below is deliberately biased toward
        rendering, because a wasted render costs seconds while a missed company
        costs the user a job they never saw.

        The ordering matters: plenty of job links is treated as conclusive even
        on a short page, because some boards are a terse list of links and
        nothing else.
    """
    if not html or not html.strip():
        return ShellVerdict(True, "empty response body", 0, 0)

    links = count_job_links(html)
    text = _visible_text_length(html)

    if links >= _ENOUGH_JOB_LINKS:
        return ShellVerdict(False, f"{links} job-shaped links already present", links, text)

    if _SPA_MARKER_RE.search(html):
        return ShellVerdict(True, "client-rendered app shell detected", links, text)

    if text < _MIN_TEXT_CHARS:
        return ShellVerdict(True, f"only {text} chars of visible text", links, text)

    if links == 0:
        return ShellVerdict(True, "no job-shaped links in static HTML", links, text)

    return ShellVerdict(False, f"{links} job-shaped links, {text} chars of text", links, text)


def playwright_available() -> bool:
    """True when Playwright is importable in this environment.

    Checked at call time, never at import time: this package must keep working
    on the httpx-only path anywhere a browser is not provisioned (CI, a plain
    `pip install -e .`, a developer machine without browsers).
    """
    try:
        import playwright.sync_api  # noqa: F401
    except Exception:  # ImportError, or a broken/partial install
        return False
    return True


# Why the last fetch_rendered returned None: an exception class name, never a url
# or page text. page.py reports it so a browser that could not run is never read
# as a site with no roles.
last_error: str | None = None


def fetch_rendered(url: str, timeout_ms: int = 30_000) -> str | None:
    """Fetch `url` through a browser and return its rendered HTML.

    The browser says who it is: the same Cello user agent as every other
    request, with no fingerprint tricks and no stealth options. A site that
    answers it with a bot check is not read.

    Returns None, never raises, when Playwright is unavailable or the render
    fails. A rendering failure must degrade to "this company yielded nothing
    this run", exactly as a fetch failure already does.
    """
    global last_error
    last_error = None
    if not playwright_available():
        logger.info("playwright not installed; skipping rendered fetch")
        last_error = "PlaywrightMissing"
        return None

    try:
        from playwright.sync_api import sync_playwright

        from .polite import USER_AGENT

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                page = browser.new_context(user_agent=USER_AGENT).new_page()
                # Career pages commonly fill the list after their first XHR
                # settles, so waiting for network idle rather than DOMContentLoaded
                # is what distinguishes a rendered board from the shell we started with.
                page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")
                try:
                    page.wait_for_load_state("networkidle", timeout=15_000)
                except Exception:  # noqa: BLE001 - a page that never goes quiet is still read as it stands
                    pass
                # Lists below the fold are often loaded as the page scrolls, as they are for a visitor.
                for _ in range(5):
                    page.mouse.wheel(0, 3000)
                    page.wait_for_timeout(800)
                content = page.content() or None
                if content is None:
                    last_error = "EmptyPage"
                return content
            finally:
                browser.close()
    except Exception as exc:  # noqa: BLE001 - any failure degrades to "no result"
        logger.warning("rendered fetch failed: %s", type(exc).__name__)
        last_error = type(exc).__name__
        return None


def fetch_with_render_fallback(url: str, static_html: str | None) -> tuple[str, bool]:
    """Return the best HTML available for `url`, and whether a browser produced it.

    Call with whatever the cheap httpx path returned. If that looks like an
    unrendered shell, this escalates to a browser and returns the rendered HTML
    when it is genuinely better — measured by job-shaped link count, so a render
    that produced no more postings is discarded rather than trusted blindly.
    """
    verdict = looks_like_unrendered_shell(static_html)
    if not verdict.is_shell:
        return static_html or "", False

    logger.info("escalating %s to a rendered fetch: %s", url, verdict.reason)
    rendered = fetch_rendered(url)
    if not rendered:
        return static_html or "", False

    # Only prefer the rendered HTML if it actually surfaced more postings.
    # Some sites render into an identical shell, and some serve a bot wall to a
    # headless browser that they do not serve to httpx.
    if count_job_links(rendered) > verdict.job_links:
        return rendered, True

    logger.info("rendered fetch of %s added no job links; keeping static HTML", url)
    return static_html or "", False
