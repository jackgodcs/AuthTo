import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-console-"));
const port = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;
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
    ONBOARDING_PROTOCOL_SCRIPT: path.join(projectRoot, "test", "mock-protocol-login.mjs"),
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let logs = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-20_000); });
child.stderr.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-20_000); });
const childExit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));

try {
  const bootstrap = await waitForJson(`${baseUrl}/api/bootstrap`);
  assert.equal(typeof bootstrap.token, "string");
  const headers = { "content-type": "application/json", "x-console-token": bootstrap.token };

  const pageResponse = await fetch(`${baseUrl}/`);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get("content-type") || "", /text\/html;\s*charset=utf-8/i);

  const createdResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "cross-platform@example.com" }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.created, true);
  const jobId = created.job.id;

  let job = await waitForJob(headers, jobId, (value) => value.status === "completed");
  assert.equal(job.canDownload, true);

  const downloadResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/download`, { headers });
  assert.equal(downloadResponse.status, 200);
  const download = await downloadResponse.json();
  assert.equal(download.type, "sub2api-data");
  assert.equal(download.accounts?.[0]?.credentials?.email, "cross-platform@example.com");

  const regenerateResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/regenerate`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(regenerateResponse.status, 200);
  job = await waitForJob(headers, jobId, (value) => value.status === "completed" && value.attempt >= 2);
  assert.equal(job.canDownload, true);

  const refreshedResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/download`, { headers });
  const refreshed = await refreshedResponse.json();
  assert.match(refreshed.accounts?.[0]?.credentials?.access_token || "", /^refreshed-access-/);

  const deleteResponse = await fetch(`${baseUrl}/api/jobs/delete-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: [jobId] }),
  });
  if (!deleteResponse.ok) {
    throw new Error(`delete request failed with HTTP ${deleteResponse.status}: ${await deleteResponse.text()}`);
  }
  const deleted = await deleteResponse.json();
  assert.equal(deleted.deleted, 1);

  const finalPage = await (await fetch(`${baseUrl}/api/jobs`, { headers })).json();
  assert.equal(finalPage.pagination.total, 0);
  console.log("console smoke tests passed");
} catch (error) {
  error.message = `${error.message}\nConsole output:\n${logs}`;
  throw error;
} finally {
  if (isRunning(child)) child.kill("SIGKILL");
  await Promise.race([childExit, delay(2_000)]);
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
    assert.equal(response.status, 200);
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
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRunning(processHandle) {
  return processHandle.exitCode === null && processHandle.signalCode === null;
}
