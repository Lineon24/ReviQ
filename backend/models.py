import json
import hashlib
from collections import defaultdict
from datetime import date, datetime
from zoneinfo import ZoneInfo
from typing import Annotated, Literal

from pydantic import BaseModel, Field, StringConstraints, field_validator

ShortText = Annotated[str, StringConstraints(min_length=1, max_length=500)]
REPORT_PROMPT_VERSION = "original-v1"


class Review(BaseModel):
    category: ShortText
    product: ShortText
    productId: ShortText
    date: Annotated[str, StringConstraints(pattern=r"^\d{4}-\d{2}-\d{2}$")]
    company: ShortText
    mall: ShortText
    rating: Annotated[int, Field(strict=True, ge=1, le=5)]
    text: Annotated[str, StringConstraints(min_length=1, max_length=10000)]
    row: Annotated[int, Field(strict=True, ge=2)]
    sheet: ShortText

    @field_validator("date")
    @classmethod
    def valid_date(cls, value):
        date.fromisoformat(value)
        return value


class ReviewFile(BaseModel):
    id: Annotated[str, StringConstraints(max_length=100)]
    name: ShortText
    size: Annotated[float, Field(ge=0, allow_inf_nan=False)]
    addedAt: Annotated[str, StringConstraints(max_length=100)]
    reviews: Annotated[list[Review], Field(min_length=1, max_length=5000)]


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: Annotated[str, StringConstraints(max_length=40000)]


class ReportContext(BaseModel):
    id: Annotated[str, StringConstraints(min_length=1, max_length=100)]
    content: Annotated[str, StringConstraints(min_length=1, max_length=100000)]
    engine: Literal["crewai-v1"]
    sources: Annotated[dict[str, str], Field(min_length=1, max_length=10)]
    promptVersion: str = ""


class AnalysisRequest(BaseModel):
    files: Annotated[list[ReviewFile], Field(min_length=1, max_length=10)]
    messages: Annotated[list[Message], Field(max_length=30)]
    mode: Literal["chat", "report"]
    title: Annotated[str, StringConstraints(max_length=100)]
    report: ReportContext | None = None


def json_text(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def data_length(files):
    # Same UTF-16 units as JSON.stringify(...).length in the browser.
    value = json_text([r.model_dump() for f in files for r in f.reviews])
    return len(value.encode("utf-16-le")) // 2


def source_fingerprints(files):
    return {f.id: hashlib.sha256(json.dumps(
        {"name": f.name, "reviews": [r.model_dump() for r in f.reviews]},
        ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode()).hexdigest() for f in files}


def compact_chat_sources(files):
    """Lossless row encoding: repeated metadata once per group, not per row."""
    dates = list(dict.fromkeys(r.date for f in files for r in f.reviews))
    malls = list(dict.fromkeys(r.mall for f in files for r in f.reviews))
    date_ids = {value: index for index, value in enumerate(dates)}
    mall_ids = {value: index for index, value in enumerate(malls)}
    groups = {}
    for file in files:
        for row in file.reviews:
            key = (file.id, row.sheet, row.company, row.category, row.product, row.productId)
            if key not in groups:
                groups[key] = {"file": file.name, "sheet": row.sheet, "company": row.company,
                               "category": row.category, "product": row.product, "productId": row.productId,
                               "reviews": []}
            groups[key]["reviews"].append([date_ids[row.date], mall_ids[row.mall], row.rating, row.text, row.row])
    return json_text({
        "format": "reviews 배열의 각 행은 columns 순서입니다. dateIndex와 mallIndex는 dates와 malls의 0부터 시작하는 위치입니다. 같은 그룹의 메타 정보를 모든 행에 적용하세요.",
        "columns": ["dateIndex", "mallIndex", "rating", "text", "row"],
        "dates": dates, "malls": malls, "groups": list(groups.values()),
    })


def report_context(files):
    """Adapt web uploads to the original CLI prompt's metadata and row format."""
    stats = summarize(files)
    rows = [(f.name, r) for f in files for r in f.reviews]
    meta = {
        "company_name": " · ".join(dict.fromkeys(r.company for _, r in rows)),
        "total_reviews": stats["count"],
        "min_date": stats["startDate"].replace("-", "."),
        "max_date": stats["endDate"].replace("-", "."),
        "today_str": datetime.now(ZoneInfo("Asia/Seoul")).strftime("%Y년 %m월 %d일"),
        "overall_mall_summary": " | ".join(
            f"**{m['name']}**: {m['count']}건 ({m['count'] / stats['count'] * 100:.1f}%)"
            for m in stats["malls"]
        ),
    }
    context = f"""=== [동적 분석 메타 정보] ===
- 회사명: {meta['company_name']}
- 전체 리뷰 수: {meta['total_reviews']}건
- 분석 대상 기간: {meta['min_date']} ~ {meta['max_date']}
- 분석 생성일: {meta['today_str']}
- 전체 쇼핑몰별 리뷰 비중: {meta['overall_mall_summary']}

=== [상세 리뷰 데이터] ===
"""
    categories = defaultdict(list)
    for filename, row in rows:
        categories[row.category].append((filename, row))
    for category, items in sorted(categories.items()):
        context += f"■ 카테고리: {category} (총 {len(items)}건)\n"
        for filename, row in items:
            context += (f"  [{row.date} | 쇼핑몰: {row.mall} | 상품: {row.product}(ID:{row.productId}) | 별점: {row.rating}점] "
                        f"리뷰: {row.text} [출처: {filename} · {row.sheet} · {row.row}행]\n")
        context += "\n"
    return context, meta


def summarize(files):
    rows = [r for f in files for r in f.reviews]
    count = len(rows)
    positive = sum(r.rating >= 4 for r in rows)
    negative = sum(r.rating <= 2 for r in rows)

    def groups(key):
        grouped = defaultdict(list)
        for row in rows:
            name = f"{row.product} ({row.productId})" if key == "product" else getattr(row, key)
            grouped[name].append(row)
        return sorted([
            {"name": name, "count": len(items), "negative": sum(r.rating <= 2 for r in items),
             "average": round(sum(r.rating for r in items) / len(items), 2)}
            for name, items in grouped.items()
        ], key=lambda item: -item["count"])

    dates = sorted(r.date for r in rows)
    return {
        "count": count, "positive": positive, "negative": negative, "neutral": count - positive - negative,
        "average": round(sum(r.rating for r in rows) / count, 2),
        "positiveRate": round(positive / count * 100, 1), "negativeRate": round(negative / count * 100, 1),
        "startDate": dates[0], "endDate": dates[-1],
        "products": groups("product"), "malls": groups("mall"), "days": groups("date"),
    }
