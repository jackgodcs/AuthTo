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
let rejectSub2ApiEmail = "";
let remoteErrorAccounts = [];
const updatedRemoteAccounts = new Map();
const clearedRemoteAccountIds = new Set();
const scheduledRemoteAccounts = new Map();
const clearRemoteCounts = new Map();
const failClearOnce = new Set();
const cpampFiles = new Map();
const supportsConsoleCpampSettings = process.platform === "win32";
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
    const rejected = uploadedAccounts.find((account) => account?.credentials?.email === rejectSub2ApiEmail);
    res.end(JSON.stringify(rejected
      ? { success: 0, failed: 1, results: [{ status: "failed", email: rejectSub2ApiEmail, message: "mock rejected credential" }] }
      : { success: uploadedAccounts.length, failed: 0, results: [] }));
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
const cpampPort = await findAvailablePort();
const cpampUrl = `http://127.0.0.1:${cpampPort}`;
const cpamp = http.createServer(async (req, res) => {
  if (req.headers.authorization !== "Bearer test-cpamp-key") {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "invalid management key" }));
    return;
  }
  const requestUrl = new URL(req.url, cpampUrl);
  if (req.method === "GET" && requestUrl.pathname === "/auth-files") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ files: [...cpampFiles.entries()].map(([name, payload]) => ({
      name,
      email: payload.email,
      disabled: payload.disabled === true,
      status: payload.status,
      failed: payload.failed || 0,
      status_message: payload.status_message,
    })) }));
    return;
  }
  if (req.method === "GET" && requestUrl.pathname === "/auth-files/download") {
    const payload = cpampFiles.get(requestUrl.searchParams.get("name"));
    if (!payload) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "not found" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }
  if (req.method === "POST" && requestUrl.pathname === "/auth-files") {
    const parsed = parseMultipartJson(await readBody(req), String(req.headers["content-type"] || ""));
    cpampFiles.set(parsed.name, parsed.payload);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ message: "not found" }));
});
await new Promise((resolve) => cpamp.listen(cpampPort, "127.0.0.1", resolve));
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
    TOSUB2_TLS_PROFILE: "chrome142",
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
  assert.equal(bootstrap.features.accountGroups, true);
  assert.equal(bootstrap.features.groupFilter, true);
  const headers = { "content-type": "application/json", "x-console-token": bootstrap.token };
  if (supportsConsoleCpampSettings) {
    const cpampConfigResponse = await fetch(`${baseUrl}/api/cpamp/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        baseUrl: cpampUrl,
        managementKey: "test-cpamp-key",
        autoSyncEnabled: false,
        syncAfterManualReauthorization: true,
      }),
    });
    const cpampConfigText = await cpampConfigResponse.text();
    assert.equal(cpampConfigResponse.status, 200, cpampConfigText);
    assert.equal(JSON.parse(cpampConfigText).syncAfterManualReauthorization, true);
  }

  const pageResponse = await fetch(`${baseUrl}/`);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get("content-type") || "", /text\/html;\s*charset=utf-8/i);

  const mailRequestConfigResponse = await fetch(`${baseUrl}/api/mail-request-config`, {
    method: "POST",
    headers,
    body: JSON.stringify({ config: {
      method: "POST",
      url: `${baseUrl}/api/bootstrap`,
      headers: { Authorization: "Bearer private-mail-token", Referer: "https://mail.example/private" },
    } }),
  });
  const mailRequestConfigText = await mailRequestConfigResponse.text();
  assert.equal(mailRequestConfigResponse.status, 200, mailRequestConfigText);
  assert.deepEqual(JSON.parse(mailRequestConfigText).config, {
    method: "POST",
    urlConfigured: true,
    headerCount: 2,
  });

  const postMailSourceLines = [
    "post-body@example.com----eyJtYWlsYm94X2lkIjoiaWQtYSJ9",
    "post-password@example.com----test-password----opaque-account-body",
    '{"mailbox_id":"id-c"}----post-unordered@example.com----test-password-c',
  ];
  const postMailBatchResponse = await fetch(`${baseUrl}/api/jobs/batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: postMailSourceLines.join("\n") }),
  });
  const postMailBatchText = await postMailBatchResponse.text();
  assert.equal(postMailBatchResponse.status, 201, postMailBatchText);
  const postMailBatch = JSON.parse(postMailBatchText);
  assert.equal(postMailBatch.jobs.length, 3);
  postMailBatch.jobs.forEach((job) => assert.equal(job.groupId, null, "newly imported accounts start ungrouped"));
  assert.equal(postMailBatch.jobs.find((job) => job.email === "post-body@example.com").loginMode, "email_otp");
  assert.equal(postMailBatch.jobs.find((job) => job.email === "post-password@example.com").loginMode, "password");
  assert.equal(postMailBatch.jobs.find((job) => job.email === "post-unordered@example.com").loginMode, "password");
  postMailBatch.jobs.forEach((job) => assert.equal(job.autoEmailOtp, true));

  const postMailSourceResponse = await fetch(`${baseUrl}/api/jobs/export-source`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: postMailBatch.jobs.map((job) => job.id) }),
  });
  const postMailSourceText = await postMailSourceResponse.text();
  assert.equal(postMailSourceResponse.status, 200, postMailSourceText);
  const postMailSourceExport = postMailSourceText.replace(/^\uFEFF/, "").trim().split("\n").sort();
  assert.deepEqual(postMailSourceExport, [
    "post-body@example.com----eyJtYWlsYm94X2lkIjoiaWQtYSJ9",
    "post-password@example.com----test-password----opaque-account-body",
    'post-unordered@example.com----test-password-c----{"mailbox_id":"id-c"}',
  ].sort());

  const deletePostMailJobsResponse = await fetch(`${baseUrl}/api/jobs/delete-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: postMailBatch.jobs.map((job) => job.id) }),
  });
  assert.equal(deletePostMailJobsResponse.status, 200, await deletePostMailJobsResponse.text());

  const forbiddenMailHeaderResponse = await fetch(`${baseUrl}/api/mail-request-config`, {
    method: "POST",
    headers,
    body: JSON.stringify({ config: { method: "GET", headers: { Host: "mail.example" } } }),
  });
  assert.equal(forbiddenMailHeaderResponse.status, 400, await forbiddenMailHeaderResponse.text());

  const resetMailRequestConfigResponse = await fetch(`${baseUrl}/api/mail-request-config`, {
    method: "POST",
    headers,
    body: JSON.stringify({ config: { method: "GET", headers: {} } }),
  });
  assert.equal(resetMailRequestConfigResponse.status, 200, await resetMailRequestConfigResponse.text());

  const createdResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "cross-platform@example.com" }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.created, true);
  assert.equal(created.job.groupId, null, "newly created accounts start ungrouped");
  assert.equal(created.job.lastOperationType, "initial_authorization");
  assert.ok(Date.parse(created.job.lastOperationAt));
  const jobId = created.job.id;

  let job = await waitForJob(headers, jobId, (value) => value.status === "completed");
  assert.equal(job.canDownload, true);
  if (supportsConsoleCpampSettings) {
    assert.equal(cpampFiles.size, 0, "initial authorization must not use the manual reauthorization switch");
  }

  const filteredJobsResponse = await fetch(`${baseUrl}/api/jobs/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      page: 1,
      emails: ["cross-platform@example.com"],
      status: "completed",
      search: "cross-platform",
    }),
  });
  const filteredJobsText = await filteredJobsResponse.text();
  assert.equal(filteredJobsResponse.status, 200, filteredJobsText);
  const filteredJobs = JSON.parse(filteredJobsText);
  assert.equal(filteredJobs.pagination.total, 1);
  assert.equal(filteredJobs.pagination.pageSize, 20);
  assert.equal(filteredJobs.jobs[0].id, jobId);
  assert.deepEqual(filteredJobs.selection.map((item) => item.id), [jobId]);

  const largerPageResponse = await fetch(`${baseUrl}/api/jobs/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({ page: 1, pageSize: 50, emails: ["cross-platform@example.com"] }),
  });
  const largerPageText = await largerPageResponse.text();
  assert.equal(largerPageResponse.status, 200, largerPageText);
  assert.equal(JSON.parse(largerPageText).pagination.pageSize, 50);

  const invalidPageSizeResponse = await fetch(`${baseUrl}/api/jobs/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({ page: 1, pageSize: 30 }),
  });
  assert.equal(invalidPageSizeResponse.status, 400, await invalidPageSizeResponse.text());

  const createGroupResponse = await fetch(`${baseUrl}/api/account-groups`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "第一批账号" }),
  });
  const createGroupText = await createGroupResponse.text();
  assert.equal(createGroupResponse.status, 201, createGroupText);
  const firstGroup = JSON.parse(createGroupText).group;
  assert.equal(firstGroup.name, "第一批账号");

  const assignFirstGroupResponse = await fetch(`${baseUrl}/api/jobs/group`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: [jobId], groupId: firstGroup.id }),
  });
  const assignFirstGroupText = await assignFirstGroupResponse.text();
  assert.equal(assignFirstGroupResponse.status, 200, assignFirstGroupText);
  assert.equal(JSON.parse(assignFirstGroupText).jobs[0].groupName, "第一批账号");

  const groupedQueryResponse = await fetch(`${baseUrl}/api/jobs/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({ page: 1, groupId: firstGroup.id }),
  });
  const groupedQueryText = await groupedQueryResponse.text();
  assert.equal(groupedQueryResponse.status, 200, groupedQueryText);
  const groupedQuery = JSON.parse(groupedQueryText);
  assert.equal(groupedQuery.pagination.total, 1);
  assert.equal(groupedQuery.jobs[0].id, jobId);
  assert.equal(groupedQuery.groups.find((group) => group.id === firstGroup.id).count, 1);

  const assignSecondGroupResponse = await fetch(`${baseUrl}/api/jobs/group`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: [jobId], groupName: "第二批账号" }),
  });
  const assignSecondGroupText = await assignSecondGroupResponse.text();
  assert.equal(assignSecondGroupResponse.status, 200, assignSecondGroupText);
  const secondGroupResult = JSON.parse(assignSecondGroupText);
  assert.equal(secondGroupResult.created, true);
  const secondGroup = secondGroupResult.group;
  assert.equal(secondGroup.name, "第二批账号");
  assert.equal(secondGroupResult.jobs[0].groupId, secondGroup.id);

  const firstGroupAfterMoveResponse = await fetch(`${baseUrl}/api/jobs/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({ page: 1, groupId: firstGroup.id }),
  });
  const firstGroupAfterMoveText = await firstGroupAfterMoveResponse.text();
  assert.equal(firstGroupAfterMoveResponse.status, 200, firstGroupAfterMoveText);
  assert.equal(JSON.parse(firstGroupAfterMoveText).pagination.total, 0, "an account cannot remain in its previous group after moving");

  const secondGroupQueryResponse = await fetch(`${baseUrl}/api/jobs/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({ page: 1, groupId: secondGroup.id }),
  });
  const secondGroupQueryText = await secondGroupQueryResponse.text();
  assert.equal(secondGroupQueryResponse.status, 200, secondGroupQueryText);
  assert.equal(JSON.parse(secondGroupQueryText).pagination.total, 1);

  const deleteGroupResponse = await fetch(`${baseUrl}/api/account-groups/${secondGroup.id}`, {
    method: "DELETE",
    headers,
  });
  const deleteGroupText = await deleteGroupResponse.text();
  assert.equal(deleteGroupResponse.status, 200, deleteGroupText);
  assert.equal(JSON.parse(deleteGroupText).ungrouped, 1);

  const ungroupedQueryResponse = await fetch(`${baseUrl}/api/jobs/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({ page: 1, groupId: "__ungrouped__" }),
  });
  const ungroupedQueryText = await ungroupedQueryResponse.text();
  assert.equal(ungroupedQueryResponse.status, 200, ungroupedQueryText);
  const ungroupedQuery = JSON.parse(ungroupedQueryText);
  assert.equal(ungroupedQuery.jobs.find((item) => item.id === jobId).groupId, null);

  const deletedGroupQueryResponse = await fetch(`${baseUrl}/api/jobs/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({ page: 1, groupId: secondGroup.id }),
  });
  assert.equal(deletedGroupQueryResponse.status, 400, await deletedGroupQueryResponse.text());

  const invalidStatusFilterResponse = await fetch(`${baseUrl}/api/jobs/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({ page: 1, status: "not-a-status" }),
  });
  assert.equal(invalidStatusFilterResponse.status, 400, await invalidStatusFilterResponse.text());

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
  assert.equal(job.lastOperationType, "reauthorize");
  if (supportsConsoleCpampSettings) {
    await waitFor(() => cpampAccount("cross-platform@example.com")?.access_token?.startsWith("refreshed-access-"));
  }

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

  const batchReauthorizeResponse = await fetch(`${baseUrl}/api/jobs/reauthorize-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: [jobId, profileJob.id] }),
  });
  const batchReauthorizeText = await batchReauthorizeResponse.text();
  assert.equal(batchReauthorizeResponse.status, 200, batchReauthorizeText);
  assert.equal(JSON.parse(batchReauthorizeText).started, 2);
  await Promise.all([
    waitForJob(headers, jobId, (value) => value.status === "completed" && value.lastOperationType === "reauthorize" && value.attempt >= 3),
    waitForJob(headers, profileJob.id, (value) => value.status === "completed" && value.lastOperationType === "reauthorize" && value.attempt >= 2),
  ]);
  if (supportsConsoleCpampSettings) {
    await waitFor(() => cpampAccount("account-profile@example.com")?.access_token?.startsWith("refreshed-access-"));
  }

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
  assert.equal(totpCompleted.lastOperationType, "setup_2fa");
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
  assert.equal(reimportUpdatedSource.jobs[0].email, "cross-platform@example.com");
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
  assert.equal(reloggedJob.lastOperationType, "relogin");
  if (supportsConsoleCpampSettings) {
    await waitFor(() => cpampAccount("cross-platform@example.com")?.access_token?.startsWith("test-access-"));
  }
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

  const phoneFallbackResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "phone@example.com" }),
  });
  const phoneFallbackText = await phoneFallbackResponse.text();
  assert.equal(phoneFallbackResponse.status, 201, phoneFallbackText);
  const phoneFallbackJobId = JSON.parse(phoneFallbackText).job.id;
  await waitForJob(headers, phoneFallbackJobId, (value) => value.status === "phone");
  const firstPhoneInput = await fetch(`${baseUrl}/api/jobs/${phoneFallbackJobId}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "phone", value: "+60111111111" }),
  });
  assert.equal(firstPhoneInput.status, 200, await firstPhoneInput.text());
  const changePhoneJob = await waitForJob(
    headers,
    phoneFallbackJobId,
    (value) => value.status === "phone" && /更换手机号/.test(value.prompt || ""),
  );
  assert.equal(changePhoneJob.attempt, 1, "a phone-specific fallback error must not restart account login");
  assert.equal(changePhoneJob.restartRequired, false);
  assert.match(changePhoneJob.phoneError || "", /手机号触发了风控/);
  const secondPhoneInput = await fetch(`${baseUrl}/api/jobs/${phoneFallbackJobId}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "phone", value: "+60122222222" }),
  });
  assert.equal(secondPhoneInput.status, 200, await secondPhoneInput.text());
  await waitForJob(headers, phoneFallbackJobId, (value) => value.status === "phone_otp");
  const phoneOtpInput = await fetch(`${baseUrl}/api/jobs/${phoneFallbackJobId}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "phone_otp", value: "123456" }),
  });
  assert.equal(phoneOtpInput.status, 200, await phoneOtpInput.text());
  await waitForJob(headers, phoneFallbackJobId, (value) => value.status === "completed");

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
  if (supportsConsoleCpampSettings) {
    await waitFor(() => cpampAccount("account-profile@example.com")?.access_token?.startsWith("test-access-"));
  }

  const addPasswordResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/add-password`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(addPasswordResponse.status, 200, await addPasswordResponse.text());
  await submitEmailOtp(headers, jobId);
  await submitEmailOtp(headers, jobId);
  const passwordAddedJob = await waitForJob(
    headers,
    jobId,
    (value) => value.status === "completed" && value.passwordAddedAt,
  );
  assert.equal(passwordAddedJob.lastOperationType, "add_password");
  if (process.platform === "linux") {
    assert.match(passwordAddedJob.passwordAddError || "", /不支持持久凭据存储/);
  } else {
    assert.equal(passwordAddedJob.passwordAddError, null);
  }
  assert.equal(passwordAddedJob.canAddPassword, false);

  const passwordSourceResponse = await fetch(`${baseUrl}/api/jobs/export-source`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: [jobId] }),
  });
  const passwordSourceText = await passwordSourceResponse.text();
  assert.equal(passwordSourceResponse.status, 200, passwordSourceText);
  const passwordSourceParts = passwordSourceText.replace(/^\uFEFF/, "").trim().split("----");
  assert.equal(passwordSourceParts[0], "cross-platform@example.com");
  assert.equal(passwordSourceParts[2], "NB2W45DFOIZAQWER");
  assert.equal(passwordSourceParts[1].length, 18);
  assert.match(passwordSourceParts[1], /[a-z]/);
  assert.match(passwordSourceParts[1], /[A-Z]/);
  assert.match(passwordSourceParts[1], /\d/);
  assert.match(passwordSourceParts[1], /[^A-Za-z0-9]/);

  const batchPasswordResponse = await fetch(`${baseUrl}/api/jobs/add-password-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: [jobId, profileJob.id] }),
  });
  const batchPasswordText = await batchPasswordResponse.text();
  assert.equal(batchPasswordResponse.status, 200, batchPasswordText);
  const batchPassword = JSON.parse(batchPasswordText);
  assert.equal(batchPassword.started, 1);
  assert.equal(batchPassword.skipped, 1);
  await submitEmailOtp(headers, profileJob.id);
  await submitEmailOtp(headers, profileJob.id);
  const profilePasswordAdded = await waitForJob(
    headers,
    profileJob.id,
    (value) => value.status === "completed" && value.passwordAddedAt,
  );
  if (process.platform === "linux") {
    assert.match(profilePasswordAdded.passwordAddError || "", /不支持持久凭据存储/);
  } else {
    assert.equal(profilePasswordAdded.passwordAddError, null);
  }
  assert.equal(profilePasswordAdded.canAddPassword, false);

  const incompleteAuthorizationResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "resume@example.com" }),
  });
  const incompleteAuthorizationText = await incompleteAuthorizationResponse.text();
  assert.equal(incompleteAuthorizationResponse.status, 201, incompleteAuthorizationText);
  const incompleteAuthorizationId = JSON.parse(incompleteAuthorizationText).job.id;
  const loginCompletedJob = await waitForJob(
    headers,
    incompleteAuthorizationId,
    (value) => value.status === "phone" && value.canAddPassword,
  );
  assert.equal(loginCompletedJob.canDownload, false);

  const incompletePasswordResponse = await fetch(`${baseUrl}/api/jobs/${incompleteAuthorizationId}/add-password`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(incompletePasswordResponse.status, 200, await incompletePasswordResponse.text());
  await submitEmailOtp(headers, incompleteAuthorizationId);
  const incompletePasswordAdded = await waitForJob(
    headers,
    incompleteAuthorizationId,
    (value) => value.status === "resume_available" && value.passwordAddedAt,
  );
  assert.equal(incompletePasswordAdded.canDownload, false);
  assert.equal(incompletePasswordAdded.canRetry, true);
  assert.equal(incompletePasswordAdded.canAddPassword, false);
  assert.equal(incompletePasswordAdded.loginMode, "password");
  if (process.platform === "linux") {
    assert.match(incompletePasswordAdded.prompt, /新密码未能持久保存/);
  } else {
    assert.match(incompletePasswordAdded.prompt, /可以继续未完成的 Codex 授权/);
  }
  const incompletePasswordLogs = await fetch(`${baseUrl}/api/jobs/${incompleteAuthorizationId}/logs`, { headers })
    .then((response) => response.json());
  assert.match(incompletePasswordLogs.logs, /Reusing verified login checkpoint/);

  const continueAuthorizationResponse = await fetch(`${baseUrl}/api/jobs/${incompleteAuthorizationId}/retry`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(continueAuthorizationResponse.status, 200, await continueAuthorizationResponse.text());
  await waitForJob(headers, incompleteAuthorizationId, (value) => value.status === "phone");
  const continuedPhoneResponse = await fetch(`${baseUrl}/api/jobs/${incompleteAuthorizationId}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "phone", value: "+60123450000" }),
  });
  assert.equal(continuedPhoneResponse.status, 200, await continuedPhoneResponse.text());
  await waitForJob(headers, incompleteAuthorizationId, (value) => value.status === "phone_otp");
  const continuedPhoneOtpResponse = await fetch(`${baseUrl}/api/jobs/${incompleteAuthorizationId}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "phone_otp", value: "123456" }),
  });
  assert.equal(continuedPhoneOtpResponse.status, 200, await continuedPhoneOtpResponse.text());
  await waitForJob(headers, incompleteAuthorizationId, (value) => value.status === "completed");

  const incompleteTotpResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "resume-phone@example.com" }),
  });
  const incompleteTotpText = await incompleteTotpResponse.text();
  assert.equal(incompleteTotpResponse.status, 201, incompleteTotpText);
  const incompleteTotpId = JSON.parse(incompleteTotpText).job.id;
  const totpLoginCompleted = await waitForJob(
    headers,
    incompleteTotpId,
    (value) => value.status === "phone" && value.canSetupTotp,
  );
  assert.equal(totpLoginCompleted.canDownload, false);

  const incompleteTotpSetupResponse = await fetch(`${baseUrl}/api/jobs/${incompleteTotpId}/setup-2fa`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(incompleteTotpSetupResponse.status, 200, await incompleteTotpSetupResponse.text());
  const incompleteTotpCompleted = await waitForJob(
    headers,
    incompleteTotpId,
    (value) => value.status === "resume_available" && value.hasTotpKey,
  );
  assert.equal(incompleteTotpCompleted.canDownload, false);
  assert.equal(incompleteTotpCompleted.canRetry, true);
  assert.equal(incompleteTotpCompleted.canSetupTotp, false);
  assert.match(incompleteTotpCompleted.prompt, /2FA 已设置.*继续未完成的 Codex 授权/);
  const incompleteTotpLogs = await fetch(`${baseUrl}/api/jobs/${incompleteTotpId}/logs`, { headers })
    .then((response) => response.json());
  assert.match(incompleteTotpLogs.logs, /Reusing verified login checkpoint/);

  const continueTotpAuthorizationResponse = await fetch(`${baseUrl}/api/jobs/${incompleteTotpId}/retry`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(continueTotpAuthorizationResponse.status, 200, await continueTotpAuthorizationResponse.text());
  await waitForJob(headers, incompleteTotpId, (value) => value.status === "phone");
  const continuedTotpPhoneResponse = await fetch(`${baseUrl}/api/jobs/${incompleteTotpId}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "phone", value: "+60123450001" }),
  });
  assert.equal(continuedTotpPhoneResponse.status, 200, await continuedTotpPhoneResponse.text());
  await waitForJob(headers, incompleteTotpId, (value) => value.status === "phone_otp");
  const continuedTotpPhoneOtpResponse = await fetch(`${baseUrl}/api/jobs/${incompleteTotpId}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "phone_otp", value: "123456" }),
  });
  assert.equal(continuedTotpPhoneOtpResponse.status, 200, await continuedTotpPhoneOtpResponse.text());
  await waitForJob(headers, incompleteTotpId, (value) => value.status === "completed");

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
      config: { baseUrl: sub2apiUrl, adminApiKey: "test-admin-key", groupIds: ["7", "8"], proxyId: "3", concurrency: "10", loadFactor: "100", priority: "1", modelWhitelist: "gpt-5\ngpt-5-mini", codexFingerprintMode: "full" },
    }),
  });
  assert.equal(uploadResponse.status, 404);

  const validUploadResponse = await fetch(`${baseUrl}/api/sub2api/upload`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ids: [profileJob.id],
      config: { baseUrl: sub2apiUrl, adminApiKey: "test-admin-key", groupIds: ["7", "8"], proxyId: "3", concurrency: "10", loadFactor: "100", priority: "1", modelWhitelist: "gpt-5\ngpt-5-mini", codexFingerprintMode: "full" },
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
  assert.equal(uploadedAccounts[0].extra.codex_fingerprint_mode, "full");
  assert.deepEqual(uploadedAccounts[0].credentials.model_mapping, { "gpt-5": "gpt-5", "gpt-5-mini": "gpt-5-mini" });
  assert.equal(uploadedAccounts[0].credentials.email, "account-profile@example.com");

  const legacyUploadResponse = await fetch(`${baseUrl}/api/sub2api/upload`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ids: [profileJob.id],
      config: { baseUrl: sub2apiUrl, adminApiKey: "test-admin-key" },
    }),
  });
  assert.equal(legacyUploadResponse.status, 200, await legacyUploadResponse.text());
  assert.equal(uploadedAccounts[0].extra.codex_fingerprint_mode, "session", "旧配置未填写时应使用 Sub2API 的推荐默认值");

  const disabledFingerprintUploadResponse = await fetch(`${baseUrl}/api/sub2api/upload`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ids: [profileJob.id],
      config: { baseUrl: sub2apiUrl, adminApiKey: "test-admin-key", codexFingerprintMode: "off" },
    }),
  });
  assert.equal(disabledFingerprintUploadResponse.status, 200, await disabledFingerprintUploadResponse.text());
  assert.equal(uploadedAccounts[0].extra.codex_fingerprint_mode, "off", "关闭模式必须显式写入，不能退回默认值");

  const invalidFingerprintUploadResponse = await fetch(`${baseUrl}/api/sub2api/upload`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ids: [profileJob.id],
      config: { baseUrl: sub2apiUrl, adminApiKey: "test-admin-key", codexFingerprintMode: "invalid" },
    }),
  });
  assert.equal(invalidFingerprintUploadResponse.status, 400, await invalidFingerprintUploadResponse.text());

  const automaticSyncConfig = {
    baseUrl: sub2apiUrl,
    adminApiKey: "test-admin-key",
    groupIds: ["7"],
    codexFingerprintMode: "session",
  };
  const automaticSyncSaveResponse = await fetch(`${baseUrl}/api/sub2api/monitor`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      enabled: false,
      autoSyncEnabled: true,
      syncAfterManualReauthorization: true,
      config: automaticSyncConfig,
    }),
  });
  const automaticSyncSaveText = await automaticSyncSaveResponse.text();
  assert.equal(automaticSyncSaveResponse.status, 200, automaticSyncSaveText);
  const automaticSyncSaved = JSON.parse(automaticSyncSaveText);
  assert.equal(automaticSyncSaved.enabled, false, "automatic sync settings must not enable pool monitoring");
  assert.equal(automaticSyncSaved.autoSyncEnabled, true);
  assert.equal(automaticSyncSaved.syncAfterManualReauthorization, true);
  const storedAutomaticSyncConfig = JSON.parse(await fs.readFile(path.join(outputRoot, "sub2api-monitor.json"), "utf8"));
  assert.equal(storedAutomaticSyncConfig.enabled, false);
  assert.equal(storedAutomaticSyncConfig.autoSyncEnabled, true);
  assert.equal(storedAutomaticSyncConfig.syncAfterManualReauthorization, true);

  const automaticManualReauthorizationResponse = await fetch(`${baseUrl}/api/jobs/reauthorize-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: [jobId, profileJob.id] }),
  });
  const automaticManualReauthorizationText = await automaticManualReauthorizationResponse.text();
  assert.equal(automaticManualReauthorizationResponse.status, 200, automaticManualReauthorizationText);
  await Promise.all([
    waitForJob(headers, jobId, (value) => value.status === "completed" && value.sub2ApiSync?.state === "synced"),
    waitForJob(headers, profileJob.id, (value) => value.status === "completed" && value.sub2ApiSync?.state === "synced"),
  ]);

  const automaticPendingCreateResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "sub2api-auto-pending@example.com" }),
  });
  const automaticPendingCreateText = await automaticPendingCreateResponse.text();
  assert.equal(automaticPendingCreateResponse.status, 201, automaticPendingCreateText);
  const automaticPendingJobId = JSON.parse(automaticPendingCreateText).job.id;
  const automaticPendingJob = await waitForJob(
    headers,
    automaticPendingJobId,
    (value) => value.status === "completed" && value.sub2ApiSync?.state === "pending_confirmation",
  );
  const automaticSyncStatus = await fetch(`${baseUrl}/api/sub2api/monitor`, { headers }).then((response) => response.json());
  assert.equal(automaticSyncStatus.pendingCount, 1);
  assert.equal(automaticSyncStatus.pending[0].pendingJobId, automaticPendingJob.id);
  assert.equal(automaticSyncStatus.enabled, false);

  const pendingSub2ApiQueryResponse = await fetch(`${baseUrl}/api/jobs/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({ page: 1, sub2ApiState: "pending_confirmation" }),
  });
  const pendingSub2ApiQueryText = await pendingSub2ApiQueryResponse.text();
  assert.equal(pendingSub2ApiQueryResponse.status, 200, pendingSub2ApiQueryText);
  assert.equal(JSON.parse(pendingSub2ApiQueryText).jobs.some((item) => item.id === automaticPendingJobId), true);

  const approveAutomaticSyncResponse = await fetch(`${baseUrl}/api/sub2api/approve`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: [automaticPendingJobId] }),
  });
  const approveAutomaticSyncText = await approveAutomaticSyncResponse.text();
  assert.equal(approveAutomaticSyncResponse.status, 200, approveAutomaticSyncText);
  assert.equal(JSON.parse(approveAutomaticSyncText).uploaded, 1);
  const approvedAutomaticJob = await waitForJob(headers, automaticPendingJobId, (value) => value.sub2ApiSync?.state === "synced");
  assert.equal(approvedAutomaticJob.sub2ApiSync.lastError, null);

  rejectSub2ApiEmail = "sub2api-manual-failure@example.com";
  const manualFailureCreateResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: rejectSub2ApiEmail }),
  });
  const manualFailureCreateText = await manualFailureCreateResponse.text();
  assert.equal(manualFailureCreateResponse.status, 201, manualFailureCreateText);
  const manualFailureJobId = JSON.parse(manualFailureCreateText).job.id;
  await waitForJob(headers, manualFailureJobId, (value) => value.status === "completed" && value.sub2ApiSync?.state === "pending_confirmation");
  const rejectApproveResponse = await fetch(`${baseUrl}/api/sub2api/approve`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: [manualFailureJobId] }),
  });
  const rejectApproveText = await rejectApproveResponse.text();
  assert.equal(rejectApproveResponse.status, 200, rejectApproveText);
  const rejectApprove = JSON.parse(rejectApproveText);
  assert.equal(rejectApprove.failed, 1);
  assert.match(rejectApprove.results[0].error, /mock rejected credential/);
  const failedAutomaticJob = await waitForJob(headers, manualFailureJobId, (value) => value.sub2ApiSync?.state === "failed");
  assert.match(failedAutomaticJob.sub2ApiSync.lastError, /mock rejected credential/);
  const failedSub2ApiQueryResponse = await fetch(`${baseUrl}/api/jobs/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({ page: 1, sub2ApiState: "failed" }),
  });
  const failedSub2ApiQueryText = await failedSub2ApiQueryResponse.text();
  assert.equal(failedSub2ApiQueryResponse.status, 200, failedSub2ApiQueryText);
  assert.equal(JSON.parse(failedSub2ApiQueryText).jobs.some((item) => item.id === manualFailureJobId), true);
  rejectSub2ApiEmail = "";

  const mailApiUrl = `${baseUrl}/api/bootstrap`;
  const sourceLines = [
    `password-mail@example.com---test-password----${mailApiUrl}`,
    `password-mail-totp@example.com----test-password-2----${mailApiUrl}----JBSWY3DPEHPK3PXP`,
    `${mailApiUrl}|JBSWY3DPEHPK3PXP|unordered-password|smart.user-name@sub.example.co.uk`,
    `pipe-password@example.dev|part-one|part-two|${mailApiUrl}|NB2W45DFOIZAQWER`,
    `MFRGGZDFMZTWQ2LK::colon-password::name+tag@sub-domain.example.cloud`,
    `${mailApiUrl},reverse.api-order@example.xyz`,
    `manual-totp@example.net--------ONSWG4TFOQXXXXXX======`,
    `user---tag@example.com----hyphen-email-password`,
    `password-empty-field@example.org----plain-password--------GEZDGNBVGY3TQOJQ`,
    `space-group@example.org  grouped-password  JBSW  Y3DP  EHPK  3PXP`,
    `base32-password@example.org----ABCDEFGHIJKLMNOP----${mailApiUrl}`,
    "biers.ellipse.case@icloud.com----aBCD2345eFGH6723----JBSWY3DPEHPK3PXPNB2W45DFOIZAQWER",
    "dot-password@example.com----r7.UjRUWVVS----JBSWY3DPEHPK3PXP",
  ];
  const batchResponse = await fetch(`${baseUrl}/api/jobs/batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: sourceLines.join("\n") }),
  });
  const batchText = await batchResponse.text();
  assert.equal(batchResponse.status, 201, batchText);
  const batch = JSON.parse(batchText);
  assert.equal(batch.jobs.length, 13);
  batch.jobs
    .filter((item) => !["manual-totp@example.net", "reverse.api-order@example.xyz"].includes(item.email))
    .forEach((item) => assert.equal(item.loginMode, "password"));
  batch.jobs
    .filter((item) => [
      "password-mail@example.com",
      "password-mail-totp@example.com",
      "smart.user-name@sub.example.co.uk",
      "pipe-password@example.dev",
      "reverse.api-order@example.xyz",
    ].includes(item.email))
    .forEach((item) => assert.equal(item.autoEmailOtp, true));
  assert.equal(batch.jobs[0].hasTotpKey, false);
  assert.equal(batch.jobs.find((item) => item.email === "password-mail-totp@example.com").hasTotpKey, true);
  assert.equal(batch.jobs.find((item) => item.email === "smart.user-name@sub.example.co.uk").hasTotpKey, true);
  assert.equal(batch.jobs.find((item) => item.email === "pipe-password@example.dev").hasTotpKey, true);
  assert.equal(batch.jobs.find((item) => item.email === "name+tag@sub-domain.example.cloud").hasTotpKey, true);
  assert.equal(batch.jobs.find((item) => item.email === "manual-totp@example.net").loginMode, "email_otp");
  assert.equal(batch.jobs.find((item) => item.email === "user---tag@example.com").loginMode, "password");
  assert.equal(batch.jobs.find((item) => item.email === "password-empty-field@example.org").hasTotpKey, true);
  assert.equal(batch.jobs.find((item) => item.email === "space-group@example.org").hasTotpKey, true);
  assert.equal(batch.jobs.find((item) => item.email === "base32-password@example.org").hasTotpKey, false);
  assert.equal(batch.jobs.find((item) => item.email === "base32-password@example.org").loginMode, "password");
  assert.equal(batch.jobs.find((item) => item.email === "biers.ellipse.case@icloud.com").hasTotpKey, true);
  assert.equal(batch.jobs.find((item) => item.email === "biers.ellipse.case@icloud.com").loginMode, "password");
  assert.equal(batch.jobs.find((item) => item.email === "dot-password@example.com").hasTotpKey, true);
  assert.equal(batch.jobs.find((item) => item.email === "dot-password@example.com").loginMode, "password");
  await Promise.all(batch.jobs.map((item) => waitForJob(headers, item.id, (value) => value.status === "completed")));

  const sourceResponse = await fetch(`${baseUrl}/api/jobs/export-source`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: batch.jobs.map((item) => item.id) }),
  });
  assert.equal(sourceResponse.status, 200);
  const sourceExport = (await sourceResponse.text()).replace(/^\uFEFF/, "").trim().split("\n").sort();
  assert.deepEqual(sourceExport, [
    `manual-totp@example.net--------ONSWG4TFOQXXXXXX`,
    `name+tag@sub-domain.example.cloud----colon-password----MFRGGZDFMZTWQ2LK`,
    `password-mail-totp@example.com----test-password-2----${mailApiUrl}----JBSWY3DPEHPK3PXP`,
    `password-mail@example.com----test-password----${mailApiUrl}`,
    `pipe-password@example.dev----part-one|part-two----${mailApiUrl}----NB2W45DFOIZAQWER`,
    `reverse.api-order@example.xyz----${mailApiUrl}`,
    `smart.user-name@sub.example.co.uk----unordered-password----${mailApiUrl}----JBSWY3DPEHPK3PXP`,
    `space-group@example.org----grouped-password----JBSWY3DPEHPK3PXP`,
    `password-empty-field@example.org----plain-password----GEZDGNBVGY3TQOJQ`,
    `user---tag@example.com----hyphen-email-password`,
    `base32-password@example.org----ABCDEFGHIJKLMNOP----${mailApiUrl}`,
    "biers.ellipse.case@icloud.com----aBCD2345eFGH6723----JBSWY3DPEHPK3PXPNB2W45DFOIZAQWER",
    "dot-password@example.com----r7.UjRUWVVS----JBSWY3DPEHPK3PXP",
  ].sort());

  const ambiguousBatchLines = [
    `two-emails@example.com----second@example.net----${mailApiUrl}`,
    `comma-url@example.com,${mailApiUrl}?a=1,b=2`,
    "odd-hyphen@example.com-----JBSWY3DPEHPK3PXP",
    `mixed-delimiter@example.com----password|${mailApiUrl}|JBSWY3DPEHPK3PXP`,
  ];
  for (const text of ambiguousBatchLines) {
    const response = await fetch(`${baseUrl}/api/jobs/batch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text }),
    });
    const responseText = await response.text();
    assert.equal(response.status, 400, `${text}: ${responseText}`);
  }

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
    codexFingerprintMode: "device",
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

  if (supportsConsoleCpampSettings) {
    cpampFiles.set("external-cpamp-problem.json", {
      email: "cross-platform@example.com",
      disabled: true,
      status: "disabled",
      failed: 2,
      status_message: "refresh token expired",
    });
    cpampFiles.set("external-cpamp-manually-disabled.json", {
      email: "account-profile@example.com",
      disabled: true,
      status: "disabled",
      failed: 0,
    });
  }
  remoteErrorAccounts = [{
    id: 90,
    name: "oauth---cross-platform@example.com",
    platform: "openai",
    type: "oauth",
    status: "error",
    error_message: "refresh token expired",
    credentials: { email: "cross-platform@example.com" },
    group_ids: [7],
  }, {
    id: 89,
    name: "oauth---missing-local@example.com",
    platform: "openai",
    type: "oauth",
    status: "error",
    error_message: "token invalid",
    credentials: { email: "missing-local@example.com" },
    group_ids: [7],
  }];
  const externalRefreshResponse = await fetch(`${baseUrl}/api/external-reauth/refresh`, { method: "POST", headers });
  const externalRefreshText = await externalRefreshResponse.text();
  assert.equal(externalRefreshResponse.status, 200, externalRefreshText);
  const externalRefresh = JSON.parse(externalRefreshText);
  assert.equal(externalRefresh.externalReauth.sub2api.count, 2);
  assert.equal(externalRefresh.externalReauth.sub2api.matchedCount, 1);
  assert.equal(externalRefresh.missingTask, supportsConsoleCpampSettings ? 1 : 1);
  if (supportsConsoleCpampSettings) {
    assert.equal(externalRefresh.externalReauth.cpamp.count, 1, "仅手动禁用的 CPAMP 账号不能列入需重登");
    assert.equal(externalRefresh.externalReauth.cpamp.matchedCount, 1);
  }
  const externalQueryResponse = await fetch(`${baseUrl}/api/jobs/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({ page: 1, externalReauth: "any" }),
  });
  const externalQueryText = await externalQueryResponse.text();
  assert.equal(externalQueryResponse.status, 200, externalQueryText);
  const externalJobs = JSON.parse(externalQueryText).jobs;
  assert.equal(externalJobs.length, 1);
  assert.equal(externalJobs[0].id, jobId);
  assert.equal(externalJobs[0].externalReauth.sources.some((entry) => entry.source === "sub2api"), true);
  if (supportsConsoleCpampSettings) assert.equal(externalJobs[0].externalReauth.sources.some((entry) => entry.source === "cpamp"), true);
  assert.equal(updatedRemoteAccounts.has(90), false, "只刷新外部异常不能触发自动重新登录或更新远端账号");

  remoteErrorAccounts = [{
    id: 91,
    name: "oauth---password-mail@example.com",
    platform: "openai",
    type: "oauth",
    status: "error",
    error_message: "refresh token expired",
    credentials: { email: "password-mail@example.com", model_mapping: { "gpt-5": "gpt-5" } },
    extra: { existing_setting: "preserved", codex_fingerprint_mode: "off" },
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
  assert.deepEqual(updatedRemoteAccounts.get(91).extra, {
    existing_setting: "preserved",
    codex_fingerprint_mode: "device",
  });

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

  const directRiskResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "direct-risk-retry@example.com" }),
  });
  assert.equal(directRiskResponse.status, 201);
  const directRiskCreated = await directRiskResponse.json();
  const directRiskFailed = await waitForJob(
    headers,
    directRiskCreated.job.id,
    (value) => value.status === "failed",
  );
  assert.match(directRiskFailed.lastError || "", /直连 TLS 指纹筛选已经使用过/);
  const directRiskReloginResponse = await fetch(`${baseUrl}/api/jobs/${directRiskCreated.job.id}/relogin`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(directRiskReloginResponse.status, 200, await directRiskReloginResponse.text());
  await waitForJob(headers, directRiskCreated.job.id, (value) => value.status === "completed");

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
      directRiskCreated.job.id,
      bannedJobId,
      manualPhoneJobId,
      phoneFallbackJobId,
      incompleteAuthorizationId,
      incompleteTotpId,
      automaticPendingJobId,
      manualFailureJobId,
    ] }),
  });
  if (!deleteResponse.ok) {
    throw new Error(`delete request failed with HTTP ${deleteResponse.status}: ${await deleteResponse.text()}`);
  }
  const deleted = await deleteResponse.json();
  assert.equal(deleted.deleted, 29);

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
  await new Promise((resolve) => cpamp.close(resolve));
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

