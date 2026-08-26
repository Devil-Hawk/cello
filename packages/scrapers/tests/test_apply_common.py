"""Tests for the shared assisted-apply plumbing: config loading, and that
fetch_bundle/report_state hit the right endpoints with the right auth and
raise on failure rather than swallowing it."""

import httpx
import pytest

from src.apply_common import (
    AssistedApplyConfigError,
    fetch_bundle,
    load_config,
    report_state,
)


class FakeResponse:
    def __init__(self, status_code: int, payload: dict | None = None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("boom", request=None, response=self)  # type: ignore[arg-type]


class TestLoadConfig:
    def test_reads_all_three_required_vars(self, monkeypatch):
        monkeypatch.setenv("DRAFT_ID", "draft-1")
        monkeypatch.setenv("APP_BASE_URL", "https://cello.example/")
        monkeypatch.setenv("BROWSER_RUNNER_SECRET", "s3cr3t")
        config = load_config()
        assert config.draft_id == "draft-1"
        assert config.app_base_url == "https://cello.example"  # trailing slash stripped
        assert config.runner_secret == "s3cr3t"

    @pytest.mark.parametrize("missing", ["DRAFT_ID", "APP_BASE_URL", "BROWSER_RUNNER_SECRET"])
    def test_raises_when_one_var_is_missing(self, monkeypatch, missing):
        env = {"DRAFT_ID": "d1", "APP_BASE_URL": "https://x", "BROWSER_RUNNER_SECRET": "s"}
        del env[missing]
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        monkeypatch.delenv(missing, raising=False)
        with pytest.raises(AssistedApplyConfigError):
            load_config()


class TestFetchBundle:
    def test_posts_to_bundle_with_bearer_auth_and_phase(self, monkeypatch):
        monkeypatch.setenv("DRAFT_ID", "draft-1")
        monkeypatch.setenv("APP_BASE_URL", "https://cello.example")
        monkeypatch.setenv("BROWSER_RUNNER_SECRET", "s3cr3t")
        config = load_config()

        calls = []

        def fake_post(url, json, headers, timeout):
            calls.append((url, json, headers))
            return FakeResponse(200, {"phase": "fill", "jobUrl": "https://x"})

        monkeypatch.setattr("src.apply_common.httpx.post", fake_post)
        result = fetch_bundle(config, "fill")

        assert result["jobUrl"] == "https://x"
        url, body, headers = calls[0]
        assert url == "https://cello.example/api/apply/bundle"
        assert body == {"draftId": "draft-1", "phase": "fill"}
        assert headers["Authorization"] == "Bearer s3cr3t"

    def test_raises_on_a_non_2xx_response_rather_than_proceeding(self, monkeypatch):
        monkeypatch.setenv("DRAFT_ID", "draft-1")
        monkeypatch.setenv("APP_BASE_URL", "https://cello.example")
        monkeypatch.setenv("BROWSER_RUNNER_SECRET", "s3cr3t")
        config = load_config()
        monkeypatch.setattr("src.apply_common.httpx.post", lambda *a, **kw: FakeResponse(403))
        with pytest.raises(httpx.HTTPStatusError):
            fetch_bundle(config, "fill")


class TestReportState:
    def test_patches_state_with_phase_and_merged_payload(self, monkeypatch):
        monkeypatch.setenv("DRAFT_ID", "draft-1")
        monkeypatch.setenv("APP_BASE_URL", "https://cello.example")
        monkeypatch.setenv("BROWSER_RUNNER_SECRET", "s3cr3t")
        config = load_config()

        calls = []

        def fake_patch(url, json, headers, timeout):
            calls.append((url, json, headers))
            return FakeResponse(200)

        monkeypatch.setattr("src.apply_common.httpx.patch", fake_patch)
        report_state(config, "submit", "tok-abc", {"result": "submitted", "confirmed": True})

        url, body, headers = calls[0]
        assert url == "https://cello.example/api/apply/state"
        assert body == {
            "draftId": "draft-1",
            "phase": "submit",
            "reportToken": "tok-abc",
            "result": "submitted",
            "confirmed": True,
        }
        assert headers["Authorization"] == "Bearer s3cr3t"

    def test_raises_on_failure_rather_than_swallowing_it(self, monkeypatch):
        monkeypatch.setenv("DRAFT_ID", "draft-1")
        monkeypatch.setenv("APP_BASE_URL", "https://cello.example")
        monkeypatch.setenv("BROWSER_RUNNER_SECRET", "s3cr3t")
        config = load_config()
        monkeypatch.setattr("src.apply_common.httpx.patch", lambda *a, **kw: FakeResponse(500))
        with pytest.raises(httpx.HTTPStatusError):
            report_state(config, "fill", "tok-abc", {})
