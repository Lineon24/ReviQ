import Papa from "papaparse";
import { COLUMNS, MAX_DATA_CHARS, MAX_ROWS, Review, ReviewFile } from "./types";

export function normalizeDate(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(+value)) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && value > 0 && value < 100000) return new Date(Date.UTC(1899, 11, 30) + value * 86400000).toISOString().slice(0, 10);
  const raw = String(value ?? "").trim();
  const match = raw.match(/^(\d{4})[-./년]\s*(\d{1,2})[-./월]\s*(\d{1,2})(?:일|\b)/);
  if (!match) throw new Error(`날짜 '${raw}'를 읽을 수 없습니다. YYYY-MM-DD 형식을 사용하세요.`);
  const [, y, m, d] = match;
  const dt = new Date(Date.UTC(+y, +m - 1, +d));
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +m - 1 || dt.getUTCDate() !== +d) throw new Error(`유효하지 않은 날짜: ${raw}`);
  return dt.toISOString().slice(0, 10);
}

export function parseRows(rows: unknown[][], sheet = "CSV"): Review[] {
  if (rows.length < 2) throw new Error(`${sheet}: 데이터가 비어 있습니다.`);
  const headers = rows[0].map(v => String(v ?? "").replace(/^\uFEFF/, "").trim());
  const missing = COLUMNS.filter(c => !headers.includes(c));
  if (missing.length) throw new Error(`${sheet}: 필수 열이 없습니다 — ${missing.join(", ")}`);
  if (COLUMNS.some(c => headers.filter(h => h === c).length !== 1)) throw new Error(`${sheet}: 중복된 필수 열 이름이 있습니다.`);
  const result: Review[] = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (!cells.some(v => String(v ?? "").trim())) continue;
    const get = (column: typeof COLUMNS[number]) => cells[headers.indexOf(column)];
    const str = (column: typeof COLUMNS[number]) => String(get(column) ?? "").trim();
    for (const c of COLUMNS) if (!str(c)) throw new Error(`${sheet} ${i + 1}행: '${c}'가 비어 있습니다.`);
    const rating = Number(get("별점"));
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error(`${sheet} ${i + 1}행: 별점은 1~5 정수여야 합니다.`);
    let date: string;
    try { date = normalizeDate(get("날짜")); } catch (e) { throw new Error(`${sheet} ${i + 1}행: ${(e as Error).message}`); }
    if (str("리뷰 원문").length > 10000) throw new Error(`${sheet} ${i + 1}행: 리뷰 원문은 10,000자 이하로 입력하세요.`);
    result.push({ category: str("카테고리"), product: str("상품"), productId: str("상품ID"), date, company: str("회사"), mall: str("쇼핑몰"), rating, text: str("리뷰 원문"), row: i + 1, sheet });
    if (result.length > MAX_ROWS) throw new Error(`파일당 최대 ${MAX_ROWS.toLocaleString()}개 리뷰를 지원합니다.`);
  }
  if (!result.length) throw new Error(`${sheet}: 리뷰 데이터가 없습니다.`);
  return result;
}

export async function parseFile(file: File): Promise<ReviewFile> {
  if (file.size > 10 * 1024 * 1024) throw new Error("파일 크기는 10MB 이하여야 합니다.");
  const ext = file.name.split(".").pop()?.toLowerCase();
  let reviews: Review[];
  if (ext === "csv") {
    const buffer = await file.arrayBuffer();
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
    catch { text = new TextDecoder("euc-kr").decode(buffer); }
    const parsed = Papa.parse<unknown[]>(text, { skipEmptyLines: "greedy" });
    const parseError = parsed.errors.find(error => error.code !== "UndetectableDelimiter");
    if (parseError) throw new Error(`CSV 형식을 확인하세요: ${parseError.message}`);
    reviews = parseRows(parsed.data);
  } else if (ext === "xlsx") {
    const { default: ExcelJS } = await import("exceljs");
    const { Workbook } = ExcelJS;
    const workbook = new Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    reviews = [];
    for (const sheet of workbook.worksheets) {
      if (!sheet.actualRowCount) continue;
      if (sheet.rowCount > MAX_ROWS + 1 || sheet.columnCount > 100) throw new Error(`${sheet.name}: 최대 ${MAX_ROWS}행, 100열까지 지원합니다. 불필요한 빈 행·열을 제거하세요.`);
      const rows: unknown[][] = [];
      sheet.eachRow({ includeEmpty: true }, row => {
        const cells: unknown[] = [];
        row.eachCell({ includeEmpty: true }, (cell, column) => {
          const v = cell.value;
          cells[column - 1] = v && typeof v === "object" && !(v instanceof Date)
            ? "result" in v ? v.result : "richText" in v ? v.richText.map(t => t.text).join("") : "text" in v ? v.text : cell.text
            : v;
        });
        rows.push(cells);
      });
      reviews.push(...parseRows(rows, sheet.name));
    }
  } else throw new Error(".xlsx 또는 .csv 파일을 올려주세요. 구형 .xls는 .xlsx로 저장 후 업로드하세요.");
  if (!reviews.length) throw new Error("리뷰 데이터가 없습니다.");
  if (reviews.length > MAX_ROWS) throw new Error(`파일당 최대 ${MAX_ROWS}개 리뷰를 지원합니다.`);
  if (JSON.stringify(reviews).length > MAX_DATA_CHARS) throw new Error("파일의 분석 데이터가 너무 큽니다. 파일을 나눠 별도 프로젝트에 올려주세요.");
  return { id: crypto.randomUUID(), name: file.name, size: file.size, addedAt: new Date().toISOString(), reviews };
}
