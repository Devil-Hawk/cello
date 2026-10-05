"""Tests for the scraper runner's due-time rule and its public-log hygiene."""

from __future__ import annotations

import asyncio
import logging
import runpy
from datetime import UTC, datetime, timedelta

import pytest

from src import runner
from src.runner import is_due

NOW = datetime(2026, 10, 4, 12, 0, 0)
URL = "https://careers.example.com"


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

    def eq(self, *_):
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
        {"id": "a", "name": "b-regular", "career_url": URL, "last_scraped_at": None},
        {"id": "b", "name": "a-dream", "career_url": URL, "is_dream_company": True, "last_scraped_at": _ago(61)},
        {"id": "c", "name": "c-fast", "career_url": URL, "scrape_frequency": 1, "last_scraped_at": _ago(120)},
    ]
    due = asyncio.run(runner.get_companies_to_scrape(_Client(rows)))
    assert [c["id"] for c in due] == ["b", "a"]


def _frozen(monkeypatch):
    class FrozenNow(datetime):
        @classmethod
        def utcnow(cls):
            return NOW

    monkeypatch.setattr(runner, "datetime", FrozenNow)


class TestOnlyTrackedCompaniesWithACareersPage:
    def _due(self, monkeypatch, extra):
        _frozen(monkeypatch)
        rows = [{"id": "kept", "career_url": URL, "last_scraped_at": None}, {"id": "other", **extra}]
        due = asyncio.run(runner.get_companies_to_scrape(_Client(rows)))
        return [c["id"] for c in due]

    def test_suggested_leads_are_skipped(self, monkeypatch):
        assert self._due(monkeypatch, {"career_url": URL, "metadata": {"suggested": True}}) == ["kept"]

    def test_rows_without_a_careers_url_are_skipped(self, monkeypatch):
        assert self._due(monkeypatch, {"career_url": ""}) == ["kept"]
        assert self._due(monkeypatch, {"career_url": None}) == ["kept"]
        assert self._due(monkeypatch, {"career_url": "  "}) == ["kept"]

    def test_null_or_unflagged_metadata_is_kept(self, monkeypatch):
        assert self._due(monkeypatch, {"career_url": URL, "metadata": None}) == ["kept", "other"]
        assert self._due(monkeypatch, {"career_url": URL, "metadata": {"suggested": False}}) == ["kept", "other"]

    def test_a_specific_company_id_is_not_filtered(self, monkeypatch):
        rows = [{"id": "x", "career_url": "", "metadata": {"suggested": True}}]
        assert asyncio.run(runner.get_companies_to_scrape(_Client(rows), "x")) == rows


