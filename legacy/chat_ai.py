import asyncio
from datetime import datetime
import os
from crewai import Agent, Crew, LLM, Process, Task
from dotenv import load_dotenv
import pandas as pd
from openai import OpenAI

# 0. 환경 변수 로드 (.env의 OPENAI_API_KEY 사용)
load_dotenv()

# 분석 대상 엑셀 파일 경로 (원하는 엑셀 파일명으로 변경 가능)
EXCEL_FILE_PATH = "OTOKI_reviews.xlsx"

# 필수 포함 엑셀 열(Column)
REQUIRED_COLUMNS = [
    "카테고리",
    "상품",
    "상품ID",
    "날짜",
    "회사",
    "쇼핑몰",
    "별점",
    "리뷰 원문",
]


# ==============================================================================
# 1. 엑셀 데이터 파싱 & 동적 메타데이터 계산 모듈 (LLM 환각 방지)
# ==============================================================================
def validate_and_parse_excel(file_path: str) -> tuple[bool, str, dict]:
    if not os.path.exists(file_path):
        return (
            False,
            f"🚨 [{file_path}] 파일이 존재하지 않습니다. 먼저 리뷰 엑셀 파일을 준비해 주세요.",
            {},
        )

    try:
        df = pd.read_excel(file_path)
    except Exception as e:
        return False, f"🚨 엑셀 파일을 읽을 수 없습니다: {str(e)}", {}

    if df.empty:
        return False, "🚨 엑셀 파일에 데이터가 존재하지 않습니다.", {}

    # 필수 컬럼 검증
    missing_cols = [col for col in REQUIRED_COLUMNS if col not in df.columns]
    if missing_cols:
        return (
            False,
            f"🚨 엑셀 필수 열이 누락되었습니다. [누락된 열: {', '.join(missing_cols)}]",
            {},
        )

    # 행 단위 데이터 이상치 검증
    error_details = []
    for idx, row in df.iterrows():
        row_num = idx + 2
        if pd.isna(row["카테고리"]) or str(row["카테고리"]).strip() == "":
            error_details.append(f"[{row_num}행] '카테고리' 비어있음")
        if pd.isna(row["상품"]) or str(row["상품"]).strip() == "":
            error_details.append(f"[{row_num}행] '상품' 비어있음")
        if pd.isna(row["리뷰 원문"]) or str(row["리뷰 원문"]).strip() == "":
            error_details.append(f"[{row_num}행] '리뷰 원문' 비어있음")

    if error_details:
        return (
            False,
            "🚨 1차 엑셀 데이터 무결성 검증 실패:\n"
            + "\n".join(error_details[:5]),
            {},
        )

    # 📊 [동적 메타데이터 자동 추출]
    company_name = (
        str(df["회사"].dropna().iloc[0]).strip()
        if not df["회사"].dropna().empty
        else "미지정 회사"
    )
    total_reviews = len(df)

    # 날짜 범위 계산 (YYYY.MM.DD)
    df["날짜_dt"] = pd.to_datetime(df["날짜"], errors="coerce")
    min_date = (
        df["날짜_dt"].min().strftime("%Y.%m.%d")
        if pd.notnull(df["날짜_dt"].min())
        else "날짜 미상"
    )
    max_date = (
        df["날짜_dt"].max().strftime("%Y.%m.%d")
        if pd.notnull(df["날짜_dt"].max())
        else "날짜 미상"
    )
    today_str = datetime.now().strftime("%Y년 %m월 %d일")

    # 쇼핑몰별 전체 리뷰 비중 동적 계산
    mall_counts = df["쇼핑몰"].value_counts()
    overall_mall_summary = " | ".join(
        [
            f"**{mall}**: {cnt}건 ({(cnt/total_reviews)*100:.1f}%)"
            for mall, cnt in mall_counts.items()
        ]
    )

    meta_info = {
        "company_name": company_name,
        "total_reviews": total_reviews,
        "min_date": min_date,
        "max_date": max_date,
        "today_str": today_str,
        "overall_mall_summary": overall_mall_summary,
    }

    # Structured Text 주입
    context = f"""=== [동적 분석 메타 정보] ===
- 회사명: {company_name}
- 전체 리뷰 수: {total_reviews}건
- 분석 대상 기간: {min_date} ~ {max_date}
- 분석 생성일: {today_str}
- 전체 쇼핑몰별 리뷰 비중: {overall_mall_summary}

=== [상세 리뷰 데이터] ===
"""
    for category, group in df.groupby("카테고리"):
        context += f"■ 카테고리: {category} (총 {len(group)}건)\n"
        for _, row in group.iterrows():
            context += (
                f"  [{row['날짜']} | 쇼핑몰: {row['쇼핑몰']} | 상품: {row['상품']}(ID:{row['상품ID']}) | 별점: {row['별점']}점] "
                f"리뷰: {row['리뷰 원문']}\n"
            )
        context += "\n"

    return True, context, meta_info


