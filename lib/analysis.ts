import { Review, ReviewFile } from "./types";

export function summarize(files: ReviewFile[]) {
  const reviews = files.flatMap(f => f.reviews);
  const count = reviews.length;
  const positive = reviews.filter(r => r.rating >= 4).length;
  const negative = reviews.filter(r => r.rating <= 2).length;
  const dates = reviews.map(r => r.date).filter(Boolean).sort();
  const groups = (key: "mall" | "product" | "date") => {
    const map = new Map<string, Review[]>();
    for (const r of reviews) { const name = key === "product" ? `${r.product} (${r.productId})` : r[key] || "미지정"; map.set(name, [...(map.get(name) ?? []), r]); }
    return [...map].map(([name, rows]) => ({ name, count: rows.length, negative: rows.filter(r => r.rating <= 2).length, average: +(rows.reduce((s, r) => s + r.rating, 0) / rows.length).toFixed(2) })).sort((a, b) => b.count - a.count);
  };
  return { count, positive, negative, neutral: count - positive - negative,
    average: count ? +(reviews.reduce((s, r) => s + r.rating, 0) / count).toFixed(2) : 0,
    positiveRate: count ? +(positive / count * 100).toFixed(1) : 0,
    negativeRate: count ? +(negative / count * 100).toFixed(1) : 0,
    startDate: dates[0] ?? "미상", endDate: dates.at(-1) ?? "미상",
    malls: groups("mall"), products: groups("product"), days: groups("date"),
  };
}

const escapeCell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");
export function statisticalReport(files: ReviewFile[], title: string) {
  const s = summarize(files);
  return `# ${escapeCell(title)} · 리뷰 분석 보고서\n\n통계 미리보기 · ${new Date().toLocaleDateString("ko-KR")}\n\n이 보고서는 업로드한 전체 데이터에서 코드로 계산한 통계입니다. AI 해석은 포함되지 않았습니다.\n\n## 전체 요약\n\n- 분석 파일: ${files.length}개\n- 총 리뷰: **${s.count.toLocaleString()}건**\n- 분석 기간: ${s.startDate} ~ ${s.endDate}\n- 평균 별점: **${s.average} / 5**\n- 긍정(4–5점): ${s.positive}건 (${s.positiveRate}%)\n- 중립(3점): ${s.neutral}건\n- 부정(1–2점): ${s.negative}건 (${s.negativeRate}%)\n\n## 상품별 분석\n\n| 상품 | 리뷰 수 | 평균 별점 | 부정 리뷰 |\n| :--- | ---: | ---: | ---: |\n${s.products.map(p => `| ${escapeCell(p.name)} | ${p.count} | ${p.average} | ${p.negative} |`).join("\n")}\n\n## 쇼핑몰별 분석\n\n| 쇼핑몰 | 리뷰 수 | 비중 | 부정 리뷰 |\n| :--- | ---: | ---: | ---: |\n${s.malls.map(m => `| ${escapeCell(m.name)} | ${m.count} | ${(m.count / s.count * 100).toFixed(1)}% | ${m.negative} |`).join("\n")}\n\n## 부정 리뷰 발생일\n\n${s.days.filter(d => d.negative).map(d => `- ${d.name}: ${d.negative}건 / 당일 ${d.count}건`).join("\n") || "부정 리뷰가 없습니다."}\n\n## 데이터 출처\n\n${files.map(f => `- ${escapeCell(f.name)}: ${f.reviews.length}건`).join("\n")}\n\n같은 리뷰가 여러 파일에 포함되어 있으면 별도 행으로 집계합니다. 별점은 감정의 대리 지표이며 실제 원인·생산일·예상 손실 금액은 리뷰만으로 확정할 수 없습니다.\n`;
}
