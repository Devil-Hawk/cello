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
    assert 'python -m src.runner "$COMPANY_ID"' in text
    assert '[[ "$COMPANY_ID" =~ ^[0-9a-fA-F]{8}-' in text


def test_schedules():
    assert "cron: '41 */6 * * *'" in _read("scrape.yml")
    assert "group: scrape\n" in _read("scrape.yml")
    assert "cron: '23 */4 * * *'" in _read("autopilot-cron.yml")
    assert "cron: '47 * * * *'" in _read("gmail-cron.yml")


def test_harness_cron_has_no_schedule_and_waits_for_the_route():
    text = _read("harness-cron.yml")
    assert "schedule:" not in text.split("jobs:")[0].replace("# No schedule here", "")
    assert "workflow_dispatch:" in text
    assert "--max-time 330" in text


def test_browser_apply_keeps_browser_use_quiet():
    assert _read("browser-apply.yml").count("BROWSER_USE_LOGGING_LEVEL: result") == 2


def test_ats_refresh_logs_ids_and_counts_only():
    text = (WORKFLOWS.parents[1] / "scripts" / "ats-refresh.ts").read_text()
    assert "companyName" not in text
    assert "errors: result.errors" not in text
    assert "error.message" not in text and "error.stack" not in text
