"""Assisted apply — FILL phase. Runs as .github/workflows/browser-apply.yml's
`fill` job.

WHAT THIS SCRIPT DOES, AND THE ONE THING IT STRUCTURALLY CANNOT DO
    Fetches the fill bundle (job URL, candidate profile/resume/cover letter,
    and a host-scoped board credential when one is stored), drives a
    browser-use Agent to fill the hosted application form, captures one
    screenshot per page reached, and reports the answers + screenshots back
    to app/api/apply/state — which moves the draft to 'pending_review' for a
    HUMAN to read before anything is ever sent.

    THIS FILE CONTAINS NO SUBMIT ACTION. Not "an agent instructed not to
    submit" as the only defense (that instruction is here too, see
    _FILL_TASK_TEMPLATE, and it is real defense-in-depth against a job page
    whose own content tries to steer the agent — indirect prompt injection
    is a live threat here exactly as browser_tier.py's docstring explains
    for scraping) — the stronger property is that PHASE is hardcoded to
    "fill" everywhere in this file, this file never imports apply_submit.py
    or anything from it, and no function, string, or Agent output schema
    anywhere below names or requests a final submission. There is no code
    PATH here that could reach one even if the task string were deleted.
    tests/test_apply_fill.py asserts this structurally — see that file's
    own header for the exact properties it checks and the mutation that was
    run against this file to prove the checks are not vacuous.

    That source-level property does not, by itself, stop the browser-use
    LLM agent from clicking a real submit button during a live run —
    click_element is one generic action, not a distinct "submit" tool
    browser-use could exclude, and an adversarial or merely confusing
    hosted form page is untrusted content the agent reads (the same
    indirect-prompt-injection threat model browser_tier.py's docstring
    names for scraping). _install_no_send_click_guard() is the code-level
    backstop for that: it shadows browser-use's click action so a click
    targeting a control that looks like it would send the application
    (an explicit HTML submit-type control, or text naming one of the same
    words _FILL_TASK_TEMPLATE's prose already forbids) is refused before it
    ever reaches the real browser, regardless of what the agent's own plan
    says. See that function's docstring and TestClickGuard in
    tests/test_apply_fill.py.

WHY sensitive_data IS WIRED HERE, UNLIKE src/browser_tier.py
    browser_tier.py's whole point is unattended scraping of a THIRD PARTY's
    public career page — a login credential has no place there, and that
    file's own test asserts `sensitive_data=` never appears in it. This
    script's whole point is the OPPOSITE: filling a hosted application form
    AS THE CANDIDATE, on THEIR OWN say-so (app/api/apply/prepare already
    refused anything else), so handing the agent the credential
    app/api/apply/bundle released — host-scoped, per lib/apply/vault.ts, so
    it is never anything but the credential for THIS job's own board — is
    the legitimate, intended use of browser-use's own credential-injection
    parameter. See browser-use's docs: sensitive_data keeps the raw secret
    out of the LLM's own prompt/logs, substituting a placeholder the model
    reasons about instead.
"""

from __future__ import annotations

import contextlib
import logging
import re
import sys
from typing import Any

from pydantic import BaseModel

from .apply_common import Phase, fetch_bundle, load_config, report_state, sensitive_data_for
from .browser_tier import browser_use_available

logger = logging.getLogger(__name__)

# ponytail: fixed ceilings, not a config surface nobody asked for yet. Raise
# these here, in one place, if a real multi-page form proves them too tight.
_MAX_STEPS = 40
_MAX_ACTIONS_PER_STEP = 4
_MAX_HISTORY_ITEMS = 12
_MAX_SCREENSHOTS = 8
# Vision-capable, unlike browser_tier's nav-only agent — reading which field
# is which on a real application form benefits from seeing the page, not
# just its accessibility tree. Same provider/model family browser_tier.py
# already uses (google/gemini-2.0-flash-001), for the same reason: it is
# this codebase's existing cheap OpenRouter default, not a new spend surface.
_LLM_MODEL = "google/gemini-2.0-flash-001"

PHASE: Phase = "fill"  # hardcoded — see module docstring

