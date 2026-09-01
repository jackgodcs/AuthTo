import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createCpampSync } from "../src/cpamp-sync.mjs";

const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-cpamp-sync-"));
const files = new Map();
const fileStates = new Map();
const accountHistoryByFile = new Map();
const credentialRefreshRequests = [];
const actionCandidates = [];
let storedManagementKey = "";
let requiresManagementPrefix = false;
let rejectsManagementKey = false;
let ignoresEnableRequests = false;
let requiresStatusIdentityMetadata = false;
let codexModels = ["gpt-5", "gpt-5-mini", "gpt-4.1"];
let modelDirectoryAvailable = true;
let uploadDelayMs = 0;
let uploadsInFlight = 0;
let maxUploadsInFlight = 0;
const server = http.createServer(async (req, res) => {
  if (rejectsManagementKey || req.headers.authorization !== "Bearer test-management-key") {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "invalid management key" }));
    return;
  }

  const requestUrl = new URL(req.url, "http://127.0.0.1");
  const authFilesPath = requiresManagementPrefix ? "/v0/management/auth-files" : "/auth-files";
  const actionCandidatesPath = requiresManagementPrefix ? "/v0/management/account-action-candidates" : "/account-action-candidates";
  const accountHistoryPath = requiresManagementPrefix ? "/v0/management/monitoring/account-history" : "/monitoring/account-history";
  const modelDefinitionsPath = requiresManagementPrefix ? "/v0/management/model-definitions/codex" : "/model-definitions/codex";
  if (req.method === "GET" && requestUrl.pathname === actionCandidatesPath) {
    const status = requestUrl.searchParams.get("status") || "pending";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ items: actionCandidates.filter((candidate) => candidate.status === status) }));
    return;
  }

  if (req.method === "POST" && requestUrl.pathname.startsWith(`${actionCandidatesPath}/`) && requestUrl.pathname.endsWith("/resolve")) {
    const id = decodeURIComponent(requestUrl.pathname.slice(actionCandidatesPath.length + 1, -"/resolve".length));
    const candidate = actionCandidates.find((item) => String(item.id) === id);
    if (!candidate) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "candidate not found" }));
      return;
    }
    candidate.status = "resolved";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === authFilesPath) {
    const listed = [...files.entries()].map(([name, payload]) => {
      const state = fileStates.get(name) || {};
      return {
        ...state.publicFields,
        name,
        id: state.id || name,
        auth_index: state.authIndex || undefined,
        email: Array.isArray(payload) ? payload[0]?.email : payload?.email,
        disabled: state.disabled ?? (Array.isArray(payload) ? payload[0]?.disabled : payload?.disabled),
        status: state.status ?? (Array.isArray(payload) ? payload[0]?.status : payload?.status),
        failed: state.failed ?? 0,
        success: state.success ?? 0,
      };
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ files: listed }));
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === accountHistoryPath) {
    const body = JSON.parse(await readBody(req));
    const accounts = Array.isArray(body.accounts) ? body.accounts : [];
    const items = accounts.map((account) => ({
      row_key: account.row_key,
      ...(accountHistoryByFile.get(account.auth_file_snapshot) || {}),
    }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ items, generated_at_ms: Date.now() }));
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === `${authFilesPath}/download`) {
    const payload = files.get(requestUrl.searchParams.get("name"));
    if (!payload) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "not found" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === modelDefinitionsPath) {
    if (!modelDirectoryAvailable) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "model directory unavailable" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ models: codexModels }));
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === authFilesPath) {
    uploadsInFlight += 1;
    maxUploadsInFlight = Math.max(maxUploadsInFlight, uploadsInFlight);
    try {
      const raw = await readBody(req);
      const parsed = parseMultipartJson(raw, String(req.headers["content-type"] || ""));
      if (uploadDelayMs) await delay(uploadDelayMs);
      files.set(parsed.name, parsed.payload);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } finally {
      uploadsInFlight -= 1;
    }
    return;
  }

  if (req.method === "PATCH" && requestUrl.pathname === `${authFilesPath}/fields`) {
    const patch = JSON.parse(await readBody(req));
    const name = String(patch.name || "");
    const payload = files.get(name);
    if (!payload) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "not found" }));
      return;
    }
    credentialRefreshRequests.push({ name, expired: patch.expired, last_refresh: patch.last_refresh });
    files.set(name, { ...payload, expired: patch.expired, last_refresh: patch.last_refresh });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  if (req.method === "PATCH" && requestUrl.pathname === `${authFilesPath}/status`) {
    const patch = JSON.parse(await readBody(req));
    const name = String(patch.name || "");
    if (!files.has(name)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "not found" }));
      return;
    }
    if (requiresStatusIdentityMetadata && patch.cpamp_physical_name !== name) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "missing CPAMP credential identity metadata" }));
      return;
    }
    const state = fileStates.get(name) || {};
    const enableRequested = patch.disabled === false;
    fileStates.set(name, {
      ...state,
      disabled: enableRequested && ignoresEnableRequests ? true : patch.disabled === true,
      status: enableRequested && ignoresEnableRequests ? "disabled" : patch.disabled === true ? "disabled" : "active",
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ message: "not found" }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const secretStore = {
    async save(_name, value) { storedManagementKey = value; },
    async load() { return storedManagementKey || null; },
    async delete() { storedManagementKey = ""; },
  };
  const sync = createCpampSync({ outputRoot, secretStore });
  await sync.load();
  const configured = await sync.configure({
    baseUrl: `${baseUrl}/management.html#/accounts?status=problem`,
    managementKey: "test-management-key",
    autoSyncEnabled: false,
  });
  assert.equal(configured.configured, true);
  assert.equal(configured.autoSyncEnabled, false);
  assert.equal(configured.baseUrl, baseUrl);

  requiresManagementPrefix = true;
  const prefixedConfigured = await sync.configure({ baseUrl: `${baseUrl}/v0/management`, managementKey: "", autoSyncEnabled: false });
  assert.equal(prefixedConfigured.configured, true);
  assert.equal(prefixedConfigured.baseUrl, `${baseUrl}/v0/management`);
  assert.deepEqual((await sync.options()).models, codexModels);

  await sync.configure({
    baseUrl,
    managementKey: "",
    autoSyncEnabled: false,
    policy: {
      newAccountEnabled: true,
      proxyMode: "fixed",
      fixedProxyUrl: "socks5://policy.example:1080",
      priority: 7,
      weight: 3,
      modelWhitelist: ["gpt-5", "gpt-4.1"],
      syncConcurrency: 1,
    },
  });

  const primary = await writeJob("primary-job", "user@example.com", "access-1", "refresh-1");
  const created = await sync.syncManual([primary]);
  assert.equal(created.created, 1);
  assert.equal(created.updated, 0);
  const primaryFileName = created.results[0].remoteFileName;
  assert.equal(files.get(primaryFileName).access_token, "access-1");
  assert.equal(files.get(primaryFileName).proxy_url, "socks5://policy.example:1080");
  assert.equal(files.get(primaryFileName).priority, 7);
  assert.equal(files.get(primaryFileName).weight, 3);
  assert.equal(files.get(primaryFileName).disabled, false);
  assert.deepEqual(files.get(primaryFileName).excluded_models, ["gpt-5-mini"]);

  files.set(primaryFileName, {
    ...files.get(primaryFileName),
    priority: 42,
    proxy_url: "socks5://proxy.example:1080",
    note: "keep this CPAMP setting",
    disabled: true,
  });
  files.set("duplicate-user.json", {
    ...files.get(primaryFileName),
    access_token: "old-duplicate-token",
  });
  const primaryUpdate = await writeJob("primary-update", "user@example.com", "access-2", "refresh-2");
  const updated = await sync.syncManual([primaryUpdate]);
  assert.equal(updated.updated, 1);
  assert.equal(updated.duplicates, 1);
  const preserved = files.get(primaryFileName);
  assert.equal(preserved.access_token, "access-2");
  assert.equal(preserved.refresh_token, "refresh-2");
  assert.equal(preserved.priority, 42);
  assert.equal(preserved.proxy_url, "socks5://proxy.example:1080");
  assert.equal(preserved.note, "keep this CPAMP setting");
  assert.equal(preserved.disabled, true);
  assert.deepEqual(preserved.excluded_models, ["gpt-5-mini"]);

  const forced = await sync.applyPolicy([primaryUpdate]);
  assert.equal(forced.updated, 1);
  const forceApplied = files.get(primaryFileName);
  assert.equal(forceApplied.proxy_url, "socks5://policy.example:1080");
  assert.equal(forceApplied.priority, 7);
  assert.equal(forceApplied.weight, 3);
  assert.equal(forceApplied.disabled, false);
  assert.equal(forceApplied.note, "keep this CPAMP setting");

  await sync.configure({
    baseUrl,
    managementKey: "",
    autoSyncEnabled: false,
    policy: { newAccountEnabled: true, proxyMode: "none", priority: "", weight: "", modelWhitelist: ["gpt-5"], syncConcurrency: 1 },
  });
  modelDirectoryAvailable = false;
  const blocked = await writeJob("blocked-models", "blocked@example.com", "blocked-access", "blocked-refresh");
  const blockedResult = await sync.syncManual([blocked]);
  assert.equal(blockedResult.failed, 1);
  assert.match(blockedResult.results[0].error, /模型目录读取失败/);
  assert.equal([...files.values()].some((payload) => payload.email === "blocked@example.com"), false);
  assert.equal(sync.status().failedCount, 1);
  assert.equal(sync.status().attention.find((item) => item.email === "blocked@example.com")?.lastError, blockedResult.results[0].error);
  modelDirectoryAvailable = true;

  await sync.configure({
    baseUrl,
    managementKey: "",
    autoSyncEnabled: false,
    inspectionEnabled: true,
    policy: { newAccountEnabled: true, proxyMode: "none", priority: "", weight: "", modelWhitelist: [], syncConcurrency: 3 },
  });
  uploadDelayMs = 40;
  maxUploadsInFlight = 0;
  const concurrentJobs = await Promise.all([
    writeJob("parallel-1", "parallel-1@example.com", "parallel-access-1", "parallel-refresh-1"),
    writeJob("parallel-2", "parallel-2@example.com", "parallel-access-2", "parallel-refresh-2"),
    writeJob("parallel-3", "parallel-3@example.com", "parallel-access-3", "parallel-refresh-3"),
    writeJob("parallel-4", "parallel-4@example.com", "parallel-access-4", "parallel-refresh-4"),
  ]);
  const concurrent = await sync.syncManual(concurrentJobs);
  assert.equal(concurrent.created, 4);
  assert.equal(maxUploadsInFlight, 3);
  uploadDelayMs = 0;

  files.delete(primaryFileName);
  const disabledFileName = concurrent.results.find((result) => result.email === "parallel-2@example.com").remoteFileName;
  const problemFileName = concurrent.results.find((result) => result.email === "parallel-3@example.com").remoteFileName;
  files.set(disabledFileName, { ...files.get(disabledFileName), disabled: true });
  files.set(problemFileName, { ...files.get(problemFileName), status: "error" });
  const inspection = await sync.inspectNow();
  assert.equal(inspection.missing, 1);
  assert.equal(inspection.disabled, 1);
  assert.equal(inspection.problem, 1);
  assert.equal(sync.recordFor("user@example.com").inspection.state, "missing");
  assert.equal(sync.recordFor("parallel-2@example.com").inspection.state, "disabled");
  assert.equal(sync.recordFor("parallel-3@example.com").inspection.state, "problem");
  assert.equal(sync.recordFor("parallel-1@example.com").inspection.state, "healthy");

  files.set("codex-wrong-xxnear@example.com-plus.json", {
    email: "xxnear@example.com",
    access_token: "wrong-account-token",
  });
  const distinct = await writeJob("distinct-job", "near@example.com", "access-3", "refresh-3");
  const distinctUpdate = await sync.syncManual([distinct]);
  assert.equal(distinctUpdate.created, 1);
  assert.equal(files.get("codex-wrong-xxnear@example.com-plus.json").access_token, "wrong-account-token");

  const disabledManualReauthorization = await writeJob("manual-reauthorization-disabled", "manual-disabled@example.com", "manual-disabled-access", "manual-disabled-refresh");
  await sync.syncAfterManualReauthorization(disabledManualReauthorization);
  assert.equal([...files.values()].some((payload) => payload.email === "manual-disabled@example.com"), false);

  const reauthorizationConfigured = await sync.configure({
    baseUrl,
    managementKey: "",
    autoSyncEnabled: false,
    syncAfterManualReauthorization: true,
  });
  assert.equal(reauthorizationConfigured.syncAfterManualReauthorization, true);
  rejectsManagementKey = true;
  const locallySavedReauthorization = await sync.configure({
    baseUrl: `${baseUrl}/v0/management`,
    managementKey: "",
    autoSyncEnabled: false,
    syncAfterManualReauthorization: true,
  });
  assert.equal(locallySavedReauthorization.syncAfterManualReauthorization, true);
  rejectsManagementKey = false;
  const manualReauthorization = await writeJob("manual-reauthorization", "manual-reauthorization@example.com", "manual-reauthorization-access", "manual-reauthorization-refresh");
  const manualReauthorizationCreated = await sync.syncManual([manualReauthorization]);
  const manualReauthorizationFileName = manualReauthorizationCreated.results[0].remoteFileName;
  files.set(manualReauthorizationFileName, {
    ...files.get(manualReauthorizationFileName),
    access_token: "stale-manual-reauthorization-access",
    refresh_token: "stale-manual-reauthorization-refresh",
  });
  fileStates.set(manualReauthorizationFileName, {
    disabled: true,
    status: "disabled",
    failed: 1,
    success: 1,
    authIndex: "manual-reauthorization-index",
  });
  actionCandidates.push({
    id: "candidate-manual-reauthorization",
    actionType: "reauth",
    status: "pending",
    reasonCode: "token_revoked",
    reason: "refresh token revoked",
    authFileName: manualReauthorizationFileName,
    authLabel: "manual-reauthorization@example.com",
    accountSnapshot: "manual-reauthorization@example.com",
  });
  requiresStatusIdentityMetadata = true;
  const refreshedManualReauthorization = await writeJob("manual-reauthorization-refresh", "manual-reauthorization@example.com", "manual-reauthorization-new-access", "manual-reauthorization-new-refresh");
  const manualReauthorizationHandled = await sync.syncAfterManualReauthorization(refreshedManualReauthorization);
  assert.equal(manualReauthorizationHandled, true);
  assert.equal([...files.values()].some((payload) => payload.email === "manual-reauthorization@example.com"), true);
  assert.equal(files.get(manualReauthorizationFileName).access_token, "manual-reauthorization-new-access");
  assert.equal(files.get(manualReauthorizationFileName).refresh_token, "manual-reauthorization-new-refresh");
  assert.equal(fileStates.get(manualReauthorizationFileName).disabled, false);
  assert.equal(fileStates.get(manualReauthorizationFileName).status, "active");
  assert.deepEqual(credentialRefreshRequests.at(-1), {
    name: manualReauthorizationFileName,
    expired: "2000-01-01T00:00:00Z",
    last_refresh: "2000-01-01T00:00:00Z",
  });
  assert.equal(sync.recordFor("manual-reauthorization@example.com").state, "synced");
  requiresStatusIdentityMetadata = false;

  const intentionallyDisabled = await writeJob("intentionally-disabled", "intentionally-disabled@example.com", "intentionally-disabled-access", "intentionally-disabled-refresh");
  const intentionallyDisabledCreated = await sync.syncManual([intentionallyDisabled]);
  const intentionallyDisabledFileName = intentionallyDisabledCreated.results[0].remoteFileName;
  fileStates.set(intentionallyDisabledFileName, { disabled: true, status: "disabled", failed: 0, success: 1 });
  const intentionallyDisabledRefresh = await writeJob("intentionally-disabled-refresh", "intentionally-disabled@example.com", "intentionally-disabled-new-access", "intentionally-disabled-new-refresh");
  const intentionallyDisabledResult = await sync.syncAfterManualReauthorization(intentionallyDisabledRefresh);
  assert.equal(intentionallyDisabledResult, true);
  assert.equal(fileStates.get(intentionallyDisabledFileName).disabled, true);
  assert.equal(credentialRefreshRequests.some((request) => request.name === intentionallyDisabledFileName), false);

  const externalProblem = await writeJob("external-reauth-problem", "external-problem@example.com", "external-problem-access", "external-problem-refresh");
  const externalProblemCreated = await sync.syncManual([externalProblem]);
  const externalProblemFileName = externalProblemCreated.results[0].remoteFileName;
  fileStates.set(externalProblemFileName, {
    disabled: true,
    status: "disabled",
    failed: 2,
    success: 0,
  });
  assert.equal((await sync.refreshExternalReauth()).needsReauthorization, 0, "禁用和历史失败计数本身不能代表当前需要重新登录");
  assert.equal(sync.externalReauthFor("external-problem@example.com"), null);

  actionCandidates.push({
    id: "candidate-external-problem",
    actionType: "reauth",
    status: "pending",
    reasonCode: "token_revoked",
    reason: "refresh token revoked",
    authFileName: externalProblemFileName,
    authLabel: "external-problem@example.com",
    accountSnapshot: "external-problem@example.com",
  });
  const externalRefresh = await sync.refreshExternalReauth();
  assert.equal(externalRefresh.needsReauthorization, 1);
  assert.equal(sync.externalReauthFor("external-problem@example.com").reason, "refresh token revoked");
  assert.equal(sync.externalReauthFor("intentionally-disabled@example.com"), null, "没有认证失败记录的手动禁用账号不能被标记为需重登");

  const historyCredentialFailure = await writeJob("history-credential-failure", "history-credential@example.com", "history-credential-access", "history-credential-refresh");
  const historyCredentialCreated = await sync.syncManual([historyCredentialFailure]);
  const historyCredentialFileName = historyCredentialCreated.results[0].remoteFileName;
  accountHistoryByFile.set(historyCredentialFileName, {
    latest_request: { timestamp_ms: 4_000, failed: true, fail_status_code: 401, fail_summary: "token invalidated" },
    recent_requests: [{ timestamp_ms: 3_000, failed: false, fail_status_code: 200 }],
  });

  const historyTransientFailure = await writeJob("history-transient-failure", "history-transient@example.com", "history-transient-access", "history-transient-refresh");
  const historyTransientCreated = await sync.syncManual([historyTransientFailure]);
  const historyTransientFileName = historyTransientCreated.results[0].remoteFileName;
  accountHistoryByFile.set(historyTransientFileName, {
    latest_request: { timestamp_ms: 7_000, failed: true, fail_status_code: 503, fail_summary: "upstream unavailable" },
    recent_requests: [
      { timestamp_ms: 6_000, failed: true, fail_status_code: 503, fail_summary: "upstream unavailable" },
      { timestamp_ms: 5_000, failed: true, fail_status_code: 503, fail_summary: "upstream unavailable" },
    ],
  });

  const quotaRiskOnly = await writeJob("history-quota-risk", "history-quota@example.com", "history-quota-access", "history-quota-refresh");
  const quotaRiskCreated = await sync.syncManual([quotaRiskOnly]);
  const quotaRiskFileName = quotaRiskCreated.results[0].remoteFileName;
  accountHistoryByFile.set(quotaRiskFileName, {
    latest_request: { timestamp_ms: 8_000, failed: true, fail_status_code: 429, fail_summary: "rate limit reached" },
  });

  const recoveredHistoryFailure = await writeJob("history-recovered", "history-recovered@example.com", "history-recovered-access", "history-recovered-refresh");
  const recoveredHistoryCreated = await sync.syncManual([recoveredHistoryFailure]);
  const recoveredHistoryFileName = recoveredHistoryCreated.results[0].remoteFileName;
  accountHistoryByFile.set(recoveredHistoryFileName, {
    latest_request: { timestamp_ms: 10_000, failed: false, fail_status_code: 200 },
    recent_requests: [{ timestamp_ms: 9_000, failed: true, fail_status_code: 401, fail_summary: "token invalidated" }],
  });

  const historyRefresh = await sync.refreshExternalReauth();
  assert.equal(historyRefresh.needsReauthorization, 3, "CPAMP 请求历史的异常账号必须与官方候选合并，而不能因候选存在而提前返回");
  assert.equal(sync.externalReauthFor("history-credential@example.com")?.source, "request_credential_failure");
  assert.equal(sync.externalReauthFor("history-transient@example.com")?.source, "request_transient_failure");
  assert.equal(sync.externalReauthFor("history-quota@example.com"), null, "额度风险不能误标为需重新登录");
  assert.equal(sync.externalReauthFor("history-recovered@example.com"), null, "新的成功请求必须覆盖旧的认证失败");

  const stillDisabled = await writeJob("still-disabled", "still-disabled@example.com", "still-disabled-access", "still-disabled-refresh");
  const stillDisabledCreated = await sync.syncManual([stillDisabled]);
  const stillDisabledFileName = stillDisabledCreated.results[0].remoteFileName;
  fileStates.set(stillDisabledFileName, { disabled: true, status: "disabled", failed: 1, success: 0 });
  actionCandidates.push({
    id: "candidate-still-disabled",
    actionType: "reauth",
    status: "pending",
    reasonCode: "token_revoked",
    reason: "refresh token revoked",
    authFileName: stillDisabledFileName,
    authLabel: "still-disabled@example.com",
    accountSnapshot: "still-disabled@example.com",
  });
  ignoresEnableRequests = true;
  const stillDisabledRefresh = await writeJob("still-disabled-refresh", "still-disabled@example.com", "still-disabled-new-access", "still-disabled-new-refresh");
  const stillDisabledResult = await sync.syncAfterManualReauthorization(stillDisabledRefresh);
  assert.equal(stillDisabledResult, true);
  assert.equal(fileStates.get(stillDisabledFileName).disabled, true);
  assert.equal(sync.recordFor("still-disabled@example.com").lastError, "CPAMP 已上传最新 OAuth，但远端仍保持禁用；请使用重新登录并授权");
  ignoresEnableRequests = false;

  await sync.configure({ baseUrl, managementKey: "", autoSyncEnabled: true });
  const automaticFirst = await writeJob("automatic-first", "auto@example.com", "auto-access-1", "auto-refresh-1", new Date(Date.now() + 1_000).toISOString());
  await sync.queueCompleted(automaticFirst);
  assert.equal(sync.status().pendingCount, 1);
  assert.equal(sync.status().attention.find((item) => item.email === "auto@example.com")?.jobId, automaticFirst.id);
  assert.equal([...files.values()].some((payload) => payload.email === "auto@example.com"), false);

  const approved = await sync.approvePending([automaticFirst]);
  assert.equal(approved.created, 1);
  assert.equal(sync.status().pendingCount, 0);
  const autoFileName = approved.results[0].remoteFileName;
  const automaticUpdate = await writeJob("automatic-update", "auto@example.com", "auto-access-2", "auto-refresh-2", new Date(Date.now() + 2_000).toISOString());
  await sync.queueCompleted(automaticUpdate);
  assert.equal(files.get(autoFileName).access_token, "auto-access-2");
  assert.equal(sync.recordFor("auto@example.com").state, "synced");

  await sync.shutdown();
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(outputRoot, { recursive: true, force: true });
}

