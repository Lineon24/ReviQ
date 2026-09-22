import { COLUMNS, ReviewFile } from "./types";

export function sampleFiles(): ReviewFile[] {
  const products = ["고소한 참깨라면", "든든한 즉석밥", "진한 토마토 파스타"];
  const comments = ["맛이 좋고 배송이 빨라요. 재구매할게요.", "간이 적당하고 간편해서 좋아요.", "무난한 맛이에요. 양은 보통입니다.", "포장이 찌그러져서 도착했어요.", "제 입맛에는 너무 짜고 양이 적어요."];
  return ["네이버", "쿠팡"].map((mall, fileIndex) => ({
    id: crypto.randomUUID(), name: `샘플_${mall}_리뷰.csv`, size: 6200, addedAt: new Date().toISOString(),
    reviews: Array.from({ length: 24 }, (_, i) => ({ category: "간편식", product: products[i % 3], productId: `DEMO-00${i % 3 + 1}`, date: `2026-09-${String(i % 12 + 1).padStart(2, "0")}`, company: "샘플푸드", mall, rating: [5, 4, 5, 3, 2, 4, 5, 1][(i + fileIndex) % 8], text: comments[([5, 4, 5, 3, 2, 4, 5, 1][(i + fileIndex) % 8] >= 4 ? i % 2 : [5, 4, 5, 3, 2, 4, 5, 1][(i + fileIndex) % 8] === 3 ? 2 : 3 + i % 2)], row: i + 2, sheet: "CSV" })),
  }));
}
export function templateCSV() {
  return "\uFEFF" + COLUMNS.join(",") + "\n간편식,예시 상품,PRODUCT-001,2026-09-01,예시 회사,네이버,5,맛이 좋고 배송이 빨라요.\n";
}
