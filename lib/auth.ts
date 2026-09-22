import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const requiresPassword = () => Boolean(process.env.APP_PASSWORD);
export const deploymentBlocked = () => Boolean(process.env.VERCEL) && !requiresPassword();
const sign = (value: string) => createHmac("sha256", process.env.APP_PASSWORD ?? "").update(value).digest("hex");
export const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export function sessionToken() {
  const expiry = String(Date.now() + 7 * 86400000);
  return `${expiry}.${sign(expiry)}`;
}
export async function authenticated() {
  if (deploymentBlocked()) return false;
  if (!requiresPassword()) return true;
  const token = (await cookies()).get("review_session")?.value ?? "";
  const [expiry, signature] = token.split(".");
  return Boolean(expiry && signature && Number(expiry) > Date.now() && safeEqual(signature, sign(expiry)));
}
export function sameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const source = new URL(origin);
    const host = req.headers.get("host") || new URL(req.url).host;
    return ["http:", "https:"].includes(source.protocol) && source.host === host;
  } catch { return false; }
}
