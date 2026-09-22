"""Fast follow-up chat: one streamed model call using a saved report and rows."""
import asyncio
import logging
import os

from openai import APIError, AsyncOpenAI, OpenAIError

from backend.analysis import RULES
from backend.errors import AnalysisError, provider_error
from backend.models import json_text, summarize, report_context, compact_chat_sources
from backend.prompts import build_chat_prompt

CHAT_ENGINE = "report-chat-v1"


async def chat_events(data, disconnected=None):
    queue = asyncio.Queue()

    async def execute():
        try:
            async with asyncio.timeout(100):
                _, meta_info = report_context(data.files)
                parsed_context = compact_chat_sources(data.files)
                context = {
                    "selectedFiles": [f.name for f in data.files],
                    "statistics": summarize(data.files),
                    # Original chat prompt already includes the report and the
                    # first 4,000 characters. Send only the continuation here;
                    # no rows are omitted and no report text is duplicated.
                    "sourceContinuation": parsed_context[4000:],
                }
                async with AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"], timeout=80, max_retries=0) as client:
                    upstream = await client.responses.create(
                        model=os.getenv("OPENAI_MODEL") or "gpt-4o", store=False, stream=True,
                        max_output_tokens=3500,
                        instructions=build_chat_prompt(parsed_context, meta_info, data.report.content) + "\n" + RULES +
                        "\nsourceContinuation은 위 파싱된 원본 리뷰 데이터 4,000자 이후의 나머지 전문입니다. "
                        "앞부분과 연결하면 선택한 원문 전체이므로 모두 함께 참고하세요. "
                        "보고서는 프로젝트 전체 범위일 수 있지만 답변의 사실과 수치는 selectedFiles의 원문·통계로 확인하세요. "
                        "선택하지 않은 파일의 사실은 질문의 근거로 사용하지 마세요. 보고서와 원문이 다르면 원문과 코드 통계를 우선하세요.",
                        input=[{"role": "user", "content": "아래 JSON은 보고서와 원문 자료입니다:\n" + json_text(context)}]
                              + [m.model_dump() for m in data.messages],
                    )
                    text = ""
                    completed = False
                    async with upstream:
                        async for event in upstream:
                            if event.type == "response.output_text.delta":
                                text += event.delta
                                await queue.put({"delta": event.delta})
                            elif event.type == "response.completed":
                                completed = event.response.status == "completed"
                            elif event.type in ("response.failed", "error"):
                                detail = getattr(getattr(event, "response", None), "error", None) or event
                                raise APIError(getattr(detail, "message", None) or "Streaming response failed", request=upstream.response.request, body={
                                    "code": getattr(detail, "code", None),
                                    "type": getattr(detail, "type", None),
                                    "message": getattr(detail, "message", None),
                                })
                            elif event.type == "response.incomplete":
                                raise AnalysisError("chat_incomplete", "답변 생성이 중단되었습니다. 다시 질문해주세요.")
                    if not completed or not text.strip():
                        raise AnalysisError("chat_incomplete", "답변이 완성되지 않았습니다. 다시 질문해주세요.")
                    await queue.put({"done": True, "engine": CHAT_ENGINE, "reportId": data.report.id})
        except OpenAIError as error:
            safe = provider_error(error)
            logging.getLogger(__name__).error("Chat provider failure: class=%s status=%s category=%s",
                                             type(error).__name__, getattr(error, "status_code", None), safe.code)
            await queue.put({"error": str(safe), "code": safe.code})
        except AnalysisError as error:
            await queue.put({"error": str(error), "code": error.code})
        except TimeoutError:
            await queue.put({"error": "답변 시간이 초과되었습니다. 다시 질문해주세요.", "code": "chat_timeout"})
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logging.getLogger(__name__).error("Chat failed: type=%s", type(error).__name__)
            await queue.put({"error": "채팅 처리 중 내부 오류가 발생했습니다. 서버 로그를 확인해주세요.", "code": "chat_internal"})

    execution = asyncio.create_task(execute())
    try:
        while True:
            if disconnected and await disconnected():
                break
            try:
                event = await asyncio.wait_for(queue.get(), 0.5) if disconnected else await queue.get()
            except TimeoutError:
                continue
            yield event
            if event.get("done") or event.get("error"):
                break
    finally:
        execution.cancel()
        await asyncio.gather(execution, return_exceptions=True)
