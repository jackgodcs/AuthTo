import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-sms-provider-"));
const smsActions = [];
let smsChecks = 0;
let customInboxChecks = 0;
const smsServer = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname === "/custom-inbox") {
    customInboxChecks += 1;
    const messages = customInboxChecks === 1
      ? [{ id: "old-sms", text: "OpenAI code\n111111\n" }]
      : [
          { id: "new-sms", text: "OpenAI code\n654321\n" },
          { id: "old-sms", text: "OpenAI code\n111111\n" },
        ];
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ messages }));
    return;
  }
  const action = url.searchParams.get("action");
  smsActions.push({ action, status: url.searchParams.get("status"), maxPrice: url.searchParams.get("maxPrice") });
  let body = "BAD_ACTION";
  if (action === "getNumber") body = "ACCESS_NUMBER:mock-activation:60123456789";
  if (action === "getStatus") body = ++smsChecks < 2 ? "STATUS_WAIT_CODE" : "STATUS_OK:654321";
  if (action === "getPrices") body = JSON.stringify({
    1001: { dr: { cost: 0.42, count: 12 } },
    7: { dr: { cost: 0.18, count: 8 } },
  });
  if (action === "getCountries") body = JSON.stringify({ countries: [
    { id: 1001, eng: "Japan", chn: "日本" },
    { id: 7, eng: "Malaysia", chn: "马来西亚" },
  ] });
  if (action === "setStatus") {
    body = { "1": "ACCESS_READY", "6": "ACCESS_ACTIVATION", "8": "ACCESS_CANCEL" }[url.searchParams.get("status")] || "BAD_STATUS";
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
});
await listen(smsServer);

const consolePort = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${consolePort}`;
const child = spawn(process.execPath, [path.join(projectRoot, "src", "console-server.mjs"), "--host", "127.0.0.1", "--port", String(consolePort)], {
  cwd: projectRoot,
  env: {
    ...process.env,
    ONBOARDING_OUTPUT_ROOT: outputRoot,
    TOSUB2_MAC_CREDENTIAL_ROOT: path.join(outputRoot, "test-mac-credentials"),
    ONBOARDING_PROTOCOL_SCRIPT: path.join(projectRoot, "test", "mock-protocol-login.mjs"),
    TOSUB2_TLS_PROFILE: "chrome142",
    SMSBOWER_API_BASE: `http://127.0.0.1:${smsServer.address().port}/handler_api.php`,
    SMS_POLL_INTERVAL_MS: "20",
    SMS_POLL_TIMEOUT_MS: "3000",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let logs = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { logs += chunk; });
child.stderr.on("data", (chunk) => { logs += chunk; });
const childExit = new Promise((resolve) => child.once("exit", resolve));

