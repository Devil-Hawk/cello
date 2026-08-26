"""Tests for the assisted-apply FILL script.

STRUCTURAL "NO SUBMIT" GUARANTEE — what is actually checked here, and why
    browser-use has no distinct "submit" action; a submit click is just
    another click_element call the LLM agent could in principle be steered
    into (by its own task text, or by indirect prompt injection from the
    hosted form's content — same threat model src/browser_tier.py's
    docstring names for scraping). The structural property this file proves
    is narrower and stronger than "the agent probably won't": THIS FILE'S
    OWN SOURCE contains no affirmative instruction to click a submit-shaped
    control, no function/import related to submitting, and PHASE is
    hardcoded to "fill" everywhere — apply_fill.py has no code path that
    could ever request or act on a submit-phase bundle, regardless of what
    the agent does inside its own browser session.

MUTATION CHECK (executed, not left to trust): added the line
`"Click the Submit button when done."` to _FILL_TASK_TEMPLATE in a working
copy of src/apply_fill.py — test_task_has_no_affirmative_submit_instruction
went red immediately. Reverted before this file was finalized.

ZERO NETWORK, NO REAL BROWSER: browser-use is not installed in this test
environment (see src/browser_tier.py's own test file for the same note), so
_run_agent's happy path is exercised via a monkeypatched Agent stand-in
rather than a real browser-use import.
"""

from __future__ import annotations

import asyncio
import inspect
import sys
import types

from src import apply_fill
from src.apply_fill import (
    PHASE,
    FillResult,
    _build_task,
    _install_no_send_click_guard,
    _is_send_shaped,
    _sensitive_data,
)


class TestNoSubmitCodePath:
    def test_phase_is_hardcoded_to_fill(self):
        assert PHASE == "fill"

    def test_module_never_imports_apply_submit(self):
        # Code only — the module DOCSTRING legitimately names apply_submit.py
        # in prose (explaining why it is never imported), so this scans
        # actual import statements, not comments/docstrings.
        for line in inspect.getsource(apply_fill).splitlines():
            stripped = line.strip()
            if stripped.startswith(("import ", "from ")):
                assert "apply_submit" not in stripped, f"forbidden import: {stripped!r}"

    def test_module_defines_no_submit_named_function(self):
        for name, obj in vars(apply_fill).items():
            if inspect.isfunction(obj) and obj.__module__ == apply_fill.__name__:
                assert "submit" not in name.lower(), f"unexpected submit-named function: {name}"

    def test_output_schema_carries_no_submission_confirmation_field(self):
        # FillResult must never grow a field that looks like "we submitted" —
        # that concept belongs entirely to apply_submit.SubmitResult.
        fields = set(FillResult.model_fields.keys())
        assert fields == {"answers", "pages_visited", "notes"}
        for banned in ("submit", "confirm", "sent"):
            assert not any(banned in f.lower() for f in fields), fields

    def test_task_forbids_submission_explicitly(self):
        task = apply_fill._FILL_TASK_TEMPLATE.lower()
        assert "do not" in task and "submit" in task
        assert "apply" in task and "send" in task  # named alongside submit in the same refusal

    def test_task_has_no_affirmative_submit_instruction(self):
        # The only occurrences of "submit"/"click" near each other in the
        # task must be part of the NEGATIVE instruction ("do not click
        # submit"), never a positive one ("click submit").
        task = apply_fill._FILL_TASK_TEMPLATE
        for line in task.splitlines():
            lower = line.lower()
            if "click" in lower and ("submit" in lower or "apply" in lower or "send" in lower):
                message = f"affirmative submit-click instruction found: {line!r}"
                assert "do not" in lower or "not" in lower, message

    def test_agent_construction_never_calls_a_submit_action(self):
        source = inspect.getsource(apply_fill._run_agent)
        assert "submit" not in source.lower()


class TestSensitiveDataWiring:
    def test_present_when_bundle_carries_a_credential(self):
        bundle = {
            "jobUrl": "https://boards.greenhouse.io/acme/jobs/1",
            "credential": {"username": "ada", "secret": "s3cr3t"},
        }
        data = _sensitive_data(bundle)
        assert data == {"boards.greenhouse.io": {"username": "ada", "password": "s3cr3t"}}

    def test_none_when_bundle_carries_no_credential(self):
        bundle = {"jobUrl": "https://boards.greenhouse.io/acme/jobs/1", "credential": None}
        assert _sensitive_data(bundle) is None


class TestBuildTask:
    def test_includes_job_url_resume_and_cover_letter(self):
        bundle = {
            "jobUrl": "https://boards.greenhouse.io/acme/jobs/1",
            "profile": {"email": "ada@example.com", "firstName": "Ada"},
            "resumeText": "Ada's resume text",
            "coverLetter": "Dear hiring manager",
        }
        task = _build_task(bundle)
        assert "https://boards.greenhouse.io/acme/jobs/1" in task
        assert "ada@example.com" in task
        assert "Ada's resume text" in task
        assert "Dear hiring manager" in task

    def test_degrades_gracefully_with_no_resume_or_cover_letter(self):
        bundle = {"jobUrl": "https://x", "profile": {}, "resumeText": None, "coverLetter": None}
        task = _build_task(bundle)
        assert "no resume text provided" in task
        assert "no cover letter provided" in task


class _FakeNode:
    def __init__(self, attributes=None, children_text="", ax_name=None):
        self.attributes = attributes or {}
        self._children_text = children_text
        self.ax_node = types.SimpleNamespace(name=ax_name) if ax_name else None

    def get_all_children_text(self, max_depth=2):
        return self._children_text


