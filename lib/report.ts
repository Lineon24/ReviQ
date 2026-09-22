import { Project } from "./types";

export const REPORT_PROMPT_VERSION = "original-v1";
export const REPORT_ENGINE = "crewai-v1";
export const CHAT_ENGINE = "report-chat-v1";
export function hasCurrentReport(project: Project | undefined): boolean {
  return Boolean(project?.report && project.reportPromptVersion === REPORT_PROMPT_VERSION && project.reportKind === "ai" && project.reportEngine === REPORT_ENGINE && project.reportId && project.reportSources &&
    Object.keys(project.reportSources).length === project.files.length && project.files.every(file => project.reportSources?.[file.id]));
}
export function clearReport(project: Project): Project {
  return { ...project, report: undefined, reportKind: undefined, reportEngine: undefined, reportId: undefined, reportSources: undefined, reportPromptVersion: undefined, reportState: undefined, reportError: undefined };
}