try {
  const bootstrap = await waitForJson(`${baseUrl}/api/bootstrap`);
  assert.deepEqual(bootstrap.features.smsProviders.map((provider) => provider.id), ["luban", "smsbower", "custom"]);
  const headers = { "content-type": "application/json", "x-console-token": bootstrap.token };
  const optionsResponse = await fetch(`${baseUrl}/api/sms-providers/smsbower/options`, {
    method: "POST",
    headers,
    body: JSON.stringify({ config: { apiKey: "test-api-key", service: "dr", country: "1001" } }),
  });
  const optionsText = await optionsResponse.text();
  assert.equal(optionsResponse.status, 200, optionsText);
  const optionData = JSON.parse(optionsText);
  assert.deepEqual(optionData.options.map((option) => option.country), ["7", "1001"]);
  const createdResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "sms-provider@example.com" }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  await waitForJob(headers, created.job.id, (job) => job.status === "phone");

  const numberResponse = await fetch(`${baseUrl}/api/jobs/${created.job.id}/sms-number`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      providerId: "smsbower",
      config: { apiKey: "test-api-key", service: "dr", country: "1001", maxPrice: "0.42" },
    }),
  });
  assert.equal(numberResponse.status, 200, await numberResponse.text());
  const completed = await waitForJob(headers, created.job.id, (job) => job.status === "completed");
  assert.equal(completed.smsProviderName, "SMSBower");
  assert.equal(completed.smsStatus, "completed");
  assert.ok(smsActions.some((item) => item.action === "getNumber"));
  assert.ok(smsActions.some((item) => item.action === "getStatus"));
  assert.ok(smsActions.some((item) => item.action === "setStatus" && item.status === "1"));
  assert.ok(smsActions.some((item) => item.action === "setStatus" && item.status === "6"));
  assert.ok(smsActions.some((item) => item.action === "getNumber" && item.maxPrice === "0.42"));

  const completedOrderCount = smsActions.filter((item) => item.action === "setStatus" && item.status === "6").length;
  const releasedOrderCount = smsActions.filter((item) => item.action === "setStatus" && item.status === "8").length;
  const smsChecksBeforeRejectedNumber = smsChecks;
  const rejectedResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "sms-recently-used@example.com" }),
  });
  assert.equal(rejectedResponse.status, 201);
  const rejected = await rejectedResponse.json();
  await waitForJob(headers, rejected.job.id, (job) => job.status === "phone");
  const rejectedNumberResponse = await fetch(`${baseUrl}/api/jobs/${rejected.job.id}/sms-number`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      providerId: "smsbower",
      config: { apiKey: "test-api-key", service: "dr", country: "1001", maxPrice: "0.42" },
    }),
  });
  assert.equal(rejectedNumberResponse.status, 200, await rejectedNumberResponse.text());
  const returnedToPhone = await waitForJob(
    headers,
    rejected.job.id,
    (job) => job.status === "phone" && /\u8fd1\u671f\u5df2\u88ab\u4f7f\u7528/.test(job.phoneError || ""),
  );
  assert.equal(returnedToPhone.smsStatus, "error");
  assert.equal(smsChecks - smsChecksBeforeRejectedNumber, 1);
  assert.equal(
    smsActions.filter((item) => item.action === "setStatus" && item.status === "6").length,
    completedOrderCount,
  );
  assert.equal(
    smsActions.filter((item) => item.action === "setStatus" && item.status === "8").length,
    releasedOrderCount + 1,
  );

  const customCreatedResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "custom-sms@example.com" }),
  });
  assert.equal(customCreatedResponse.status, 201);
  const customCreated = await customCreatedResponse.json();
  await waitForJob(headers, customCreated.job.id, (job) => job.status === "phone");
  const customNumberResponse = await fetch(`${baseUrl}/api/jobs/${customCreated.job.id}/sms-number`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      providerId: "custom",
      config: {
        entries: `+8613711111111----${baseUrl.replace(String(consolePort), String(smsServer.address().port))}/custom-inbox`,
      },
    }),
  });
  assert.equal(customNumberResponse.status, 200, await customNumberResponse.text());
  const customCompleted = await waitForJob(headers, customCreated.job.id, (job) => job.status === "completed");
  assert.equal(customCompleted.smsProviderName, "自定义接码");
  assert.equal(customCompleted.currentPhone, "+8613711111111");
  assert.equal(customCompleted.smsStatus, "completed");
  assert.ok(customInboxChecks >= 2);
  console.log("sms provider console tests passed");
} catch (error) {
  error.message = `${error.message}\nConsole output:\n${logs}`;
  throw error;
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.race([childExit, delay(2_000)]);
  await close(smsServer);
  await fs.rm(outputRoot, { recursive: true, force: true });
}

async function waitForJson(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {}
    await delay(100);
  }
  throw new Error("console did not start");
}

async function waitForJob(headers, jobId, predicate) {
  const deadline = Date.now() + 10_000;
  let lastJob = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/jobs`, { headers });
    const page = await response.json();
    const job = page.jobs.find((item) => item.id === jobId);
    lastJob = job || lastJob;
    if (job && predicate(job)) return job;
    if (job?.status === "failed") throw new Error(job.lastError || "task failed");
    await delay(50);
  }
  throw new Error(`task did not reach expected state: ${JSON.stringify(lastJob)}`);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
