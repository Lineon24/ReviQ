import asyncio
import json
from types import SimpleNamespace

import pytest

# Import analysis first to disable CrewAI telemetry for tests as in production.
from backend.analysis import RequestOutputStorage, analysis_events, build_crew
from backend.models import AnalysisRequest, summarize
from crewai.llms.base_llm import BaseLLM


def request_data(mode="chat", product="테스트 상품"):
    return AnalysisRequest.model_validate({
        "files": [{"id": "one", "name": "리뷰.csv", "size": 100, "addedAt": "2026-09-22", "reviews": [
            {"category": "식품", "product": product, "productId": "P1", "date": "2026-09-01", "company": "회사", "mall": "쿠팡", "rating": 1, "text": "포장이 파손됐어요", "row": 2, "sheet": "CSV"},
            {"category": "식품", "product": product, "productId": "P1", "date": "2026-09-02", "company": "회사", "mall": "네이버", "rating": 5, "text": "맛있어요", "row": 3, "sheet": "CSV"},
        ]}], "messages": [{"role": "user", "content": "문제가 뭐야?"}], "mode": mode, "title": "검증",
    })


class ScriptedLLM(BaseLLM):
    index: int
    record: list
    fail: bool = False
    cancelled: list
    stall: bool = False

    def call(self, messages, **kwargs):
        raise AssertionError("Must use native async, not a background thread")

    async def acall(self, messages, **kwargs):
        self.record.append((self.index, json.dumps(messages, ensure_ascii=False)))
        if self.fail:
            raise RuntimeError("Synthetic agent failure")
        if self.stall:
            try:
                await asyncio.sleep(60)
            finally:
                self.cancelled.append(self.index)
        return f"Final Answer: agent-{self.index}-verified-result"


def factory(record, crews, *, fail=-1, stall=-1, cancelled=None):
    def create(data, notify):
        def llm(index):
            model = ScriptedLLM(model="test-only", index=index, record=[], cancelled=[], fail=index == fail, stall=index == stall)
            # Pydantic copies input lists, so share test observation sinks explicitly.
            model.record = record
            model.cancelled = cancelled if cancelled is not None else []
            return model
        crew = build_crew(data, notify, llm_factory=llm)
        crews.append(crew)
        return crew
    return create


@pytest.mark.parametrize("mode", ["chat", "report"])
def test_real_crewai_executes_three_agents_and_passes_task_outputs(mode):
    record, crews = [], []

    async def run():
        return [event async for event in analysis_events(request_data(mode), factory(record, crews))]

    events = asyncio.run(run())
    assert [index for index, _ in record] == [0, 1, 2]
    assert "agent-0-verified-result" in record[1][1]
    assert "agent-0-verified-result" in record[2][1]
    assert "agent-1-verified-result" in record[2][1]
    assert events[-2] == {"delta": "agent-2-verified-result"}
    assert events[-1]["done"] and events[-1]["engine"] == "crewai-v1" and events[-1]["completedStages"] == 3
    assert set(events[-1]["report"]["sources"]) == {"one"}
    assert events[-1]["report"]["id"]
    assert [e["progress"] for e in events if "progress" in e] == [
        {"stage": i, "status": status} for i in range(3) for status in ("running", "completed")
    ]
    assert isinstance(crews[0]._task_output_handler, RequestOutputStorage)
    assert len(crews[0]._task_output_handler.load()) == 3
    assert len({id(a) for a in crews[0].agents}) == 3


def test_second_agent_failure_never_runs_reporter_or_emits_success():
    record, crews = [], []

    async def run():
        return [e async for e in analysis_events(request_data(), factory(record, crews, fail=1))]

    events = asyncio.run(run())
    assert [index for index, _ in record] == [0, 1]
    assert "error" in events[-1]
    assert not any("done" in e or "delta" in e for e in events)


def test_timeout_and_disconnect_cancel_inflight_agent():
    async def run():
        for timeout in (True, False):
            record, crews, cancelled = [], [], []
            events = analysis_events(request_data(), factory(record, crews, stall=0, cancelled=cancelled), timeout=0.1 if timeout else 30)
            if timeout:
                received = [e async for e in events]
                assert "초과" in received[-1]["error"]
            else:
                await anext(events)
                pending = asyncio.create_task(anext(events))
                while not record:
                    await asyncio.sleep(0.01)
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
                await events.aclose()
            assert cancelled == [0]
            assert [index for index, _ in record] == [0]
    asyncio.run(run())


def test_concurrent_crews_do_not_share_sources_or_outputs():
    async def run():
        async def one(product):
            record, crews = [], []
            events = [e async for e in analysis_events(request_data(product=product), factory(record, crews))]
            return record, crews[0], events
        return await asyncio.gather(one("상품-A"), one("상품-B"))
    first, second = asyncio.run(run())
    assert "상품-B" not in first[0][0][1]
    assert "상품-A" not in second[0][0][1]
    assert first[1]._task_output_handler is not second[1]._task_output_handler
    assert first[2][-1]["done"] and second[2][-1]["done"]


def test_statistics_are_computed_from_selected_rows():
    data = request_data()
    stats = summarize(data.files)
    assert (stats["count"], stats["positive"], stats["negative"], stats["average"]) == (2, 1, 1, 3)
    assert stats["malls"][0]["negative"] == 1
    assert stats["malls"][1]["negative"] == 0


