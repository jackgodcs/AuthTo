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
const quotaRefreshRequests = [];
const runtimeResetRequests = [];
const quotaSnapshotEntries = new Map();
const quotaSnapshotQueries = [];
const actionCandidates = [];
let storedManagementKey = "";
let requiresManagementPrefix = false;
let rejectsManagementKey = false;
let ignoresEnableRequests = false;
let requiresStatusIdentityMetadata = false;
let quotaRefreshStatus = 200;
let runtimeResetStatus = 200;
let ignoresRuntimeResetRequests = false;
let quotaSnapshotsAvailable = true;
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
  const apiCallPath = requiresManagementPrefix ? "/v0/management/api-call" : "/api-call";
  const resetQuotaPath = requiresManagementPrefix ? "/v0/management/reset-quota" : "/reset-quota";
  const quotaSnapshotsPath = requiresManagementPrefix ? "/v0/management/quota-snapshots" : "/quota-snapshots";
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
        last_refresh: state.listedLastRefresh ?? (Array.isArray(payload) ? payload[0]?.last_refresh : payload?.last_refresh),
        modtime: Array.isArray(payload) ? payload[0]?.modtime : payload?.modtime,
        disabled: state.disabled ?? (Array.isArray(payload) ? payload[0]?.disabled : payload?.disabled),
        status: state.status ?? (Array.isArray(payload) ? payload[0]?.status : payload?.status),
        status_message: state.statusMessage || "",
        unavailable: state.unavailable === true,
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

  if (req.method === "POST" && requestUrl.pathname === apiCallPath) {
    const payload = JSON.parse(await readBody(req));
    quotaRefreshRequests.push(payload);
    const fileEntry = [...fileStates.entries()].find(([, state]) => String(state.authIndex || "") === String(payload.authIndex || ""));
    if (!fileEntry || payload.method !== "GET" || payload.url !== "https://chatgpt.com/backend-api/wham/usage") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "invalid quota refresh request" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status_code: quotaRefreshStatus,
      body: {
        plan_type: "plus",
        rate_limit: {
          primary_window: { limit_window_seconds: 18_000, used_percent: 41, reset_at: Math.floor(Date.now() / 1_000) + 1_800 },
          secondary_window: { limit_window_seconds: 604_800, used_percent: 23, reset_at: Math.floor(Date.now() / 1_000) + 86_400 },
        },
      },
    }));
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === resetQuotaPath) {
    const payload = JSON.parse(await readBody(req));
    runtimeResetRequests.push(payload);
    const fileEntry = [...fileStates.entries()].find(([, state]) => String(state.authIndex || "") === String(payload.auth_index || ""));
    if (!fileEntry) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "auth not found" }));
      return;
    }
    if (runtimeResetStatus < 200 || runtimeResetStatus >= 300) {
      res.writeHead(runtimeResetStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "runtime reset rejected" }));
      return;
    }
    const [fileName, state] = fileEntry;
    if (!ignoresRuntimeResetRequests) {
      fileStates.set(fileName, {
        ...state,
        status: "active",
        statusMessage: "",
        unavailable: false,
      });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", auth_index: payload.auth_index, models: ["gpt-5"] }));
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === quotaSnapshotsPath) {
    if (!quotaSnapshotsAvailable) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "quota snapshots unavailable" }));
      return;
    }
    const payload = JSON.parse(await readBody(req));
    for (const entry of payload.entries || []) quotaSnapshotEntries.set(entry.row_key, entry);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ written: payload.entries?.length || 0 }));
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === `${quotaSnapshotsPath}/query`) {
    if (!quotaSnapshotsAvailable) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "quota snapshots unavailable" }));
      return;
    }
    const payload = JSON.parse(await readBody(req));
    quotaSnapshotQueries.push(payload);
    const items = (payload.accounts || []).map((account) => {
      const entry = quotaSnapshotEntries.get(account.row_key);
      return entry ? { row_key: account.row_key, windows: entry.windows, observation: entry.observation } : { row_key: account.row_key, windows: [] };
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ items }));
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
  const sync = createCpampSync({ outputRoot, secretStore, credentialConfirmationAttempts: 3, credentialConfirmationDelayMs: 1 });
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
    statusMessage: "unauthorized",
    unavailable: true,
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
  assert.equal(fileStates.get(manualReauthorizationFileName).unavailable, false, "重新授权必须清理 CLIProxyAPI 保存的不可用状态");
  assert.deepEqual(runtimeResetRequests.at(-1), { auth_index: "manual-reauthorization-index" }, "必须通过官方 reset-quota 接口清理目标凭证的运行状态");
  assert.match(sync.recordFor("manual-reauthorization@example.com").runtimeStateRecoveredAt || "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(credentialRefreshRequests.some((request) => request.name === manualReauthorizationFileName), false, "上传的新 OAuth 已携带当前刷新时间，不能再改回 2000 年触发值");
  assert.deepEqual(quotaRefreshRequests.at(-1), {
    authIndex: "manual-reauthorization-index",
    method: "GET",
    url: "https://chatgpt.com/backend-api/wham/usage",
    header: {
      Authorization: "Bearer $TOKEN$",
      "Content-Type": "application/json",
      "User-Agent": "codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal",
    },
  });
  const refreshedHistory = await sync.refreshExternalReauth();
  assert.equal(refreshedHistory.needsReauthorization, 0, "重新授权后的成功额度查询必须覆盖 CPAMP 的旧登录失效记录");
  assert.equal(sync.recordFor("manual-reauthorization@example.com").state, "synced");
  const manualSnapshot = [...quotaSnapshotEntries.values()].find((entry) => entry.account.auth_file_snapshot === manualReauthorizationFileName);
  assert.ok(manualSnapshot, "重新授权后的额度结果必须写入 CPAMP 快照");
  assert.equal(manualSnapshot.row_key, `${manualReauthorizationFileName}\u0000manual-reauthorization-index`);
  assert.equal(manualSnapshot.observation.inventory_mode, "complete");
  assert.deepEqual(manualSnapshot.windows.map((window) => window.provider_window_id), ["five-hour", "weekly"]);
  assert.equal(manualSnapshot.windows[0].relationship_kind, "concurrent_subwindow");
  assert.equal(manualSnapshot.windows[0].container_provider_window_id, "weekly");
  assert.deepEqual(quotaSnapshotQueries.at(-1).accounts, [{
    row_key: `${manualReauthorizationFileName}\u0000manual-reauthorization-index`,
    provider: "codex",
    account: manualSnapshot.account,
  }], "额度快照回读必须使用 CPAMP 官方页面的嵌套账号载荷");
  assert.match(sync.recordFor("manual-reauthorization@example.com").stateEvidencePersistedAt || "", /^\d{4}-\d{2}-\d{2}T/);
  requiresStatusIdentityMetadata = false;

  const historyOnlyReauthorization = await writeJob("history-only-reauthorization", "history-only@example.com", "history-only-access", "history-only-refresh");
  const historyOnlyCreated = await sync.syncManual([historyOnlyReauthorization]);
  const historyOnlyFileName = historyOnlyCreated.results[0].remoteFileName;
  fileStates.set(historyOnlyFileName, {
    disabled: false,
    status: "active",
    authIndex: "history-only-index",
    publicFields: { account_id: "history-only-account" },
  });
  accountHistoryByFile.set(historyOnlyFileName, {
    latest_request: { timestamp_ms: 4_000, failed: true, fail_status_code: 401, fail_summary: "token invalidated" },
  });
  files.set(historyOnlyFileName, { ...files.get(historyOnlyFileName), last_refresh: "1970-01-01T00:00:05.000Z" });
  const quotaRefreshCount = quotaRefreshRequests.length;
  const runtimeResetCount = runtimeResetRequests.length;
  const historyOnlyRefresh = await writeJob("history-only-reauthorization-refresh", "history-only@example.com", "history-only-new-access", "history-only-new-refresh");
  await sync.syncAfterManualReauthorization(historyOnlyRefresh);
  assert.equal(quotaRefreshRequests.length, quotaRefreshCount + 1, "已有账号完成手动重新授权后，即使 CPAMP 尚未返回候选项，也必须刷新额度以清除请求历史中的需重登状态");
  assert.equal(runtimeResetRequests.length, runtimeResetCount, "运行状态已经健康的账号不应清除真实的额度冷却");
  assert.equal(quotaRefreshRequests.at(-1).authIndex, "history-only-index");
  assert.equal(quotaRefreshRequests.at(-1).header["Chatgpt-Account-Id"], "history-only-account");
  assert.equal(sync.recordFor("history-only@example.com").lastError, null);
  assert.match(sync.recordFor("history-only@example.com").quotaRefreshedAt || "", /^\d{4}-\d{2}-\d{2}T/);
  const historyOnlyStatus = sync.status();
  assert.match(historyOnlyStatus.lastSyncAt || "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(historyOnlyStatus.lastError, null);

  const intentionallyDisabled = await writeJob("intentionally-disabled", "intentionally-disabled@example.com", "intentionally-disabled-access", "intentionally-disabled-refresh");
  const intentionallyDisabledCreated = await sync.syncManual([intentionallyDisabled]);
  const intentionallyDisabledFileName = intentionallyDisabledCreated.results[0].remoteFileName;
  fileStates.set(intentionallyDisabledFileName, { disabled: true, status: "disabled", failed: 0, success: 1 });
  const intentionallyDisabledRefresh = await writeJob("intentionally-disabled-refresh", "intentionally-disabled@example.com", "intentionally-disabled-new-access", "intentionally-disabled-new-refresh");
  const disabledQuotaRefreshCount = quotaRefreshRequests.length;
  const intentionallyDisabledResult = await sync.syncAfterManualReauthorization(intentionallyDisabledRefresh);
  assert.equal(intentionallyDisabledResult, true);
  assert.equal(fileStates.get(intentionallyDisabledFileName).disabled, true);
  assert.equal(credentialRefreshRequests.some((request) => request.name === intentionallyDisabledFileName), false);
  assert.equal(quotaRefreshRequests.length, disabledQuotaRefreshCount, "手动禁用且没有认证异常证据的账号不能自动触发额度查询");

  const missingAuthIndex = await writeJob("missing-auth-index", "missing-auth-index@example.com", "missing-auth-index-access", "missing-auth-index-refresh");
  const missingAuthIndexCreated = await sync.syncManual([missingAuthIndex]);
  const missingAuthIndexFileName = missingAuthIndexCreated.results[0].remoteFileName;
  fileStates.set(missingAuthIndexFileName, { disabled: false, status: "active" });
  const missingAuthIndexRefresh = await writeJob("missing-auth-index-refresh", "missing-auth-index@example.com", "missing-auth-index-new-access", "missing-auth-index-new-refresh");
  const missingAuthIndexQuotaRefreshCount = quotaRefreshRequests.length;
  await sync.syncAfterManualReauthorization(missingAuthIndexRefresh);
  assert.equal(quotaRefreshRequests.length, missingAuthIndexQuotaRefreshCount);
  assert.match(sync.recordFor("missing-auth-index@example.com").lastError || "", /未返回可用于状态复核的凭证索引/);

  const rejectedRuntimeReset = await writeJob("rejected-runtime-reset", "rejected-runtime-reset@example.com", "rejected-runtime-reset-access", "rejected-runtime-reset-refresh");
  const rejectedRuntimeResetCreated = await sync.syncManual([rejectedRuntimeReset]);
  const rejectedRuntimeResetFileName = rejectedRuntimeResetCreated.results[0].remoteFileName;
  fileStates.set(rejectedRuntimeResetFileName, {
    disabled: false,
    status: "error",
    statusMessage: "unauthorized",
    unavailable: true,
    authIndex: "rejected-runtime-reset-index",
  });
  runtimeResetStatus = 503;
  const rejectedRuntimeResetQuotaCount = quotaRefreshRequests.length;
  const rejectedRuntimeResetRetry = await writeJob("rejected-runtime-reset-retry", "rejected-runtime-reset@example.com", "rejected-runtime-reset-new-access", "rejected-runtime-reset-new-refresh");
  await sync.syncAfterManualReauthorization(rejectedRuntimeResetRetry);
  assert.equal(quotaRefreshRequests.length, rejectedRuntimeResetQuotaCount, "运行状态重置失败后不能继续写入误导性的健康证据");
  assert.match(sync.recordFor("rejected-runtime-reset@example.com").lastError || "", /HTTP 503|runtime reset rejected/);
  assert.equal(sync.recordFor("rejected-runtime-reset@example.com").runtimeStateRecoveredAt, null);
  runtimeResetStatus = 200;

  const staleRuntimeState = await writeJob("stale-runtime-state", "stale-runtime-state@example.com", "stale-runtime-state-access", "stale-runtime-state-refresh");
  const staleRuntimeStateCreated = await sync.syncManual([staleRuntimeState]);
  const staleRuntimeStateFileName = staleRuntimeStateCreated.results[0].remoteFileName;
  fileStates.set(staleRuntimeStateFileName, {
    disabled: false,
    status: "error",
    statusMessage: "unauthorized",
    unavailable: true,
    authIndex: "stale-runtime-state-index",
  });
  ignoresRuntimeResetRequests = true;
  const staleRuntimeStateQuotaCount = quotaRefreshRequests.length;
  const staleRuntimeStateRetry = await writeJob("stale-runtime-state-retry", "stale-runtime-state@example.com", "stale-runtime-state-new-access", "stale-runtime-state-new-refresh");
  await sync.syncAfterManualReauthorization(staleRuntimeStateRetry);
  assert.equal(quotaRefreshRequests.length, staleRuntimeStateQuotaCount, "状态重置回读仍异常时不能继续写入健康证据");
  assert.match(sync.recordFor("stale-runtime-state@example.com").lastError || "", /运行状态回读仍显示异常/);
  assert.equal(sync.recordFor("stale-runtime-state@example.com").runtimeStateRecoveredAt, null);
  ignoresRuntimeResetRequests = false;

  const rejectedQuotaRefresh = await writeJob("rejected-quota-refresh", "rejected-quota@example.com", "rejected-quota-access", "rejected-quota-refresh");
  const rejectedQuotaCreated = await sync.syncManual([rejectedQuotaRefresh]);
  const rejectedQuotaFileName = rejectedQuotaCreated.results[0].remoteFileName;
  fileStates.set(rejectedQuotaFileName, { disabled: false, status: "active", authIndex: "rejected-quota-index" });
  quotaRefreshStatus = 503;
  const rejectedQuotaRetry = await writeJob("rejected-quota-retry", "rejected-quota@example.com", "rejected-quota-new-access", "rejected-quota-new-refresh");
  const rejectedQuotaRefreshCount = quotaRefreshRequests.length;
  await sync.syncAfterManualReauthorization(rejectedQuotaRetry);
  assert.equal(quotaRefreshRequests.length, rejectedQuotaRefreshCount + 1);
  assert.match(sync.recordFor("rejected-quota@example.com").lastError || "", /状态复核请求返回 HTTP 503/);
  quotaRefreshStatus = 200;

  const snapshotsUnavailable = await writeJob("snapshots-unavailable", "snapshots-unavailable@example.com", "snapshots-unavailable-access", "snapshots-unavailable-refresh");
  const snapshotsUnavailableCreated = await sync.syncManual([snapshotsUnavailable]);
  const snapshotsUnavailableFileName = snapshotsUnavailableCreated.results[0].remoteFileName;
  fileStates.set(snapshotsUnavailableFileName, { disabled: false, status: "active", authIndex: "snapshots-unavailable-index" });
  quotaSnapshotsAvailable = false;
  const snapshotsUnavailableRetry = await writeJob("snapshots-unavailable-retry", "snapshots-unavailable@example.com", "snapshots-unavailable-new-access", "snapshots-unavailable-new-refresh");
  await sync.syncAfterManualReauthorization(snapshotsUnavailableRetry);
  assert.match(sync.recordFor("snapshots-unavailable@example.com").lastError || "", /额度快照|状态证据/);
  assert.equal(sync.recordFor("snapshots-unavailable@example.com").quotaRefreshedAt, null);
  quotaSnapshotsAvailable = true;

  const staleCredential = await writeJob("stale-credential", "stale-credential@example.com", "stale-credential-access", "stale-credential-refresh");
  const staleCredentialCreated = await sync.syncManual([staleCredential]);
  const staleCredentialFileName = staleCredentialCreated.results[0].remoteFileName;
  fileStates.set(staleCredentialFileName, {
    disabled: false,
    status: "active",
    authIndex: "stale-credential-index",
    listedLastRefresh: "2000-01-01T00:00:00Z",
  });
  const staleCredentialQuotaRefreshCount = quotaRefreshRequests.length;
  const staleCredentialRetry = await writeJob("stale-credential-retry", "stale-credential@example.com", "stale-credential-new-access", "stale-credential-new-refresh");
  await sync.syncAfterManualReauthorization(staleCredentialRetry);
  assert.equal(quotaRefreshRequests.length, staleCredentialQuotaRefreshCount, "未确认 CPAMP 已载入本次新凭证时不能继续状态复核");
  assert.match(sync.recordFor("stale-credential@example.com").lastError || "", /未确认远端已载入本次新凭证/);
  assert.equal(sync.recordFor("stale-credential@example.com").credentialVerifiedAt, null);
  assert.equal(sync.recordFor("stale-credential@example.com").quotaRefreshedAt, null);

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
  files.set(historyCredentialFileName, { ...files.get(historyCredentialFileName), last_refresh: "1970-01-01T00:00:03.000Z" });

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
  files.set(historyTransientFileName, { ...files.get(historyTransientFileName), last_refresh: "1970-01-01T00:00:04.000Z" });

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
  files.set(recoveredHistoryFileName, { ...files.get(recoveredHistoryFileName), last_refresh: "1970-01-01T00:00:11.000Z" });

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
