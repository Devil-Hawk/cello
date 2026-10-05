"""Fetch one careers page the way a browser would show it, and print its HTML.

    python -m src.page <url>

This is all Python does for job ingestion now. Reading the page (structured
data, the model, verification) is TypeScript, so the scheduled check and the
in-app button read a page identically; the one thing only this side can do is
get HTML from a page that builds its list with script.

The ladder is the existing one, cheapest first: a plain request, then a
Scrapling browser render when the result looks like an empty shell, then a
Playwright click-through to a "see open roles" page. Each later rung is used
only when it surfaces more job links than the one before it.

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

import httpx

from .browser_tier import fetch_with_browser_fallback
from .render import fetch_with_render_fallback

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
_MAX_BYTES = 5_000_000


def _static_get(url: str) -> tuple[str, str]:
    """A plain request: (html, final_url). Raises on a transport or HTTP error."""
    with httpx.Client(
        timeout=20.0, follow_redirects=True, headers={"User-Agent": _USER_AGENT}
    ) as client:
        response = client.get(url)
        response.raise_for_status()
        return response.text[:_MAX_BYTES], str(response.url)


def fetch_page(url: str) -> dict[str, object]:
    """Fetch `url`; always returns the output dict, never raises."""
    static_html: str | None = None
    final_url = url
    first_error: Exception | None = None
    try:
        static_html, final_url = _static_get(url)
    except Exception as exc:  # noqa: BLE001 - reported by class name only
        first_error = exc

    try:
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
    # Scrapling logs the address it fetched on its own handler; this output is
    # public. disable() survives any handler setup.
    logging.disable(logging.CRITICAL)
    if len(argv) != 2 or not argv[1].startswith(("http://", "https://")):
        print(json.dumps({"ok": False, "error": "BadArguments"}))
        return 0
    # Libraries that print would corrupt the one JSON line, so they print to stderr.
    with contextlib.redirect_stdout(sys.stderr):
        result = fetch_page(argv[1])
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