async function submitEmailOtp(headers, jobId) {
  await waitForJob(headers, jobId, (value) => value.status === "email_otp");
  const response = await fetch(`${baseUrl}/api/jobs/${jobId}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "email_otp", value: "123456" }),
  });
  assert.equal(response.status, 200, await response.text());
  await waitForJob(headers, jobId, (value) => value.status !== "working");
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

function cpampAccount(email) {
  return [...cpampFiles.values()].find((account) => account.email === email) || null;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function parseMultipartJson(raw, contentType) {
  const boundary = /boundary=([^;]+)/i.exec(contentType)?.[1]?.replace(/^\"|\"$/g, "");
  assert.ok(boundary, "expected CPAMP multipart boundary");
  const name = /filename=\"([^\"]+)\"/i.exec(raw)?.[1];
  assert.ok(name, "expected CPAMP uploaded file name");
  const contentStart = raw.indexOf("\r\n\r\n");
  const contentEnd = raw.indexOf(`\r\n--${boundary}`, contentStart);
  assert.ok(contentStart >= 0 && contentEnd > contentStart, "expected CPAMP uploaded JSON body");
  return { name, payload: JSON.parse(raw.slice(contentStart + 4, contentEnd)) };
}

function isRunning(processHandle) {
  return processHandle.exitCode === null && processHandle.signalCode === null;
}
