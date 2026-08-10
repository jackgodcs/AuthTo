import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-console-"));
const port = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const sub2apiPort = await findAvailablePort();
const sub2apiUrl = `http://127.0.0.1:${sub2apiPort}`;
let uploadedAccounts = [];
let remoteErrorAccounts = [];
const updatedRemoteAccounts = new Map();
const clearedRemoteAccountIds = new Set();
const scheduledRemoteAccounts = new Map();
const clearRemoteCounts = new Map();
const failClearOnce = new Set();
const sub2api = http.createServer(async (req, res) => {
  if (req.headers["x-api-key"] !== "test-admin-key") {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "invalid admin key" }));
    return;
  }
  if (req.method === "GET" && req.url === "/api/v1/admin/groups/all?platform=openai") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([
      { id: 7, name: "测试号池", status: "active" },
      { id: 8, name: "备用号池", status: "active" },
    ]));
    return;
  }
  if (req.method === "GET" && req.url === "/api/v1/admin/proxies/all") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ id: 3, name: "测试代理", protocol: "http", host: "proxy.example", port: 8080, ip_address: "203.0.113.10", status: "active" }]));
    return;
  }
  if (req.method === "POST" && req.url === "/api/v1/admin/accounts/batch") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    uploadedAccounts = body.accounts || [];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: uploadedAccounts.length, failed: 0, results: [] }));
    return;
  }
  if (req.method === "GET" && req.url?.startsWith("/api/v1/admin/accounts?")) {
    const requestUrl = new URL(req.url, sub2apiUrl);
    const status = requestUrl.searchParams.get("status");
    const items = remoteErrorAccounts.filter((account) => !status || account.status === status);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      code: 0,
      message: "success",
      data: { items, total: items.length, page: 1, page_size: 100, pages: 1 },
    }));
    return;
  }
  const detailMatch = /^\/api\/v1\/admin\/accounts\/(\d+)$/.exec(req.url || "");
  if (req.method === "GET" && detailMatch) {
    const accountId = Number(detailMatch[1]);
    const account = remoteErrorAccounts.find((item) => Number(item.id) === accountId);
    if (!account) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "account not found" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 0, message: "success", data: account }));
    return;
  }
  const updateMatch = /^\/api\/v1\/admin\/accounts\/(\d+)$/.exec(req.url || "");
  if (req.method === "PUT" && updateMatch) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const accountId = Number(updateMatch[1]);
    updatedRemoteAccounts.set(accountId, body);
    remoteErrorAccounts = remoteErrorAccounts.map((account) => (
      Number(account.id) === accountId ? { ...account, ...body } : account
    ));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 0, message: "success", data: { id: accountId } }));
    return;
  }
  const clearMatch = /^\/api\/v1\/admin\/accounts\/(\d+)\/clear-error$/.exec(req.url || "");
  if (req.method === "POST" && clearMatch) {
    const accountId = Number(clearMatch[1]);
    clearedRemoteAccountIds.add(accountId);
    clearRemoteCounts.set(accountId, (clearRemoteCounts.get(accountId) || 0) + 1);
    remoteErrorAccounts = remoteErrorAccounts.map((account) => (
      Number(account.id) === accountId ? { ...account, status: "active", error_message: "" } : account
    ));
    if (failClearOnce.delete(accountId)) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "rate-limit cleanup failed after status recovery" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 0, message: "success", data: { id: accountId, status: "active" } }));
    return;
  }
  const schedulableMatch = /^\/api\/v1\/admin\/accounts\/(\d+)\/schedulable$/.exec(req.url || "");
  if (req.method === "POST" && schedulableMatch) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const accountId = Number(schedulableMatch[1]);
    scheduledRemoteAccounts.set(accountId, body.schedulable);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 0, message: "success", data: { id: accountId, schedulable: body.schedulable } }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ message: "not found" }));
});
await new Promise((resolve) => sub2api.listen(sub2apiPort, "127.0.0.1", resolve));
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
    PROXY_CONNECTION_RETRY_BASE_MS: "1",
    SUB2API_AUTO_REPAIR_COOLDOWN_MS: "0",
    TOSUB2_MAC_CREDENTIAL_ROOT: path.join(outputRoot, "test-mac-credentials"),
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

  const profileResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "account-profile@example.com" }),
  });
  assert.equal(profileResponse.status, 201);
  const profileCreated = await profileResponse.json();
  const profileJob = await waitForJob(headers, profileCreated.job.id, (value) => value.status === "completed");
  assert.equal(profileJob.canDownload, true);

  const setupTotpResponse = await fetch(`${baseUrl}/api/jobs/${profileJob.id}/setup-2fa`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(setupTotpResponse.status, 200, await setupTotpResponse.text());
  const totpCompleted = await waitForJob(
    headers,
    profileJob.id,
    (value) => value.status === "completed" && value.hasTotpKey,
  );
  assert.equal(totpCompleted.canDownload, true);
  assert.equal(totpCompleted.totpSetupSecret, null);
  const setupLogs = await fetch(`${baseUrl}/api/jobs/${profileJob.id}/logs`, { headers }).then((response) => response.json());
  assert.match(setupLogs.logs, /Generated a current 6-digit activation code/);
  assert.doesNotMatch(setupLogs.logs, /NB2W45DFOIZAQWER/);
  const downloadAfterTotp = await fetch(`${baseUrl}/api/jobs/${profileJob.id}/download`, { headers });
  assert.equal(downloadAfterTotp.status, 200);

  const batchTotpResponse = await fetch(`${baseUrl}/api/jobs/setup-2fa-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: [jobId, profileJob.id] }),
  });
  const batchTotpText = await batchTotpResponse.text();
  assert.equal(batchTotpResponse.status, 200, batchTotpText);
  const batchTotp = JSON.parse(batchTotpText);
  assert.equal(batchTotp.started, 1);
  assert.equal(batchTotp.skipped, 1);
  await waitForJob(headers, jobId, (value) => value.status === "completed" && value.hasTotpKey);
  const updatedSourceResponse = await fetch(`${baseUrl}/api/jobs/export-source`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: [jobId] }),
  });
  assert.equal(updatedSourceResponse.status, 200);
  assert.equal(
    (await updatedSourceResponse.text()).replace(/^\uFEFF/, "").trim(),
    "cross-platform@example.com--------NB2W45DFOIZAQWER",
  );
  const reimportUpdatedSourceResponse = await fetch(`${baseUrl}/api/jobs/batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "cross-platform@example.com--------NB2W45DFOIZAQWER" }),
  });
  const reimportUpdatedSourceText = await reimportUpdatedSourceResponse.text();
  assert.equal(reimportUpdatedSourceResponse.status, 201, reimportUpdatedSourceText);
  const reimportUpdatedSource = JSON.parse(reimportUpdatedSourceText);
  assert.equal(reimportUpdatedSource.created, 0);
  assert.equal(reimportUpdatedSource.updated, 1);
  assert.equal(reimportUpdatedSource.jobs[0].hasTotpKey, true);

  const reloginResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/relogin`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(reloginResponse.status, 200, await reloginResponse.text());
  const reloggedJob = await waitForJob(
    headers,
    jobId,
    (value) => value.status === "completed" && value.canForceRelogin,
  );
  assert.equal(reloggedJob.hasTotpKey, true);
  const reloginLogs = await fetch(`${baseUrl}/api/jobs/${jobId}/logs`, { headers }).then((response) => response.json());
  assert.match(reloginLogs.logs, /\[relogin\].*跳过刷新令牌并强制重新登录/);

  const mfaPromptResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "mfa-prompt@example.com" }),
  });
  assert.equal(mfaPromptResponse.status, 201);
  const mfaPromptJobId = (await mfaPromptResponse.json()).job.id;
  const mfaPromptJob = await waitForJob(headers, mfaPromptJobId, (value) => value.status === "mfa_otp");
  assert.equal(mfaPromptJob.prompt, "请输入 6 位 2FA 验证码");
  const mfaInputResponse = await fetch(`${baseUrl}/api/jobs/${mfaPromptJobId}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "mfa_otp", value: "123456" }),
  });
  assert.equal(mfaInputResponse.status, 200, await mfaInputResponse.text());
  await waitForJob(headers, mfaPromptJobId, (value) => value.status === "completed");

  const wrongEmailOtpResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "wrong-email-otp-console@example.com" }),
  });
  assert.equal(wrongEmailOtpResponse.status, 201);
  const wrongEmailOtpJobId = (await wrongEmailOtpResponse.json()).job.id;
  await waitForJob(headers, wrongEmailOtpJobId, (value) => value.status === "email_otp");
  const wrongEmailOtpInput = await fetch(`${baseUrl}/api/jobs/${wrongEmailOtpJobId}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "email_otp", value: "000000" }),
  });
  assert.equal(wrongEmailOtpInput.status, 200, await wrongEmailOtpInput.text());
  const retryEmailOtpJob = await waitForJob(
    headers,
    wrongEmailOtpJobId,
    (value) => value.status === "email_otp" && /验证码错误/.test(value.prompt || ""),
  );
  assert.equal(retryEmailOtpJob.prompt, "邮箱验证码错误，请重新输入或重新发送");
  const correctEmailOtpInput = await fetch(`${baseUrl}/api/jobs/${wrongEmailOtpJobId}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "email_otp", value: "123456" }),
  });
  assert.equal(correctEmailOtpInput.status, 200, await correctEmailOtpInput.text());
  const manuallyVerifiedJob = await waitForJob(headers, wrongEmailOtpJobId, (value) => value.status === "completed");
  assert.equal(manuallyVerifiedJob.autoRepairEligible, false);
  assert.match(manuallyVerifiedJob.autoRepairEligibilityReason, /手动输入/);

  const batchReloginResponse = await fetch(`${baseUrl}/api/jobs/relogin-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: [jobId, profileJob.id] }),
  });
  const batchReloginText = await batchReloginResponse.text();
  assert.equal(batchReloginResponse.status, 200, batchReloginText);
  const batchRelogin = JSON.parse(batchReloginText);
  assert.equal(batchRelogin.started, 2);
  assert.equal(batchRelogin.skipped, 0);
  await Promise.all([jobId, profileJob.id].map((id) => (
    waitForJob(headers, id, (value) => value.status === "completed" && value.canForceRelogin)
  )));

  const groupsResponse = await fetch(`${baseUrl}/api/sub2api/options`, {
    method: "POST",
    headers,
    body: JSON.stringify({ config: { baseUrl: sub2apiUrl, adminApiKey: "test-admin-key" } }),
  });
  assert.equal(groupsResponse.status, 200);
  assert.deepEqual(await groupsResponse.json(), {
    groups: [
      { id: 7, name: "测试号池", status: "active" },
      { id: 8, name: "备用号池", status: "active" },
    ],
    proxies: [{ id: 3, name: "测试代理", protocol: "http", host: "proxy.example", port: 8080, ipAddress: "203.0.113.10", status: "active" }],
  });

  const uploadResponse = await fetch(`${baseUrl}/api/sub2api/upload`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ids: [profileJob.id, "missing-job-is-filtered-by-selection-limit"],
      config: { baseUrl: sub2apiUrl, adminApiKey: "test-admin-key", groupIds: ["7", "8"], proxyId: "3", concurrency: "10", loadFactor: "100", priority: "1", modelWhitelist: "gpt-5\ngpt-5-mini" },
    }),
  });
  assert.equal(uploadResponse.status, 404);

  const validUploadResponse = await fetch(`${baseUrl}/api/sub2api/upload`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ids: [profileJob.id],
      config: { baseUrl: sub2apiUrl, adminApiKey: "test-admin-key", groupIds: ["7", "8"], proxyId: "3", concurrency: "10", loadFactor: "100", priority: "1", modelWhitelist: "gpt-5\ngpt-5-mini" },
    }),
  });
  const validUploadText = await validUploadResponse.text();
  assert.equal(validUploadResponse.status, 200, validUploadText);
  const uploadResult = JSON.parse(validUploadText);
  assert.equal(uploadResult.uploaded, 1);
  assert.equal(uploadResult.result.success, 1);
  assert.deepEqual(uploadedAccounts[0].group_ids, [7, 8]);
  assert.equal(uploadedAccounts[0].proxy_id, 3);
  assert.equal(uploadedAccounts[0].concurrency, 10);
  assert.equal(uploadedAccounts[0].load_factor, 100);
  assert.equal(uploadedAccounts[0].priority, 1);
  assert.equal(uploadedAccounts[0].status, "active");
  assert.equal(uploadedAccounts[0].schedulable, true);
  assert.deepEqual(uploadedAccounts[0].credentials.model_mapping, { "gpt-5": "gpt-5", "gpt-5-mini": "gpt-5-mini" });
  assert.equal(uploadedAccounts[0].credentials.email, "account-profile@example.com");

  const mailApiUrl = `${baseUrl}/api/bootstrap`;
  const sourceLines = [
    `password-mail@example.com---test-password----${mailApiUrl}`,
    `password-mail-totp@example.com----test-password-2----${mailApiUrl}----JBSWY3DPEHPK3PXP`,
  ];
  const batchResponse = await fetch(`${baseUrl}/api/jobs/batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: sourceLines.join("\n") }),
  });
  const batchText = await batchResponse.text();
  assert.equal(batchResponse.status, 201, batchText);
  const batch = JSON.parse(batchText);
  assert.equal(batch.jobs.length, 2);
  batch.jobs.forEach((item) => {
    assert.equal(item.loginMode, "password");
    assert.equal(item.autoEmailOtp, true);
  });
  assert.equal(batch.jobs[0].hasTotpKey, false);
  assert.equal(batch.jobs[1].hasTotpKey, true);
  await Promise.all(batch.jobs.map((item) => waitForJob(headers, item.id, (value) => value.status === "completed")));

  const sourceResponse = await fetch(`${baseUrl}/api/jobs/export-source`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: batch.jobs.map((item) => item.id) }),
  });
  assert.equal(sourceResponse.status, 200);
  const sourceExport = (await sourceResponse.text()).replace(/^\uFEFF/, "").trim().split("\n").sort();
  assert.deepEqual(sourceExport, [
    `password-mail-totp@example.com----test-password-2----${mailApiUrl}----JBSWY3DPEHPK3PXP`,
    `password-mail@example.com----test-password----${mailApiUrl}`,
  ]);

  const preserveCredentialsResponse = await fetch(`${baseUrl}/api/jobs/batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "password-mail-totp@example.com" }),
  });
  assert.equal(preserveCredentialsResponse.status, 201, await preserveCredentialsResponse.text());
  const preservedSourceResponse = await fetch(`${baseUrl}/api/jobs/export-source`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: [batch.jobs[1].id] }),
  });
  assert.equal(preservedSourceResponse.status, 200);
  assert.match(
    (await preservedSourceResponse.text()).replace(/^\uFEFF/, ""),
    new RegExp(`password-mail-totp@example\\.com----test-password-2----.*----JBSWY3DPEHPK3PXP`),
  );

  const manualPhoneResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "manual-phone-automation@example.com", password: "saved-phone-password" }),
  });
  const manualPhoneText = await manualPhoneResponse.text();
  assert.equal(manualPhoneResponse.status, 201, manualPhoneText);
  const manualPhoneJobId = JSON.parse(manualPhoneText).job.id;
  await waitForJob(headers, manualPhoneJobId, (value) => value.status === "phone");
  const manualPhoneInput = await fetch(`${baseUrl}/api/jobs/${manualPhoneJobId}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "phone", value: "+60123456789" }),
  });
  assert.equal(manualPhoneInput.status, 200, await manualPhoneInput.text());
  await waitForJob(headers, manualPhoneJobId, (value) => value.status === "phone_otp");
  const manualPhoneOtpInput = await fetch(`${baseUrl}/api/jobs/${manualPhoneJobId}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "phone_otp", value: "123456" }),
  });
  assert.equal(manualPhoneOtpInput.status, 200, await manualPhoneOtpInput.text());
  const manualPhoneCompleted = await waitForJob(
    headers,
    manualPhoneJobId,
    (value) => value.status === "completed",
  );
  assert.equal(manualPhoneCompleted.autoRepairEligible, true);

  const monitorJob = await waitForJob(
    headers,
    batch.jobs.find((item) => item.email === "password-mail@example.com").id,
    (value) => value.status === "completed" && value.autoRepairEligible,
  );
  const monitorConfig = {
    baseUrl: sub2apiUrl,
    adminApiKey: "test-admin-key",
    groupIds: ["7"],
  };
  const monitorSaveResponse = await fetch(`${baseUrl}/api/sub2api/monitor`, {
    method: "POST",
    headers,
    body: JSON.stringify({ enabled: true, config: monitorConfig }),
  });
  const monitorSaveText = await monitorSaveResponse.text();
  assert.equal(monitorSaveResponse.status, 200, monitorSaveText);
  const monitorSaved = JSON.parse(monitorSaveText);
  assert.equal(monitorSaved.enabled, true);
  assert.equal(monitorSaved.configured, true);

  remoteErrorAccounts = [{
    id: 91,
    name: "oauth---password-mail@example.com",
    platform: "openai",
    type: "oauth",
    status: "error",
    error_message: "refresh token expired",
    credentials: { email: "password-mail@example.com", model_mapping: { "gpt-5": "gpt-5" } },
    group_ids: [7],
  }];
  failClearOnce.add(91);
  const monitorCheckResponse = await fetch(`${baseUrl}/api/sub2api/monitor/check`, {
    method: "POST",
    headers,
  });
  const monitorCheckText = await monitorCheckResponse.text();
  assert.equal(monitorCheckResponse.status, 200, monitorCheckText);
  const monitorCheck = JSON.parse(monitorCheckText);
  assert.equal(monitorCheck.result.checked, 1);
  assert.equal(monitorCheck.result.started, 1);
  const firstRepair = await waitForJob(
    headers,
    monitorJob.id,
    (value) => value.status === "completed" && value.attempt > monitorJob.attempt && value.autoRepairLastError,
  );
  assert.equal(Object.hasOwn(updatedRemoteAccounts.get(91), "status"), false);
  assert.equal(remoteErrorAccounts[0].status, "active", "the mock simulates clear-error partially restoring status before failing");
  assert.equal(scheduledRemoteAccounts.has(91), false, "scheduling must remain disabled until error cleanup succeeds");

  const pendingRetryResponse = await fetch(`${baseUrl}/api/sub2api/monitor/check`, {
    method: "POST",
    headers,
  });
  const pendingRetryText = await pendingRetryResponse.text();
  assert.equal(pendingRetryResponse.status, 200, pendingRetryText);
  const pendingRetry = JSON.parse(pendingRetryText);
  assert.equal(pendingRetry.result.checked, 0, "an active account no longer appears in the error-only list");
  assert.equal(pendingRetry.result.updated, 1, "persisted pending IDs must still be retried directly");
  const repairedJob = await waitForJob(headers, monitorJob.id, (value) => value.autoRepairLastSuccessAt && !value.autoRepairLastError);
  assert.equal(repairedJob.attempt, firstRepair.attempt, "retrying the remote update must not repeat account login");
  assert.equal(clearRemoteCounts.get(91), 2);
  assert.equal(scheduledRemoteAccounts.get(91), true);
  assert.match(updatedRemoteAccounts.get(91).credentials.access_token, /^test-access-password-mail@example\.com$/);
  assert.deepEqual(updatedRemoteAccounts.get(91).credentials.model_mapping, { "gpt-5": "gpt-5" });

  const bannedCreateResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "monitor-banned@example.com", password: "saved-test-password" }),
  });
  const bannedCreateText = await bannedCreateResponse.text();
  assert.equal(bannedCreateResponse.status, 201, bannedCreateText);
  const bannedJobId = JSON.parse(bannedCreateText).job.id;
  await waitForJob(headers, bannedJobId, (value) => value.status === "completed" && value.autoRepairEligible);
  remoteErrorAccounts = [{
    id: 92,
    name: "oauth---monitor-banned@example.com",
    platform: "openai",
    type: "oauth",
    status: "error",
    error_message: "token invalid",
    credentials: { email: "monitor-banned@example.com" },
    group_ids: [7],
  }];
  const bannedMonitorResponse = await fetch(`${baseUrl}/api/sub2api/monitor/check`, {
    method: "POST",
    headers,
  });
  const bannedMonitorText = await bannedMonitorResponse.text();
  assert.equal(bannedMonitorResponse.status, 200, bannedMonitorText);
  assert.equal(JSON.parse(bannedMonitorText).result.started, 1);
  const blockedJob = await waitForJob(
    headers,
    bannedJobId,
    (value) => value.status === "failed" && value.autoRepairBlocked,
  );
  assert.match(blockedJob.autoRepairBlockedReason, /deactivated/i);
  const blockedCheckResponse = await fetch(`${baseUrl}/api/sub2api/monitor/check`, {
    method: "POST",
    headers,
  });
  const blockedCheckText = await blockedCheckResponse.text();
  assert.equal(blockedCheckResponse.status, 200, blockedCheckText);
  const blockedCheck = JSON.parse(blockedCheckText);
  assert.equal(blockedCheck.result.started, 0);
  assert.equal(blockedCheck.result.blocked, 1);

  const rotatingProxy = "socks5h://account-region-JP-sid-initial-t-20:password@proxy.example:5000";
  const proxyRetryResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "proxy-risk-retry@example.com", proxyUrl: rotatingProxy }),
  });
  assert.equal(proxyRetryResponse.status, 201);
  const proxyRetryCreated = await proxyRetryResponse.json();
  const proxyRetryCompleted = await waitForJob(
    headers,
    proxyRetryCreated.job.id,
    (value) => value.status === "completed",
  );
  assert.equal(proxyRetryCompleted.canDownload, true);
  const proxyRetryLogs = await fetch(`${baseUrl}/api/jobs/${proxyRetryCreated.job.id}/logs`, { headers }).then((response) => response.json());
  assert.match(proxyRetryLogs.logs, /正在检测第 1\/10 个新代理会话/);
  assert.match(proxyRetryLogs.logs, /正在检测第 3\/10 个新代理会话/);

  const proxyAlwaysResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "proxy-risk-always@example.com", proxyUrl: rotatingProxy }),
  });
  assert.equal(proxyAlwaysResponse.status, 201);
  const proxyAlwaysCreated = await proxyAlwaysResponse.json();
  const proxyAlwaysFailed = await waitForJob(
    headers,
    proxyAlwaysCreated.job.id,
    (value) => value.status === "failed",
  );
  assert.match(proxyAlwaysFailed.lastError || "", /自动更换 10 次/);
  const proxyAlwaysLogs = await fetch(`${baseUrl}/api/jobs/${proxyAlwaysCreated.job.id}/logs`, { headers }).then((response) => response.json());
  assert.equal((proxyAlwaysLogs.logs.match(/个新代理会话/g) || []).length, 10);
  assert.doesNotMatch(proxyAlwaysLogs.logs, /正在检测第 11\//);

  const proxyConnectionResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "proxy-connection-retry@example.com", proxyUrl: rotatingProxy }),
  });
  assert.equal(proxyConnectionResponse.status, 201);
  const proxyConnectionCreated = await proxyConnectionResponse.json();
  await waitForJob(headers, proxyConnectionCreated.job.id, (value) => value.status === "completed");
  const proxyConnectionLogs = await fetch(`${baseUrl}/api/jobs/${proxyConnectionCreated.job.id}/logs`, { headers })
    .then((response) => response.json());
  assert.match(proxyConnectionLogs.logs, /HTTP 检测次数仍为 0\/10；连接失败 1\/20/);
  assert.equal((proxyConnectionLogs.logs.match(/个新代理会话/g) || []).length, 1);

  const proxyConnectionAlwaysResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "proxy-connection-always@example.com", proxyUrl: rotatingProxy }),
  });
  assert.equal(proxyConnectionAlwaysResponse.status, 201);
  const proxyConnectionAlwaysCreated = await proxyConnectionAlwaysResponse.json();
  const proxyConnectionAlwaysFailed = await waitForJob(
    headers,
    proxyConnectionAlwaysCreated.job.id,
    (value) => value.status === "failed",
  );
  assert.match(proxyConnectionAlwaysFailed.lastError || "", /连续失败 20 次/);

  const deleteResponse = await fetch(`${baseUrl}/api/jobs/delete-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: [
      jobId,
      profileJob.id,
      mfaPromptJobId,
      wrongEmailOtpJobId,
      ...batch.jobs.map((item) => item.id),
      proxyRetryCreated.job.id,
      proxyAlwaysCreated.job.id,
      proxyConnectionCreated.job.id,
      proxyConnectionAlwaysCreated.job.id,
      bannedJobId,
      manualPhoneJobId,
    ] }),
  });
  if (!deleteResponse.ok) {
    throw new Error(`delete request failed with HTTP ${deleteResponse.status}: ${await deleteResponse.text()}`);
  }
  const deleted = await deleteResponse.json();
  assert.equal(deleted.deleted, 12);

  const finalPage = await (await fetch(`${baseUrl}/api/jobs`, { headers })).json();
  assert.equal(finalPage.pagination.total, 0);
  console.log("console smoke tests passed");
} catch (error) {
  error.message = `${error.message}\nConsole output:\n${logs}`;
  throw error;
} finally {
  if (isRunning(child)) child.kill("SIGKILL");
  await Promise.race([childExit, delay(2_000)]);
  await new Promise((resolve) => sub2api.close(resolve));
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

async function waitFor(predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error("condition did not become true before timeout");
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
