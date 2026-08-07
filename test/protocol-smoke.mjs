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
    { pattern: /Email OTP \(r=resend/, value: "123456" },
    { pattern: /Phone number, E\.164 format/, value: "+60123456789" },
    { pattern: /Phone OTP \(r=resend/, value: "654321" },
  ]);
  assert.equal(login.code, 0, processFailure("protocol login", login));
  assert.equal(login.completedInputSteps, 3, processFailure("protocol input", login));
  assert.match(login.output, /Saved sub2api import/);
  assert.equal(await fileExists(checkpointPath), false);

  const firstExport = JSON.parse(await fs.readFile(outputPath, "utf8"));
  assert.equal(firstExport.type, "sub2api-data");
  assert.equal(firstExport.accounts?.[0]?.credentials?.email, "add-phone-page@example.com");

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
  console.log("protocol smoke tests passed");
} catch (error) {
  error.message = `${error.message}\nMock server output:\n${serverLogs}`;
  throw error;
} finally {
  if (isRunning(mockServer)) mockServer.kill("SIGKILL");
  await Promise.race([serverExit, delay(2_000)]);
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function runNode(args, inputSteps = []) {
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
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
