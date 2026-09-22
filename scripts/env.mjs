import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import nextEnv from "@next/env";

// The local launcher must use this project's credentials, even when the host
// editor/terminal injects its own OpenAI key. Never read .env.example at runtime.
export function loadWorkspaceEnv(directory, development) {
  nextEnv.loadEnvConfig(directory, development);
  const mode = development ? "development" : "production";
  const keys = ["OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL", "APP_PASSWORD"];
  const resolved = new Set();
  for (const name of [`.env.${mode}.local`, ".env.local", `.env.${mode}`, ".env"]) {
    const path = join(directory, name);
    if (!existsSync(path)) continue;
    const values = parseEnv(readFileSync(path, "utf8"));
    for (const key of keys) {
      if (resolved.has(key) || !Object.hasOwn(values, key)) continue;
      process.env[key] = values[key];
      resolved.add(key);
    }
  }
}
