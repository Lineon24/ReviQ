import asyncio
import json

import httpx
import pytest
from openai import AsyncOpenAI, BadRequestError, AuthenticationError, RateLimitError

from backend import analysis  # Disable telemetry before importing the adapter.
from backend import llm
from backend.errors import AnalysisError, provider_error


def test_real_sdk_serializes_crewai_messages_without_internal_metadata(monkeypatch):
    messages = [
        {"role": "system", "content": "분석 규칙", "cache_breakpoint": True},
        {"role": "user", "content": "리뷰 원문 전체", "cache_breakpoint": True},
    ]
    def transport(request):
        payload = json.loads(request.content)
        assert payload["input"] == [
            {"role": "system", "content": "분석 규칙"},
            {"role": "user", "content": "리뷰 원문 전체"},
        ]
        assert payload["store"] is False
        return httpx.Response(200, json={
            "id": "resp_test", "object": "response", "created_at": 1,
            "model": "gpt-4o", "status": "completed",
            "output": [{"id": "msg_test", "type": "message", "role": "assistant", "status": "completed",
                        "content": [{"type": "output_text", "text": "검증된 결과", "annotations": []}]}],
        })
    def client(**kwargs):
        return AsyncOpenAI(**kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(transport)))
    monkeypatch.setenv("OPENAI_API_KEY", "test-only-never-sent")
    monkeypatch.setattr(llm, "AsyncOpenAI", client)
    result = asyncio.run(llm.ReviewLLM(model="gpt-4o").acall(messages))
    assert result == "Final Answer: 검증된 결과"
    assert messages[0]["cache_breakpoint"] is True


@pytest.mark.parametrize("error_type,status,code,expected", [
    (BadRequestError, 400, "unknown_parameter", "model_request"),
    (BadRequestError, 400, "context_length_exceeded", "model_context"),
    (AuthenticationError, 401, "invalid_api_key", "model_auth"),
    (RateLimitError, 429, "insufficient_quota", "model_quota"),
    (RateLimitError, 429, "credit_balance_exhausted", "model_credits"),
    (RateLimitError, 429, "project_spend_limit_exceeded", "model_project_limit"),
    (RateLimitError, 429, "organization_spend_limit_exceeded", "model_organization_limit"),
    (RateLimitError, 429, "organization_usage_limit_exceeded", "model_usage_limit"),
    (RateLimitError, 429, "rate_limit_exceeded", "model_rate_limit"),
])
def test_errors_are_specific_without_exposing_provider_body(error_type, status, code, expected):
    response = httpx.Response(status, request=httpx.Request("POST", "https://api.openai.com/v1/responses"))
    error = error_type("secret-key-and-review-data", response=response, body={"code": code})
    safe = provider_error(error)
    assert safe.code == expected
    assert "secret-key-and-review-data" not in str(safe)


def test_unknown_quota_code_is_not_classified_as_temporary_rate_limit():
    response = httpx.Response(429, request=httpx.Request("POST", "https://api.openai.com/v1/responses"))
    error = RateLimitError("private provider body", response=response,
                          body={"code": "future_billing_code", "type": "insufficient_quota"})
    assert provider_error(error).code == "model_quota"


def test_pipeline_reports_failed_stage_and_safe_error_code():
    class Crew:
        async def akickoff(self):
            raise AnalysisError("model_request", "안전한 오류 안내")
    def factory(data, notify):
        notify({"stage": 1, "status": "running"})
        return Crew()
    async def run():
        return [event async for event in analysis.analysis_events(None, crew_factory=factory)]
    events = asyncio.run(run())
    assert events[-1] == {"error": "원인 추적 단계: 안전한 오류 안내", "code": "model_request"}
    assert not any(event.get("done") for event in events)
