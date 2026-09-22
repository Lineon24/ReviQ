import type { Metadata } from "next";
import "./globals.css";
import "./reviq.css";

export const metadata: Metadata = {
  title: "ReviQ — 리뷰에 질문하세요",
  applicationName: "ReviQ",
  description: "[AI 에이전트] 고객 리뷰 데이터를 분석하고, 프로젝트별 AI 채팅과 종합 보고서 생성을 지원하는 서비스",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
