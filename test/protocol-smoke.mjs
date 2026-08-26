import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-protocol-"));
const port = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const outputPath = path.join(tempRoot, "sub2api-import-oauth.json");
const checkpointPath = path.join(tempRoot, "login-checkpoint.json");
const mockServer = spawn(process.execPath, [
  path.join(projectRoot, "test", "mock-add-phone-page-server.mjs"),
  String(port),
], {
  cwd: projectRoot,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let serverLogs = "";
mockServer.stdout.setEncoding("utf8");
mockServer.stderr.setEncoding("utf8");
mockServer.stdout.on("data", (chunk) => { serverLogs = `${serverLogs}${chunk}`.slice(-20_000); });
mockServer.stderr.on("data", (chunk) => { serverLogs = `${serverLogs}${chunk}`.slice(-20_000); });
const serverExit = new Promise((resolve) => mockServer.once("exit", resolve));

try {
  await waitForServer();
  const login = await runNode([
    path.join(projectRoot, "src", "protocol-login.mjs"),
    "--email",
    "add-phone-page@example.com",
    "--chatgpt-base",
    baseUrl,
    "--auth-base",
    baseUrl,
    "--output-mode",
    "sub2api",
    "--sub2api-out",
    outputPath,
    "--checkpoint",
    checkpointPath,
    "--verbose",
  ], [
    { pattern: /Email OTP \(r=resend/, value: "r" },
    { pattern: /Email OTP \(r=resend/, value: "123456" },
    { pattern: /Phone number, E\.164 format/, value: "+60123456789" },
    { pattern: /Phone OTP \(r=resend/, value: "654321" },
  ]);
  assert.equal(login.code, 0, processFailure("protocol login", login));
  assert.equal(login.completedInputSteps, 4, processFailure("protocol input", login));
  assert.match(login.output, /Resend request accepted/);
  assert.match(login.output, /Saved sub2api import/);
  assert.equal(await fileExists(checkpointPath), false);

  const firstExport = JSON.parse(await fs.readFile(outputPath, "utf8"));
  assert.equal(firstExport.type, "sub2api-data");
  assert.equal(firstExport.accounts?.[0]?.credentials?.email, "add-phone-page@example.com");

  const passwordAddResultPath = path.join(tempRoot, "password-add-result.json");
  const newPassword = "Added_Test_4826!";
  const passwordAdd = await runNode([
    path.join(projectRoot, "src", "protocol-login.mjs"),
    "--email",
    "add-password@example.com",
    "--add-password",
    "--password-add-result",
    passwordAddResultPath,
    "--chatgpt-base",
    baseUrl,
    "--auth-base",
    baseUrl,
    "--verbose",
  ], [
    { pattern: /Email OTP \(r=resend/, value: "123456" },
    { pattern: /Email OTP \(r=resend/, value: "123456" },
  ], { CHATGPT_NEW_PASSWORD: newPassword });
  assert.equal(passwordAdd.code, 0, processFailure("add password", passwordAdd));
  assert.equal(passwordAdd.completedInputSteps, 2, processFailure("add password input", passwordAdd));
  assert.match(passwordAdd.output, /Account password added and saved securely/);
  assert.doesNotMatch(passwordAdd.output, new RegExp(newPassword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const passwordAddResult = JSON.parse(await fs.readFile(passwordAddResultPath, "utf8"));
  assert.equal(passwordAddResult.email, "add-password@example.com");
  assert.equal(passwordAddResult.password, newPassword);

  const passwordCheckpointPath = path.join(tempRoot, "password-add-checkpoint.json");
  const checkpointPasswordResultPath = path.join(tempRoot, "checkpoint-password-add-result.json");
  await fs.writeFile(passwordCheckpointPath, `${JSON.stringify({
    version: 1,
    stage: "phone_required",
    updated_at: new Date().toISOString(),
    email: "checkpoint-password@example.com",
    chatgpt_base: baseUrl,
    auth_base: baseUrl,
    cookies: [],
    web: { deviceId: "11111111-2222-4333-8444-555555555555" },
    oauth: { codeVerifier: "stale-verifier", state: "stale-state" },
  }, null, 2)}\n`, { mode: 0o600 });
  const checkpointPasswordAdd = await runNode([
    path.join(projectRoot, "src", "protocol-login.mjs"),
    "--email",
    "checkpoint-password@example.com",
    "--add-password",
    "--password-add-result",
    checkpointPasswordResultPath,
    "--resume-checkpoint",
    passwordCheckpointPath,
    "--chatgpt-base",
    baseUrl,
    "--auth-base",
    baseUrl,
    "--verbose",
  ], [
    { pattern: /Email OTP \(r=resend/, value: "123456" },
  ], { CHATGPT_NEW_PASSWORD: "Checkpoint_Test_4826!" });
  assert.equal(checkpointPasswordAdd.code, 0, processFailure("checkpoint add password", checkpointPasswordAdd));
  assert.equal(checkpointPasswordAdd.completedInputSteps, 1, processFailure("checkpoint add password input", checkpointPasswordAdd));
  assert.match(checkpointPasswordAdd.output, /Reusing verified login checkpoint from phone_required/);
  const updatedPasswordCheckpoint = JSON.parse(await fs.readFile(passwordCheckpointPath, "utf8"));
  assert.equal(updatedPasswordCheckpoint.stage, "email_verified");
  assert.equal(Object.hasOwn(updatedPasswordCheckpoint, "oauth"), false);

  const wrongEmailOtpOutputPath = path.join(tempRoot, "wrong-email-otp-sub2api.json");
  const wrongEmailOtpLogin = await runNode([
    path.join(projectRoot, "src", "protocol-login.mjs"),
    "--email",
    "wrong-email-otp@example.com",
    "--chatgpt-base",
    baseUrl,
    "--auth-base",
    baseUrl,
    "--output-mode",
    "sub2api",
    "--sub2api-out",
    wrongEmailOtpOutputPath,
    "--verbose",
  ], [
    { pattern: /Email OTP \(r=resend/, value: "000000" },
    { pattern: /Email OTP \(r=resend/, value: "123456" },
    { pattern: /Phone number, E\.164 format/, value: "+60123456789" },
    { pattern: /Phone OTP \(r=resend/, value: "654321" },
  ]);
  assert.equal(wrongEmailOtpLogin.code, 0, processFailure("wrong email OTP retry", wrongEmailOtpLogin));
  assert.equal(wrongEmailOtpLogin.completedInputSteps, 4, processFailure("wrong email OTP input", wrongEmailOtpLogin));
  assert.match(wrongEmailOtpLogin.output, /\[email-otp-rejected\].*邮箱验证码错误/);
  assert.equal(await fileExists(wrongEmailOtpOutputPath), true);

  const refresh = await runNode([
    path.join(projectRoot, "src", "protocol-login.mjs"),
    "--refresh-sub2api",
    outputPath,
    "--sub2api-out",
    outputPath,
    "--auth-base",
    baseUrl,
  ]);
  assert.equal(refresh.code, 0, processFailure("OAuth refresh", refresh));
  assert.match(refresh.output, /Refreshed OAuth account/);

  const refreshedExport = JSON.parse(await fs.readFile(outputPath, "utf8"));
  assert.equal(refreshedExport.type, "sub2api-data");
  assert.equal(refreshedExport.accounts?.[0]?.credentials?.refresh_token, "mock-refresh-token");

  const riskOutputPath = path.join(tempRoot, "risk-sub2api.json");
  const riskLogin = await runNode([
    path.join(projectRoot, "src", "protocol-login.mjs"),
    "--email",
    "risk-control@example.com",
    "--chatgpt-base",
    baseUrl,
    "--auth-base",
    baseUrl,
    "--output-mode",
    "sub2api",
    "--sub2api-out",
    riskOutputPath,
    "--verbose",
  ]);
  assert.equal(riskLogin.code, 1, processFailure("risk-control detection", riskLogin));
  assert.match(riskLogin.output, /\[proxy-risk-retry\]/);
  assert.doesNotMatch(riskLogin.output, /Email OTP \(r=resend/);
  assert.equal(await fileExists(riskOutputPath), false);

  const phoneInvalidStateOutputPath = path.join(tempRoot, "phone-invalid-state-sub2api.json");
  const phoneInvalidStateLogin = await runNode([
    path.join(projectRoot, "src", "protocol-login.mjs"),
    "--email",
    "phone-invalid-state@example.com",
    "--chatgpt-base",
    baseUrl,
    "--auth-base",
    baseUrl,
    "--output-mode",
    "sub2api",
    "--sub2api-out",
    phoneInvalidStateOutputPath,
    "--verbose",
  ], [
    { pattern: /Email OTP \(r=resend/, value: "123456" },
    { pattern: /Phone number, E\.164 format/, value: "+60111111111" },
    { pattern: /Enter another phone number/, value: "+60122222222" },
    { pattern: /Phone OTP \(r=resend/, value: "654321" },
  ]);
  assert.equal(phoneInvalidStateLogin.code, 0, processFailure("ordinary phone 400 handling", phoneInvalidStateLogin));
  assert.match(phoneInvalidStateLogin.output, /Could not send SMS to \+60111111111/);
  assert.doesNotMatch(phoneInvalidStateLogin.output, /\[security-check-required\]/);
  assert.doesNotMatch(phoneInvalidStateLogin.output, /\[proxy-risk-retry\]/);
  assert.equal(await fileExists(phoneInvalidStateOutputPath), true);

  const phoneChangeInvalidStepOutputPath = path.join(tempRoot, "phone-change-invalid-step-sub2api.json");
  const phoneChangeInvalidStepLogin = await runNode([
    path.join(projectRoot, "src", "protocol-login.mjs"),
    "--email",
    "phone-change-invalid-step@example.com",
    "--chatgpt-base",
    baseUrl,
    "--auth-base",
    baseUrl,
    "--output-mode",
    "sub2api",
    "--sub2api-out",
    phoneChangeInvalidStepOutputPath,
    "--verbose",
  ], [
    { pattern: /Email OTP \(r=resend/, value: "123456" },
    { pattern: /Phone number, E\.164 format/, value: "+60111111111" },
    { pattern: /Phone OTP \(r=resend/, value: "p" },
    { pattern: /Phone number, E\.164 format/, value: "+60122222222" },
  ]);
  assert.equal(phoneChangeInvalidStepLogin.code, 1, processFailure("invalid phone authorization step", phoneChangeInvalidStepLogin));
  assert.match(phoneChangeInvalidStepLogin.output, /invalid_auth_step/);
  assert.doesNotMatch(phoneChangeInvalidStepLogin.output, /Enter another phone number/);
  assert.equal(
    (phoneChangeInvalidStepLogin.output.match(/> POST .*\/api\/accounts\/add-phone\/send/g) || []).length,
    3,
    "the first phone uses the channel fallback, while invalid_auth_step must stop after one request",
  );
  assert.equal(await fileExists(phoneChangeInvalidStepOutputPath), false);

  const unexpectedPageOutputPath = path.join(tempRoot, "unexpected-page-sub2api.json");
  const unexpectedPageLogin = await runNode([
    path.join(projectRoot, "src", "protocol-login.mjs"),
    "--email",
    "unexpected-page@example.com",
    "--chatgpt-base",
    baseUrl,
    "--auth-base",
    baseUrl,
    "--output-mode",
    "sub2api",
    "--sub2api-out",
    unexpectedPageOutputPath,
    "--verbose",
  ]);
  assert.equal(unexpectedPageLogin.code, 1, processFailure("unexpected login page", unexpectedPageLogin));
  assert.match(unexpectedPageLogin.output, /UNEXPECTED_LOGIN_PAGE/);
  assert.doesNotMatch(unexpectedPageLogin.output, /Email OTP \(r=resend/);
  assert.equal(await fileExists(unexpectedPageOutputPath), false);

  const bannedOutputPath = path.join(tempRoot, "banned-sub2api.json");
  const bannedLogin = await runNode([
    path.join(projectRoot, "src", "protocol-login.mjs"),
    "--email",
    "banned@example.com",
    "--chatgpt-base",
    baseUrl,
    "--auth-base",
    baseUrl,
    "--output-mode",
    "sub2api",
    "--sub2api-out",
    bannedOutputPath,
    "--verbose",
  ]);
  assert.equal(bannedLogin.code, 1, processFailure("deactivated account", bannedLogin));
  assert.match(bannedLogin.output, /Your account has been deactivated/);
  assert.doesNotMatch(bannedLogin.output, /\[proxy-risk-retry\]/);
  assert.doesNotMatch(bannedLogin.output, /Email OTP \(r=resend/);
  assert.equal(await fileExists(bannedOutputPath), false);

  const phoneRiskOutputPath = path.join(tempRoot, "phone-risk-sub2api.json");
  const phoneRiskLogin = await runNode([
    path.join(projectRoot, "src", "protocol-login.mjs"),
    "--email",
    "phone-risk-control@example.com",
    "--chatgpt-base",
    baseUrl,
    "--auth-base",
    baseUrl,
    "--output-mode",
    "sub2api",
    "--sub2api-out",
    phoneRiskOutputPath,
    "--verbose",
  ], [
    { pattern: /Email OTP \(r=resend/, value: "123456" },
    { pattern: /Phone number, E\.164 format/, value: "+60123456789" },
  ]);
  assert.equal(phoneRiskLogin.code, 1, processFailure("phone security-check page", phoneRiskLogin));
  assert.match(phoneRiskLogin.output, /\[proxy-risk-retry\]/);
  assert.doesNotMatch(phoneRiskLogin.output, /Enter another phone number/);
  assert.equal(await fileExists(phoneRiskOutputPath), false);

  const profileCheckpointPath = path.join(tempRoot, "profile-checkpoint.json");
  const profileOutputPath = path.join(tempRoot, "profile-sub2api.json");
  const profileCompleted = await runNode([
    path.join(projectRoot, "src", "protocol-login.mjs"),
    "--email",
    "account-profile@example.com",
    "--chatgpt-base",
    baseUrl,
    "--auth-base",
    baseUrl,
    "--output-mode",
    "sub2api",
    "--sub2api-out",
    profileOutputPath,
    "--checkpoint",
    profileCheckpointPath,
    "--verbose",
  ], [
    { pattern: /Email OTP \(r=resend/, value: "123456" },
    { pattern: /Phone number, E\.164 format/, value: "+60123456789" },
    { pattern: /Phone OTP \(r=resend/, value: "654321" },
  ]);
  assert.equal(profileCompleted.code, 0, processFailure("profile completion", profileCompleted));
  assert.equal(profileCompleted.completedInputSteps, 3, processFailure("profile input", profileCompleted));
  assert.match(profileCompleted.output, /age between 20 and 50/);
  assert.match(profileCompleted.output, /fresh security token/);
  assert.match(profileCompleted.output, /Account profile completed/);
  assert.match(profileCompleted.output, /Start Codex OAuth flow/);
  const profileExport = JSON.parse(await fs.readFile(profileOutputPath, "utf8"));
  assert.equal(profileExport.accounts?.[0]?.credentials?.email, "add-phone-page@example.com");
  assert.equal(await fileExists(profileCheckpointPath), false);
  console.log("protocol smoke tests passed");
} catch (error) {
  error.message = `${error.message}\nMock server output:\n${serverLogs}`;
  throw error;
} finally {
  if (isRunning(mockServer)) mockServer.kill("SIGKILL");
  await Promise.race([serverExit, delay(2_000)]);
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function runNode(args, inputSteps = [], extraEnv = {}) {
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      TOSUB2_TEST_SENTINEL_TOKEN: "mock-sentinel-challenge",
      TOSUB2_TEST_SENTINEL_SO_TOKEN: "mock-so-token",
      CHATGPT_SAME_PROXY_RISK_RETRY_DELAY_MS: "0",
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let stepIndex = 0;
  let interactionTail = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-40_000);
    interactionTail = `${interactionTail}${chunk}`.slice(-4_000);
    const step = inputSteps[stepIndex];
    if (step?.pattern.test(interactionTail)) {
      child.stdin.write(`${step.value}\n`);
      stepIndex += 1;
      interactionTail = "";
    }
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-40_000); });
  if (inputSteps.length === 0) child.stdin.end();
  const result = await Promise.race([
    new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code: code ?? 1, signal }));
    }),
    delay(20_000).then(() => null),
  ]);
  if (!result) {
    child.kill("SIGKILL");
    throw new Error(`process timed out: ${args.join(" ")}`);
  }
  return { ...result, stdout, stderr, output: `${stdout}\n${stderr}`, completedInputSteps: stepIndex };
}

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (mockServer.exitCode !== null) throw new Error(`mock server exited with code ${mockServer.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`mock server did not start at ${baseUrl}`);
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function processFailure(label, result) {
  return `${label} failed with code ${result.code} and signal ${result.signal || "none"}:\n${result.output}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRunning(processHandle) {
  return processHandle.exitCode === null && processHandle.signalCode === null;
}
