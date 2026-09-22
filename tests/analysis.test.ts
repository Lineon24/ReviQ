import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRows, normalizeDate, parseFile } from "../lib/parse";
import { summarize, statisticalReport } from "../lib/analysis";
import { COLUMNS, ReviewFile } from "../lib/types";
import { Workbook } from "exceljs";

const rows = [
  [...COLUMNS],
  ["식품", "상품 A", "001", "2026-09-01", "테스트 회사", "네이버", 5, "맛있어요"],
  ["식품", "상품 A", "001", "2026-09-02", "테스트 회사", "쿠팡", 2, "포장이 찌그러졌어요"],
  ["식품", "상품 B", "002", "2026-09-02", "테스트 회사", "네이버", 3, "보통이에요"],
];
const file = (): ReviewFile => ({ id: "test", name: "테스트.csv", size: 500, addedAt: "2026-09-22", reviews: parseRows(rows) });

test("all rows drive totals, neutral counts, mall and date breakdowns", () => {
  const stats = summarize([file()]);
  assert.equal(stats.count, 3); assert.equal(stats.average, 3.33);
  assert.equal(stats.positive, 1); assert.equal(stats.negative, 1); assert.equal(stats.neutral, 1);
  assert.equal(stats.negativeRate, 33.3);
  assert.equal(stats.malls.find(m => m.name === "쿠팡")?.negative, 1);
  assert.equal(stats.days.find(d => d.name === "2026-09-02")?.count, 2);
});
test("aggregates multiple files but scopes correctly to a selected file", () => {
  const a = file(); const b = { ...file(), id: "second", reviews: [file().reviews[0]] };
  assert.equal(summarize([a, b]).count, 4);
  assert.equal(summarize([b]).negative, 0);
});
test("validates required columns, blanks, dates and rating range", () => {
  assert.throws(() => parseRows([["상품"], ["A"]]), /필수 열/);
  const bad = structuredClone(rows); bad[1][6] = 6;
  assert.throws(() => parseRows(bad), /별점/);
  bad[1][6] = 4; bad[1][7] = "";
  assert.throws(() => parseRows(bad), /비어/);
  assert.throws(() => normalizeDate("2026-02-30"), /유효하지/);
  assert.equal(normalizeDate("2026.9.2"), "2026-09-02");
  assert.equal(normalizeDate("2026년 9월 2일"), "2026-09-02");
  assert.equal(normalizeDate(46267), "2026-09-02");
});
test("CSV imports multiline quoted reviews and BOM without dropping data", async () => {
  const csv = "\uFEFF" + COLUMNS.join(",") + '\n식품,상품 A,001,2026-09-01,테스트,네이버,4,"맛있어요,\n또 살게요"';
  const parsed = await parseFile(new File([csv], "review.csv"));
  assert.equal(parsed.reviews.length, 1);
  assert.equal(parsed.reviews[0].text, "맛있어요,\n또 살게요");
  assert.equal(parsed.reviews[0].productId, "001");
});
test("XLSX reads every populated sheet and preserves source rows", async () => {
  const book = new Workbook();
  book.addWorksheet("서울").addRows(rows);
  book.addWorksheet("부산").addRows(rows.slice(0, 2));
  const bytes = await book.xlsx.writeBuffer();
  const parsed = await parseFile(new File([new Uint8Array(bytes)], "review.xlsx"));
  assert.equal(parsed.reviews.length, 4);
  assert.equal(parsed.reviews[3].sheet, "부산");
  assert.equal(parsed.reviews[3].row, 2);
});
test("reports contain computed statistics and explicit preview label", () => {
  const report = statisticalReport([file()], "테스트");
  assert.match(report, /통계 미리보기/);
  assert.match(report, /3건/);
  assert.match(report, /33.3%/);
  assert.match(report, /테스트.csv/);
});