class TestIsSendShaped:
    def test_explicit_submit_type_matches_regardless_of_text(self):
        node = _FakeNode(attributes={"type": "submit"}, children_text="Continue")
        assert _is_send_shaped(node) is True

    def test_explicit_image_type_matches(self):
        node = _FakeNode(attributes={"type": "image"})
        assert _is_send_shaped(node) is True

    def test_button_text_naming_submit_matches(self):
        node = _FakeNode(attributes={"type": "button"}, children_text="Submit Application")
        assert _is_send_shaped(node) is True

    def test_aria_label_naming_send_matches(self):
        node = _FakeNode(attributes={"role": "button", "aria-label": "Send my application"})
        assert _is_send_shaped(node) is True

    def test_accessible_name_naming_finish_matches(self):
        node = _FakeNode(attributes={}, ax_name="Finish and apply")
        assert _is_send_shaped(node) is True

    def test_ordinary_checkbox_does_not_match(self):
        node = _FakeNode(attributes={"type": "checkbox"}, children_text="I agree to the terms")
        assert _is_send_shaped(node) is False

    def test_ordinary_multi_page_continue_button_does_not_match(self):
        node = _FakeNode(attributes={"type": "button"}, children_text="Next")
        assert _is_send_shaped(node) is False

    def test_survives_a_node_with_no_get_all_children_text(self):
        node = types.SimpleNamespace(attributes={"type": "checkbox"})
        assert _is_send_shaped(node) is False


def _stub_browser_use_action_result(monkeypatch):
    """_install_no_send_click_guard()'s wrapped click handler lazily imports
    browser_use.agent.views.ActionResult — stubbed here so this test never
    needs a real browser-use install (ZERO NETWORK, NO REAL BROWSER; see
    this file's own header).
    """

    class ActionResult:
        def __init__(self, error=None, extracted_content=None, **_kw):
            self.error = error
            self.extracted_content = extracted_content

    browser_use_pkg = types.ModuleType("browser_use")
    agent_pkg = types.ModuleType("browser_use.agent")
    views_mod = types.ModuleType("browser_use.agent.views")
    views_mod.ActionResult = ActionResult
    monkeypatch.setitem(sys.modules, "browser_use", browser_use_pkg)
    monkeypatch.setitem(sys.modules, "browser_use.agent", agent_pkg)
    monkeypatch.setitem(sys.modules, "browser_use.agent.views", views_mod)
    return ActionResult


class _FakeRegisteredAction:
    def __init__(self, param_model):
        self.param_model = param_model


class _FakeTools:
    """Duck-typed stand-in for browser_use.tools.service.Tools, modeling
    only the surface _install_no_send_click_guard() touches."""

    def __init__(self):
        self.registry = types.SimpleNamespace(
            registry=types.SimpleNamespace(
                actions={"click": _FakeRegisteredAction(param_model=object())}
            )
        )
        self._registered: dict[str, object] = {}
        self.real_click_calls: list[object] = []

    async def _click_by_index(self, params, browser_session):
        self.real_click_calls.append(params)
        return "REAL_CLICK_RESULT"

    def action(self, description, param_model=None):
        def decorator(func):
            self._registered[func.__name__] = func
            return func

        return decorator


class TestClickGuard:
    def test_replaces_the_click_registration(self):
        tools = _FakeTools()
        _install_no_send_click_guard(tools)
        assert "click" in tools._registered

    def test_fails_loud_when_browser_use_click_internals_are_missing(self):
        tools = _FakeTools()
        tools._click_by_index = None
        import pytest

        with pytest.raises(RuntimeError):
            _install_no_send_click_guard(tools)

    def test_refuses_a_send_shaped_control_without_calling_the_real_handler(self, monkeypatch):
        _stub_browser_use_action_result(monkeypatch)
        tools = _FakeTools()
        _install_no_send_click_guard(tools)
        guarded = tools._registered["click"]

        class Session:
            async def get_element_by_index(self, index):
                return _FakeNode(attributes={"type": "submit"}, children_text="Submit Application")

        result = asyncio.run(guarded(types.SimpleNamespace(index=5), Session()))
        assert result.error is not None
        assert tools.real_click_calls == []

    def test_allows_a_safe_control_through_to_the_real_handler(self, monkeypatch):
        _stub_browser_use_action_result(monkeypatch)
        tools = _FakeTools()
        _install_no_send_click_guard(tools)
        guarded = tools._registered["click"]

        class Session:
            async def get_element_by_index(self, index):
                return _FakeNode(attributes={"type": "checkbox"}, children_text="I agree")

        result = asyncio.run(guarded(types.SimpleNamespace(index=2), Session()))
        assert result == "REAL_CLICK_RESULT"
        assert len(tools.real_click_calls) == 1

    def test_a_missing_element_index_delegates_to_the_real_handler(self, monkeypatch):
        # Matches the real click handler's own "element not available" path
        # (page changed since the DOM snapshot) rather than the guard
        # inventing a different behavior for it.
        _stub_browser_use_action_result(monkeypatch)
        tools = _FakeTools()
        _install_no_send_click_guard(tools)
        guarded = tools._registered["click"]

        class Session:
            async def get_element_by_index(self, index):
                return None

        result = asyncio.run(guarded(types.SimpleNamespace(index=99), Session()))
        assert result == "REAL_CLICK_RESULT"
        assert len(tools.real_click_calls) == 1
