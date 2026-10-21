"""Guards on the GitHub Actions workflows. The repo is public, so every log is too."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

WORKFLOWS = Path(__file__).resolve().parents[3] / ".github" / "workflows"


def _read(name: str) -> str:
    return (WORKFLOWS / name).read_text()


@pytest.mark.parametrize("name", ["gmail-cron.yml", "autopilot-cron.yml"])
def test_cron_workflows_never_print_the_response_body(name):
    text = _read(name)
    assert not re.search(r"\bcat\s+/tmp/", text), "response body must not be cat'd into the log"
    assert "--- response ---" not in text
    assert "jq -c" in text, "success path prints a whitelisted jq summary"


def test_scrape_dispatch_input_is_not_interpolated_into_the_shell():
    text = _read("scrape.yml")
    for line in text.splitlines():
        if "inputs.company_ids" in line:
            assert line.strip().startswith("COMPANY_IDS:"), line
    assert "npx tsx scripts/ingest.ts" in text
    assert '[[ "$COMPANY_IDS" =~ ^${uuid}' in text


def test_scrape_runs_one_at_a_time_and_is_not_scheduled_here():
    # The database clock dispatches this workflow; lib/clock/no-schedules.test.ts holds every workflow to that.
    text = _read("scrape.yml")
    assert re.search(r"^\s*group: scrape$", text, re.M)
    assert not re.search(r"^\s*schedule:", "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#")), re.M)


def test_autopilot_cron_has_no_schedule():
    text = _read("autopilot-cron.yml")
    assert "schedule:" not in text.split("jobs:")[0].replace("# No schedule: paused", "")
    assert "workflow_dispatch:" in text


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
    assert "type(error).__name__" in text


def test_scrape_is_one_job_on_free_models():
    text = _read("scrape.yml")
    assert text.count("\n  find-new-roles:") == 1
    assert "\n  scrape:" not in text and "\n  ats-refresh:" not in text
    assert "OPENROUTER_API_KEY" in text
    for paid in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "SCRAPER_BROWSER_USE_AGENT"):
        assert paid not in text
    assert "timeout-minutes: 50" in text


def test_directory_read_takes_a_count_from_the_environment_and_prints_no_address():
    text = _read("directory-read.yml")
    assert "schedule:" not in text
    assert "COUNT: ${{ inputs.count }}" in text
    assert "-gt 50" in text
    assert "CELLO_URL: ${{ secrets.CELLO_URL }}" in text
    assert "CELLO_CONTINUE_SECRET: ${{ secrets.CELLO_CONTINUE_SECRET }}" in text
    assert "SUPABASE" not in text
    assert "echo" not in text.replace('echo "::error::count must be a number from 1 to 50"', "")
