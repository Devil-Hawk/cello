"""The page fetcher the TypeScript ingestion shells out to."""

from __future__ import annotations

import json
import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src import page  # noqa: E402

_real_allowed = page._allowed

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
