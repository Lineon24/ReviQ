import { test, expect } from "@playwright/test";
import { COLUMNS } from "../../lib/types";
import { Workbook } from "exceljs";

let reportSequence = 0;
function aiResponse(data: { mode: string; files: { id: string }[]; report?: { id: string } }, text = "검증용 모의 응답입니다. 모든 데이터가 정상 전달되었습니다.") {
  const done = data.mode === "report"
    ? { done: true, engine: "crewai-v1", completedStages: 3, report: { promptVersion: "original-v1", id: `report-${++reportSequence}`, sources: Object.fromEntries(data.files.map(f => [f.id, "a".repeat(64)])) } }
    : { done: true, engine: "report-chat-v1", reportId: data.report?.id };
  return JSON.stringify({ delta: text }) + "\n" + JSON.stringify(done) + "\n";
}

test("project, real CSV upload, persistence, statistics and report download", async ({ page }) => {
  await page.route("**/api/session", route => route.fulfill({ json: { configured: false, authenticated: true, passwordRequired: false, deploymentBlocked: false } }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "리뷰에 질문하세요." })).toBeVisible();
  await page.screenshot({ path: "test-results/desktop.png", fullPage: true });
  await page.getByRole("button", { name: "새 프로젝트" }).click();
  await page.getByLabel("프로젝트 이름").fill("9월 실제 업로드 테스트");
  await page.getByRole("button", { name: "프로젝트 만들기" }).click();
  const csv = COLUMNS.join(",") + "\n간편식,테스트 상품,P01,2026-09-02,테스트 회사,네이버,5,맛있어요\n간편식,테스트 상품,P01,2026-09-03,테스트 회사,쿠팡,1,포장 손상";
  await page.locator('input[type="file"]').setInputFiles({ name: "리뷰.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(page.getByRole("heading", { name: "1개 파일, 분석 준비 완료" })).toBeVisible();
  await expect(page.locator(".stats-strip")).toContainText("3.00");
  await page.getByRole("button", { name: "데이터 요약 보기" }).click();
  await expect(page.locator(".message-content")).toContainText("50%");
  await expect(page.locator(".message-content")).toContainText("리뷰.csv");
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.locator(".message-content")).toContainText("50%");
  await page.getByRole("button", { name: "보고서 다운로드" }).click();
  await expect(page.getByRole("dialog")).toContainText("통계 미리보기");
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "다운로드 .md" }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("9월 실제 업로드 테스트_보고서.md");
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "첫 번째 프로젝트", exact: true }).click();
  await expect(page.getByRole("heading", { name: "어떤 리뷰를 살펴볼까요?" })).toBeVisible();
});

test("sample workflow, responsive layout, file scope and upload rejection", async ({ page }) => {
  await page.route("**/api/session", route => route.fulfill({ json: { configured: false, authenticated: true, passwordRequired: false, deploymentBlocked: false } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "리뷰에 질문하세요." })).toBeVisible();
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.getByRole("button", { name: "샘플 데이터로 체험하기" }).click();
  await expect(page.getByRole("heading", { name: "2개 파일, 분석 준비 완료" })).toBeVisible();
  await page.getByLabel("분석할 파일 선택").selectOption({ label: "샘플_네이버_리뷰.csv" });
  await page.getByRole("button", { name: "데이터 요약 보기" }).click();
  await expect(page.locator(".message-content")).toContainText("24건");
  await expect(page.locator(".message-content")).not.toContainText("샘플_쿠팡_리뷰.csv");
  await page.locator('input[type="file"]').setInputFiles({ name: "오류.csv", mimeType: "text/csv", buffer: Buffer.from("상품,리뷰\nA,좋아요") });
  await expect(page.locator(".error-notice")).toContainText("필수 열");
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await expect(page.getByRole("button", { name: "새 프로젝트" })).toBeVisible();
});

test("streams answers, isolates file scope and generates AI reports with a mock transport", async ({ page }) => {
  await page.route("**/api/session", route => route.fulfill({ json: { configured: true, authenticated: true, passwordRequired: false, deploymentBlocked: false } }));
  const requests: { files: { id: string; name: string }[]; messages: { role: string; content: string }[]; mode: string; report?: { content: string; id: string } }[] = [];
  await page.route("**/api/chat", async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ contentType: "application/x-ndjson", body: aiResponse(route.request().postDataJSON()) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "샘플 데이터로 체험하기" }).click();
  await page.getByLabel("리뷰 데이터에 질문하기").fill("전체 요약해줘");
  await page.getByRole("button", { name: "질문 보내기" }).click();
  await expect(page.locator(".message.assistant")).toContainText("모든 데이터가 정상 전달되었습니다.");
  expect(requests[0].mode).toBe("report");
  expect(requests[1].mode).toBe("chat");
  expect(requests[1].report?.content).toContain("검증용 모의 응답");
  expect(requests[1].files).toHaveLength(2);
  await page.getByLabel("분석할 파일 선택").selectOption({ label: "샘플_네이버_리뷰.csv" });
  await page.getByLabel("리뷰 데이터에 질문하기").fill("네이버만 요약해줘");
  await page.getByRole("button", { name: "질문 보내기" }).click();
  await expect(page.locator(".message.assistant")).toHaveCount(2);
  await expect(page.locator(".message.assistant").last()).toContainText("모든 데이터가 정상 전달되었습니다.");
  expect(requests[2].files).toHaveLength(1);
  expect(requests[2].messages).toHaveLength(1);
  await page.getByRole("button", { name: "보고서 다운로드" }).click();
  await expect(page.locator(".report-body")).toContainText("검증용 모의 응답");
  expect(requests).toHaveLength(3);
  expect(requests.filter(r => r.mode === "report")).toHaveLength(1);
  await page.screenshot({ path: "test-results/report.png", fullPage: true });
});

