export const COLUMNS = ["카테고리", "상품", "상품ID", "날짜", "회사", "쇼핑몰", "별점", "리뷰 원문"] as const;
export const MAX_FILES = 10;
export const MAX_ROWS = 5000;
export const MAX_DATA_CHARS = 160000;
export type Review = {
  category: string; product: string; productId: string; date: string;
  company: string; mall: string; rating: number; text: string; row: number; sheet: string;
};
export type ReviewFile = { id: string; name: string; size: number; addedAt: string; reviews: Review[] };
export type Message = { id: string; role: "user" | "assistant"; content: string; sources?: string[]; sourceIds?: string[]; preview?: boolean };
export type Project = { id: string; name: string; createdAt: string; files: ReviewFile[]; messages: Message[]; report?: string; reportKind?: "ai" | "preview" };
