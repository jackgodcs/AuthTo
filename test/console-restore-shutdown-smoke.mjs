import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-restore-"));
const outputRoot = path.join(tempRoot, "output");
const restoredId = "11111111-1111-4111-8111-111111111111";
const restoredDir = path.join(outputRoot, restoredId);
const restoredEmail = "restore-failed@example.com";
const interruptedId = "22222222-2222-4222-8222-222222222222";
const interruptedEmail = "restore-interrupted@example.com";
const port = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;

await fs.mkdir(restoredDir, { recursive: true });
await fs.writeFile(path.join(restoredDir, "sub2api-import-oauth.json"), `${JSON.stringify({
  type: "sub2api-data",
  version: 1,
  accounts: [{ name: `oauth---${restoredEmail}`, credentials: { email: restoredEmail }, extra: { email: restoredEmail } }],
}, null, 2)}\n`);
await fs.writeFile(path.join(restoredDir, "job-meta.json"), `${JSON.stringify({
  version: 1,
  email: restoredEmail,
  status: "failed",
  prompt: "本次重新授权失败",
  last_error: "模拟的最近错误",
  result_saved: true,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}, null, 2)}\n`);
await fs.mkdir(path.join(outputRoot, interruptedId), { recursive: true });
await fs.writeFile(path.join(outputRoot, interruptedId, "job-meta.json"), `${JSON.stringify({
  version: 1,
  email: interruptedEmail,
  status: "email_otp",
  prompt: "请输入邮箱验证码",
  last_error: null,
  result_saved: false,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}, null, 2)}\n`);

const child = spawn(process.execPath, [
  path.join(projectRoot, "src", "console-server.mjs"),
  "--host", "127.0.0.1",
  "--port", String(port),
], {
  cwd: projectRoot,
  env: {
    ...process.env,
    ONBOARDING_OUTPUT_ROOT: outputRoot,
    ONBOARDING_PROTOCOL_SCRIPT: path.join(projectRoot, "test", "mock-protocol-login.mjs"),
    TOSUB2_MAC_CREDENTIAL_ROOT: path.join(tempRoot, "credentials"),
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let logs = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { logs += chunk; });
child.stderr.on("data", (chunk) => { logs += chunk; });
const childExit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));

try {
  const bootstrap = await waitForJson(`${baseUrl}/api/bootstrap`);
  const headers = { "content-type": "application/json", "x-console-token": bootstrap.token };
  const page = await fetch(`${baseUrl}/api/jobs`, { headers }).then((response) => response.json());
  const restored = page.jobs.find((job) => job.id === restoredId);
  assert.equal(restored.status, "failed");
  assert.equal(restored.canDownload, true);
  assert.equal(restored.prompt, "本次重新授权失败");
  assert.equal(restored.lastError, "模拟的最近错误");
  const interrupted = page.jobs.find((job) => job.id === interruptedId);
  assert.equal(interrupted.status, "failed");
  assert.equal(interrupted.canDownload, false);
  assert.equal(interrupted.canRetry, true);
  assert.match(interrupted.prompt, /服务重启中断/);

  const createResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "mfa-prompt@example.com" }),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  await waitForJob(headers, created.job.id, (job) => job.status === "mfa_otp");

  child.kill("SIGTERM");
  const exit = await Promise.race([childExit, delay(10_000).then(() => null)]);
  assert.ok(exit, "console did not exit after SIGTERM");
  assert.equal(exit.code, 0, logs);
  const metadata = JSON.parse(await fs.readFile(path.join(outputRoot, created.job.id, "job-meta.json"), "utf8"));
  assert.equal(metadata.status, "canceled");
  assert.equal(metadata.prompt, "流程已取消");
  console.log("console restore and graceful shutdown tests passed");
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.race([childExit, delay(2_000)]);
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function waitForJson(url) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await delay(50);
  }
  throw new Error(`server did not start: ${url}`);
}

async function waitForJob(headers, id, predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const page = await fetch(`${baseUrl}/api/jobs`, { headers }).then((response) => response.json());
    const job = page.jobs.find((item) => item.id === id);
    if (job && predicate(job)) return job;
    await delay(25);
  }
  throw new Error(`job ${id} did not reach expected state`);
}

async function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