# ==============================================================================
# 2. Multi-Agent & Task 정의
# ==============================================================================
llm_engine = LLM(
    model="gpt-5.6",
    api_key=os.getenv("OPENAI_API_KEY"),
    #temperature=0.1,
)

trend_analyzer = Agent(
    role="데이터 정량 통계 분석가",
    goal="입력 데이터에서 실제 상품명 유지, 쇼핑몰별 부정 건수, 긍/부정 키워드를 정량 추출한다.",
    backstory="당신은 사실 데이터 추출 전문 수석 분석가입니다. 없는 수치를 지어내지 않고 데이터에 기반해서만 정량화합니다.",
    llm=llm_engine,
    verbose=False,
)

root_cause_assessor = Agent(
    role="원인 역추적 평가원",
    goal="부정 리뷰 발생 패턴을 다각도로 분석하여 원인(물류 vs 공장)과 Churn Risk를 상품별로 다르게 역추적한다.",
    backstory="당신은 QA 총괄 리드로서 논리적 추론(CoT/ReAct)을 사용하여 이상 징후의 근본 원인을 상품별로 분석해 냅니다.",
    llm=llm_engine,
    verbose=False,
)

executive_reporter = Agent(
    role="전사 B2B 최종 보고서 리포터",
    goal="동적 메타 정보 및 개별 상품 수치를 반영한 풍부한 마크다운 종합 보고서를 작성한다.",
    backstory="당신은 C-Level 직속 테크니컬 라이터입니다. 전달받은 정량 수치를 바탕으로 명확한 두괄식 마크다운 보고서를 출력합니다.",
    llm=llm_engine,
    verbose=False,
)


