import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-console-lock-"));
const port = await findAvailablePort();
const mailboxPort = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const mailboxUrl = `http://127.0.0.1:${mailboxPort}/messages`;
const mailbox = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("[]");
});
await new Promise((resolve) => mailbox.listen(mailboxPort, "127.0.0.1", resolve));

const child = spawn(process.execPath, [
  path.join(projectRoot, "src", "console-server.mjs"),
  "--host",
  "127.0.0.1",
  "--port",
  String(port),
], {
  cwd: projectRoot,
  env: {
    ...process.env,
    ONBOARDING_OUTPUT_ROOT: outputRoot,
    TOSUB2_MAC_CREDENTIAL_ROOT: path.join(outputRoot, "test-mac-credentials"),
    ONBOARDING_PROTOCOL_SCRIPT: path.join(projectRoot, "test", "mock-queue-protocol.mjs"),
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let consoleLogs = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { consoleLogs = `${consoleLogs}${chunk}`.slice(-20_000); });
child.stderr.on("data", (chunk) => { consoleLogs = `${consoleLogs}${chunk}`.slice(-20_000); });
const childExit = new Promise((resolve) => child.once("exit", resolve));

try {
  const bootstrap = await waitForJson(`${baseUrl}/api/bootstrap`);
  const headers = { "content-type": "application/json", "x-console-token": bootstrap.token };
  const requests = Array.from({ length: 10 }, () => fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "same-email@example.com" }),
  }));
  const responses = await Promise.all(requests);
  const payloads = await Promise.all(responses.map((response) => response.json()));
  assert.equal(responses.filter((response) => response.status === 201).length, 1);
  assert.equal(new Set(payloads.map((payload) => payload.job.id)).size, 1);

  const jobId = payloads[0].job.id;
  await waitForJob(headers, jobId, (job) => job.status === "email_otp");
  const updateResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "same-email@example.com", mailApiUrl: mailboxUrl }),
  });
  assert.equal(updateResponse.status, 200, await updateResponse.text());
  await waitForJob(headers, jobId, (job) => job.attempt === 2 && job.status === "email_otp");

  const logsAfterRestart = await (await fetch(`${baseUrl}/api/jobs/${jobId}/logs`, { headers })).json();
  assert.equal(countOccurrences(logsAfterRestart.logs, "Mock queued login started"), 2);

  const unchangedResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "same-email@example.com", mailApiUrl: mailboxUrl }),
  });
  assert.equal(unchangedResponse.status, 200, await unchangedResponse.text());
  await delay(300);
  const unchangedLogs = await (await fetch(`${baseUrl}/api/jobs/${jobId}/logs`, { headers })).json();
  assert.equal(countOccurrences(unchangedLogs.logs, "Mock queued login started"), 2);

  const page = await (await fetch(`${baseUrl}/api/jobs`, { headers })).json();
  assert.equal(page.pagination.total, 1);
  await fetch(`${baseUrl}/api/jobs/${jobId}/cancel`, { method: "POST", headers, body: "{}" });
  console.log("console job lock tests passed");
} catch (error) {
  error.message = `${error.message}\nConsole output:\n${consoleLogs}`;
  throw error;
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.race([childExit, delay(2_000)]);
  await new Promise((resolve) => mailbox.close(resolve));
  await fs.rm(outputRoot, { recursive: true, force: true });
}

async function waitForJson(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`console exited before startup with code ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {}
    await delay(100);
  }
  throw new Error(`console did not start at ${url}`);
}

async function waitForJob(headers, jobId, predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/jobs`, { headers });
    const page = await response.json();
    const job = page.jobs.find((item) => item.id === jobId);
    if (job && predicate(job)) return job;
    await delay(100);
  }
  throw new Error(`job ${jobId} did not reach the expected state`);
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

function countOccurrences(value, needle) {
  return String(value || "").split(needle).length - 1;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
