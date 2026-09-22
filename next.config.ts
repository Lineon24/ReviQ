import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false, devIndicators: false,
  experimental: { proxyTimeout: 300000 },
  async rewrites() {
    return process.env.VERCEL ? [] : [{ source: "/api/chat", destination: `http://127.0.0.1:${process.env.REVIQ_API_PORT || "8000"}/api/chat` }];
  },
};
export default config;
