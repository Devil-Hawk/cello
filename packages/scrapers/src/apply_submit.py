"""Assisted apply — SUBMIT phase. Runs as .github/workflows/browser-apply.yml's
`submit` job, dispatched ONLY by app/api/apply/confirm — the human click
(ruling 8; see that route's header for why it is the sole mint site for a
submit-phase token).

WHAT THIS SCRIPT DOES
    Fetches the submit bundle — the job URL, the credential (host-scoped),
    and `answers`, which is draft.fill_state EXACTLY as a human reviewed it,
    never recomputed — and drives a browser-use Agent to:
      1. Re-open the live form and check it AGAINST the approved answers
         BEFORE touching anything.
      2. If the live form has drifted since review (a new required field,
         changed options, a field that vanished), ABORT: fill nothing,
         submit nothing, report a deviation. app/api/apply/state sends the
         draft straight back to 'pending_review' for that.
      3. Only if the form matches exactly: re-fill it with the SAME values
         byte-for-byte, click the one Submit/Apply/Send control ONCE, and
         report whether a confirmation was actually observed.

    Unlike apply_fill.py, THIS script's whole job is to submit — that is the
    one thing apply_fill.py structurally cannot do, and this is the only
    place in the two-phase design that ever clicks it, reachable only behind
    the human-click chain: app/api/apply/confirm -> a fresh submit-phase
    token -> this dispatch. tests/test_apply_submit.py asserts the deviation
    check runs BEFORE any fill/submit action, not the honesty of the click
    itself (browser-use is not a formally verifiable actor) — the real
    backstop against a bad submission is app/api/apply/state's honest
    verification_state (system_confirmed only when `confirmed: true` is
    reported) plus the human review that already happened before this
    dispatch existed at all.
"""

from __future__ import annotations

import logging
import sys
from typing import Any

from pydantic import BaseModel

from .apply_common import Phase, fetch_bundle, load_config, report_state, sensitive_data_for
from .browser_tier import browser_use_available

logger = logging.getLogger(__name__)

# Same ceilings as apply_fill.py, for the same ponytail reason (see that
# file). Slightly fewer steps: this run re-fills a form it already knows the
# shape of rather than exploring one.
_MAX_STEPS = 30
_MAX_ACTIONS_PER_STEP = 4
_MAX_HISTORY_ITEMS = 12
_LLM_MODEL = "google/gemini-2.0-flash-001"

PHASE: Phase = "submit"

_SUBMIT_TASK_TEMPLATE = """Open {job_url}. This form was already filled and approved
with these EXACT answers:
{answers_block}

STEP 1 — VERIFY FIRST, BEFORE FILLING OR CLICKING ANYTHING: compare the
CURRENT live form against the answers above. If the form now has a required
field that is not in the list above, or an existing field's available
options have changed, or a field listed above no longer exists on the form,
STOP IMMEDIATELY. Do not fill anything and do not click anything else.
Report this as a deviation, describing exactly what is different.

STEP 2 — ONLY IF THE FORM MATCHES EXACTLY: re-fill every field with the SAME
values listed above, byte-for-byte — do not invent, change, or improve any
answer. Then click the application's single final Submit / Apply / Send
button EXACTLY ONCE.

STEP 3 — After clicking, look for a confirmation message, confirmation page,
or reference/confirmation number. Report plainly whether you actually
observed one, and quote it if so — never guess or assume success."""


class SubmitResult(BaseModel):
    """The agent's entire output. `deviation` set means STEP 1 aborted the
    run — `submitted`/`confirmed` are meaningless in that case and the
    caller must not act on them."""

    deviation: str = ""
    submitted: bool = False
    confirmed: bool = False
    confirmation_identifier: str = ""
    confirmation_text: str = ""


def _format_answers(answers: dict[str, Any]) -> str:
    if not answers:
        return "  (no answers were recorded)"
    return "\n".join(f"  {k}: {v}" for k, v in answers.items())


# Shared with apply_fill.py via apply_common.py — see that module's
# sensitive_data_for() docstring.
_sensitive_data = sensitive_data_for


def _run_agent(bundle: dict[str, Any]) -> SubmitResult:
    import os

    from browser_use import Agent, Tools
    from browser_use.llm import ChatOpenRouter

    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY is required for the submit agent")

    answers = bundle.get("answers") or {}
    flat_answers = answers.get("answers", answers) if isinstance(answers, dict) else {}

    task = _SUBMIT_TASK_TEMPLATE.format(
        job_url=bundle["jobUrl"], answers_block=_format_answers(flat_answers)
    )
    agent = Agent(
        task=task,
        llm=ChatOpenRouter(model=_LLM_MODEL, api_key=api_key),
        tools=Tools(exclude_actions=["evaluate", "write_file", "replace_file"]),
        sensitive_data=_sensitive_data(bundle),
        output_model_schema=SubmitResult,
        use_vision=True,
        max_actions_per_step=_MAX_ACTIONS_PER_STEP,
        max_history_items=_MAX_HISTORY_ITEMS,
    )
    history = agent.run_sync(max_steps=_MAX_STEPS)
    structured = getattr(history, "structured_output", None)
    return structured if isinstance(structured, SubmitResult) else SubmitResult()


def run() -> None:
    config = load_config()
    bundle = fetch_bundle(config, PHASE)

    if not browser_use_available():
        raise RuntimeError("browser-use is not installed in this runner")

    result = _run_agent(bundle)

    report_token = bundle["reportToken"]

    if result.deviation:
        report_state(
            config,
            PHASE,
            report_token,
            {"result": "deviation", "deviationDetail": result.deviation},
        )
        logger.info("submit aborted for draft %s: deviation reported", config.draft_id)
        return

    if not result.submitted:
        report_state(
            config,
            PHASE,
            report_token,
            {"result": "failed", "error": "agent did not submit and reported no deviation"},
        )
        logger.warning(
            "submit run for draft %s neither submitted nor reported a deviation", config.draft_id
        )
        return

    report_state(
        config,
        PHASE,
        report_token,
        {
            "result": "submitted",
            "confirmed": result.confirmed,
            "confirmationIdentifier": result.confirmation_identifier or None,
            "confirmationNote": result.confirmation_text or None,
        },
    )
    logger.info("submit complete for draft %s: confirmed=%s", config.draft_id, result.confirmed)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    try:
        run()
    except Exception:  # noqa: BLE001 — a failed submit run must exit non-zero for GitHub Actions
        logger.exception("assisted-apply submit run failed")
        sys.exit(1)
