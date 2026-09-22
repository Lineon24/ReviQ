import { Check, LoaderCircle } from "lucide-react";

export const ANALYSIS_ENGINE = "crewai-v1";
export type StageStatus = "pending" | "running" | "completed";
export const initialStages = (): StageStatus[] => ["pending", "pending", "pending"];
const stages = [
  { name: "정량 분석", description: "리뷰 통계와 주요 의견을 확인하고 있어요" },
  { name: "원인 추적", description: "문제의 원인과 개선 방향을 살펴보고 있어요" },
  { name: "답변·보고서 작성", description: "분석 결과와 원문을 대조해 정리하고 있어요" },
];

export function AnalysisProgress({ statuses }: { statuses: StageStatus[] }) {
  const active = statuses.findIndex(status => status === "running");
  return <div className="analysis-progress" role="status" aria-live="polite" aria-label="멀티에이전트 분석 진행">
    <div className="analysis-progress-heading">3개 에이전트가 함께 분석하고 있어요</div>
    <ol>{stages.map((stage, index) => <li key={stage.name} data-status={statuses[index]}>
      <span className="analysis-step-icon">{statuses[index] === "completed" ? <Check size={13} /> : statuses[index] === "running" ? <LoaderCircle size={13} className="spin" /> : index + 1}</span>
      <span>{stage.name}</span><small>{statuses[index] === "completed" ? "완료" : statuses[index] === "running" ? "분석 중" : "대기"}</small>
    </li>)}</ol>
    <p>{active < 0 ? "분석을 준비하고 있습니다." : stages[active].description}</p>
  </div>;
}
