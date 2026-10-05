"""Fetch one careers page as a browser builds it, and print its HTML.

    python -m src.page <url> [--render]

This is all Python does for job ingestion now. Reading the page (structured
data, the model, verification) is TypeScript, so the scheduled check and the
in-app button read a page identically; the one thing only this side can do is
get HTML from a page that builds its list with script.

Everything here is plain and honest. The page's robots.txt is read first and
obeyed. Requests and the browser both send the Cello user agent (polite.py),
which names the product and its repository; nothing pretends to be a person.
The ladder is cheapest first: a plain request, then a browser render when the
result looks like an empty shell, then a click-through to a "see open roles"
page. Each later rung is used only when it surfaces more job links than the one
before it. A site that answers with a bot check, a login or a CAPTCHA is not
read.

Output is exactly one JSON line on stdout:

    {"ok": true, "html": "...", "final_url": "...", "rendered": false}
    {"ok": false, "error": "<ExceptionClass>"}

A failure carries only the exception's class name. The repo is public and so are
its Actions logs, and an exception message can hold the page's address.
"""

from __future__ import annotations

import contextlib
import json
import logging
import sys

from urllib.parse import urlsplit

import httpx

from .browser_tier import fetch_with_browser_fallback
from .polite import USER_AGENT, RobotsCache
from .render import fetch_rendered, fetch_with_render_fallback

_USER_AGENT = USER_AGENT
_MAX_BYTES = 5_000_000


def _static_get(url: str) -> tuple[str, str]:
    """A plain request: (html, final_url). Raises on a transport or HTTP error."""
    with httpx.Client(
        timeout=20.0, follow_redirects=True, headers={"User-Agent": _USER_AGENT}
    ) as client:
        response = client.get(url)
        response.raise_for_status()
        return response.text[:_MAX_BYTES], str(response.url)


def _allowed(url: str, robots: RobotsCache | None = None) -> bool:
    """Does the site's robots.txt let Cello read `url`?"""
    parts = urlsplit(url)
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    return (robots or RobotsCache()).for_url(url).allows(path)


def fetch_page(url: str, force_render: bool = False) -> dict[str, object]:
    """Fetch `url`; always returns the output dict, never raises.

    `force_render` is for a page the plain tiers already read without finding a
    role: the browser view is used whenever it differs, whatever the shell
    heuristic says (a page can have plenty of text and still build its list in
    the browser).
    """
    if not _allowed(url):
        return {"ok": False, "error": "RobotsDisallowed"}
    static_html: str | None = None
    final_url = url
    first_error: Exception | None = None
    try:
        static_html, final_url = _static_get(url)
    except Exception as exc:  # noqa: BLE001 - reported by class name only
        first_error = exc

    try:
        if force_render:
            browser_html = fetch_rendered(final_url)
            html = browser_html or static_html or ""
            rendered = bool(browser_html) and browser_html != static_html
        else:
            html, rendered = fetch_with_render_fallback(final_url, static_html)
        html, clicked = fetch_with_browser_fallback(final_url, html)
    except Exception as exc:  # noqa: BLE001
        html, rendered, clicked = static_html or "", False, False
        first_error = first_error or exc

    if not html:
        error = first_error or RuntimeError("empty")
        return {"ok": False, "error": type(error).__name__}
    return {"ok": True, "html": html, "final_url": final_url, "rendered": rendered or clicked}


def main(argv: list[str]) -> int:
    # Libraries log the address they fetched on their own handlers; this output is
    # public. disable() survives any handler setup.
    logging.disable(logging.CRITICAL)
    force_render = "--render" in argv[2:]
    if len(argv) not in (2, 3) or not argv[1].startswith(("http://", "https://")) or (len(argv) == 3 and not force_render):
        print(json.dumps({"ok": False, "error": "BadArguments"}))
        return 0
    # Libraries that print would corrupt the one JSON line, so they print to stderr.
    with contextlib.redirect_stdout(sys.stderr):
        result = fetch_page(argv[1], force_render)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
