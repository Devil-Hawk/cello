"""The page fetcher the TypeScript ingestion shells out to."""

from __future__ import annotations

import json
import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src import page  # noqa: E402

from src import polite  # noqa: E402

_real_allowed = page._allowed
_real_is_public = page._is_public

LISTING = (
    "<html><body>"
    + "".join(f'<a href="/jobs/{i}">Role {i}</a>' for i in range(5))
    + "<p>"
    + "We hire people who care. " * 40
    + "</p></body></html>"
)


@pytest.fixture(autouse=True)
def _robots_allow(monkeypatch):
    monkeypatch.setattr(page, "_allowed", lambda url, robots=None: True)
    # acme.example does not resolve offline: the first address counts as public here.
    monkeypatch.setattr(page, "_is_public", lambda url: True)


def _no_escalation(monkeypatch):
    monkeypatch.setattr(page, "fetch_with_render_fallback", lambda url, html: (html or "", False))
    monkeypatch.setattr(page, "fetch_with_browser_fallback", lambda url, html: (html or "", False))


def test_returns_the_html_and_where_it_came_from(monkeypatch):
    _no_escalation(monkeypatch)
    monkeypatch.setattr(page, "_static_get", lambda url: (LISTING, "https://acme.example/careers/"))
    out = page.fetch_page("https://acme.example/careers")
    assert out == {
        "ok": True,
        "html": LISTING,
        "final_url": "https://acme.example/careers/",
        "rendered": False,
    }


def test_reports_a_browser_render(monkeypatch):
    monkeypatch.setattr(page, "_static_get", lambda url: ("<html><body></body></html>", url))
    monkeypatch.setattr(page, "fetch_with_render_fallback", lambda url, html: (LISTING, True))
    monkeypatch.setattr(page, "fetch_with_browser_fallback", lambda url, html: (html, False))
    out = page.fetch_page("https://acme.example/careers")
    assert out["ok"] is True and out["rendered"] is True and out["html"] == LISTING


def test_a_failure_prints_only_the_class_name_never_the_url(monkeypatch, capsys):
    secret = "https://acme.example/careers?token=hunter2"

    def boom(url):
        raise httpx.ConnectError(f"could not reach {url}")

    monkeypatch.setattr(page, "_static_get", boom)
    monkeypatch.setattr(page, "fetch_with_render_fallback", lambda url, html: ("", False))
    monkeypatch.setattr(page, "fetch_with_browser_fallback", lambda url, html: ("", False))
    assert page.main(["page", secret]) == 0
    printed = capsys.readouterr().out
    assert json.loads(printed) == {"ok": False, "error": "ConnectError"}
    assert "acme.example" not in printed and "hunter2" not in printed


def test_a_render_that_rescues_a_failed_static_fetch_still_succeeds(monkeypatch):
    def refused(url):
        raise httpx.HTTPStatusError("403", request=None, response=None)  # type: ignore[arg-type]

    monkeypatch.setattr(page, "_static_get", refused)
    monkeypatch.setattr(page, "fetch_with_render_fallback", lambda url, html: (LISTING, True))
    monkeypatch.setattr(page, "fetch_with_browser_fallback", lambda url, html: (html, False))
    out = page.fetch_page("https://acme.example/careers")
    assert out["ok"] is True and out["html"] == LISTING


def test_prints_exactly_one_json_line_even_when_a_library_prints(monkeypatch, capsys):
    def chatty(url):
        print("Fetched (200) <GET https://acme.example/careers>")
        return LISTING, url

    monkeypatch.setattr(page, "_static_get", chatty)
    _no_escalation(monkeypatch)
    page.main(["page", "https://acme.example/careers"])
    out = capsys.readouterr().out.strip().splitlines()
    assert len(out) == 1 and json.loads(out[0])["ok"] is True


def test_a_forced_render_uses_the_browser_view_even_when_the_static_page_has_text_and_links(monkeypatch):
    monkeypatch.setattr(page, "_static_get", lambda url: (LISTING, url))
    monkeypatch.setattr(page, "fetch_rendered", lambda url: LISTING + "<a href='/jobs/99'>Role 99</a>")
    monkeypatch.setattr(page, "fetch_with_browser_fallback", lambda url, html: (html, False))
    forced = page.fetch_page("https://acme.example/careers", force_render=True)
    assert forced["rendered"] is True and "Role 99" in forced["html"]
    # Without the flag the same page is not a shell, so it is not rendered.
    monkeypatch.setattr(page, "fetch_with_render_fallback", lambda url, html: (html or "", False))
    assert page.fetch_page("https://acme.example/careers")["rendered"] is False


