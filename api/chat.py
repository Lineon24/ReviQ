"""Vercel Python function; same /api/chat contract as the browser client."""
import hashlib
import hmac
import os
import time
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import ValidationError

from backend.analysis import analysis_events
from backend.chat import chat_events
from backend.models import REPORT_PROMPT_VERSION, AnalysisRequest, data_length, json_text, source_fingerprints

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


def authenticated(request):
    password = os.getenv("APP_PASSWORD", "")
    if not password:
        return not os.getenv("VERCEL")
    try:
        expiry, signature = request.cookies.get("review_session", "").split(".")
        expected = hmac.new(password.encode(), expiry.encode(), hashlib.sha256).hexdigest()
        return int(expiry) > time.time() * 1000 and hmac.compare_digest(signature, expected)
    except (ValueError, TypeError):
        return False


def same_origin(request):
    origin = request.headers.get("origin")
    if not origin:
        return True
    try:
        source = urlsplit(origin)
        host = request.headers.get("host", "")
        # Local Next.js proxy changes Host; its original host is allowed only
        # when explicitly configured by our local launcher, never on Vercel.
        local_host = request.headers.get("x-forwarded-host") if os.getenv("REVIQ_LOCAL_PROXY") and not os.getenv("VERCEL") else None
        return source.scheme in ("http", "https") and (
            source.netloc == host or (local_host is not None and source.netloc == local_host)
        )
    except ValueError:
        return False


def error(message, status, code=None):
    return JSONResponse({"error": message, "code": code}, status_code=status, headers={"Cache-Control": "no-store"})


@app.post("/api/chat")
async def chat(request: Request):
    if not same_origin(request):
        return error("허용되지 않은 요청입니다.", 403)
    if not authenticated(request):
        return error("워크스페이스에 로그인해주세요.", 401)
    if not os.getenv("OPENAI_API_KEY"):
        return error("AI 연결을 위해 서버에 OPENAI_API_KEY를 설정해주세요.", 503)
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 2_000_000:
            return error("요청 데이터가 너무 큽니다.", 413)
    try:
        data = AnalysisRequest.model_validate_json(raw)
    except (ValidationError, ValueError):
        return error("분석 데이터 형식이 올바르지 않습니다. 파일을 다시 올려주세요.", 400)
    if data_length(data.files) > 160000:
        return error("분석 데이터가 너무 큽니다. 파일을 나누어 프로젝트를 만들어주세요.", 413)
    if data.mode == "chat" and (not data.messages or data.messages[-1].role != "user" or not data.messages[-1].content.strip()):
        return error("분석할 질문을 입력해주세요.", 400)
    if len({f.id for f in data.files}) != len(data.files):
        return error("중복된 파일 식별자가 있습니다. 파일을 다시 올려주세요.", 400)
    if data.mode == "chat":
        if not data.report or data.report.promptVersion != REPORT_PROMPT_VERSION or any(data.report.sources.get(key) != value for key, value in source_fingerprints(data.files).items()):
            return error("현재 자료의 분석 보고서가 필요합니다. 보고서를 먼저 생성해주세요.", 409, "report_stale")

    async def stream():
        # ASGI >= 2.4 only notices send failures between chunks in Starlette.
        # Poll disconnects while an agent is waiting for its model response.
        spec = tuple(map(int, request.scope.get("asgi", {}).get("spec_version", "2.0").split(".")))
        options = {"disconnected": request.is_disconnected} if spec >= (2, 4) else {}
        events = analysis_events(data, **options) if data.mode == "report" else chat_events(data, **options)
        try:
            async for event in events:
                yield json_text(event) + "\n"
        finally:
            await events.aclose()

    return StreamingResponse(stream(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
