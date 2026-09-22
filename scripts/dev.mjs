import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { loadWorkspaceEnv } from "./env.mjs";

const production = process.argv.includes("--production");
loadWorkspaceEnv(process.cwd(), !production);
const port = Number(process.env.PORT || 3000);
const apiPort = Number(process.env.REVIQ_API_PORT || 8000);
const python = process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python";
if (!existsSync(python)) {
  console.error("Python 백엔드 설치가 필요합니다. uv sync를 실행한 뒤 다시 시작해주세요.");
  process.exit(1);
}
for (const value of [port, apiPort]) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error("포트 설정을 확인해주세요.");
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(new Error(`${value} 포트가 사용 중입니다. 기존 서버를 종료하거나 PORT / REVIQ_API_PORT를 변경해주세요.`)));
    probe.listen(value, "0.0.0.0", () => probe.close(resolve));
  });
}
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  const timer = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    process.exit(code);
  }, 3000);
  Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once("exit", resolve))))
    .then(() => { clearTimeout(timer); process.exit(code); });
}
function launch(command, args) {
  const child = spawn(command, args, { stdio: "inherit", env: { ...process.env, REVIQ_LOCAL_PROXY: "1" } });
  children.push(child);
  child.once("error", error => { console.error(error.message); stop(1); });
  child.once("exit", code => { if (!stopping) stop(code ?? 1); });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
launch(python, ["-m", "uvicorn", "api.chat:app", "--host", "127.0.0.1", "--port", String(apiPort), "--no-access-log"]);
// Start the UI only after the analysis endpoint is reachable.
let backendReady = false;
for (let attempt = 0; attempt < 120 && !stopping; attempt++) {
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/chat`, { signal: AbortSignal.timeout(1000) });
    if (response.status === 405) { backendReady = true; break; }
  } catch { /* Cold Python import can take a few seconds. */ }
  await new Promise(resolve => setTimeout(resolve, 500));
}
if (!backendReady) { console.error("분석 서버를 시작하지 못했습니다."); stop(1); }
else launch(process.execPath, ["node_modules/next/dist/bin/next", production ? "start" : "dev", "--hostname", "0.0.0.0", "--port", String(port)]);