test("browser parses XLSX and displays a failed AI stream without saving a report", async ({ page }) => {
  await page.route("**/api/session", route => route.fulfill({ json: { configured: true, authenticated: true, passwordRequired: false, deploymentBlocked: false } }));
  await page.route("**/api/chat", route => route.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify({ delta: "미완성 보고서" }) + "\n" + JSON.stringify({ error: "테스트: 응답 중단" }) + "\n" }));
  const workbook = new Workbook();
  workbook.addWorksheet("리뷰").addRows([[...COLUMNS], ["식품", "엑셀 상품", "X01", new Date("2026-09-02"), "회사", "쿠팡", 4, "만족해요"]]);
  const bytes = await workbook.xlsx.writeBuffer();
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({ name: "엑셀.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(bytes) });
  await expect(page.getByRole("heading", { name: "1개 파일, 분석 준비 완료" })).toBeVisible();
  await expect(page.locator(".stats-strip")).toContainText("4.00");
  await page.getByRole("button", { name: "보고서 다운로드" }).click();
  await expect(page.locator(".report-body")).toContainText("테스트: 응답 중단");
  await expect(page.getByRole("button", { name: "다운로드 .md" })).toBeDisabled();
});

test("shows actual agent progress and cancels without saving a report", async ({ page }) => {
  await page.route("**/api/session", route => route.fulfill({ json: { configured: true, authenticated: true, passwordRequired: false, deploymentBlocked: false } }));
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      if (input !== "/api/chat") return original(input, init);
      const body = new ReadableStream({
        start(controller) {
          const emit = (data: object) => controller.enqueue(new TextEncoder().encode(JSON.stringify(data) + "\n"));
          (window as unknown as { advanceAgent: () => void }).advanceAgent = () => {
            emit({ progress: { stage: 0, status: "completed" } });
            emit({ progress: { stage: 1, status: "running" } });
          };
          emit({ progress: { stage: 0, status: "running" } });
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
        },
      });
      return new Response(body, { headers: { "Content-Type": "application/x-ndjson" } });
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "샘플 데이터로 체험하기" }).click();
  await page.getByRole("button", { name: "보고서 다운로드" }).click();
  const progress = page.getByRole("status", { name: "멀티에이전트 분석 진행" });
  await expect(progress.locator('[data-status="running"]')).toContainText("정량 분석");
  await page.evaluate(() => (window as unknown as { advanceAgent: () => void }).advanceAgent());
  await expect(progress.locator('[data-status="completed"]')).toContainText("정량 분석");
  await expect(progress.locator('[data-status="running"]')).toContainText("원인 추적");
  await expect(progress.locator('[data-status="pending"]')).toContainText("답변·보고서 작성");
  await page.screenshot({ path: "test-results/agent-progress.png" });
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "생성 중지", exact: true }).click();
  await expect(page.getByRole("button", { name: "질문 보내기" })).toBeVisible();
  await page.getByRole("button", { name: "보고서 다운로드" }).click();
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(progress).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "생성 중지" }).click();
  await expect(page.getByRole("button", { name: "다운로드 .md" })).toBeDisabled();
});

test("does not accept an old single-model response as a completed multi-agent report", async ({ page }) => {
  await page.route("**/api/session", route => route.fulfill({ json: { configured: true, authenticated: true, passwordRequired: false, deploymentBlocked: false } }));
  await page.route("**/api/chat", route => route.fulfill({ contentType: "application/x-ndjson", body: '{"delta":"old report"}\n{"done":true}\n' }));
  await page.goto("/");
  await page.getByRole("button", { name: "샘플 데이터로 체험하기" }).click();
  await page.getByRole("button", { name: "보고서 다운로드" }).click();
  await expect(page.locator(".report-body")).toContainText("답변이 완성되지 않았습니다.");
  await expect(page.getByRole("button", { name: "다운로드 .md" })).toBeDisabled();
});