_FILL_TASK_TEMPLATE = """Open {job_url} and fill in the job application form using
ONLY the information below. Use the login details if the site asks you to
sign in.

Candidate:
{profile_block}

Resume text (attach as the resume/CV if the form has a file upload; otherwise
paste relevant text into any resume/CV text field):
{resume_block}

Cover letter (paste into a cover letter field if one exists):
{cover_letter_block}

Fill every visible field you can answer from the information above. If a
required field asks something you cannot answer from the information above
(a legal/demographic/visa/salary question, or anything else not covered
above), leave it blank and note it in your answer.

Do NOT log in anywhere except this job's own application form. Do NOT click
Submit, Apply, Send, Finish, or any other button that would send the
application. Stop as soon as every visible field is filled (or every page of
a multi-page form has been filled) and report what you filled — never submit
anything."""


class FillResult(BaseModel):
    """The agent's entire output: what it filled, and where it went. No
    submission confirmation field exists on this model — there is nothing
    for the agent to report here that a submit would have produced."""

    answers: dict[str, str]
    pages_visited: list[str]
    notes: str = ""


def _build_task(bundle: dict[str, Any]) -> str:
    profile = bundle.get("profile") or {}
    profile_lines = "\n".join(
        f"  {k}: {v}" for k, v in profile.items() if isinstance(v, str) and v.strip()
    )
    resume_text = (bundle.get("resumeText") or "").strip()
    cover_letter = (bundle.get("coverLetter") or "").strip()
    return _FILL_TASK_TEMPLATE.format(
        job_url=bundle["jobUrl"],
        profile_block=profile_lines or "  (no profile fields provided)",
        resume_block=resume_text or "(no resume text provided)",
        cover_letter_block=cover_letter or "(no cover letter provided)",
    )


# See module docstring for why this script (unlike browser_tier.py)
# legitimately wires browser-use's credential-injection parameter. Shared
# with apply_submit.py via apply_common.py — pure bundle plumbing, no
# fill-specific content, so keeping two copies would just be drift risk.
_sensitive_data = sensitive_data_for

# Same forbidden words _FILL_TASK_TEMPLATE's prose already names — kept as
# one list so the code-level guard and the prompt instruction cannot drift
# apart into checking for different things.
_SEND_SHAPED_WORDS = ("submit", "apply", "send", "finish")
_SEND_SHAPED_RE = re.compile(r"\b(" + "|".join(_SEND_SHAPED_WORDS) + r")\b", re.IGNORECASE)


def _is_send_shaped(node: Any) -> bool:
    """True when `node` (a browser-use EnhancedDOMTreeNode) looks like a
    control that would send the application: an explicit HTML
    type="submit"/"image" attribute (the unambiguous structural signal —
    the default semantic of a <button> inside a <form>), or visible/
    accessible text naming one of _SEND_SHAPED_WORDS. Checked against the
    element's own value/aria-label attributes, its accessibility-tree name,
    and its rendered child text — covering an icon button labelled only via
    aria-label as well as an ordinary <button>Submit Application</button>.

    Deliberately keyword-broad rather than narrow: a false positive here
    just makes the fill run report an unfilled field and stop (safe — a
    human reviews before anything is ever sent); a false negative would let
    a real submission through unreviewed, which is the one outcome ruling 8
    exists to prevent.
    """
    attrs = getattr(node, "attributes", None) or {}
    if str(attrs.get("type", "")).strip().lower() in ("submit", "image"):
        return True
    texts = [str(attrs.get("value", "")), str(attrs.get("aria-label", ""))]
    ax_node = getattr(node, "ax_node", None)
    if ax_node is not None and getattr(ax_node, "name", None):
        texts.append(str(ax_node.name))
    get_children_text = getattr(node, "get_all_children_text", None)
    if callable(get_children_text):
        # A text-extraction failure must not defeat the guard.
        with contextlib.suppress(Exception):
            texts.append(str(get_children_text(max_depth=2)))
    return any(_SEND_SHAPED_RE.search(t) for t in texts if t)


