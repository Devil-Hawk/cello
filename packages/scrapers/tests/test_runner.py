"""Tests for the scraper runner's due-time rule and its public-log hygiene."""

from __future__ import annotations

import asyncio
import logging
import runpy
from datetime import datetime, timedelta

import pytest

from src import runner
from src.runner import is_due

NOW = datetime(2026, 10, 4, 12, 0, 0)


def _ago(minutes: float) -> str:
    return (NOW - timedelta(minutes=minutes)).isoformat() + "Z"


class TestIsDue:
    def test_never_scraped_is_due(self):
        assert is_due({"last_scraped_at": None}, NOW)

    def test_dream_company_due_after_an_hour_with_slack(self):
        c = {"is_dream_company": True, "last_scraped_at": _ago(56)}
        assert is_due(c, NOW)

    def test_dream_company_not_due_before_the_slack_window(self):
        c = {"is_dream_company": True, "last_scraped_at": _ago(50)}
        assert not is_due(c, NOW)

    def test_regular_company_waits_a_day(self):
        assert not is_due({"last_scraped_at": _ago(60 * 23)}, NOW)
        assert is_due({"last_scraped_at": _ago(60 * 24 - 5)}, NOW)

    def test_small_user_frequency_cannot_beat_the_tier(self):
        # Before the clamp, scrape_frequency=1 made a daily company due every tick.
        c = {"scrape_frequency": 1, "last_scraped_at": _ago(120)}
        assert not is_due(c, NOW)

    def test_user_frequency_can_stretch_the_interval(self):
        c = {"is_dream_company": True, "scrape_frequency": 600, "last_scraped_at": _ago(120)}
        assert not is_due(c, NOW)
        c["last_scraped_at"] = _ago(600)
        assert is_due(c, NOW)

    def test_null_frequency_falls_back_to_the_tier(self):
        c = {"is_dream_company": True, "scrape_frequency": None, "last_scraped_at": _ago(60)}
        assert is_due(c, NOW)


class _Result:
    def __init__(self, data):
        self.data = data


class _Table:
    def __init__(self, rows):
        self.rows = rows

    def select(self, *_):
        return self

    def execute(self):
        return _Result(self.rows)


class _Client:
    def __init__(self, rows):
        self.rows = rows

    def table(self, _name):
        return _Table(self.rows)


def test_get_companies_to_scrape_applies_the_clamp_and_orders_dream_first(monkeypatch):
    class FrozenNow(datetime):
        @classmethod
        def utcnow(cls):
            return NOW

    monkeypatch.setattr(runner, "datetime", FrozenNow)
    rows = [
        {"id": "a", "name": "b-regular", "last_scraped_at": None},
        {"id": "b", "name": "a-dream", "is_dream_company": True, "last_scraped_at": _ago(61)},
        {"id": "c", "name": "c-fast", "scrape_frequency": 1, "last_scraped_at": _ago(120)},
    ]
    due = asyncio.run(runner.get_companies_to_scrape(_Client(rows)))
    assert [c["id"] for c in due] == ["b", "a"]


def _scraper_returning(res):
    class Scraper:
        def __init__(self, **_):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        async def scrape(self):
            return res

    return Scraper


class TestNoUserDataInLogs:
    def test_scrape_company_prints_ids_and_counts_only(self, monkeypatch, capsys):
        class Job:
            title = "Secret Title"
            description = "d"
            url = "https://careers.example.com/job/1"
            location = None
            salary_range = None
            job_type = None
            posted_at = None
            external_id = "1"

        class Res:
            success = True
            error = None
            jobs = [Job()]
            duration_ms = 1

        class Boom:
            def upsert(self, *_, **__):
                raise RuntimeError("row (secret@example.com) violates something")

            def update(self, *_):
                return self

            def eq(self, *_):
                return self

            def execute(self):
                return None

        class Sb:
            def table(self, _):
                return Boom()

        monkeypatch.setattr(runner, "IntelligentScraper", _scraper_returning(Res()))
        company = {
            "id": "cid-1",
            "name": "Acme Private",
            "career_url": "https://careers.example.com",
        }
        out = asyncio.run(runner.scrape_company(company, None, Sb()))
        printed = capsys.readouterr().out
        assert "cid-1" in printed
        for leaked in ("Acme Private", "careers.example.com", "Secret Title", "secret@example.com"):
            assert leaked not in printed
        assert out["company"] == "cid-1"

    def test_failed_scrape_does_not_print_the_error_text(self, monkeypatch, capsys):
        class Res:
            success = False
            error = "GET https://careers.example.com/x failed"
            jobs = []

        monkeypatch.setattr(runner, "IntelligentScraper", _scraper_returning(Res()))
        company = {
            "id": "cid-2",
            "name": "Acme Private",
            "career_url": "https://careers.example.com",
        }
        asyncio.run(runner.scrape_company(company, None, object()))
        printed = capsys.readouterr().out
        assert "careers.example.com" not in printed and "Acme" not in printed

    def test_main_quiets_the_scrapers_url_bearing_warnings(self, monkeypatch):
        monkeypatch.setattr(runner, "get_supabase_client", lambda: _Client([]))
        monkeypatch.setattr(runner, "get_llm_provider", lambda: None)
        logging.getLogger("src").setLevel(logging.NOTSET)
        try:
            asyncio.run(runner.main())
            assert logging.getLogger("src").getEffectiveLevel() >= logging.ERROR
        finally:
            logging.getLogger("src").setLevel(logging.NOTSET)


@pytest.mark.parametrize("module", ["src.apply_fill", "src.apply_submit"])
def test_apply_scripts_do_not_log_browser_actions_at_info(module, monkeypatch):
    """browser-use logs typed values at INFO; the root level must stay at WARNING."""
    seen = {}
    monkeypatch.setattr(logging, "basicConfig", lambda **kw: seen.update(kw))
    for var in ("DRAFT_ID", "APP_BASE_URL", "BROWSER_RUNNER_SECRET", "OPENROUTER_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    with pytest.raises(SystemExit):
        runpy.run_module(module, run_name="__main__")
    assert seen["level"] == logging.WARNING