def build_tasks(parsed_context_text: str, meta_info: dict):

    task1 = Task(
        description=f"""
[입력 데이터 및 메타 정보]:
{parsed_context_text}

[작업 지침]:
1. 입력 데이터상의 **실제 상품명과 상품ID**를 그대로 유지하세요.
2. 각 상품별로 전체 데이터 건수에 맞춰 다음을 정밀 파싱하세요:
   - **쇼핑몰별 리뷰 비중** (% 및 실제 건수)
   - **쇼핑몰별 부정 리뷰(1~2점) 발생 건수** (예: 쿠팡 8건 | 네이버 6건 ...)
   - 🌟 **[핵심] 부정 리뷰(1~2점) 발생 날짜 및 일자별 건수 분포**: 부정 리뷰가 발생한 정확한 날짜(YYYY-MM-DD)와 해당 날짜의 부정 리뷰 건수를 명확히 파싱하세요 (예: 2026-05-10에 쿠팡 부정 리뷰 10건 집중 발생).
   - **상품 상태(State) 분포 표**: 식품 도메인 세부 속성(풍미/맛, 짠맛/간, 찰기/식감, 건더기/양, 포장 개봉성 등)
   - **전체 긍/부정 비율 (%) 및 실제 건수**
   - **긍정 주요 피드백 (Top 3)**: "문구" ── X건 / 전체 N건 (비율%)
   - **부정 주요 피드백 (Top 3)**: "문구" ── X건 / 전체 N건 (비율%)

[엄격 제약사항]:
- 부정 리뷰가 집중 발생한 특정 날짜(YYYY-MM-DD)를 절대로 누락하지 말고 기록하세요.
""",
        expected_output="상품별 부정 리뷰 집중 발생 일자(YYYY-MM-DD), 쇼핑몰별 부정 건수, 세부 속성 표, 긍/부정 Top3 집계 결과",
        agent=trend_analyzer,
    )


    task2 = Task(
            description="""
[이전 분석 결과]:
task1의 정량 집계를 바탕으로 각 상품별 이상 탐지 및 날짜 기반 원인 역추적을 수행하세요.


[날짜 역추적 및 원인 판별 규칙]:
1. **[이슈 집중 발생일]**: task1에서 파싱된 부정 리뷰 폭증 날짜(예: 2026-05-07)를 명시하세요.
2. **[추정 공장 출고/생산일 역산]**:
   - e-커머스 평균 배송 소요시간(1~2일)을 감안하여, **[리뷰 집중 작성일(T) - 1~2일 = 추정 출고/생산일(T-1~2일)]**로 역산하여 명시하세요.
   - 예: 5월 7일 리뷰 폭증 ➔ 추정 공장 출고일: 5월 5일~5월 6일 출고분 (Batch #0505)
3. **[원인 구분]**:
   - 특정 쇼핑몰 특정 일자 집중 ➔ '물류창고 보관/배송 충격 결함'
   - 전 쇼핑몰 공통 특정 일자 집중 ➔ '공장 특정 날짜 생산 설비/포장 결함'
4. **[상태/이슈 구분]** 및 Churn Risk Score, 예상 손실 금액을 정밀 산출하세요.
""",
        expected_output="이슈 집중 발생일 및 추정 공장 출고일이 역산된 상품별 원인 역추적 결과",
        agent=root_cause_assessor,
        context=[task1],
    )

    task3 = Task(
        description=f"""
[전사 메타 정보]:
- **회사명**: {meta_info['company_name']}
- **분석 생성일**: {meta_info['today_str']}
- **분석 대상 기간**: {meta_info['min_date']} ~ {meta_info['max_date']}
- **전체 분석 리뷰 수**: 총 {meta_info['total_reviews']}건
- **전체 쇼핑몰별 리뷰 비중**: {meta_info['overall_mall_summary']}

[보고서 필수 구조 (Schema Enforcement)]:
# 🏢 {meta_info['company_name']}
## 📊 전사 B2B 제품 품질 & 고객 피드백 종합 분석 보고서
- **분석 생성일**: {meta_info['today_str']}
- **분석 대상 기간**: {meta_info['min_date']} ~ {meta_info['max_date']}
- **총 분석 리뷰 수**: 총 {meta_info['total_reviews']}건
- **전체 쇼핑몰별 리뷰 비중**: {meta_info['overall_mall_summary']}

---

## 📄 [보고서 N] [카테고리명]: [실제 상품명] ([상품ID])

### 1. 🏬 쇼핑몰 점유율 & 상품 상태(State) 분포
* **[쇼핑몰별 리뷰 비중]**: (해당 상품 쇼핑몰별 건수 및 %) [총 N건]
* **[쇼핑몰별 부정 리뷰 발생 건수]**: 쿠팡 X건 | 네이버 Y건 ... (상세 명시)
* **[상품 상태(State) 분포 표]**: 
  | 측정 속성 (맛/간/식감/포장개봉성 등) | 상태(State) 구분 | 리뷰 건수 / 비율 | 최종 상태 평가 |

### 2. 📊 긍/부정 키워드 비율 및 주요 피드백 건수
- **전체 긍/부정 비율**: 긍정 X% (A건) : 부정 Y% (B건)
- **긍정 주요 피드백 (Top 3)**:
  * 긍정 1: "문구" ── X건 / 전체 N건 (A%)
  * 긍정 2: "문구" ── Y건 / 전체 N건 (B%)
  * 긍정 3: "문구" ── Z건 / 전체 N건 (C%)
- **부정 주요 피드백 (Top 3)**:
  * 부정 1: "문구" ── X건 / 전체 N건 (A%) [⚠️ 경고]
  * 부정 2: "문구" ── Y건 / 전체 N건 (B%)
  * 부정 3: "문구" ── Z건 / 전체 N건 (C%)

### 3. 🚨 이상 징후 탐지 및 날짜/쇼핑몰 원인 역추적 (Root Cause)
* **[상태/이슈 구분]**: (예: 공장 설비 결함 - 이지컷 노칭 칼날 마모)
* **[이슈 집중 작성 날짜]**: YYYY년 MM월 DD일 (특정 날짜 부정 리뷰 X건 집중 출현)
* **[추정 공장 출고/생산일]**: YYYY년 MM월 DD일 ~ YYYY년 MM월 DD일 출고분 (배송일 1~2일 역산 추정)
* **발생 이슈 및 이상 탐지 내역**: (날짜와 쇼핑몰 명시)
* **원인 역추적 (Root Cause)**: (이슈 발생 일자 및 출고일 기준 물류 vs 공장 상세 역추적 서술)
* **고객 이탈 위험도 (Churn Risk Score)**: X점 / 100점
* **💰 예상 손실 금액 추정**: 정량적 손실액 추정치

### 4. 📝 C-Level 두괄식 종합 요약
> **[두괄식 핵심 요약]** (인용구 블록)

### 5. 👥 이해관계자(부서별) 전달 및 조치 사항
* 👑 **경영진 (C-Level)**:
* 🔍 **품질관리팀 (QC)**:
* 🚚 **물류/SCM팀**:
* 🛠️ **제품기획팀 (PM)**:
* 🎧 **CS팀**:
* 📢 **마케팅/영업팀**:

[🚨 마크다운 문법 절대 금지 제약사항]:
- `> [!IMPORTANT]`, `> [!WARNING]`, `> **데이터 정합성 주의:**` 문법 및 인용구 상자를 보고서 어디에도 절대 작성하지 마세요.
- 전달받은 메타 정보 수치를 절대 의심하거나 재산출 문구를 덧붙이지 마세요.
""",
        expected_output="식품 도메인 세부 속성과 세부 이슈 구분이 완벽히 적용된 최종 마크다운 보고서",
        agent=executive_reporter,
        context=[task1, task2],
    )

    return [task1, task2, task3]