def _install_no_send_click_guard(tools: Any) -> None:
    """Shadows browser-use's built-in 'click' action on `tools` so a click
    targeting a send-shaped control (_is_send_shaped()) is refused before it
    ever reaches the real browser — the code-level backstop the module
    docstring describes. Ordinary clicks (checkboxes, dropdown options,
    multi-page "Next" navigation) are unaffected: they are delegated to
    browser-use's own click handler unchanged.

    Reaches into browser-use's private per-Tools-instance click handler
    (`tools._click_by_index`, the exact coroutine its built-in 'click'
    action already delegates to — browser_use.tools.service.Tools) because
    the library has no public "veto this click" hook. Reuses the ALREADY-
    REGISTERED action's own param_model rather than importing browser-use's
    param types directly, so this does not need to track which click
    signature (index-only vs. index-or-coordinate) is currently active.

    FAILS LOUD if the existing 'click' registration or `_click_by_index`
    is missing (a browser-use upgrade moved or renamed them) rather than
    silently leaving clicks unguarded — an unguarded click action during
    the fill phase is exactly the gap this function exists to close.
    """
    existing = tools.registry.registry.actions.get("click")
    real_click_by_index = getattr(tools, "_click_by_index", None)
    if existing is None or real_click_by_index is None:
        raise RuntimeError(
            "browser-use's click action/handler shape changed; the fill-phase "
            "click guard cannot be installed. Refusing to run unguarded."
        )
    param_model = existing.param_model

    async def click(params: Any, browser_session: Any) -> Any:
        from browser_use.agent.views import ActionResult

        node = await browser_session.get_element_by_index(params.index)
        if node is not None and _is_send_shaped(node):
            return ActionResult(
                error=(
                    "Refused: this control looks like it would send the application "
                    "(Submit/Apply/Send/Finish). This phase never sends the "
                    "application — leave it unclicked and report what you filled."
                )
            )
        return await real_click_by_index(params, browser_session)

    tools.action(
        "Click element by index. Refuses controls that look like they would send the application.",
        param_model=param_model,
    )(click)


def _run_agent(bundle: dict[str, Any]) -> tuple[FillResult, list[dict[str, str]]]:
    """Drives the browser-use Agent. Returns the structured fill result plus
    up to _MAX_SCREENSHOTS screenshots (one per distinct page URL visited,
    the LAST screenshot captured on that page). Raises on any failure — a
    fill run that could not complete must surface as a failed job, not
    quietly report an empty result.
    """
    import os

    from browser_use import Agent, Tools
    from browser_use.llm import ChatOpenRouter

    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY is required for the fill agent")

    tools = Tools(exclude_actions=["evaluate", "write_file", "replace_file"])
    _install_no_send_click_guard(tools)
    agent = Agent(
        task=_build_task(bundle),
        llm=ChatOpenRouter(model=_LLM_MODEL, api_key=api_key),
        tools=tools,
        sensitive_data=_sensitive_data(bundle),
        output_model_schema=FillResult,
        use_vision=True,
        max_actions_per_step=_MAX_ACTIONS_PER_STEP,
        max_history_items=_MAX_HISTORY_ITEMS,
    )
    history = agent.run_sync(max_steps=_MAX_STEPS)

    structured = getattr(history, "structured_output", None)
    empty_result = FillResult(answers={}, pages_visited=[])
    result = structured if isinstance(structured, FillResult) else empty_result

    screenshots_fn = getattr(history, "screenshots", None)
    raw_screenshots: list[str] = screenshots_fn() if callable(screenshots_fn) else []
    urls: list[str] = history.urls() if hasattr(history, "urls") else []

    screenshots: list[dict[str, str]] = []
    seen_pages: set[str] = set()
    # Walk backwards so the LAST screenshot on each page wins (the most
    # filled-in state of that page), capped at _MAX_SCREENSHOTS pages.
    for i in range(min(len(raw_screenshots), len(urls)) - 1, -1, -1):
        page = urls[i] or f"step-{i}"
        if page in seen_pages:
            continue
        seen_pages.add(page)
        data_url = raw_screenshots[i]
        if not data_url:
            continue
        screenshots.append({"page": page, "dataUrl": data_url})
        if len(screenshots) >= _MAX_SCREENSHOTS:
            break
    screenshots.reverse()  # chronological order for the review UI

    return result, screenshots


def run() -> None:
    config = load_config()
    bundle = fetch_bundle(config, PHASE)

    if not browser_use_available():
        raise RuntimeError("browser-use is not installed in this runner")

    result, screenshots = _run_agent(bundle)

    fill_state = {
        "answers": result.answers,
        "pagesVisited": result.pages_visited,
        "notes": result.notes,
    }
    report_state(
        config, PHASE, bundle["reportToken"], {"fillState": fill_state, "screenshots": screenshots}
    )
    logger.info(
        "fill complete for draft %s: %d field(s), %d screenshot(s)",
        config.draft_id,
        len(result.answers),
        len(screenshots),
    )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    try:
        run()
    except Exception:  # noqa: BLE001 — a failed fill run must exit non-zero for GitHub Actions
        logger.exception("assisted-apply fill run failed")
        sys.exit(1)
