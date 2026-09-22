import { test, expect } from "@playwright/test";
import { COLUMNS } from "../../lib/types";
import { Workbook } from "exceljs";

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
  const requests: { files: { name: string }[]; messages: { role: string; content: string }[]; mode: string }[] = [];
  await page.route("**/api/chat", async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify({ delta: "검증용 모의 응답입니다.\n\n" }) + "\n" + JSON.stringify({ delta: "모든 데이터가 정상 전달되었습니다." }) + "\n" + JSON.stringify({ done: true }) + "\n" });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "샘플 데이터로 체험하기" }).click();
  await page.getByLabel("리뷰 데이터에 질문하기").fill("전체 요약해줘");
  await page.getByRole("button", { name: "질문 보내기" }).click();
  await expect(page.locator(".message.assistant")).toContainText("모든 데이터가 정상 전달되었습니다.");
  expect(requests[0].files).toHaveLength(2);
  await page.getByLabel("분석할 파일 선택").selectOption({ label: "샘플_네이버_리뷰.csv" });
  await page.getByLabel("리뷰 데이터에 질문하기").fill("네이버만 요약해줘");
  await page.getByRole("button", { name: "질문 보내기" }).click();
  await expect(page.locator(".message.assistant")).toHaveCount(2);
  await expect(page.locator(".message.assistant").last()).toContainText("모든 데이터가 정상 전달되었습니다.");
  expect(requests[1].files).toHaveLength(1);
  expect(requests[1].messages).toHaveLength(1);
  await page.getByRole("button", { name: "보고서 다운로드" }).click();
  await expect(page.locator(".report-body")).toContainText("검증용 모의 응답");
  expect(requests[2].mode).toBe("report");
  expect(requests[2].files).toHaveLength(2);
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
