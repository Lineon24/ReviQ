import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function configured(files: Record<string, string>, development = true) {
  const dir = mkdtempSync(join(tmpdir(), "reviq-env-test-"));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    const helper = new URL("../scripts/env.mjs", import.meta.url).href;
    const code = `import { loadWorkspaceEnv } from ${JSON.stringify(helper)};
      loadWorkspaceEnv(${JSON.stringify(dir)}, ${development});
      console.log(JSON.stringify({key:process.env.OPENAI_API_KEY,model:process.env.OPENAI_MODEL,password:process.env.APP_PASSWORD}));`;
    return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", code], {
      env: { PATH: process.env.PATH, NODE_ENV: development ? "development" : "production", OPENAI_API_KEY: "inherited-key", OPENAI_MODEL: "inherited-model", APP_PASSWORD: "inherited-password" },
      encoding: "utf8",
    }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("local credentials override editor credentials and are shared with child servers", () => {
  assert.deepEqual(configured({ ".env.local": 'OPENAI_API_KEY="project-key"\nOPENAI_MODEL=project-model\nAPP_PASSWORD=\n' }),
    { key: "project-key", model: "project-model", password: "" });
});
test("development and production environment priority is preserved", () => {
  const files = { ".env": "OPENAI_API_KEY=base-key", ".env.local": "OPENAI_API_KEY=local-key",
    ".env.development.local": "OPENAI_API_KEY=dev-key", ".env.production.local": "OPENAI_API_KEY=prod-key" };
  assert.equal(configured(files).key, "dev-key");
  assert.equal(configured(files, false).key, "prod-key");
});
test("example files are never loaded and missing settings keep the inherited values", () => {
  assert.deepEqual(configured({ ".env.example": "OPENAI_API_KEY=example-key" }),
    { key: "inherited-key", model: "inherited-model", password: "inherited-password" });
  assert.equal(configured({ ".env.local": "OPENAI_API_KEY=" }).key, "");
});
