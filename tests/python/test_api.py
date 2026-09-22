import hashlib
import hmac
import json
import time

import pytest
from fastapi.testclient import TestClient

from api import chat
from test_agents import request_data


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("VERCEL", raising=False)
    monkeypatch.delenv("APP_PASSWORD", raising=False)
    monkeypatch.delenv("REVIQ_LOCAL_PROXY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "test-only-never-sent")
    return TestClient(chat.app)


def test_api_validation_before_any_ai_call(client, monkeypatch):
    assert client.post("/api/chat", json={}, headers={"origin": "https://other.example"}).status_code == 403
    monkeypatch.delenv("OPENAI_API_KEY")
    assert client.post("/api/chat", json={}).status_code == 503
    monkeypatch.setenv("OPENAI_API_KEY", "test-only-never-sent")
    assert client.post("/api/chat", content="not-json").status_code == 400
    assert client.post("/api/chat", json={}).status_code == 400
    assert client.post("/api/chat", content="x" * 2_000_001).status_code == 413
    data = request_data().model_dump()
    data["files"][0]["reviews"][0]["date"] = "2026-02-30"
    assert client.post("/api/chat", json=data).status_code == 400
    data = request_data().model_dump()
    data["files"][0]["reviews"] *= 800
    assert client.post("/api/chat", json=data).status_code == 413
    data = request_data().model_dump()
    data["messages"] = []
    assert client.post("/api/chat", json=data).status_code == 400
    monkeypatch.setenv("VERCEL", "1")
    assert client.post("/api/chat", json={}).status_code == 401


def test_python_accepts_node_compatible_signed_session_cookie(client, monkeypatch):
    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.setenv("APP_PASSWORD", "test-password")
    expiry = str(int(time.time() * 1000) + 60000)
    signature = hmac.new(b"test-password", expiry.encode(), hashlib.sha256).hexdigest()
    client.cookies.set("review_session", f"{expiry}.{signature}")
    assert client.post("/api/chat", json={}).status_code == 400
    client.cookies.set("review_session", f"{expiry}.forged")
    assert client.post("/api/chat", json={}).status_code == 401


def test_stream_protocol_and_file_scope(client, monkeypatch):
    observed = []
    async def fake(data):
        observed.append(data)
        yield {"progress": {"stage": 0, "status": "running"}}
        yield {"delta": "완료"}
        yield {"done": True, "engine": "crewai-v1", "completedStages": 3}
    monkeypatch.setattr(chat, "analysis_events", fake)
    response = client.post("/api/chat", json=request_data("report").model_dump())
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/x-ndjson")
    assert response.headers["cache-control"] == "no-store"
    assert [json.loads(line) for line in response.text.splitlines()][-1]["completedStages"] == 3
    assert len(observed[0].files) == 1
    assert len(observed[0].files[0].reviews) == 2


def test_local_proxy_origin_is_not_trusted_on_vercel(client, monkeypatch):
    monkeypatch.setenv("REVIQ_LOCAL_PROXY", "1")
    headers = {"origin": "http://localhost:3000", "x-forwarded-host": "localhost:3000"}
    assert client.post("/api/chat", json={}, headers=headers).status_code == 400
    monkeypatch.setenv("VERCEL", "1")
    assert client.post("/api/chat", json={}, headers=headers).status_code == 403


def test_http_request_runs_full_crew_with_three_provider_calls(client, monkeypatch):
    from backend import llm
    from types import SimpleNamespace
    calls = []
    class Provider:
        def __init__(self, **kwargs):
            assert kwargs["max_retries"] == 0
            self.responses = self
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def create(self, **kwargs):
            calls.append(kwargs)
            assert kwargs["store"] is False
            # Reject CrewAI's cache_breakpoint exactly as Responses API does.
            assert all(set(message) == {"role", "content"} for message in kwargs["input"])
            return SimpleNamespace(status="completed", output_text=f"verified-provider-result-{len(calls)}")
    monkeypatch.setattr(llm, "AsyncOpenAI", Provider)
    response = client.post("/api/chat", json=request_data("report").model_dump())
    events = [json.loads(line) for line in response.text.splitlines()]
    assert len(calls) == 3
    assert "verified-provider-result-1" in json.dumps(calls[1]["input"])
    assert "verified-provider-result-1" in json.dumps(calls[2]["input"])
    assert "verified-provider-result-2" in json.dumps(calls[2]["input"])
    assert events[-2]["delta"] == "verified-provider-result-3"
    assert events[-1]["done"]


def chat_payload():
    from backend.models import source_fingerprints
    data = request_data("chat")
    return {**data.model_dump(), "report": {
        "promptVersion": "original-v1", "id": "report-1", "content": "저장된 종합 보고서: 포장 손상과 맛 만족.", "engine": "crewai-v1", "sources": source_fingerprints(data.files),
    }}


def test_chat_requires_report_matching_current_sources(client):
    data = chat_payload()
    missing = {**data, "report": None}
    assert client.post("/api/chat", json=missing).status_code == 409
    old_prompt = {**data, "report": {**data["report"], "promptVersion": ""}}
    assert client.post("/api/chat", json=old_prompt).status_code == 409
    data["files"][0]["reviews"][0]["text"] = "수정된 원문"
    response = client.post("/api/chat", json=data)
    assert response.status_code == 409
    assert response.json()["code"] == "report_stale"


def test_followup_chat_uses_saved_report_and_rows_in_one_call_per_question(client, monkeypatch):
    import httpx
    from openai import AsyncOpenAI
    from backend import chat as followup
    calls = []

    def transport(request):
        payload = json.loads(request.content)
        calls.append(payload)
        assert payload["stream"] is True and payload["store"] is False
        context = payload["instructions"] + payload["input"][0]["content"]
        assert "저장된 종합 보고서" in context
        assert "포장이 파손됐어요" in context
        assert "맛있어요" in context
        events = [
            {"type": "response.output_text.delta", "delta": "보고서와 원문 기반 답변", "output_index": 0, "content_index": 0, "item_id": "msg", "sequence_number": 1},
            {"type": "response.completed", "response": {"id": "resp", "object": "response", "status": "completed", "output": []}, "sequence_number": 2},
        ]
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content="".join("data: " + json.dumps(e) + "\n\n" for e in events))

    def provider(**kwargs):
        return AsyncOpenAI(**kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(transport)))
    def no_crew(*args, **kwargs):
        raise AssertionError("Follow-up chat must never run CrewAI")
    monkeypatch.setattr(followup, "AsyncOpenAI", provider)
    monkeypatch.setattr(chat, "analysis_events", no_crew)
    data = chat_payload()
    for question in ["어떤 문제가 있어?", "어떻게 개선할까?"]:
        data["messages"] = [{"role": "user", "content": question}]
        response = client.post("/api/chat", json=data)
        events = [json.loads(line) for line in response.text.splitlines()]
        assert events[-1] == {"done": True, "engine": "report-chat-v1", "reportId": "report-1"}
        assert not any("progress" in event for event in events)
    assert len(calls) == 2


