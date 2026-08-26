"""Shared plumbing for assisted-apply's two runner scripts (apply_fill.py,
apply_submit.py): read the workflow's env, fetch the phase bundle from the
app, and report results back.

WHY A THIRD MODULE RATHER THAN DUPLICATING THIS IN BOTH SCRIPTS
    fetch_bundle()/report_state() are pure HTTP plumbing — no browser action,
    no credential handling beyond passing through what the bundle already
    contains, no submit-shaped call anywhere. Splitting them out keeps
    apply_fill.py's own source small enough that
    tests/test_apply_fill.py's structural "contains no submit invocation"
    scan stays meaningful (see that file): everything in apply_fill.py is
    fill-phase-specific, and this module is the same code either script
    would otherwise have had to write twice.

AUTH: BROWSER_RUNNER_SECRET on every call, PLUS (for report_state) the
report token fetch_bundle()'s response just handed back for this exact run.
See app/api/apply/bundle/route.ts and app/api/apply/state/route.ts's
headers — the phase token itself is consumed server-side and never held
here; the report token is the one secret this script DOES hold and must
present back.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Literal

import httpx

Phase = Literal["fill", "submit"]

# ponytail: fixed ceiling, not a retry/backoff policy nobody asked for yet.
# Raise this here, in one place, if a slow bundle/state endpoint proves it
# too tight.
_HTTP_TIMEOUT_S = 30.0


class AssistedApplyConfigError(RuntimeError):
    """Required env var missing — fails loudly rather than guessing."""


@dataclass(frozen=True)
class RunnerConfig:
    app_base_url: str
    runner_secret: str
    draft_id: str


def load_config() -> RunnerConfig:
    """Read DRAFT_ID / APP_BASE_URL / BROWSER_RUNNER_SECRET from the
    workflow's own env (browser-apply.yml sets all three). Raises
    AssistedApplyConfigError — never returns a partially-configured object —
    because a missing secret here must fail the run, not silently skip
    authentication.
    """
    draft_id = os.environ.get("DRAFT_ID", "").strip()
    app_base_url = os.environ.get("APP_BASE_URL", "").strip().rstrip("/")
    runner_secret = os.environ.get("BROWSER_RUNNER_SECRET", "").strip()
    missing = [
        name
        for name, value in (
            ("DRAFT_ID", draft_id),
            ("APP_BASE_URL", app_base_url),
            ("BROWSER_RUNNER_SECRET", runner_secret),
        )
        if not value
    ]
    if missing:
        raise AssistedApplyConfigError(f"missing required env var(s): {', '.join(missing)}")
    return RunnerConfig(app_base_url=app_base_url, runner_secret=runner_secret, draft_id=draft_id)


def _headers(config: RunnerConfig) -> dict[str, str]:
    return {"Authorization": f"Bearer {config.runner_secret}", "Content-Type": "application/json"}


def fetch_bundle(config: RunnerConfig, phase: Phase) -> dict[str, Any]:
    """POST app/api/apply/bundle. Raises httpx.HTTPStatusError on any
    non-2xx — a refused bundle (no live token, stale review, wrong host)
    must stop the run rather than proceed with nothing to fill.
    """
    url = f"{config.app_base_url}/api/apply/bundle"
    res = httpx.post(
        url,
        json={"draftId": config.draft_id, "phase": phase},
        headers=_headers(config),
        timeout=_HTTP_TIMEOUT_S,
    )
    res.raise_for_status()
    return res.json()


def report_state(
    config: RunnerConfig, phase: Phase, report_token: str, payload: dict[str, Any]
) -> None:
    """PATCH app/api/apply/state. `report_token` is the value
    app/api/apply/bundle's response handed back for THIS run (bundle["reportToken"])
    — app/api/apply/state now requires it match the one it minted at bundle
    time (verifyReportToken(), lib/ats-apply/phase-tokens.ts) before it will
    record a fill/submit result, closing the gap where a caller holding only
    BROWSER_RUNNER_SECRET plus (draftId, phase) — both visible in this run's
    own GitHub Actions logs — could fabricate an outcome for a run that never
    fetched a bundle at all.

    Raises on failure — a run whose result could not be recorded must
    surface as a failed GitHub Actions job, not disappear silently (the
    draft would otherwise be stuck in 'filling' or 'approved' forever with
    no visible reason).
    """
    url = f"{config.app_base_url}/api/apply/state"
    body = {"draftId": config.draft_id, "phase": phase, "reportToken": report_token, **payload}
    res = httpx.patch(url, json=body, headers=_headers(config), timeout=_HTTP_TIMEOUT_S)
    res.raise_for_status()


def sensitive_data_for(bundle: dict[str, Any]) -> dict[str, dict[str, str]] | None:
    """browser-use's own credential-injection parameter, shared by
    apply_fill.py and apply_submit.py — pure bundle->dict plumbing, no
    browser action and no fill/submit-specific content, so it belongs here
    rather than duplicated in both (the exact kind of code this module
    exists to hold once). Keyed by the job's own host, exactly as released:
    never a credential for anywhere else, because the bundle never contains
    one (see app/api/apply/bundle's host-scoped release).
    """
    credential = bundle.get("credential")
    if not credential or not credential.get("username") or not credential.get("secret"):
        return None
    from urllib.parse import urlparse

    host = urlparse(bundle["jobUrl"]).hostname or bundle["jobUrl"]
    return {host: {"username": credential["username"], "password": credential["secret"]}}
