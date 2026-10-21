"""The page ladder the TypeScript ingestion and the worker shell out to.

Every test drives the real page.py and render.py over fakes of Scrapling's two
fetchers (Fetcher.get and StealthyFetcher.fetch), so nothing here touches the
network or launches a browser.
"""

from __future__ import annotations

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from scrapling.fetchers import Fetcher, StealthyFetcher  # noqa: E402

from src import page, polite  # noqa: E402

_real_allowed = page._allowed
_real_is_public = page._is_public

LISTING = (
    "<html><body>"
    + "".join(f'<a href="/jobs/{i}">Role {i}</a>' for i in range(5))
    + "<p>"
    + "We hire people who care. " * 40
    + "</p></body></html>"
)
SHELL = '<html><body><div id="root"></div><script src="/app.js"></script></body></html>'
CLOUDFLARE = (
    "<html><head><title>Just a moment...</title></head>"
    '<body><div id="challenge-form"></div></body></html>'
)
CAPTCHA = (
    "<html><body><h1>Verify you are human</h1>"
    '<iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe></body></html>'
)
SIGN_IN = '<html><body><form><input type="password" name="p"></form></body></html>'


class FakeResponse:
    """The parts of Scrapling's Response that page.py and render.py read."""

    encoding = "utf-8"

    def __init__(self, body="", status=200, headers=None, url="https://acme.example/careers"):
        self.body = body.encode()
        self.status, self.headers, self.url = status, headers or {}, url


class Net:
    """Scripted fetchers: one answer per call, in order, and a record of the calls."""

    def __init__(self, monkeypatch):
        self.http: list = []
        self.browser: list = []
        self.calls: list[tuple[str, dict]] = []
        monkeypatch.setattr(Fetcher, "get", staticmethod(self._get))
        monkeypatch.setattr(StealthyFetcher, "fetch", staticmethod(self._fetch))

    def _answer(self, queue, label, url, kwargs):
        self.calls.append((label, {"url": url, **kwargs}))
        item = queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def _get(self, url, **kwargs):
        return self._answer(self.http, "http", url, kwargs)

    def _fetch(self, url, **kwargs):
        label = "stealth" if kwargs.get("solve_cloudflare") else "rendered"
        return self._answer(self.browser, label, url, kwargs)

    @property
    def rungs(self):
        return [label for label, _ in self.calls]


@pytest.fixture(autouse=True)
def _robots_allow(monkeypatch):
    monkeypatch.setattr(page, "_allowed", lambda url, robots=None: True)
    # acme.example does not resolve offline: the first address counts as public here.
    monkeypatch.setattr(page, "_is_public", lambda url: True)
    # The click rung needs a real browser; a test that wants it replaces this.
    monkeypatch.setattr(page, "fetch_with_browser_fallback", lambda url, html: (html, False))


@pytest.fixture
def net(monkeypatch):
    return Net(monkeypatch)


def test_a_page_with_job_links_stops_at_the_first_rung_even_when_a_browser_was_asked_for(net):
    net.http = [FakeResponse(LISTING, url="https://acme.example/careers/")]
    out = page.fetch_page("https://acme.example/careers", force_render=True)
    assert out == {
        "ok": True,
        "html": LISTING,
        "final_url": "https://acme.example/careers/",
        "rendered": False,
        "rung": "http",
    }
    assert net.rungs == ["http"]


def test_the_first_rung_is_chrome_with_scraplings_own_headers_not_the_cello_agent(net):
    net.http = [FakeResponse(LISTING)]
    page.fetch_page("https://acme.example/careers")
    kwargs = net.calls[0][1]
    assert kwargs["impersonate"] == "chrome"
    assert kwargs["follow_redirects"] is False
    assert "headers" not in kwargs and "stealthy_headers" not in kwargs  # Scrapling's default is on


def test_an_empty_shell_escalates_to_the_rendered_rung(net):
    net.http = [FakeResponse(SHELL)]
    net.browser = [FakeResponse(LISTING, url="https://acme.example/careers/all")]
    out = page.fetch_page("https://acme.example/careers", force_render=True)
    assert out["ok"] is True and out["html"] == LISTING and out["rung"] == "rendered"
    assert out["rendered"] is True and out["final_url"] == "https://acme.example/careers/all"
    assert net.rungs == ["http", "rendered"]
    assert net.calls[1][1]["solve_cloudflare"] is False
    assert net.calls[1][1]["timeout"] == 30_000


