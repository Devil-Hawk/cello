"""The page fetcher the TypeScript ingestion shells out to."""

from __future__ import annotations

import json
import os
import sys

import httpx

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src import page  # noqa: E402

LISTING = (
    "<html><body>"
    + "".join(f'<a href="/jobs/{i}">Role {i}</a>' for i in range(5))
    + "<p>"
    + "We hire people who care. " * 40
    + "</p></body></html>"
)


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


def test_rejects_anything_that_is_not_an_http_url(capsys):
    page.main(["page", "file:///etc/passwd"])
    assert json.loads(capsys.readouterr().out) == {"ok": False, "error": "BadArguments"}