def test_production_prompts_match_original_python_without_shortening():
    """Compare against the user's source, without running its CLI or SDK setup."""
    import ast
    from pathlib import Path
    from backend.models import report_context, REPORT_PROMPT_VERSION
    from backend.prompts import build_chat_prompt

    tree = ast.parse((Path(__file__).parents[2] / "legacy/chat_ai.py").read_text())
    data = request_data("report")
    context, meta = report_context(data.files)
    crew = factory([], [])(data, lambda event: None)
    names = ["trend_analyzer", "root_cause_assessor", "executive_reporter"]
    for name, agent in zip(names, crew.agents):
        original = next(n for n in tree.body if isinstance(n, ast.Assign)
                        and isinstance(n.targets[0], ast.Name) and n.targets[0].id == name)
        for kw in original.value.keywords:
            if kw.arg in ("role", "goal", "backstory"):
                assert getattr(agent, kw.arg) == ast.literal_eval(kw.value)
    original_tasks = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "build_tasks")
    scope = {"Task": SimpleNamespace, **dict(zip(names, crew.agents))}
    exec(compile(ast.Module(body=[original_tasks], type_ignores=[]), "original-prompts", "exec"), scope)
    expected = scope["build_tasks"](context, meta)
    for index, (actual, original) in enumerate(zip(crew.tasks, expected)):
        assert actual.description == original.description
        assert actual.expected_output == original.expected_output
        assert actual.agent is crew.agents[index]
        if index:
            assert actual.context == crew.tasks[:index]
    original_chat = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "run_chatbot_session")
    expression = next(n.value for n in original_chat.body if isinstance(n, ast.Assign)
                      and isinstance(n.targets[0], ast.Name) and n.targets[0].id == "system_prompt")
    chat_scope = {"parsed_context": context, "meta_info": meta, "final_report": "완성 보고서"}
    expected_chat = eval(compile(ast.Expression(expression), "original-chat", "eval"), chat_scope)
    assert build_chat_prompt(context, meta, "완성 보고서") == expected_chat
    assert REPORT_PROMPT_VERSION == "original-v1"


def test_original_prompt_metadata_includes_all_uploaded_files():
    from backend.models import report_context
    data = request_data("report")
    second = data.files[0].model_copy(deep=True)
    second.id, second.name = "two", "추가.xlsx"
    second.reviews = [second.reviews[0]]
    second.reviews[0].company = "두 번째 회사"
    second.reviews[0].product = "두 번째 상품"
    context, meta = report_context([*data.files, second])
    assert meta["total_reviews"] == 3
    assert meta["company_name"] == "회사 · 두 번째 회사"
    assert meta["min_date"] == "2026.09.01" and meta["max_date"] == "2026.09.02"
    assert meta["overall_mall_summary"] == "**쿠팡**: 2건 (66.7%) | **네이버**: 1건 (33.3%)"
    assert "두 번째 상품" in context and "추가.xlsx · CSV · 2행" in context


def test_compact_chat_encoding_recovers_every_original_row_and_source():
    from backend.models import compact_chat_sources
    data = request_data("report")
    second = data.files[0].model_copy(deep=True)
    second.id = "two"
    second.name = "추가.xlsx"
    second.reviews[0].productId = "P2"
    second.reviews[1].sheet = "다른 시트"
    second.reviews[1].text = '여러 줄\n"맛" 평가도 그대로'
    data.files.append(second)
    encoded = json.loads(compact_chat_sources(data.files))
    recovered = []
    for group in encoded["groups"]:
        for date_index, mall_index, rating, text, row in group["reviews"]:
            recovered.append({
                **{key: value for key, value in group.items() if key != "reviews"},
                "date": encoded["dates"][date_index], "mall": encoded["malls"][mall_index],
                "rating": rating, "text": text, "row": row,
            })
    expected = [{"file": f.name, **r.model_dump()} for f in data.files for r in f.reviews]
    sort_key = lambda row: json.dumps(row, sort_keys=True, ensure_ascii=False)
    assert sorted(recovered, key=sort_key) == sorted(expected, key=sort_key)


def test_asgi_24_disconnect_cancels_agent_without_waiting_for_a_chunk():
    async def run():
        record, crews, cancelled = [], [], []
        async def disconnected():
            return bool(record)
        events = [e async for e in analysis_events(request_data(), factory(record, crews, stall=0, cancelled=cancelled), disconnected=disconnected)]
        assert cancelled == [0]
        assert not any(e.get("done") or e.get("delta") for e in events)
    asyncio.run(run())


def test_llm_adapter_rejects_incomplete_provider_output(monkeypatch):
    from backend import llm
    class Client:
        def __init__(self, **kwargs):
            self.responses = self
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def create(self, **kwargs):
            assert kwargs["store"] is False
            return SimpleNamespace(status="incomplete", output_text="partial report")
    monkeypatch.setenv("OPENAI_API_KEY", "test-only-never-sent")
    monkeypatch.setattr(llm, "AsyncOpenAI", Client)
    from backend.errors import AnalysisError
    with pytest.raises(AnalysisError) as captured:
        asyncio.run(llm.ReviewLLM(model="test").acall("question"))
    assert captured.value.code == "model_incomplete"