console.log("cpamp sync tests passed");

async function writeJob(id, email, accessToken, refreshToken, completedAt = new Date().toISOString()) {
  const outputPath = path.join(outputRoot, `${id}.json`);
  await fs.writeFile(outputPath, `${JSON.stringify({
    type: "sub2api-data",
    accounts: [{
      name: email,
      credentials: {
        email,
        account_id: `account-${id}`,
        chatgpt_user_id: `user-${id}`,
        organization_id: `org-${id}`,
        plan_type: "plus",
        access_token: accessToken,
        refresh_token: refreshToken,
      },
    }],
  }, null, 2)}\n`);
  return { id, email, outputPath, resultSaved: true, completedAt };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseMultipartJson(raw, contentType) {
  const boundary = /boundary=([^;]+)/i.exec(contentType)?.[1]?.replace(/^\"|\"$/g, "");
  assert.ok(boundary, "expected multipart boundary");
  const name = /filename=\"([^\"]+)\"/i.exec(raw)?.[1];
  assert.ok(name, "expected uploaded file name");
  const contentStart = raw.indexOf("\r\n\r\n");
  const contentEnd = raw.indexOf(`\r\n--${boundary}`, contentStart);
  assert.ok(contentStart >= 0 && contentEnd > contentStart, "expected uploaded JSON body");
  return { name, payload: JSON.parse(raw.slice(contentStart + 4, contentEnd)) };
}