class TestOldPostingsAreNotStored:
    def test_a_200_day_old_posting_is_dropped_and_a_10_day_old_one_kept(self, monkeypatch):
        now = datetime.now(UTC)

        def job(i, age_days):
            return type(
                "Job",
                (),
                {
                    "title": f"t{i}", "description": "d", "url": f"https://careers.example.com/{i}",
                    "location": None, "salary_range": None, "job_type": None, "external_id": str(i),
                    "posted_at": now - timedelta(days=age_days) if age_days is not None else None,
                },
            )()

        class Res:
            success = True
            error = None
            jobs = [job(1, 200), job(2, 10), job(3, None)]
            duration_ms = 1

        stored = []

        class Table:
            def __init__(self, name):
                self.name = name

            def upsert(self, row, **_):
                stored.append(row["external_id"])
                return self

            def update(self, *_):
                return self

            def eq(self, *_):
                return self

            def execute(self):
                return None

        class Sb:
            def table(self, name):
                return Table(name)

        monkeypatch.setattr(runner, "IntelligentScraper", _scraper_returning(Res()))
        asyncio.run(runner.scrape_company({"id": "c", "career_url": URL}, None, Sb()))
        assert stored == ["2", "3"]

    def test_the_cutoff_is_180_days(self):
        now = datetime(2026, 10, 4, tzinfo=UTC)
        assert not runner.is_stale_posting(now - timedelta(days=180), now)
        assert runner.is_stale_posting(now - timedelta(days=181), now)
        assert runner.is_stale_posting(datetime(2026, 1, 1), now)  # naive reads as UTC
        assert not runner.is_stale_posting(None, now)


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

    def test_main_silences_third_party_logs_carrying_the_url(self, monkeypatch, capsys):
        """scrapling and browser-use log the fetched URL at INFO, and failures at ERROR, on their own handlers."""
        import sys

        from src import browser_tier

        monkeypatch.setattr(runner, "get_supabase_client", lambda: _Client([]))
        monkeypatch.setattr(runner, "get_llm_provider", lambda: None)
        handler = logging.StreamHandler(sys.stderr)
        handler.setLevel(logging.INFO)
        names = ("", "scrapling", "browser_use", "playwright", "httpx")
        loggers = [logging.getLogger(n) for n in names]
        saved = [lg.level for lg in loggers]
        try:
            for lg in loggers:
                lg.addHandler(handler)
                lg.setLevel(logging.INFO)
            asyncio.run(runner.main())
            browser_tier.browser_use_available()
            for lg in loggers:
                lg.info("Fetched (200) <GET https://private-user-company.example/careers>")
                lg.warning("Navigated to https://private-user-company.example/careers")
                lg.error("Failed after 3 attempts: Page.goto: net::ERR_NAME_NOT_RESOLVED at https://private-user-company.example/careers")
        finally:
            logging.disable(logging.NOTSET)
            for lg, level in zip(loggers, saved):
                lg.removeHandler(handler)
                lg.setLevel(level)
        assert "private-user-company" not in capsys.readouterr().err

    def test_one_company_blowing_up_prints_only_its_id_and_exception_class(
        self, monkeypatch, capsys
    ):
        company = {"id": "cid-9", "name": "Acme Private", "career_url": "https://careers.example.com"}

        async def boom(*_a, **_k):
            raise RuntimeError("GET https://careers.example.com failed: row Acme Private")

        async def one(*_a, **_k):
            return [company]

        async def no_sleep(_s):
            return None

        monkeypatch.setattr(runner, "get_supabase_client", lambda: _Client([]))
        monkeypatch.setattr(runner, "get_llm_provider", lambda: None)
        monkeypatch.setattr(runner, "get_companies_to_scrape", one)
        monkeypatch.setattr(runner, "scrape_company", boom)
        monkeypatch.setattr(runner.asyncio, "sleep", no_sleep)
        try:
            asyncio.run(runner.main())
        finally:
            logging.disable(logging.NOTSET)
        out = capsys.readouterr().out
        assert "cid-9" in out and "RuntimeError" in out
        assert "careers.example.com" not in out and "Acme" not in out


@pytest.mark.parametrize("module", ["src.apply_fill", "src.apply_submit"])
def test_apply_scripts_print_only_their_own_log_lines(module, monkeypatch, capsys):
    """browser-use logs typed values at INFO and failed actions at ERROR; only ours may print."""
    import sys

    for var in ("DRAFT_ID", "APP_BASE_URL", "BROWSER_RUNNER_SECRET", "OPENROUTER_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    root = logging.getLogger()
    saved = (root.handlers[:], root.level, logging.getLogger("browser_use").level)
    root.handlers = [logging.StreamHandler(sys.stderr)]
    try:
        with pytest.raises(SystemExit):
            runpy.run_module(module, run_name="__main__")
        for name in ("browser_use.Agent", "browser_use.browser.watchdogs", "bubus", "cdp_use"):
            lg = logging.getLogger(name)
            lg.info("Typed 'Jane Roe jane@example.com' into element")
            lg.error("Failed to input text into element: Jane Roe jane@example.com")
    finally:
        root.handlers, root.level = saved[0], saved[1]
        logging.getLogger("browser_use").setLevel(saved[2])
        logging.getLogger("__main__").setLevel(logging.NOTSET)
    err = capsys.readouterr().err
    assert "Jane Roe" not in err and "jane@example.com" not in err
    assert "run failed (" in err


def test_runner_script_crash_prints_only_the_exception_class(monkeypatch, capsys):
    """A failure outside the per-company try must not dump a traceback into the public log."""
    for var in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr("sys.argv", ["runner"])
    try:
        with pytest.raises(SystemExit) as exc:
            runpy.run_module("src.runner", run_name="__main__")
    finally:
        logging.disable(logging.NOTSET)
    assert exc.value.code == 1
    captured = capsys.readouterr()
    assert "Traceback" not in captured.err
    assert "Scout Agent failed (ValueError)" in captured.out
