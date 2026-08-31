import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
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
const interruptedPasswordId = "33333333-3333-4333-8333-333333333333";
const interruptedPasswordEmail = "restore-password@example.com";
const interruptedTotpId = "44444444-4444-4444-8444-444444444444";
const interruptedTotpEmail = "restore-totp@example.com";
const restoredOperationAt = "2026-08-12T08:30:00.000Z";
const port = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const sub2apiPort = await findAvailablePort();
const sub2apiUrl = `http://127.0.0.1:${sub2apiPort}`;
let resolveMonitorRequest;
const monitorRequestStarted = new Promise((resolve) => { resolveMonitorRequest = resolve; });
const sub2api = http.createServer((req, res) => {
  if (req.headers["x-api-key"] !== "shutdown-test-key") {
    res.writeHead(401).end();
    return;
  }
  if (req.method === "GET" && req.url?.startsWith("/api/v1/admin/accounts?")) {
    resolveMonitorRequest();
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => sub2api.listen(sub2apiPort, "127.0.0.1", resolve));

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
  last_operation_at: restoredOperationAt,
  last_operation_type: "relogin",
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
const interruptedPasswordDir = path.join(outputRoot, interruptedPasswordId);
await fs.mkdir(interruptedPasswordDir, { recursive: true });
await fs.writeFile(path.join(interruptedPasswordDir, "login-checkpoint.json"), `${JSON.stringify({
  version: 1,
  stage: "email_verified",
  updated_at: new Date().toISOString(),
  email: interruptedPasswordEmail,
  cookies: [],
}, null, 2)}\n`, { mode: 0o600 });
await fs.writeFile(path.join(interruptedPasswordDir, "password-add-result.json"), `${JSON.stringify({
  version: 1,
  email: interruptedPasswordEmail,
  password: "Recovered_Test_4826!",
  added_at: "2026-08-17T05:00:00.000Z",
}, null, 2)}\n`, { mode: 0o600 });
await fs.writeFile(path.join(interruptedPasswordDir, "job-meta.json"), `${JSON.stringify({
  version: 1,
  email: interruptedPasswordEmail,
  status: "password_add_starting",
  prompt: "正在添加密码",
  result_saved: false,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  login_checkpoint_available: true,
}, null, 2)}\n`);
const interruptedTotpDir = path.join(outputRoot, interruptedTotpId);
await fs.mkdir(interruptedTotpDir, { recursive: true });
await fs.writeFile(path.join(interruptedTotpDir, "login-checkpoint.json"), `${JSON.stringify({
  version: 1,
  stage: "email_verified",
  updated_at: new Date().toISOString(),
  email: interruptedTotpEmail,
  cookies: [],
}, null, 2)}\n`, { mode: 0o600 });
await fs.writeFile(path.join(interruptedTotpDir, "totp-setup-result.json"), `${JSON.stringify({
  version: 1,
  activation_mode: "automatic",
  activation_succeeded: true,
  activated_at: "2026-08-17T05:10:00.000Z",
  email: interruptedTotpEmail,
  secret: "NB2W45DFOIZAQWER",
  otpauth_uri: `otpauth://totp/OpenAI%3A${encodeURIComponent(interruptedTotpEmail)}?secret=NB2W45DFOIZAQWER&issuer=OpenAI`,
}, null, 2)}\n`, { mode: 0o600 });
await fs.writeFile(path.join(interruptedTotpDir, "job-meta.json"), `${JSON.stringify({
  version: 1,
  email: interruptedTotpEmail,
  status: "totp_starting",
  prompt: "正在设置 2FA",
  result_saved: false,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  login_checkpoint_available: true,
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
    TOSUB2_TLS_PROFILE: "chrome142",
  },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
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
  assert.equal(restored.lastOperationAt, restoredOperationAt);
  assert.equal(restored.lastOperationType, "relogin");
  const interrupted = page.jobs.find((job) => job.id === interruptedId);
  assert.equal(interrupted.status, "failed");
  assert.equal(interrupted.canDownload, false);
  assert.equal(interrupted.canRetry, true);
  assert.equal(interrupted.lastOperationType, "initial_authorization");
  assert.match(interrupted.prompt, /服务重启中断/);
  const recoveredPassword = page.jobs.find((job) => job.id === interruptedPasswordId);
  assert.equal(recoveredPassword.status, "resume_available");
  assert.equal(recoveredPassword.loginMode, "password");
  assert.equal(recoveredPassword.canAddPassword, false);
  assert.equal(recoveredPassword.canRetry, true);
  assert.equal(recoveredPassword.passwordAddError, null);
  assert.equal(recoveredPassword.passwordAddedAt, "2026-08-17T05:00:00.000Z");
  assert.match(recoveredPassword.prompt, /已恢复成功添加的新密码/);
  await assert.rejects(fs.access(path.join(interruptedPasswordDir, "password-add-result.json")));
  const recoveredTotp = page.jobs.find((job) => job.id === interruptedTotpId);
  assert.equal(recoveredTotp.status, "resume_available");
  assert.equal(recoveredTotp.hasTotpKey, true);
  assert.equal(recoveredTotp.canSetupTotp, false);
  assert.equal(recoveredTotp.canRetry, true);
  assert.equal(recoveredTotp.totpSetupError, null);
  assert.match(recoveredTotp.prompt, /已恢复成功激活的 2FA 密钥/);
  await assert.rejects(fs.access(path.join(interruptedTotpDir, "totp-setup-result.json")));

  const createResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "mfa-prompt@example.com" }),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  await waitForJob(headers, created.job.id, (job) => job.status === "mfa_otp");

  const monitorConfigResponse = await fetch(`${baseUrl}/api/sub2api/monitor`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      enabled: true,
      config: { baseUrl: sub2apiUrl, adminApiKey: "shutdown-test-key" },
    }),
  });
  assert.equal(monitorConfigResponse.status, 200, await monitorConfigResponse.text());
  void fetch(`${baseUrl}/api/sub2api/monitor/check`, { method: "POST", headers }).catch(() => {});
  await Promise.race([
    monitorRequestStarted,
    delay(3_000).then(() => { throw new Error("monitor request did not start"); }),
  ]);
  const shutdownStartedAt = Date.now();
  assert.equal(child.send({ type: "shutdown" }), true, "console shutdown request was not sent");
  const exit = await Promise.race([childExit, delay(10_000).then(() => null)]);
  assert.ok(exit, "console did not exit after the shutdown request");
  assert.equal(exit.code, 0, logs);
  assert.ok(Date.now() - shutdownStartedAt < 5_000, "shutdown should abort the pending Sub2API monitor request");
  const metadata = JSON.parse(await fs.readFile(path.join(outputRoot, created.job.id, "job-meta.json"), "utf8"));
  assert.equal(metadata.status, "canceled");
  assert.equal(metadata.prompt, "流程已取消");
  console.log("console restore and graceful shutdown tests passed");
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.race([childExit, delay(2_000)]);
  sub2api.closeAllConnections?.();
  await new Promise((resolve) => sub2api.close(resolve));
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
