import { NextResponse } from "next/server";
import { authenticated, deploymentBlocked, requiresPassword, safeEqual, sameOrigin, sessionToken } from "@/lib/auth";

export async function GET() {
  return NextResponse.json({ configured: Boolean(process.env.OPENAI_API_KEY), authenticated: await authenticated(), passwordRequired: requiresPassword(), deploymentBlocked: deploymentBlocked() }, { headers: { "Cache-Control": "no-store" } });
}
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "허용되지 않은 요청입니다." }, { status: 403 });
  if (!requiresPassword()) return NextResponse.json({ error: "서버에 APP_PASSWORD를 설정하세요." }, { status: 503 });
  const text = await req.text();
  if (text.length > 1024) return NextResponse.json({ error: "입력이 너무 깁니다." }, { status: 400 });
  let password: unknown;
  try { password = JSON.parse(text).password; } catch { return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 }); }
  if (typeof password !== "string" || !safeEqual(password, process.env.APP_PASSWORD!)) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    return NextResponse.json({ error: "비밀번호를 확인해주세요." }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set("review_session", sessionToken(), { httpOnly: true, secure: Boolean(process.env.VERCEL), sameSite: "strict", path: "/", maxAge: 7 * 86400 });
  return res;
}