test("regenerates a saved legacy report and reuses the completed crew report", async ({ page }) => {
  await page.route("**/api/session", route => route.fulfill({ json: { configured: true, authenticated: true, passwordRequired: false, deploymentBlocked: false } }));
  let requests = 0;
  await page.route("**/api/chat", route => {
    requests++;
    return route.fulfill({ contentType: "application/x-ndjson", body: aiResponse(route.request().postDataJSON(), "새 멀티에이전트 보고서") });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "샘플 데이터로 체험하기" }).click();
  await expect(page.getByRole("heading", { name: "2개 파일, 분석 준비 완료" })).toBeVisible();
  await expect(page.getByLabel("분석 보고서 상태")).toContainText("보고서 준비 완료");
  // Wait for the app's debounced IndexedDB write before simulating an upgrade.
  await expect.poll(() => page.evaluate(() => new Promise<boolean>(resolve => {
    const open = indexedDB.open("keyval-store");
    open.onsuccess = () => {
      const db = open.result;
      const read = db.transaction("keyval").objectStore("keyval").get("review-studio-v1");
      read.onsuccess = () => { resolve(read.result?.projects?.some((p: { files: unknown[]; reportId?: string }) => p.files.length === 2 && !!p.reportId) ?? false); db.close(); };
    };
  }))).toBe(true);
  await page.evaluate(() => new Promise<void>(resolve => {
    const open = indexedDB.open("keyval-store");
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("keyval", "readwrite");
      const store = tx.objectStore("keyval");
      const read = store.get("review-studio-v1");
      read.onsuccess = () => {
        const saved = read.result;
        const project = saved.projects.find((p: { id: string }) => p.id === saved.activeId);
        project.report = "이전 축약 프롬프트 보고서";
        project.reportKind = "ai";
        delete project.reportPromptVersion;
        store.put(saved, "review-studio-v1");
      };
      tx.oncomplete = () => { db.close(); resolve(); };
    };
  }));
  await page.reload();
  await page.getByRole("button", { name: "보고서 다운로드" }).click();
  await expect(page.locator(".report-body")).toContainText("새 멀티에이전트 보고서");
  expect(requests).toBe(2);
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "보고서 다운로드" }).click();
  await expect(page.locator(".report-body")).toContainText("새 멀티에이전트 보고서");
  expect(requests).toBe(2);
});

test("upload builds one report, file changes rebuild it, and reload reuses it", async ({ page }) => {
  await page.route("**/api/session", route => route.fulfill({ json: { configured: true, authenticated: true, passwordRequired: false, deploymentBlocked: false } }));
  const requests: { mode: string; files: { id: string; name: string }[]; messages: unknown[]; report?: { id: string; content: string } }[] = [];
  await page.route("**/api/chat", route => {
    const data = route.request().postDataJSON(); requests.push(data);
    return route.fulfill({ contentType: "application/x-ndjson", body: aiResponse(data) });
  });
  const csv = (product: string) => Buffer.from(COLUMNS.join(",") + `\n식품,${product},P01,2026-09-02,회사,네이버,5,맛있어요`);
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles([
    { name: "첫째.csv", mimeType: "text/csv", buffer: csv("첫째 상품") },
    { name: "둘째.csv", mimeType: "text/csv", buffer: csv("둘째 상품") },
  ]);
  await expect(page.getByLabel("분석 보고서 상태")).toContainText("보고서 준비 완료");
  expect(requests).toHaveLength(1);
  expect(requests[0].mode).toBe("report");
  expect(requests[0].files).toHaveLength(2);
  await page.getByLabel("리뷰 데이터에 질문하기").fill("처음 질문");
  await page.getByRole("button", { name: "질문 보내기" }).click();
  await expect(page.locator(".message.assistant")).toContainText("보고서 + 원문 기반");
  const firstReportId = requests[1].report?.id;
  await page.getByRole("button", { name: "둘째.csv 삭제", exact: true }).click();
  await expect.poll(() => requests.filter(r => r.mode === "report").length).toBe(2);
  await expect(page.getByLabel("분석 보고서 상태")).toContainText("보고서 준비 완료");
  expect(requests[2].files.map(f => f.name)).toEqual(["첫째.csv"]);
  await page.getByLabel("리뷰 데이터에 질문하기").fill("자료 변경 후 질문");
  await page.getByRole("button", { name: "질문 보내기" }).click();
  await expect(page.locator(".message.assistant").last()).toContainText("보고서 + 원문 기반");
  expect(requests[3].report?.id).not.toBe(firstReportId);
  expect(requests[3].messages).toHaveLength(1);
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.getByLabel("분석 보고서 상태")).toContainText("보고서 준비 완료");
  expect(requests.filter(r => r.mode === "report")).toHaveLength(2);
  await page.locator('input[type="file"]').setInputFiles({ name: "셋째.csv", mimeType: "text/csv", buffer: csv("셋째 상품") });
  await expect.poll(() => requests.filter(r => r.mode === "report").length).toBe(3);
  await expect(page.getByLabel("분석 보고서 상태")).toContainText("보고서 준비 완료");
  expect(requests[4].files.map(f => f.name)).toEqual(["첫째.csv", "셋째.csv"]);
  await expect(page.getByRole("button", { name: "분석 보고서.md 원문과 함께 채팅에 사용" })).toBeVisible();
  await page.screenshot({ path: "test-results/report-chat-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("분석 보고서 상태")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: "test-results/report-chat-mobile.png" });
});
