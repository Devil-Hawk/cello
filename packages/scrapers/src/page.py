"""Fetch one careers page as a browser builds it, and print its HTML.

    python -m src.page <url> [--render]

This is all Python does for job ingestion. Reading the page (structured data, the
board links, the proof rules) is TypeScript, so every read treats a page the same
way; the one thing only this side can do is get HTML from a page that builds its
list with script or sits behind a bot check.

The page's robots.txt is read first and obeyed. The ladder is cheapest first, and
each later rung runs only with --render and only when the page so far holds no job
links:

    http      Scrapling's Fetcher, impersonating Chrome with Scrapling's browser headers
    rendered  Scrapling's browser (StealthyFetcher) without the Cloudflare solver
    stealth   the same browser with Cloudflare solving, 60 s (owner directive 55)
    click     the click-through to a "see open roles" page (browser_tier.py)

Scrapling 0.5 has no DynamicFetcher, so the "rendered" rung is its StealthyFetcher
with the solver off. A sign-in wall, a CAPTCHA that is not Cloudflare's, or a
Cloudflare wall the solver could not pass is not read and not bypassed. The fetcher
never signs in or submits anything.

Output is exactly one JSON line on stdout:

    {"ok": true, "html": "...", "final_url": "...", "rendered": false, "rung": "http"}
    {"ok": false, "error": "<ExceptionClass>", "rung": "stealth"}

"rung" is the one that produced the page, or the one that ended the read. When
--render was asked for and no browser rung produced a page (not installed, crashed,
timed out), the line carries "render_error": "<Class>" and the plain page, so the
caller can say the browser failed instead of reading the plain page again and
finding no roles.

A failure carries only the exception's class name. The repo is public and so are
its Actions logs, and an exception message can hold the page's address.
"""

from __future__ import annotations

import contextlib
import json
import logging
import sys
from urllib.parse import urljoin

from . import render
from .browser_tier import fetch_with_browser_fallback
from .polite import is_public as _is_public
from .polite import robots_allowed as _allowed
from .render import body_text, count_job_links, fetch_rendered, looks_like_unrendered_shell

_MAX_HOPS = 4


class UnsafeRedirect(Exception):  # noqa: N818 - named for what happened, tests and the runner import it
    """A redirect hop that is not a public http(s) address, or that robots.txt closes."""


class HttpStatus(Exception):  # noqa: N818 - the class name is what the caller is told
    """The server answered with an error status."""


class RenderFailed(Exception):  # noqa: N818 - carries the browser's own exception class as `label`
    def __init__(self, label: str):
        super().__init__("render failed")
        self.label = label


class Wall(Exception):  # noqa: N818 - subclasses are the class names the caller is told
    """The page is a wall, not a careers page. `passable` walls are worth a browser."""

    passable = False


class CloudflareWall(Wall):
    passable = True


class SignInWall(Wall):
    pass


class CaptchaWall(Wall):
    pass


def _wall(html: str) -> type[Wall] | None:
    """Which wall this page is, or None. A wall is a small page with no job links."""
    from scrapling.parser import Selector

    verdict = looks_like_unrendered_shell(html)
    if verdict.job_links or verdict.text_chars >= 600:
        return None
    page = Selector(html)
    title = (page.css("title::text").get() or "").lower()
    if "just a moment" in title or page.css("#challenge-form, .cf-turnstile, #cf-challenge-running"):
        return CloudflareWall
    if page.css(
        'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, .h-captcha, '
        '#px-captcha, [src*="captcha-delivery.com"]'
    ):
        return CaptchaWall
    if page.css("input[type=password]"):
        return SignInWall
    return None


def _static_get(url: str) -> tuple[str, str]:
    """Rung "http": (html, final_url). Raises on a transport error, an error status or a wall.

    Scrapling's Fetcher sends Chrome's TLS fingerprint and Scrapling's browser headers.
    Redirects are followed by hand, at most _MAX_HOPS, and every hop is held to the
    same rules as the first address: a public http(s) host, and a robots.txt that
    allows the path.
    """
    from scrapling.fetchers import Fetcher

    current = url
    for _ in range(_MAX_HOPS + 1):
        response = Fetcher.get(
            current, impersonate="chrome", follow_redirects=False, timeout=20, retries=1
        )
        location = {k.lower(): v for k, v in response.headers.items()}.get("location")
        if 300 <= response.status < 400 and location:
            current = urljoin(current, location)
            if not _is_public(current) or not _allowed(current):
                raise UnsafeRedirect("redirect refused")
            continue
        html = body_text(response)
        wall = _wall(html)
        if wall:
            raise wall("wall")
        if response.status >= 400:
            raise HttpStatus(str(response.status))
        return html, str(response.url)
    raise UnsafeRedirect("too many redirects")