def test_the_render_flag_is_accepted_on_the_command_line(monkeypatch, capsys):
    seen = {}
    monkeypatch.setattr(page, "fetch_page", lambda url, force_render=False: seen.setdefault("force", force_render) and {"ok": True})
    page.main(["page", "https://acme.example/careers", "--render"])
    assert seen["force"] is True


def test_rejects_anything_that_is_not_an_http_url(capsys):
    page.main(["page", "file:///etc/passwd"])
    assert json.loads(capsys.readouterr().out) == {"ok": False, "error": "BadArguments"}


def test_sends_the_cello_user_agent_never_a_browser_one():
    assert page._USER_AGENT.startswith("cello-job-tracker/")
    assert "/Devil-Hawk/cello" in page._USER_AGENT
    assert "Mozilla" not in page._USER_AGENT


def test_a_page_robots_txt_disallows_is_not_fetched(monkeypatch):
    monkeypatch.setattr(page, "_allowed", lambda url, robots=None: False)

    def never(url):
        raise AssertionError("fetched a disallowed page")

    monkeypatch.setattr(page, "_static_get", never)
    assert page.fetch_page("https://acme.example/careers") == {"ok": False, "error": "RobotsDisallowed"}


def test_the_robots_check_reads_the_rules_for_the_path_and_query():
    from src.polite import RobotsCache

    robots = RobotsCache(fetcher=lambda url: (200, "User-agent: *\nDisallow: /results\n"))
    assert _real_allowed("https://acme.example/careers", robots) is True
    assert _real_allowed("https://acme.example/results?q=data", robots) is False


def _client_over(handler, monkeypatch):
    """Make page._static_get talk to `handler` (a MockTransport) instead of the network."""
    real = httpx.Client
    monkeypatch.setattr(page.httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))


def test_a_redirect_to_an_internal_address_is_refused_and_never_requested(monkeypatch):
    seen = []

    def handler(request):
        seen.append(str(request.url))
        if request.url.host == "acme.example":
            return httpx.Response(302, headers={"location": "http://169.254.169.254/latest/meta-data/"})
        return httpx.Response(200, text="secret")

    _client_over(handler, monkeypatch)
    monkeypatch.setattr(page, "_allowed", lambda url, robots=None: True)
    # acme.example is not resolvable offline: treat it as public, leave the metadata address to the real check.
    real_public = _real_is_public
    monkeypatch.setattr(page, "_is_public", lambda url: True if "acme.example" in url else real_public(url))
    with pytest.raises(page.UnsafeRedirect):
        page._static_get("https://acme.example/careers")
    assert seen == ["https://acme.example/careers"]


def test_a_redirect_the_new_hosts_robots_txt_closes_is_refused(monkeypatch):
    def handler(request):
        if request.url.host == "acme.example":
            return httpx.Response(301, headers={"location": "https://boards.example/private"})
        return httpx.Response(200, text="private")

    _client_over(handler, monkeypatch)
    monkeypatch.setattr(page, "_is_public", lambda url: True)
    monkeypatch.setattr(page, "_allowed", lambda url, robots=None: "boards.example" not in url)
    with pytest.raises(page.UnsafeRedirect):
        page._static_get("https://acme.example/careers")


def test_an_ordinary_redirect_to_a_public_page_is_followed(monkeypatch):
    def handler(request):
        if request.url.path == "/careers":
            return httpx.Response(301, headers={"location": "/en/careers/"})
        return httpx.Response(200, text="<html>roles</html>")

    _client_over(handler, monkeypatch)
    monkeypatch.setattr(page, "_is_public", lambda url: True)
    monkeypatch.setattr(page, "_allowed", lambda url, robots=None: True)
    html, final = page._static_get("https://acme.example/careers")
    assert html == "<html>roles</html>" and final == "https://acme.example/en/careers/"


def test_only_public_http_addresses_are_read():
    for url in ("http://127.0.0.1/", "http://169.254.169.254/latest/", "http://10.0.0.5/", "http://[::1]/", "file:///etc/passwd", "ftp://example.com/"):
        assert _real_is_public(url) is False, url


