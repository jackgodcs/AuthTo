import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-password-mfa-"));
const port = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const outputPath = path.join(tempRoot, "sub2api-import-oauth.json");
const checkpointPath = path.join(tempRoot, "login-checkpoint.json");
const emailOutputPath = path.join(tempRoot, "email-sub2api-import-oauth.json");
const emailCheckpointPath = path.join(tempRoot, "email-login-checkpoint.json");
const skipOutputPath = path.join(tempRoot, "skip-sub2api-import-oauth.json");
const skipCheckpointPath = path.join(tempRoot, "skip-login-checkpoint.json");
const directOutputPath = path.join(tempRoot, "direct-sub2api-import-oauth.json");
const directCheckpointPath = path.join(tempRoot, "direct-login-checkpoint.json");
const mockServer = spawn(process.execPath, [
  path.join(projectRoot, "test", "mock-password-mfa-server.mjs"),
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
    "--email", "mfa-test@example.com",
    "--chatgpt-base", baseUrl,
    "--auth-base", baseUrl,
    "--output-mode", "sub2api",
    "--sub2api-out", outputPath,
    "--checkpoint", checkpointPath,
    "--verbose",
  ], {
    CHATGPT_LOGIN_PASSWORD: "local-test-password",
    CHATGPT_TOTP_SECRET: "JBSWY3DPEHPK3PXP",
  });

  assert.equal(login.code, 0, processFailure(login));
  assert.match(login.output, /\[ok\] Password accepted/);
  assert.match(login.output, /\[ok\] 2FA verification accepted/);
  assert.match(login.output, /\[web\] Select ChatGPT login workspace/);
  assert.match(login.output, /Saved sub2api import/);

  const state = await fetch(`${baseUrl}/__test/state`).then((response) => response.json());
  assert.equal(state.chatgptWorkspaceSelected, true);
  assert.equal(state.workspaceSelectionCount, 2);

  const exported = JSON.parse(await fs.readFile(outputPath, "utf8"));
  assert.equal(exported.type, "sub2api-data");
  assert.equal(exported.accounts?.[0]?.credentials?.email, "mfa-test@example.com");

  const emailLogin = await runNode([
    path.join(projectRoot, "src", "protocol-login.mjs"),
    "--email", "email-mfa@example.com",
    "--chatgpt-base", baseUrl,
    "--auth-base", baseUrl,
    "--output-mode", "sub2api",
    "--sub2api-out", emailOutputPath,
    "--checkpoint", emailCheckpointPath,
    "--verbose",
  ], {
    CHATGPT_TOTP_SECRET: "JBSWY3DPEHPK3PXP",
  }, [{ pattern: /Email OTP \(r=resend/, value: "123456" }]);

  assert.equal(emailLogin.code, 0, processFailure(emailLogin));
  assert.match(emailLogin.output, /Email OTP page reached/);
  assert.match(emailLogin.output, /\[ok\] 2FA verification accepted/);
  assert.match(emailLogin.output, /\[web\] Select ChatGPT login workspace/);

  const stateAfterEmailLogin = await fetch(`${baseUrl}/__test/state`).then((response) => response.json());
  assert.equal(stateAfterEmailLogin.chatgptWorkspaceSelected, true);
  assert.equal(stateAfterEmailLogin.workspaceSelectionCount, 4);

  const emailExport = JSON.parse(await fs.readFile(emailOutputPath, "utf8"));
  assert.equal(emailExport.accounts?.[0]?.credentials?.email, "email-mfa@example.com");

  const skipWorkspaceLogin = await runNode([
    path.join(projectRoot, "src", "protocol-login.mjs"),
    "--email", "skip-workspace@example.com",
    "--chatgpt-base", baseUrl,
    "--auth-base", baseUrl,
    "--output-mode", "sub2api",
    "--sub2api-out", skipOutputPath,
    "--checkpoint", skipCheckpointPath,
    "--verbose",
  ], {
    CHATGPT_LOGIN_PASSWORD: "local-test-password",
    CHATGPT_TOTP_SECRET: "JBSWY3DPEHPK3PXP",
  });

  assert.equal(skipWorkspaceLogin.code, 0, processFailure(skipWorkspaceLogin));
  assert.match(skipWorkspaceLogin.output, /\[web\] Workspace page did not include a selectable workspace; skipping selection\./);
  assert.match(skipWorkspaceLogin.output, /\[ok\] ChatGPT web session cookie received/);

  const stateAfterSkipWorkspace = await fetch(`${baseUrl}/__test/state`).then((response) => response.json());
  assert.equal(stateAfterSkipWorkspace.chatgptLoginComplete, true);
  assert.equal(stateAfterSkipWorkspace.chatgptWorkspaceSelected, false);
  assert.equal(stateAfterSkipWorkspace.workspaceSelectionCount, 5);

  const skipExport = JSON.parse(await fs.readFile(skipOutputPath, "utf8"));
  assert.equal(skipExport.accounts?.[0]?.credentials?.email, "skip-workspace@example.com");

  const directCodexCallback = await runNode([
    path.join(projectRoot, "src", "protocol-login.mjs"),
    "--email", "direct-codex-callback@example.com",
    "--chatgpt-base", baseUrl,
    "--auth-base", baseUrl,
    "--output-mode", "sub2api",
    "--sub2api-out", directOutputPath,
    "--checkpoint", directCheckpointPath,
    "--verbose",
  ], {
    CHATGPT_LOGIN_PASSWORD: "local-test-password",
    CHATGPT_TOTP_SECRET: "JBSWY3DPEHPK3PXP",
  });

  assert.equal(directCodexCallback.code, 0, processFailure(directCodexCallback));
  assert.match(directCodexCallback.output, /phone binding and workspace selection were not requested/);
  assert.doesNotMatch(directCodexCallback.output, /\[5\/5\] Select workspace/);

  const stateAfterDirectCallback = await fetch(`${baseUrl}/__test/state`).then((response) => response.json());
  assert.equal(stateAfterDirectCallback.chatgptWorkspaceSelected, true);
  assert.equal(stateAfterDirectCallback.workspaceSelectionCount, 6);

  const directExport = JSON.parse(await fs.readFile(directOutputPath, "utf8"));
  assert.equal(directExport.accounts?.[0]?.credentials?.email, "direct-codex-callback@example.com");
  console.log("password/email OTP + 2FA workspace smoke tests passed");
} catch (error) {
  error.message = `${error.message}\nMock server output:\n${serverLogs}`;
  throw error;
} finally {
  if (isRunning(mockServer)) mockServer.kill("SIGKILL");
  await Promise.race([serverExit, delay(2_000)]);
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function runNode(args, extraEnv, inputSteps = []) {
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env: { ...process.env, ...extraEnv },
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
    throw new Error("password + 2FA protocol test timed out");
  }
  return { ...result, output: `${stdout}\n${stderr}` };
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
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function processFailure(result) {
  return `password + 2FA login failed with code ${result.code} and signal ${result.signal || "none"}:\n${result.output}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRunning(processHandle) {
  return processHandle.exitCode === null && processHandle.signalCode === null;
}