def _browser(url: str, solve_cloudflare: bool) -> tuple[str, str]:
    """Rungs "rendered" and "stealth": (html, final_url), or raises the wall or the class."""
    got = fetch_rendered(
        url, solve_cloudflare=solve_cloudflare, timeout_ms=60_000 if solve_cloudflare else 30_000
    )
    if got is None:
        raise RenderFailed(render.last_error or "RenderFailed")
    wall = _wall(got[0])
    if wall:
        raise wall("wall")
    return got


def _name(error: Exception) -> str:
    return error.label if isinstance(error, RenderFailed) else type(error).__name__


def _fail(error: Exception, rung: str) -> dict[str, object]:
    return {"ok": False, "error": _name(error), "rung": rung}


class NoClickThrough(Exception):  # noqa: N818 - internal: the click rung found nothing better
    pass


def fetch_page(url: str, force_render: bool = False) -> dict[str, object]:
    """Fetch `url`; always returns the output dict, never raises.

    `force_render` climbs the ladder: each later rung runs only when the page so far
    holds no job links (a page can have plenty of text and still build its list in
    the browser). A rung's page replaces the best one only when it holds more.
    """
    if not _is_public(url):
        return {"ok": False, "error": "UnsafeUrl"}
    if not _allowed(url):
        return {"ok": False, "error": "RobotsDisallowed"}
    best: tuple[str, str, str] | None = None  # html, final_url, rung
    best_links = -1
    target = url  # where the later rungs go: the address the plain fetch ended on
    error: Exception | None = None
    failed_rung = "http"
    browser_error: str | None = None
    browser_page = False

    def click() -> tuple[str, str]:
        html, used = fetch_with_browser_fallback(target, best[0] if best else "")
        if not used:
            raise NoClickThrough
        return html, target

    ladder = [
        ("http", lambda: _static_get(url)),
        ("rendered", lambda: _browser(target, False)),
        ("stealth", lambda: _browser(target, True)),
        ("click", click),
    ]
    for rung, step in ladder if force_render else ladder[:1]:
        if best and not looks_like_unrendered_shell(best[0]).is_shell:
            break
        try:
            html, final = step()
        except NoClickThrough:
            continue
        except UnsafeRedirect as exc:
            # A hop the plain fetch refused is never handed to the browser.
            return _fail(exc, rung)
        except Exception as exc:  # noqa: BLE001 - reported by class name only
            error, failed_rung = exc, rung
            if rung in ("rendered", "stealth"):
                browser_error = _name(exc)
            if isinstance(exc, Wall) and not exc.passable and best_links < 1:
                return _fail(exc, rung)
            continue
        if rung == "http":
            target = final
        elif rung != "click":
            browser_page = True
        links = count_job_links(html)
        if links > best_links:
            best, best_links = (html, final, rung), links
    if best is None or not best[0].strip():
        return _fail(error or RuntimeError("EmptyPage"), failed_rung)
    html, final, found = best
    out: dict[str, object] = {
        "ok": True,
        "html": html,
        "final_url": final,
        "rendered": found != "http",
        "rung": found,
    }
    if browser_error and not browser_page and found == "http":
        out["render_error"] = browser_error
    return out


def main(argv: list[str]) -> int:
    # Libraries log the address they fetched on their own handlers; this output is
    # public. disable() survives any handler setup.
    logging.disable(logging.CRITICAL)
    force_render = "--render" in argv[2:]
    bad_shape = len(argv) not in (2, 3) or (len(argv) == 3 and not force_render)
    if bad_shape or not argv[1].startswith(("http://", "https://")):
        print(json.dumps({"ok": False, "error": "BadArguments"}))
        return 0
    # Libraries that print would corrupt the one JSON line, so they print to stderr.
    with contextlib.redirect_stdout(sys.stderr):
        result = fetch_page(argv[1], force_render)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
