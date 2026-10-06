"""Guards on the GitHub Actions workflows. The repo is public, so every log is too."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

WORKFLOWS = Path(__file__).resolve().parents[3] / ".github" / "workflows"


def _read(name: str) -> str:
    return (WORKFLOWS / name).read_text()


@pytest.mark.parametrize("name", ["harness-cron.yml", "gmail-cron.yml", "autopilot-cron.yml"])
def test_cron_workflows_never_print_the_response_body(name):
    text = _read(name)
    assert not re.search(r"\bcat\s+/tmp/", text), "response body must not be cat'd into the log"
    assert "--- response ---" not in text
    assert "jq -c" in text, "success path prints a whitelisted jq summary"


def test_scrape_dispatch_input_is_not_interpolated_into_the_shell():
    text = _read("scrape.yml")
    for line in text.splitlines():
        if "github.event.inputs.company_id" in line or "inputs.company_id" in line:
            assert line.strip().startswith("COMPANY_ID:"), line
    assert "npx tsx scripts/ingest.ts" in text
    assert '[[ "$COMPANY_ID" =~ ^[0-9a-fA-F]{8}-' in text


def test_schedules():
    assert "cron: '41 */6 * * *'" in _read("scrape.yml")
    assert "group: scrape\n" in _read("scrape.yml")
    assert "cron: '47 * * * *'" in _read("gmail-cron.yml")


def test_autopilot_cron_has_no_schedule():
    text = _read("autopilot-cron.yml")
    assert "schedule:" not in text.split("jobs:")[0].replace("# No schedule: paused", "")
    assert "workflow_dispatch:" in text


def test_harness_cron_has_no_schedule_and_waits_for_the_route():
    text = _read("harness-cron.yml")
    assert "schedule:" not in text.split("jobs:")[0].replace("# No schedule here", "")
    assert "workflow_dispatch:" in text
    assert "--max-time 330" in text


def test_browser_apply_does_not_lean_on_the_inert_browser_use_env_var():
    assert "BROWSER_USE_LOGGING_LEVEL" not in _read("browser-apply.yml")


def test_ingest_logs_ids_and_counts_only():
    text = (WORKFLOWS.parents[1] / "apps" / "web" / "scripts" / "ingest.ts").read_text()
    assert "companyName" not in text and "career_url" not in text
    assert "errors: result.errors" not in text
    assert "error.message" not in text and "error.stack" not in text
    assert "console.error(error" not in text


def test_the_page_fetcher_cannot_print_a_url():
    text = (WORKFLOWS.parents[1] / "packages" / "scrapers" / "src" / "page.py").read_text()
    assert "logging.disable(logging.CRITICAL)" in text
    assert '"error": type(' in text


def test_scrape_is_one_job_on_free_models():
    text = _read("scrape.yml")
    assert text.count("\n  find-new-roles:") == 1
    assert "\n  scrape:" not in text and "\n  ats-refresh:" not in text
    assert "OPENROUTER_API_KEY" in text
    for paid in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "SCRAPER_BROWSER_USE_AGENT"):
        assert paid not in text
    assert "timeout-minutes: 50" in text
