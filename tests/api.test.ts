import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/chat/route";
import { sameOrigin } from "../lib/auth";

test("API rejects cross-origin, missing configuration, oversized or invalid bodies before calling AI", async () => {
  const env = { key: process.env.OPENAI_API_KEY, password: process.env.APP_PASSWORD, vercel: process.env.VERCEL };
  const request = (body: string, origin = "http://localhost:3000") => new Request("http://localhost:3000/api/chat", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body });
  try {
    assert.equal(sameOrigin(new Request("http://0.0.0.0:3000/api/chat", { headers: { Host: "localhost:3000", Origin: "http://localhost:3000" } })), true);
    delete process.env.APP_PASSWORD; delete process.env.VERCEL; delete process.env.OPENAI_API_KEY;
    assert.equal((await POST(request("{}", "https://other.example"))).status, 403);
    assert.equal((await POST(request("{}"))).status, 503);
    process.env.OPENAI_API_KEY = "test-only-never-sent";
    assert.equal((await POST(request("not-json"))).status, 400);
    assert.equal((await POST(request('{"files":[],"messages":[],"mode":"chat","title":"x"}'))).status, 400);
    assert.equal((await POST(request("x".repeat(2_000_001)))).status, 413);
    process.env.VERCEL = "1";
    assert.equal((await POST(request("{}"))).status, 401);
  } finally {
    for (const [name, value] of Object.entries({ OPENAI_API_KEY: env.key, APP_PASSWORD: env.password, VERCEL: env.vercel })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
