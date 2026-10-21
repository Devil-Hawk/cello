"""Browser-rendered fetching, for career pages that plain HTTP cannot read.

A large share of modern career pages are single-page apps: a plain request gets a
near-empty shell and a bundle reference, the parsers find no postings, and the
employer is recorded as having nothing open. fetch_rendered loads the page in
Scrapling's browser (StealthyFetcher) so the list the page builds is what the
caller reads. page.py decides when to call it, rung by rung (see its docstring);
this module holds the two things every rung shares: what a job link looks like,
and the browser call itself.

Public career pages only. robots.txt is checked by page.py before any rung, and
polite.guard_browser holds every request the browser makes to the same rules.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


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
    from scrapling.parser import Selector

    return sum(1 for h in Selector(html).css("a::attr(href)").getall() if _JOB_HREF_RE.search(h))


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


# Why the last fetch_rendered returned None: an exception class name, never a url
# or page text. page.py reports it so a browser that could not run is never read
# as a site with no roles.
last_error: str | None = None


def _scroll(page: Any) -> None:
    """Lists below the fold often load as the page scrolls, as for a visitor."""
    for _ in range(5):
        page.mouse.wheel(0, 3000)
        page.wait_for_timeout(800)


def body_text(response: Any, limit: int = 5_000_000) -> str:
    """The page text of a Scrapling response, as received (not re-serialised), capped."""
    return bytes(response.body).decode(response.encoding or "utf-8", "replace")[:limit]


def fetch_rendered(
    url: str, *, solve_cloudflare: bool = False, timeout_ms: int = 30_000
) -> tuple[str, str] | None:
    """Load `url` in Scrapling's browser; return (html, final_url).

    `solve_cloudflare` is the stealth rung: the Cloudflare interstitial or Turnstile
    is solved before the page is read (directive 55). Nothing here signs in or
    submits a form. Returns None, never raises, when the browser is missing or the
    load fails; `last_error` then holds the exception class.
    """
    global last_error
    last_error = None
    try:
        from scrapling.fetchers import StealthyFetcher

        from .polite import guard_browser

        response = StealthyFetcher.fetch(
            url,
            timeout=timeout_ms,
            network_idle=True,
            solve_cloudflare=solve_cloudflare,
            retries=1,  # the ladder escalates; a rung does not retry for minutes
            page_setup=guard_browser,
            page_action=_scroll,
        )
        html = body_text(response)
    except Exception as exc:  # noqa: BLE001 - any failure degrades to "no result"
        last_error = type(exc).__name__
        return None
    if not html:
        last_error = "EmptyPage"
        return None
    return html, str(response.url)