def test_the_rungs_run_in_order_and_the_stealth_rung_solves_cloudflare_for_sixty_seconds(net):
    net.http = [FakeResponse(SHELL)]
    net.browser = [FakeResponse(SHELL), FakeResponse(LISTING)]
    out = page.fetch_page("https://acme.example/careers", force_render=True)
    assert out["rung"] == "stealth"
    assert net.rungs == ["http", "rendered", "stealth"]
    stealth = net.calls[2][1]
    assert stealth["solve_cloudflare"] is True and stealth["timeout"] == 60_000
    assert stealth["page_setup"] is polite.guard_browser  # every browser request is held to the plain rules


def test_without_the_render_flag_the_ladder_stops_at_the_first_rung(net):
    net.http = [FakeResponse(SHELL)]
    out = page.fetch_page("https://acme.example/careers")
    assert out["ok"] is True and out["rung"] == "http" and out["rendered"] is False
    assert net.rungs == ["http"]


def test_the_click_through_is_the_last_rung(net, monkeypatch):
    net.http = [FakeResponse(SHELL)]
    net.browser = [FakeResponse(SHELL), FakeResponse(SHELL)]
    monkeypatch.setattr(page, "fetch_with_browser_fallback", lambda url, html: (LISTING, True))
    out = page.fetch_page("https://acme.example/careers", force_render=True)
    assert out["ok"] is True and out["rung"] == "click" and out["html"] == LISTING
    assert net.rungs == ["http", "rendered", "stealth"]


def test_a_cloudflare_wall_climbs_to_the_stealth_rung_and_is_read_there(net):
    net.http = [FakeResponse(CLOUDFLARE, status=403)]
    net.browser = [FakeResponse(CLOUDFLARE), FakeResponse(LISTING)]
    out = page.fetch_page("https://acme.example/careers", force_render=True)
    assert out["ok"] is True and out["rung"] == "stealth"


def test_a_cloudflare_wall_the_solver_could_not_pass_ends_as_a_class_and_the_rung(net):
    net.http = [FakeResponse(CLOUDFLARE, status=403)]
    net.browser = [FakeResponse(CLOUDFLARE), FakeResponse(CLOUDFLARE)]
    out = page.fetch_page("https://acme.example/careers", force_render=True)
    assert out == {"ok": False, "error": "CloudflareWall", "rung": "stealth"}


@pytest.mark.parametrize(
    ("html", "status", "error"),
    [(CAPTCHA, 200, "CaptchaWall"), (CAPTCHA, 403, "CaptchaWall"), (SIGN_IN, 200, "SignInWall")],
)
def test_a_wall_that_is_not_cloudflares_ends_the_read_and_no_browser_is_sent(net, html, status, error):
    net.http = [FakeResponse(html, status=status)]
    out = page.fetch_page("https://acme.example/careers", force_render=True)
    assert out == {"ok": False, "error": error, "rung": "http"}
    assert net.rungs == ["http"]


def test_a_wall_the_browser_meets_is_reported_with_its_rung(net):
    net.http = [FakeResponse(SHELL)]
    net.browser = [FakeResponse(SIGN_IN)]
    out = page.fetch_page("https://acme.example/careers", force_render=True)
    assert out == {"ok": False, "error": "SignInWall", "rung": "rendered"}


def test_a_login_form_on_a_page_that_lists_jobs_is_not_a_wall(net):
    net.http = [FakeResponse(LISTING.replace("</body>", '<input type="password"></body>'))]
    assert page.fetch_page("https://acme.example/careers")["ok"] is True


def test_a_server_error_is_rescued_by_a_browser_rung(net):
    net.http = [FakeResponse("", status=403)]
    net.browser = [FakeResponse(LISTING)]
    out = page.fetch_page("https://acme.example/careers", force_render=True)
    assert out["ok"] is True and out["rung"] == "rendered"


def test_a_server_error_with_no_browser_asked_for_is_the_class_of_the_error(net):
    net.http = [FakeResponse("", status=503)]
    assert page.fetch_page("https://acme.example/careers") == {
        "ok": False,
        "error": "HttpStatus",
        "rung": "http",
    }


def test_a_page_robots_txt_disallows_is_not_fetched(net, monkeypatch):
    monkeypatch.setattr(page, "_allowed", lambda url, robots=None: False)
    assert page.fetch_page("https://acme.example/careers", True) == {"ok": False, "error": "RobotsDisallowed"}
    assert net.calls == []


def test_a_first_address_that_is_internal_is_not_fetched(net, monkeypatch):
    monkeypatch.setattr(page, "_is_public", _real_is_public)
    assert page.fetch_page("http://169.254.169.254/latest/", force_render=True) == {"ok": False, "error": "UnsafeUrl"}
    assert net.calls == []