# ==============================================================================
# 3. 대화형 챗봇 AI 세션 모듈 (추가된 기능)
# ==============================================================================
async def run_chatbot_session(parsed_context: str, meta_info: dict, final_report: str):
    client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

    system_prompt = f"""
당신은 {meta_info['company_name']}의 B2B 리포트 및 리뷰 데이터 전문 AI 컨설턴트입니다.
사용자는 엑셀 파일 분석 결과 및 생성된 보고서에 대해 궁금한 점을 질문하거나 추가 요구사항을 요청할 것입니다.

[시스템에 주입된 데이터 맥락]
1. 분석 메타 정보:
   - 회사명: {meta_info['company_name']}
   - 총 리뷰 건수: {meta_info['total_reviews']}건
   - 분석 기간: {meta_info['min_date']} ~ {meta_info['max_date']}

2. 생성된 최종 보고서 전문:
{final_report}

3. 파싱된 원본 리뷰 데이터:
{parsed_context[:4000]} (중략)

[답변 수칙]
- 위 데이터와 보고서 내용에 철저히 근거하여 답변하세요.
- 데이터에 없는 사실을 임의로 지어내지 마세요.
- 사용자가 특정 질문(예: 특정 쇼핑몰 분석, 특정 부서 조치사항 확대, 재작성 요구 등)을 할 경우 친절하고 전문적으로 답변해 주세요.
"""

    messages = [{"role": "system", "content": system_prompt}]

    print("\n" + "=" * 60)
    print("💬 [AI 챗봇 세션 시작]")
    print("분석된 데이터 및 보고서 내용에 대해 궁금한 점이나 요구사항을 입력해 주세요.")
    print("('exit' 또는 'q'를 입력하면 종료됩니다.)")
    print("=" * 60 + "\n")

    while True:
        try:
            user_input = input("\n👤 사용자 질문: ").strip()
            if not user_input:
                continue
            if user_input.lower() in ["exit", "q", "quit", "종료"]:
                print("👋 챗봇 세션을 종료합니다.")
                break

            messages.append({"role": "user", "content": user_input})

            print("\n🤖 AI가 답변을 작성 중입니다...")
            
            response = client.chat.completions.create(
                model="gpt-4o",
                messages=messages,
                temperature=0.3,
            )

            assistant_response = response.choices[0].message.content
            messages.append({"role": "assistant", "content": assistant_response})

            print(f"\n🤖 AI 답변:\n{assistant_response}")
            print("-" * 60)

        except KeyboardInterrupt:
            print("\n👋 대화를 종료합니다.")
            break
        except Exception as e:
            print(f"\n❌ 오류 발생: {str(e)}")

