import fs from "node:fs/promises";
import path from "node:path";

import { createProtectedStore } from "./protected-store.mjs";

const CONFIG_FILENAME = "cpamp-sync.json";
const MANAGEMENT_KEY_ID = "cpamp-management-key";
const MAX_RETRIES = 5;
const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000, 900_000];
const REQUEST_TIMEOUT_MS = 120_000;
const INSPECTION_INTERVAL_MS = 5 * 60_000;
const SYNC_CONCURRENCY_OPTIONS = new Set([1, 3, 5]);
const MAX_POLICY_INTEGER = 1_000_000;

export function createCpampSync(options) {
  const outputRoot = path.resolve(options.outputRoot);
  const configPath = path.join(outputRoot, CONFIG_FILENAME);
  const secretStore = options.secretStore || createProtectedStore();
  const fetchImpl = options.fetchImpl || fetch;
  let config = emptyConfig();
  let managementKey = null;
  const retryTimers = new Map();
  const requests = new Set();
  let persistPromise = Promise.resolve();
  let inspectionTimer = null;
  let inspectionPromise = null;
  let nextInspectionAt = null;

  return {
    async load() {
      config = await readConfig(configPath);
      if (!config.baseUrl) return;
      try {
        managementKey = await secretStore.load(MANAGEMENT_KEY_ID);
      } catch (error) {
        config.lastError = error.message;
        config.updatedAt = new Date().toISOString();
        await persist();
      }
      scheduleInspection();
    },

    status() {
      const records = Object.values(config.records);
      const pending = records
        .filter((record) => record.state === "pending_confirmation" && record.pendingJobId)
        .map((record) => ({ email: record.email, jobId: record.pendingJobId, requestedAt: record.pendingSince || null }));
      return {
        configured: Boolean(config.baseUrl && managementKey),
        baseUrl: config.baseUrl || null,
        autoSyncEnabled: config.autoSyncEnabled === true,
        autoSyncEnabledAt: config.autoSyncEnabledAt || null,
        syncAfterManualReauthorization: config.syncAfterManualReauthorization === true,
        pending,
        pendingCount: pending.length,
        syncingCount: records.filter((record) => record.state === "syncing").length,
        lastError: config.lastError || null,
        lastSyncAt: config.lastSyncAt || null,
        policy: publicPolicy(config.policy),
        inspection: {
          enabled: config.inspection.enabled === true,
          supported: config.inspection.supported !== false,
          running: Boolean(inspectionPromise),
          intervalMinutes: Math.round(INSPECTION_INTERVAL_MS / 60_000),
          lastCheckAt: config.inspection.lastCheckAt || null,
          nextCheckAt: nextInspectionAt,
          lastError: config.inspection.lastError || null,
          lastResult: config.inspection.lastResult || null,
        },
      };
    },

    recordFor(email) {
      const record = config.records[normalizeEmail(email)];
      if (!record) return null;
      return {
        state: record.state || null,
        remoteFileName: record.remoteFileName || null,
        lastSyncAt: record.lastSyncAt || null,
        lastError: record.lastError || null,
        duplicateCount: Number(record.duplicateCount || 0),
        retryAttempt: Number(record.retryAttempt || 0),
        inspection: publicInspection(record.inspection),
      };
    },

    async configure(input) {
      const baseUrl = normalizeBaseUrl(input.baseUrl);
      const suppliedKey = String(input.managementKey || "").trim();
      const nextKey = suppliedKey || managementKey;
      if (!nextKey) throw syncError(400, "请填写 CPAMP 管理密钥");
      const nextAuto = input.autoSyncEnabled === true;
      const syncAfterManualReauthorization = input.syncAfterManualReauthorization === undefined
        ? config.syncAfterManualReauthorization === true
        : input.syncAfterManualReauthorization === true;
      const policy = normalizePolicy(input.policy === undefined ? config.policy : input.policy);
      const inspectionEnabled = input.inspectionEnabled === undefined
        ? config.inspection.enabled === true
        : input.inspectionEnabled === true;
      // Local policy changes must remain editable when a previously saved remote key has expired.
      const apiBase = suppliedKey || !config.baseUrl || baseUrl !== config.baseUrl
        ? await discoverApiBase(baseUrl, nextKey)
        : config.baseUrl;
      const connectionChanged = config.baseUrl !== apiBase || (Boolean(suppliedKey) && suppliedKey !== managementKey);
      if (suppliedKey) await secretStore.save(MANAGEMENT_KEY_ID, suppliedKey);
      const enabling = nextAuto && (!config.autoSyncEnabled || connectionChanged);
      config.baseUrl = apiBase;
      config.autoSyncEnabled = nextAuto;
      config.autoSyncEnabledAt = enabling ? new Date().toISOString() : (nextAuto ? config.autoSyncEnabledAt || new Date().toISOString() : null);
      config.syncAfterManualReauthorization = syncAfterManualReauthorization;
      config.policy = policy;
      config.inspection.enabled = inspectionEnabled;
      if (!inspectionEnabled) config.inspection.lastError = null;
      config.lastError = null;
      config.updatedAt = new Date().toISOString();
      managementKey = nextKey;
      await persist();
      scheduleInspection();
      return this.status();
    },

    async options() {
      if (!managementKey || !config.baseUrl) throw syncError(409, "请先配置 CPAMP 服务器地址和管理密钥");
      const models = await listCodexModels();
      return { models, modelCount: models.length };
    },

    async syncManual(jobs) {
      if (!managementKey || !config.baseUrl) throw syncError(409, "请先配置 CPAMP 服务器地址和管理密钥");
      const result = await syncJobs(jobs, { source: "manual", approve: true });
      return result;
    },

    async applyPolicy(jobs) {
      if (!managementKey || !config.baseUrl) throw syncError(409, "请先配置 CPAMP 服务器地址和管理密钥");
      return syncJobs(jobs, { source: "manual", approve: true, forcePolicy: true });
    },

    async approvePending(jobs) {
      const pending = jobs.filter((job) => {
        const record = config.records[normalizeEmail(job.email)];
        return record?.state === "pending_confirmation" && record.pendingJobId === job.id;
      });
      if (pending.length === 0) throw syncError(409, "所选账号当前没有待确认的 CPAMP 同步");
      return syncJobs(pending, { source: "automatic", approve: true });
    },

    async queueCompleted(job) {
      if (!config.autoSyncEnabled || !managementKey || !config.baseUrl || !job?.resultSaved) return;
      const enabledAt = Date.parse(config.autoSyncEnabledAt || "");
      const completedAt = Date.parse(job.completedAt || "");
      if (!Number.isFinite(enabledAt) || !Number.isFinite(completedAt) || completedAt < enabledAt) return;
      const record = recordForWrite(job.email);
      if (!record.approvedAt) {
        record.state = "pending_confirmation";
        record.pendingJobId = job.id;
        record.pendingSince = new Date().toISOString();
        record.lastError = null;
        await persist();
        return;
      }
      await syncAutomatic(job);
    },

    async syncAfterManualReauthorization(job) {
      if (!config.syncAfterManualReauthorization || !managementKey || !config.baseUrl || !job?.resultSaved) return false;
      await syncJobs([job], { source: "manual_reauthorization", approve: true });
      return true;
    },

    async resume(jobsById) {
      if (!config.autoSyncEnabled || !managementKey || !config.baseUrl) return;
      const now = Date.now();
      for (const record of Object.values(config.records)) {
        if (!record.approvedAt || !record.pendingJobId || record.retryAttempt >= MAX_RETRIES) continue;
        const job = jobsById.get(record.pendingJobId);
        if (!job?.resultSaved) continue;
        const delay = Math.max(0, Date.parse(record.nextRetryAt || "") - now);
        if (Number.isFinite(delay)) scheduleRetry(job, delay);
      }
      scheduleInspection();
    },

    async inspectNow() {
      if (!managementKey || !config.baseUrl) throw syncError(409, "请先配置 CPAMP 服务器地址和管理密钥");
      if (!config.inspection.enabled) throw syncError(409, "请先启用 CPAMP 异常巡检");
      return runInspection("manual");
    },

    async shutdown() {
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear();
      if (inspectionTimer) clearInterval(inspectionTimer);
      inspectionTimer = null;
      nextInspectionAt = null;
      await Promise.allSettled([...requests, inspectionPromise, persistPromise].filter(Boolean));
    },
  };

  async function syncJobs(jobs, syncOptions) {
    const unique = uniqueByEmail(jobs);
    const summary = { selected: jobs.length, attempted: unique.length, created: 0, updated: 0, failed: 0, duplicates: 0, results: [] };
    let modelIdsPromise = null;
    const context = {
      async getModelIds() {
        if (!modelIdsPromise) modelIdsPromise = listCodexModels();
        return modelIdsPromise;
      },
    };
    const outcomes = await mapWithConcurrency(unique, config.policy.syncConcurrency, async (job) => {
      try {
        return { result: await syncOne(job, syncOptions, context) };
      } catch (error) {
        if (syncOptions.source === "automatic") await recordAutomaticFailure(job, error);
        else await recordManualFailure(job, error);
        return { result: { email: job.email, status: "failed", error: redactSecrets(error.message) } };
      }
    });
    for (const outcome of outcomes) {
      const result = outcome.result;
      if (result.status === "failed") summary.failed += 1;
      else if (result.operation === "created") summary.created += 1;
      else summary.updated += 1;
      summary.duplicates += Number(result.duplicateCount || 0);
      summary.results.push(result);
    }
    config.lastSyncAt = new Date().toISOString();
    config.lastError = summary.failed ? summary.results.find((item) => item.status === "failed")?.error || "CPAMP 同步失败" : null;
    await persist();
    return summary;
  }

  async function syncAutomatic(job) {
    const record = recordForWrite(job.email);
    record.pendingJobId = job.id;
    await persist();
    try {
      await syncJobs([job], { source: "automatic", approve: false });
    } catch (error) {
      await recordAutomaticFailure(job, error);
    }
  }

  async function syncOne(job, syncOptions, context) {
    const email = normalizeEmail(job.email);
    const record = recordForWrite(email);
    record.state = "syncing";
    record.lastError = null;
    await persist();
    const auth = await buildCodexAuth(job);
    const files = extractFiles(await request(config.baseUrl, managementKey, "/auth-files"));
    const selection = selectRemoteFile(files, email, record.remoteFileName);
    const fileName = selection.file?.name || codexFileName(auth);
    let payload = auth;
    if (selection.file) {
      const remote = await requestText(config.baseUrl, managementKey, `/auth-files/download?name=${encodeURIComponent(fileName)}`);
      payload = mergeRemoteAuth(JSON.parse(remote), email, auth);
    }
    if (!selection.file || syncOptions.forcePolicy === true) {
      const models = config.policy.modelWhitelist.length
        ? await context.getModelIds()
        : null;
      payload = applyPolicyToPayload(payload, email, config.policy, models, job);
    }
    await uploadAuthFile(config.baseUrl, managementKey, fileName, payload);
    record.email = email;
    record.remoteFileName = fileName;
    record.pendingJobId = null;
    record.pendingSince = null;
    record.state = "synced";
    record.lastSyncAt = new Date().toISOString();
    record.lastError = null;
    record.retryAttempt = 0;
    record.nextRetryAt = null;
    record.duplicateCount = selection.duplicateCount;
    if (syncOptions.approve) record.approvedAt = record.approvedAt || new Date().toISOString();
    await persist();
    return {
      email,
      status: "success",
      operation: selection.file ? "updated" : "created",
      remoteFileName: fileName,
      duplicateCount: selection.duplicateCount,
    };
  }

  async function recordAutomaticFailure(job, error) {
    const record = recordForWrite(job.email);
    record.pendingJobId = job.id;
    record.lastError = redactSecrets(error.message);
    if (!isTemporaryError(error)) {
      record.state = "failed";
      record.nextRetryAt = null;
      await persist();
      return;
    }
    const attempt = Number(record.retryAttempt || 0) + 1;
    record.state = "retrying";
    record.lastError = redactSecrets(error.message);
    record.retryAttempt = attempt;
    if (attempt >= MAX_RETRIES) {
      record.state = "failed";
      record.nextRetryAt = null;
      await persist();
      return;
    }
    const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
    record.nextRetryAt = new Date(Date.now() + delay).toISOString();
    await persist();
    scheduleRetry(job, delay);
  }

  async function recordManualFailure(job, error) {
    const record = recordForWrite(job.email);
    record.state = "failed";
    record.lastError = redactSecrets(error.message);
    record.nextRetryAt = null;
    await persist();
  }

  function scheduleRetry(job, delay) {
    const email = normalizeEmail(job.email);
    const existing = retryTimers.get(email);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      retryTimers.delete(email);
      void syncAutomatic(job);
    }, delay);
    timer.unref?.();
    retryTimers.set(email, timer);
  }

  function recordForWrite(email) {
    const normalized = normalizeEmail(email);
    const existing = config.records[normalized];
    if (existing) return existing;
    const record = { email: normalized, state: null, retryAttempt: 0 };
    config.records[normalized] = record;
    return record;
  }

  async function persist() {
    config.updatedAt = new Date().toISOString();
    const serialized = `${JSON.stringify(config, null, 2)}\n`;
    persistPromise = persistPromise.catch(() => {}).then(async () => {
      const tempPath = `${configPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(tempPath, serialized, { mode: 0o600 });
      await fs.rename(tempPath, configPath);
    });
    return persistPromise;
  }

  async function request(baseUrl, key, endpoint) {
    const response = await requestRaw(baseUrl, key, endpoint);
    const text = await response.text();
    if (!response.ok) throw remoteError(response.status, text);
    try { return text ? JSON.parse(text) : {}; } catch { return {}; }
  }

  async function requestText(baseUrl, key, endpoint) {
    const response = await requestRaw(baseUrl, key, endpoint);
    const text = await response.text();
    if (!response.ok) throw remoteError(response.status, text);
    return text;
  }

  async function requestRaw(baseUrl, key, endpoint) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let requestPromise;
    try {
      requestPromise = fetchImpl(`${baseUrl}${endpoint}`, {
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
        signal: controller.signal,
      });
      requests.add(requestPromise);
      return await requestPromise;
    } catch (error) {
      if (error?.name === "AbortError") throw syncError(504, "CPAMP 请求超时");
      throw syncError(502, `无法连接 CPAMP：${error.message}`);
    } finally {
      clearTimeout(timeout);
      if (requestPromise) requests.delete(requestPromise);
    }
  }

  async function discoverApiBase(baseUrl, key) {
    try {
      await request(baseUrl, key, "/auth-files");
      return baseUrl;
    } catch (error) {
      if (error?.remoteStatus !== 404 || /\/v0\/management$/i.test(baseUrl)) throw error;
    }
    const managementApiBase = `${baseUrl}/v0/management`;
    await request(managementApiBase, key, "/auth-files");
    return managementApiBase;
  }

  async function uploadAuthFile(baseUrl, key, fileName, payload) {
    const form = new FormData();
    form.append("file", new Blob([JSON.stringify(payload)], { type: "application/json" }), fileName);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let requestPromise;
    try {
      requestPromise = fetchImpl(`${baseUrl}/auth-files`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
        body: form,
        signal: controller.signal,
      });
      requests.add(requestPromise);
      const response = await requestPromise;
      const text = await response.text();
      if (!response.ok) throw remoteError(response.status, text);
    } catch (error) {
      if (error?.status) throw error;
      if (error?.name === "AbortError") throw syncError(504, "CPAMP 上传超时");
      throw syncError(502, `无法上传 CPAMP 凭证：${error.message}`);
    } finally {
      clearTimeout(timeout);
      if (requestPromise) requests.delete(requestPromise);
    }
  }

  async function listCodexModels() {
    let payload;
    try {
      payload = await request(config.baseUrl, managementKey, "/model-definitions/codex");
    } catch (error) {
      throw syncError(error.status || 502, `CPAMP 模型目录读取失败，已停止同步以避免未受模型限制导入：${redactSecrets(error.message)}`);
    }
    const models = extractModelIds(payload);
    if (!models.length) {
      throw syncError(502, "CPAMP 模型目录读取失败，已停止同步以避免未受模型限制导入");
    }
    return models;
  }

  function scheduleInspection() {
    if (inspectionTimer) clearInterval(inspectionTimer);
    inspectionTimer = null;
    nextInspectionAt = null;
    if (!config.inspection.enabled || !managementKey || !config.baseUrl) return;
    nextInspectionAt = new Date(Date.now() + INSPECTION_INTERVAL_MS).toISOString();
    inspectionTimer = setInterval(() => {
      nextInspectionAt = new Date(Date.now() + INSPECTION_INTERVAL_MS).toISOString();
      void runInspection("scheduled").catch(() => {});
    }, INSPECTION_INTERVAL_MS);
    inspectionTimer.unref?.();
  }

  function runInspection(source) {
    if (inspectionPromise) return inspectionPromise;
    const task = (async () => {
      const checkedAt = new Date().toISOString();
      try {
        const files = extractFiles(await request(config.baseUrl, managementKey, "/auth-files"));
        const fileByName = new Map(files.map((file) => [file.name, file]));
        const summary = { source, checked: 0, healthy: 0, missing: 0, disabled: 0, problem: 0 };
        for (const record of Object.values(config.records)) {
          if (!record.remoteFileName) continue;
          summary.checked += 1;
          const file = fileByName.get(record.remoteFileName);
          if (!file) {
            record.inspection = { state: "missing", reason: "远端文件缺失", checkedAt };
            summary.missing += 1;
          } else if (file.disabled === true) {
            record.inspection = { state: "disabled", reason: "CPAMP 已禁用", checkedAt };
            summary.disabled += 1;
          } else if (hasRemoteProblem(file)) {
            record.inspection = { state: "problem", reason: "CPAMP 返回远端异常状态", checkedAt };
            summary.problem += 1;
          } else {
            record.inspection = { state: "healthy", reason: null, checkedAt };
            summary.healthy += 1;
          }
        }
        config.inspection.lastCheckAt = checkedAt;
        config.inspection.lastError = null;
        config.inspection.lastResult = summary;
        await persist();
        return summary;
      } catch (error) {
        config.inspection.lastCheckAt = checkedAt;
        config.inspection.lastError = redactSecrets(error.message);
        await persist();
        throw error;
      }
    })();
    inspectionPromise = task;
    void task.finally(() => {
      if (inspectionPromise === task) inspectionPromise = null;
    }).catch(() => {});
    return task;
  }
}

async function buildCodexAuth(job) {
  const data = JSON.parse(await fs.readFile(job.outputPath, "utf8"));
  const account = data?.accounts?.find((item) => normalizeEmail(extractEmail(item)) === normalizeEmail(job.email));
  if (!account?.credentials?.access_token) throw syncError(409, `${job.email} 的 OAuth 导入文件格式不正确`);
  const credentials = account.credentials || {};
  const extra = account.extra && typeof account.extra === "object" ? account.extra : {};
  const pick = (...values) => values.find((value) => typeof value === "string" && value.trim())?.trim() || "";
  const email = normalizeEmail(pick(credentials.email, credentials.email_address, extra.email, extra.email_address, job.email));
  const accountId = pick(credentials.chatgpt_account_id, credentials.account_id, extra.chatgpt_account_id, extra.account_id);
  const auth = {
    type: "codex",
    account_id: accountId,
    chatgpt_account_id: accountId,
    chatgpt_user_id: pick(credentials.chatgpt_user_id, credentials.user_id, extra.chatgpt_user_id, extra.user_id),
    organization_id: pick(credentials.organization_id, credentials.org_id, extra.organization_id, extra.org_id, extra.poid),
    email,
    name: pick(account.name, email, accountId, "OpenAI OAuth Account"),
    plan_type: pick(credentials.plan_type, credentials.chatgpt_plan_type, extra.plan_type, extra.chatgpt_plan_type),
    chatgpt_plan_type: pick(credentials.chatgpt_plan_type, credentials.plan_type, extra.chatgpt_plan_type, extra.plan_type),
    access_token: String(credentials.access_token),
    refresh_token: pick(credentials.refresh_token, credentials.refreshToken),
    client_id: pick(credentials.client_id, credentials.clientId),
    last_refresh: new Date().toISOString(),
  };
  const idToken = pick(credentials.id_token, credentials.idToken);
  const expiresAt = pick(credentials.expires_at, credentials.expiresAt, account.expires_at, account.expiresAt);
  if (idToken) auth.id_token = idToken;
  if (expiresAt) auth.expired = expiresAt;
  return removeEmpty(auth);
}

function extractFiles(payload) {
  const files = Array.isArray(payload?.files) ? payload.files : Array.isArray(payload) ? payload : [];
  return files.filter((file) => file && typeof file === "object" && typeof file.name === "string" && file.name.trim());
}

function selectRemoteFile(files, email, preferredFileName) {
  const preferred = preferredFileName ? files.find((file) => file.name === preferredFileName) : null;
  if (preferred) return { file: preferred, duplicateCount: Math.max(0, files.filter((file) => fileMatchesEmail(file, email)).length - 1) };
  const matches = files.filter((file) => fileMatchesEmail(file, email));
  if (!matches.length) return { file: null, duplicateCount: 0 };
  const active = matches.find((file) => file.disabled !== true);
  return { file: active || matches[0], duplicateCount: matches.length - 1 };
}

function fileMatchesEmail(file, email) {
  const normalized = normalizeEmail(email);
  const directCandidates = [file.email, file.account, file.display_account, file.displayAccount];
  if (directCandidates.some((value) => normalizeEmail(value) === normalized)) return true;
  return [file.name, file.path].some((value) => fileNameContainsEmail(value, normalized));
}

function fileNameContainsEmail(value, email) {
  const name = String(value || "").trim().toLowerCase().replace(/\\/g, "/");
  if (!name || !email) return false;
  return name === email
    || name === `${email}.json`
    || name.startsWith(`${email}-`)
    || name.startsWith(`${email}_`)
    || name.includes(`-${email}-`)
    || name.includes(`-${email}_`)
    || name.includes(`_${email}-`)
    || name.includes(`_${email}_`)
    || name.endsWith(`-${email}.json`)
    || name.endsWith(`_${email}.json`);
}

function mergeRemoteAuth(remote, email, auth) {
  if (Array.isArray(remote)) {
    const index = remote.findIndex((entry) => authMatchesEmail(entry, email));
    if (index < 0) throw syncError(409, `${email} 的 CPAMP 主凭证内容已变化，已拒绝覆盖`);
    return remote.map((entry, current) => current === index ? mergeAuthFields(entry, auth) : entry);
  }
  if (!remote || typeof remote !== "object" || !authMatchesEmail(remote, email)) {
    throw syncError(409, `${email} 的 CPAMP 主凭证内容已变化，已拒绝覆盖`);
  }
  return mergeAuthFields(remote, auth);
}

function authMatchesEmail(value, email) {
  if (!value || typeof value !== "object") return false;
  const normalized = normalizeEmail(email);
  const candidates = [value.email, value.account, value.display_account, value.displayAccount, value?.user?.email, value?.credentials?.email];
  return candidates.some((candidate) => normalizeEmail(candidate) === normalized);
}

function mergeAuthFields(remote, auth) {
  const merged = { ...remote };
  const fields = [
    "type", "account_id", "chatgpt_account_id", "chatgpt_user_id", "organization_id",
    "email", "name", "plan_type", "chatgpt_plan_type", "access_token", "refresh_token",
    "id_token", "client_id", "last_refresh", "expired",
  ];
  fields.forEach((field) => {
    if (Object.hasOwn(auth, field) && auth[field]) merged[field] = auth[field];
    else if (["id_token", "refresh_token", "client_id", "expired"].includes(field)) delete merged[field];
  });
  return merged;
}

function applyPolicyToPayload(payload, email, policy, modelIds, job) {
  if (Array.isArray(payload)) {
    const index = payload.findIndex((entry) => authMatchesEmail(entry, email));
    if (index < 0) throw syncError(409, `${email} 的 CPAMP 主凭证内容已变化，已拒绝覆盖`);
    return payload.map((entry, current) => current === index ? applyPolicyToAuth(entry, policy, modelIds, job) : entry);
  }
  return applyPolicyToAuth(payload, policy, modelIds, job);
}

function applyPolicyToAuth(auth, policy, modelIds, job) {
  const next = { ...auth };
  if (policy.proxyMode === "fixed") next.proxy_url = policy.fixedProxyUrl;
  else if (policy.proxyMode === "job" && job?.proxyUrl) next.proxy_url = String(job.proxyUrl);
  else delete next.proxy_url;

  if (policy.priority === null) delete next.priority;
  else next.priority = policy.priority;
  if (policy.weight === null) delete next.weight;
  else next.weight = policy.weight;
  next.disabled = policy.newAccountEnabled !== true;

  if (!policy.modelWhitelist.length) {
    delete next.excluded_models;
  } else {
    next.excluded_models = modelIds.filter((model) => !policy.modelWhitelist.includes(model));
  }
  return next;
}

function extractModelIds(payload) {
  const candidates = Array.isArray(payload)
    ? payload
    : [payload?.models, payload?.data, payload?.items, payload?.definitions].find(Array.isArray) || [];
  const seen = new Set();
  for (const item of candidates) {
    const value = typeof item === "string" ? item : item?.id || item?.name || item?.model;
    const model = String(value || "").trim();
    if (model && model.length <= 200) seen.add(model);
  }
  return [...seen];
}

function hasRemoteProblem(file) {
  const status = String(file?.status || file?.state || file?.inspection_status || "").trim().toLowerCase();
  return ["problem", "error", "failed", "invalid", "unhealthy"].includes(status);
}

function mapWithConcurrency(values, limit, callback) {
  const count = Math.max(1, Math.min(Number(limit) || 1, values.length || 1));
  const results = new Array(values.length);
  let nextIndex = 0;
  return Promise.all(Array.from({ length: count }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await callback(values[index], index);
    }
  })).then(() => results);
}

function codexFileName(auth) {
  const account = sanitize(auth.account_id || auth.chatgpt_account_id || stableId(auth.email), 8);
  const email = sanitize(auth.email || "account", 96, true);
  const plan = sanitize(auth.plan_type || auth.chatgpt_plan_type || "", 32);
  return ["codex", account, email, plan].filter(Boolean).join("-") + ".json";
}

function sanitize(value, maxLength, preserveEmailSymbols = false) {
  const text = String(value || "").trim().toLowerCase();
  const invalid = preserveEmailSymbols ? /[^a-z0-9@._+-]+/g : /[^a-z0-9]+/g;
  return text.replace(/[\/:*?"<>|]+/g, "-").replace(invalid, "-").replace(/-+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, maxLength);
}

function stableId(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
}

function extractEmail(account) {
  return account?.credentials?.email || account?.credentials?.email_address || account?.extra?.email || account?.extra?.email_address || account?.name || "";
}

function normalizeBaseUrl(value) {
  const text = String(value || "").trim();
  let parsed;
  try { parsed = new URL(text); } catch { throw syncError(400, "CPAMP 服务器地址格式不正确"); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw syncError(400, "CPAMP 服务器地址必须使用 HTTP 或 HTTPS");
  parsed.hash = "";
  parsed.search = "";
  if (/\/management\.html$/i.test(parsed.pathname)) parsed.pathname = "/";
  return parsed.toString().replace(/\/+$/, "");
}

function normalizePolicy(input) {
  const source = input && typeof input === "object" ? input : {};
  const proxyMode = String(source.proxyMode || "none").trim();
  if (!["none", "fixed", "job"].includes(proxyMode)) throw syncError(400, "CPAMP 代理来源无效");
  const fixedProxyUrl = String(source.fixedProxyUrl || "").trim();
  if (proxyMode === "fixed") validateProxyUrl(fixedProxyUrl);
  const whitelistSource = Array.isArray(source.modelWhitelist) ? source.modelWhitelist : String(source.modelWhitelist || "").split(/[\n,]/);
  const modelWhitelist = [...new Set(whitelistSource
    .map((value) => String(value || "").trim())
    .filter((value) => value && value.length <= 200 && !/[\r\n]/.test(value)))];
  if (modelWhitelist.length > 300) throw syncError(400, "CPAMP 仅允许模型数量不能超过 300 个");
  const syncConcurrency = Number(source.syncConcurrency ?? 1);
  if (!SYNC_CONCURRENCY_OPTIONS.has(syncConcurrency)) throw syncError(400, "CPAMP 批量同步并发只支持 1、3 或 5");
  return {
    newAccountEnabled: source.newAccountEnabled !== false,
    proxyMode,
    fixedProxyUrl: proxyMode === "fixed" ? fixedProxyUrl : "",
    priority: normalizeOptionalInteger(source.priority, "CPAMP 优先级"),
    weight: normalizeOptionalInteger(source.weight, "CPAMP 调度权重"),
    modelWhitelist,
    syncConcurrency,
  };
}

function validateProxyUrl(value) {
  if (!value || value.length > 2_000 || /[\r\n]/.test(value)) throw syncError(400, "固定代理地址格式不正确");
  let parsed;
  try { parsed = new URL(value); } catch { throw syncError(400, "固定代理地址格式不正确"); }
  if (!["http:", "https:", "socks5:", "socks5h:"].includes(parsed.protocol) || !parsed.hostname) {
    throw syncError(400, "固定代理地址必须使用 http、https、socks5 或 socks5h");
  }
}

function normalizeOptionalInteger(value, label) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || Math.abs(number) > MAX_POLICY_INTEGER) {
    throw syncError(400, `${label}必须是 ${MAX_POLICY_INTEGER} 以内的整数`);
  }
  return number;
}

function publicPolicy(policy) {
  const normalized = normalizePolicy(policy);
  return { ...normalized, modelWhitelist: [...normalized.modelWhitelist] };
}

function publicInspection(inspection) {
  if (!inspection || typeof inspection !== "object") return null;
  return {
    state: String(inspection.state || ""),
    reason: inspection.reason ? String(inspection.reason).slice(0, 300) : null,
    checkedAt: typeof inspection.checkedAt === "string" ? inspection.checkedAt : null,
  };
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function uniqueByEmail(jobs) {
  const values = new Map();
  jobs.filter((job) => job?.resultSaved).forEach((job) => values.set(normalizeEmail(job.email), job));
  return [...values.values()];
}

function removeEmpty(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== "" && item !== null && item !== undefined));
}

function isTemporaryError(error) {
  const status = Number(error?.remoteStatus || error?.status || 0);
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

function remoteError(status, text) {
  const message = responseMessage(text);
  const error = syncError(status === 401 || status === 403 || status === 400 || status === 404 ? 502 : 503, `CPAMP 返回 HTTP ${status}${message ? `：${message}` : ""}`);
  error.remoteStatus = status;
  return error;
}

function responseMessage(text) {
  try {
    const data = JSON.parse(text);
    const message = data?.error?.message || data?.message || data?.error;
    return typeof message === "string" ? redactSecrets(message).slice(0, 500) : "";
  } catch {
    return redactSecrets(String(text || "")).slice(0, 500);
  }
}

function redactSecrets(value) {
  return String(value || "")
    .replace(/(access_token|refresh_token|id_token|authorization|bearer|management[_ -]?key)\s*[:=]\s*[^\s,}]]+/gi, "$1=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]");
}

async function readConfig(configPath) {
  try {
    const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
    if (!raw || typeof raw !== "object") return emptyConfig();
    return {
      ...emptyConfig(),
      baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : "",
      autoSyncEnabled: raw.autoSyncEnabled === true,
      autoSyncEnabledAt: typeof raw.autoSyncEnabledAt === "string" ? raw.autoSyncEnabledAt : null,
      syncAfterManualReauthorization: raw.syncAfterManualReauthorization === true,
      records: raw.records && typeof raw.records === "object" && !Array.isArray(raw.records) ? raw.records : {},
      lastError: typeof raw.lastError === "string" ? raw.lastError : null,
      lastSyncAt: typeof raw.lastSyncAt === "string" ? raw.lastSyncAt : null,
      policy: normalizeStoredPolicy(raw.policy),
      inspection: normalizeStoredInspection(raw.inspection),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return emptyConfig();
    return emptyConfig();
  }
}

function emptyConfig() {
  return {
    version: 2,
    baseUrl: "",
    autoSyncEnabled: false,
    autoSyncEnabledAt: null,
    syncAfterManualReauthorization: false,
    records: {},
    lastError: null,
    lastSyncAt: null,
    updatedAt: null,
    policy: { newAccountEnabled: true, proxyMode: "none", fixedProxyUrl: "", priority: null, weight: null, modelWhitelist: [], syncConcurrency: 1 },
    inspection: { enabled: false, supported: true, lastCheckAt: null, lastError: null, lastResult: null },
  };
}

function normalizeStoredPolicy(value) {
  try { return normalizePolicy(value); } catch { return emptyConfig().policy; }
}

function normalizeStoredInspection(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    enabled: source.enabled === true,
    supported: source.supported !== false,
    lastCheckAt: typeof source.lastCheckAt === "string" ? source.lastCheckAt : null,
    lastError: typeof source.lastError === "string" ? source.lastError : null,
    lastResult: source.lastResult && typeof source.lastResult === "object" ? source.lastResult : null,
  };
}

function syncError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
