"""Tests for the assisted-apply SUBMIT script — the one place in this
two-phase design allowed to click Submit, and only reachable via the human
click at app/api/apply/confirm (ruling 8). Proves the deviation check is
ORDERED before any fill/submit action in the task, and that a `deviation`
result short-circuits run() before report_state ever claims a submission.
"""

from __future__ import annotations

from src import apply_submit
from src.apply_submit import PHASE, SubmitResult, _format_answers, _sensitive_data


class TestTaskOrdering:
    def test_phase_is_hardcoded_to_submit(self):
        assert PHASE == "submit"

    def test_verification_step_precedes_the_fill_and_submit_steps(self):
        task = apply_submit._SUBMIT_TASK_TEMPLATE
        verify_at = task.index("STEP 1")
        fill_at = task.index("STEP 2")
        submit_word_at = task.lower().index("click the application")
        assert verify_at < fill_at < submit_word_at

    def test_step_one_explicitly_forbids_acting_before_verifying(self):
        step_one = apply_submit._SUBMIT_TASK_TEMPLATE.split("STEP 2")[0].lower()
        assert "stop immediately" in step_one
        assert "do not fill" in step_one

    def test_task_forbids_inventing_or_changing_answers(self):
        task = apply_submit._SUBMIT_TASK_TEMPLATE.lower()
        assert "byte-for-byte" in task
        assert "do not invent" in task or "never guess" in task

    def test_submit_click_is_scoped_to_exactly_one_button(self):
        task = apply_submit._SUBMIT_TASK_TEMPLATE.lower()
        assert "exactly once" in task


class TestOutputSchema:
    def test_deviation_field_exists_and_defaults_to_empty(self):
        result = SubmitResult()
        assert result.deviation == ""
        assert result.submitted is False
        assert result.confirmed is False


class TestRunShortCircuitsOnDeviation:
    def test_deviation_result_reports_deviation_and_never_claims_submitted(self, monkeypatch):
        reported = []

        def fake_load_config():
            class C:
                draft_id = "draft-1"

            return C()

        monkeypatch.setattr(apply_submit, "load_config", fake_load_config)
        fake_bundle = {"jobUrl": "https://x", "answers": {}, "reportToken": "tok-abc"}
        monkeypatch.setattr(apply_submit, "fetch_bundle", lambda config, phase: fake_bundle)
        monkeypatch.setattr(apply_submit, "browser_use_available", lambda: True)
        monkeypatch.setattr(
            apply_submit,
            "_run_agent",
            lambda bundle: SubmitResult(deviation="a new required field appeared", submitted=False),
        )

        report_tokens = []

        def fake_report_state(config, phase, report_token, payload):
            report_tokens.append(report_token)
            reported.append(payload)

        monkeypatch.setattr(apply_submit, "report_state", fake_report_state)

        apply_submit.run()

        assert len(reported) == 1
        assert reported[0]["result"] == "deviation"
        assert "new required field" in reported[0]["deviationDetail"]
        # A deviation report never claims a submission outcome.
        assert "confirmed" not in reported[0]
        # The report token from THIS run's bundle is what proves the
        # callback corresponds to a real fetch — not fabricated.
        assert report_tokens == ["tok-abc"]

    def test_submitted_result_reports_confirmed_flag_honestly(self, monkeypatch):
        reported = []

        def fake_load_config():
            class C:
                draft_id = "draft-1"

            return C()

        monkeypatch.setattr(apply_submit, "load_config", fake_load_config)
        fake_bundle = {"jobUrl": "https://x", "answers": {}, "reportToken": "tok-abc"}
        monkeypatch.setattr(apply_submit, "fetch_bundle", lambda config, phase: fake_bundle)
        monkeypatch.setattr(apply_submit, "browser_use_available", lambda: True)
        monkeypatch.setattr(
            apply_submit,
            "_run_agent",
            lambda bundle: SubmitResult(submitted=True, confirmed=False),
        )
        monkeypatch.setattr(
            apply_submit,
            "report_state",
            lambda config, phase, report_token, payload: reported.append(payload),
        )

        apply_submit.run()

        assert reported[0]["result"] == "submitted"
        assert reported[0]["confirmed"] is False  # never inferred as True


class TestSensitiveDataWiring:
    def test_present_when_bundle_carries_a_credential(self):
        bundle = {
            "jobUrl": "https://acme.wd5.myworkdayjobs.com/en-US/careers/job/1",
            "credential": {"username": "ada", "secret": "s3cr3t"},
        }
        data = _sensitive_data(bundle)
        assert data == {"acme.wd5.myworkdayjobs.com": {"username": "ada", "password": "s3cr3t"}}


class TestFormatAnswers:
    def test_renders_empty_answers_honestly(self):
        assert "no answers" in _format_answers({}).lower()

    def test_renders_each_answer_on_its_own_line(self):
        out = _format_answers({"first_name": "Ada", "email": "ada@example.com"})
        assert "first_name: Ada" in out
        assert "email: ada@example.com" in out