def test_a_failure_prints_only_the_class_name_and_the_rung_never_the_url(net, capsys):
    secret = "https://acme.example/careers?token=hunter2"

    class ConnectError(Exception):
        pass

    net.http = [ConnectError(f"could not reach {secret}")]
    assert page.main(["page", secret]) == 0
    printed = capsys.readouterr().out
    assert json.loads(printed) == {"ok": False, "error": "ConnectError", "rung": "http"}
    assert "acme.example" not in printed and "hunter2" not in printed


def test_a_browser_that_could_not_run_says_so_with_the_class_and_keeps_the_plain_page(net):
    class PlaywrightMissing(Exception):
        pass

    net.http = [FakeResponse(SHELL)]
    net.browser = [PlaywrightMissing("no browser"), PlaywrightMissing("no browser")]
    out = page.fetch_page("https://acme.example/careers", force_render=True)
    assert out["ok"] is True and out["html"] == SHELL and out["rung"] == "http"
    assert out["render_error"] == "PlaywrightMissing"


def test_a_browser_that_worked_carries_no_render_error(net):
    net.http = [FakeResponse(SHELL)]
    net.browser = [FakeResponse(SHELL), FakeResponse(SHELL)]
    assert "render_error" not in page.fetch_page("https://acme.example/careers", force_render=True)


def test_a_redirect_the_plain_fetch_refused_is_never_handed_to_the_browser(net, monkeypatch):
    net.http = [FakeResponse("", 302, {"Location": "http://169.254.169.254/latest/meta-data/"})]
    real_public = _real_is_public
    monkeypatch.setattr(page, "_is_public", lambda url: True if "acme.example" in url else real_public(url))
    out = page.fetch_page("https://acme.example/careers", force_render=True)
    assert out == {"ok": False, "error": "UnsafeRedirect", "rung": "http"}
    assert net.rungs == ["http"]  # the internal address was not requested either


def test_a_redirect_the_new_hosts_robots_txt_closes_is_refused(net, monkeypatch):
    net.http = [FakeResponse("", 301, {"location": "https://boards.example/private"})]
    monkeypatch.setattr(page, "_allowed", lambda url, robots=None: "boards.example" not in url)
    with pytest.raises(page.UnsafeRedirect):
        page._static_get("https://acme.example/careers")


def test_an_ordinary_redirect_to_a_public_page_is_followed(net):
    net.http = [
        FakeResponse("", 301, {"Location": "/en/careers/"}),
        FakeResponse(LISTING, url="https://acme.example/en/careers/"),
    ]
    html, final = page._static_get("https://acme.example/careers")
    assert html == LISTING and final == "https://acme.example/en/careers/"
    assert net.calls[1][1]["url"] == "https://acme.example/en/careers/"


def test_prints_exactly_one_json_line_even_when_a_library_prints(net, capsys):
    def chatty(url, **kwargs):
        print("Fetched (200) <GET https://acme.example/careers>")
        return FakeResponse(LISTING)

    Fetcher.get = staticmethod(chatty)  # restored by the net fixture's monkeypatch
    page.main(["page", "https://acme.example/careers"])
    out = capsys.readouterr().out.strip().splitlines()
    assert len(out) == 1 and json.loads(out[0])["ok"] is True


def test_the_render_flag_is_accepted_on_the_command_line(monkeypatch):
    seen = {}
    monkeypatch.setattr(
        page, "fetch_page", lambda url, force_render=False: seen.setdefault("force", force_render) and {"ok": True}
    )
    page.main(["page", "https://acme.example/careers", "--render"])
    assert seen["force"] is True


def test_rejects_anything_that_is_not_an_http_url(capsys):
    page.main(["page", "file:///etc/passwd"])
    assert json.loads(capsys.readouterr().out) == {"ok": False, "error": "BadArguments"}


def test_the_robots_check_reads_the_rules_for_the_path_and_query():
    from src.polite import RobotsCache

    robots = RobotsCache(fetcher=lambda url: (200, "User-agent: *\nDisallow: /results\n"))
    assert _real_allowed("https://acme.example/careers", robots) is True
    assert _real_allowed("https://acme.example/results?q=data", robots) is False


def test_only_public_http_addresses_are_read():
    for url in ("http://127.0.0.1/", "http://169.254.169.254/latest/", "http://10.0.0.5/", "http://[::1]/", "file:///etc/passwd", "ftp://example.com/"):
        assert _real_is_public(url) is False, url


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