# ==============================================================================
# 4. 메인 실행 함수
# ==============================================================================
async def main():
    print("==================================================")
    print("🚀 B2B AI 리뷰 분석 & 대화형 챗봇 시스템")
    print("==================================================\n")

    # 1. 사용자로부터 파일 경로 동적 입력 받기
    excel_file_path = input(
        "📁 분석할 엑셀 파일 경로를 입력하세요 (기본값: OTOKI_reviews.xlsx): "
    ).strip()
    
    if not excel_file_path:
        excel_file_path = "OTOKI_reviews.xlsx"

    # 2. 엑셀 파일 읽기 & 동적 메타데이터 자동 계산
    print(f"\n🔍 [{excel_file_path}] 데이터 파싱 및 무결성 검증 중...")
    is_valid, parsed_context, meta_info = validate_and_parse_excel(excel_file_path)

    if not is_valid:
        print(f"\n❌ 실행 중단:\n{parsed_context}")
        return

    print("✅ 1차 검증 완료 및 메타데이터 계산 성공!")
    print(f"  ├─ 회사명: {meta_info['company_name']}")
    print(f"  ├─ 총 리뷰 건수: {meta_info['total_reviews']}건")
    print(f"  └─ 분석 대상 기간: {meta_info['min_date']} ~ {meta_info['max_date']}\n")

    # 3. Tasks 구축 & Multi-Agent 파이프라인 구동
    print("🤖 CrewAI 에이전트 파이프라인 분석 시작...\n")
    tasks = build_tasks(parsed_context, meta_info)

    crew_pipeline = Crew(
        agents=[trend_analyzer, root_cause_assessor, executive_reporter],
        tasks=tasks,
        process=Process.sequential,
        verbose=False,
    )

    pipeline_result = await crew_pipeline.kickoff_async()
    final_report_text = pipeline_result.raw

    # 4. 분석 결과 파일 저장
    output_filename = "final_analysis_report.md"
    with open(output_filename, "w", encoding="utf-8") as f:
        f.write(final_report_text)

    print("\n==================================================")
    print("🎉 전사 B2B 분석 결과 보고서 생성이 완료되었습니다!")
    print(f"📄 마크다운 파일 저장 위치: {os.path.abspath(output_filename)}")
    print("==================================================\n")

    # 생성된 보고서 전문 콘솔 출력
    print(final_report_text)

    # 5. 분석 후 대화형 AI 챗봇 모드 실행
    await run_chatbot_session(parsed_context, meta_info, final_report_text)


if __name__ == "__main__":
    asyncio.run(main())