def test_a_forced_render_the_browser_could_not_do_says_so_with_the_class_and_keeps_the_plain_page(monkeypatch):
    monkeypatch.setattr(page, "_static_get", lambda url: (LISTING, url))
    monkeypatch.setattr(page, "fetch_rendered", lambda url: None)
    monkeypatch.setattr(page.render, "last_error", "PlaywrightMissing")
    monkeypatch.setattr(page, "fetch_with_browser_fallback", lambda url, html: (html, False))
    out = page.fetch_page("https://acme.example/careers", force_render=True)
    assert out["ok"] is True and out["html"] == LISTING
    assert out["render_error"] == "PlaywrightMissing"


def test_a_render_that_worked_carries_no_render_error(monkeypatch):
    monkeypatch.setattr(page, "_static_get", lambda url: (LISTING, url))
    monkeypatch.setattr(page, "fetch_rendered", lambda url: LISTING + "<a href='/jobs/99'>Role 99</a>")
    monkeypatch.setattr(page, "fetch_with_browser_fallback", lambda url, html: (html, False))
    assert "render_error" not in page.fetch_page("https://acme.example/careers", force_render=True)
    assert "render_error" not in page.fetch_page("https://acme.example/careers")


def test_a_redirect_the_plain_fetch_refused_is_never_handed_to_the_browser(monkeypatch):
    def refused(url):
        raise page.UnsafeRedirect("redirect refused")

    def never(url, *a, **kw):
        raise AssertionError("the browser was sent to an address the plain fetch refused")

    monkeypatch.setattr(page, "_static_get", refused)
    for name in ("fetch_rendered", "fetch_with_render_fallback", "fetch_with_browser_fallback"):
        monkeypatch.setattr(page, name, never)
    for force in (True, False):
        assert page.fetch_page("https://acme.example/careers", force_render=force) == {"ok": False, "error": "UnsafeRedirect"}


def test_a_first_address_that_is_internal_is_not_fetched(monkeypatch):
    monkeypatch.setattr(page, "_is_public", _real_is_public)

    def never(url):
        raise AssertionError("fetched an internal address")

    monkeypatch.setattr(page, "_static_get", never)
    assert page.fetch_page("http://169.254.169.254/latest/", force_render=True) == {"ok": False, "error": "UnsafeUrl"}


class _Req:
    def __init__(self, url, navigation):
        self.url, self._nav = url, navigation

    def is_navigation_request(self):
        return self._nav


class _Route:
    def __init__(self, url, navigation=False):
        self.request, self.verdict = _Req(url, navigation), None

    def continue_(self):
        self.verdict = "continue"

    def abort(self):
        self.verdict = "abort"


def _guard(monkeypatch, public, robots_ok=lambda url, robots=None: True):
    monkeypatch.setattr(polite, "is_public", public)
    monkeypatch.setattr(polite, "robots_allowed", robots_ok)
    routes = {}

    class Context:
        def route(self, pattern, handler):
            routes[pattern] = handler

    polite.guard_browser(Context())
    assert list(routes) == ["**/*"]

    def run(url, navigation=False):
        route = _Route(url, navigation)
        routes["**/*"](route)
        return route.verdict

    return run


def test_the_browser_aborts_a_request_to_an_address_that_is_not_public(monkeypatch):
    run = _guard(monkeypatch, lambda url: "169.254." not in url)
    assert run("https://acme.example/careers", navigation=True) == "continue"
    assert run("https://cdn.example/app.js") == "continue"
    # a redirect hop, a script request and a click all arrive here as requests
    assert run("http://169.254.169.254/latest/meta-data/", navigation=True) == "abort"
    assert run("http://169.254.169.254/latest/meta-data/") == "abort"


def test_the_browser_aborts_a_page_load_robots_txt_closes_but_not_an_asset(monkeypatch):
    run = _guard(monkeypatch, lambda url: True, robots_ok=lambda url, robots=None: "/private" not in url)
    assert run("https://acme.example/private/jobs", navigation=True) == "abort"
    assert run("https://acme.example/private/logo.png") == "continue"


def test_the_browser_aborts_a_request_it_cannot_judge(monkeypatch):
    def broken(url):
        raise OSError("dns")

    assert _guard(monkeypatch, broken)("https://acme.example/") == "abort"