def test_interrupted_chat_is_not_marked_complete(client, monkeypatch):
    from types import SimpleNamespace
    from backend import chat as followup
    class Stream:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def __aiter__(self):
            yield SimpleNamespace(type="response.output_text.delta", delta="부분 답변")
            yield SimpleNamespace(type="response.incomplete")
    class Provider:
        def __init__(self, **kwargs): self.responses = self
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def create(self, **kwargs): return Stream()
    monkeypatch.setattr(followup, "AsyncOpenAI", Provider)
    response = client.post("/api/chat", json=chat_payload())
    events = [json.loads(line) for line in response.text.splitlines()]
    assert events[0]["delta"] == "부분 답변"
    assert events[-1]["code"] == "chat_incomplete"
    assert not any(e.get("done") for e in events)


@pytest.mark.parametrize("shape", ["nested", "flat", "response.failed"])
@pytest.mark.parametrize("code,expected", [
    ("rate_limit_exceeded", "model_rate_limit"),
    ("credit_balance_exhausted", "model_credits"),
    ("context_length_exceeded", "model_context"),
])
def test_streaming_provider_errors_keep_their_category(client, monkeypatch, shape, code, expected):
    import httpx
    from openai import AsyncOpenAI
    from backend import chat as followup
    calls = []
    def transport(request):
        calls.append(request)
        detail = {"code": code, "message": "private provider message", "type": "test_error"}
        if shape == "nested": event = {"error": detail}
        elif shape == "flat": event = {**detail, "type": "error", "sequence_number": 1, "param": None}
        else: event = {"type": "response.failed", "sequence_number": 1,
                       "response": {"id": "resp", "object": "response", "status": "failed", "error": detail, "output": []}}
        return httpx.Response(200, headers={"content-type": "text/event-stream"},
                              content="data: " + json.dumps(event) + "\n\n")
    def provider(**kwargs):
        return AsyncOpenAI(**kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(transport)))
    monkeypatch.setattr(followup, "AsyncOpenAI", provider)
    response = client.post("/api/chat", json=chat_payload())
    events = [json.loads(line) for line in response.text.splitlines()]
    assert events[-1]["code"] == expected
    assert not any(e.get("done") for e in events)
    assert "private provider" not in response.text
    assert len(calls) == 1


def test_chat_transmits_report_and_long_original_data_once_without_omissions(client, monkeypatch):
    from types import SimpleNamespace
    from backend import chat as followup
    from backend.models import AnalysisRequest, compact_chat_sources, source_fingerprints
    data = chat_payload()
    data["files"][0]["reviews"][0]["text"] = "첫 리뷰 시작 " + "상세 리뷰 " * 1100 + " 첫 리뷰 끝"
    parsed = AnalysisRequest.model_validate(data)
    data["report"]["sources"] = source_fingerprints(parsed.files)
    source = compact_chat_sources(parsed.files)
    assert len(source) > 4000
    class Stream:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def __aiter__(self):
            yield SimpleNamespace(type="response.output_text.delta", delta="완료")
            yield SimpleNamespace(type="response.completed", response=SimpleNamespace(status="completed"))
    class Provider:
        def __init__(self, **kwargs): self.responses = self
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def create(self, **kwargs):
            prefix, context_json = kwargs["input"][0]["content"].split("\n", 1)
            context = json.loads(context_json)
            assert source[:4000] in kwargs["instructions"]
            assert context["sourceContinuation"] == source[4000:]
            assert "sources" not in context and "savedReport" not in context
            combined = kwargs["instructions"] + context_json
            assert combined.count(data["report"]["content"]) == 1
            assert "첫 리뷰 시작" in combined and "첫 리뷰 끝" in combined and "맛있어요" in combined
            return Stream()
    monkeypatch.setattr(followup, "AsyncOpenAI", Provider)
    response = client.post("/api/chat", json=data)
    assert json.loads(response.text.splitlines()[-1])["done"]
