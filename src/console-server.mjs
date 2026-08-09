#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { createServer as createViteServer } from "vite";
import { createCredentialStore } from "./credential-store.mjs";
import { fetchMailboxOtpCandidates, validateMailApiUrl } from "./mail-otp.mjs";
import { createSmsProvider, publicSmsProviderDefinitions } from "./sms-providers.mjs";
import { proxySupportsSessionRotation } from "./tls-transport.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4399;
const MAX_ACTIVE_JOBS = 20;
const MAX_BATCH_JOBS = 500;
const MAX_PROXY_RISK_RETRIES = 10;
const MAX_PROXY_CONNECTION_FAILURES = 20;
const PROXY_CONNECTION_RETRY_BASE_MS = Math.max(1, Number(process.env.PROXY_CONNECTION_RETRY_BASE_MS || 1_000));
const PROXY_CONNECTION_RETRY_MAX_MS = 15_000;
const PAGE_SIZE = 20;
const MAX_LOG_CHARS = 80_000;
const JOB_META_FILENAME = "job-meta.json";
const LOGIN_CHECKPOINT_FILENAME = "login-checkpoint.json";
const TOTP_SETUP_RESULT_FILENAME = "totp-setup-result.json";
const MAIL_POLL_INTERVAL_MS = 2_500;
const MAIL_POLL_TIMEOUT_MS = 10 * 60_000;
const SMS_POLL_INTERVAL_MS = Number(process.env.SMS_POLL_INTERVAL_MS || process.env.LUBAN_SMS_POLL_INTERVAL_MS || 3_000);
const SMS_POLL_TIMEOUT_MS = Number(process.env.SMS_POLL_TIMEOUT_MS || process.env.LUBAN_SMS_POLL_TIMEOUT_MS || 10 * 60_000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(__dirname, "..");
const WEB_ROOT = path.join(TOOL_ROOT, "web");
const PROTOCOL_SCRIPT = path.resolve(process.env.ONBOARDING_PROTOCOL_SCRIPT || path.join(__dirname, "protocol-login.mjs"));
const WORKSPACE_ROOT = TOOL_ROOT;
const OUTPUT_ROOT = path.resolve(
  process.env.ONBOARDING_OUTPUT_ROOT || path.join(WORKSPACE_ROOT, "tmp", "chatgpt-onboarding-console"),
);
const credentialStore = createCredentialStore();
const consoleToken = crypto.randomBytes(24).toString("base64url");
const jobs = new Map();
const customSmsPoolPositions = new Map();
const emailJobLocks = new Map();
let outputSyncPromise = null;
let lastOutputSyncAt = 0;
let shuttingDown = false;
let queueSchedulingPaused = false;
let shutdownPromise = null;

const hostArg = process.argv.find((item) => item.startsWith("--host="));
const hostIndex = process.argv.indexOf("--host");
const requestedHost = String(
  hostArg?.slice("--host=".length)
    || (hostIndex >= 0 ? process.argv[hostIndex + 1] : "")
    || process.env.ONBOARDING_HOST
    || DEFAULT_HOST,
).trim();
const portArg = process.argv.find((item) => item.startsWith("--port="));
const portIndex = process.argv.indexOf("--port");
const requestedPort = Number(
  portArg?.slice("--port=".length) || (portIndex >= 0 ? process.argv[portIndex + 1] : "") || DEFAULT_PORT,
);
const hmrPort = requestedPort <= 45_535 ? requestedPort + 20_000 : requestedPort - 20_000;

if (!requestedHost || requestedHost.startsWith("--")) {
  throw new Error("--host must be a valid hostname or IP address");
}

if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
  throw new Error("--port must be an integer between 1 and 65535");
}

await fs.mkdir(OUTPUT_ROOT, { recursive: true });
await syncCompletedOutputs(true);
scheduleQueuedJobs();

const vite = await createViteServer({
  root: WEB_ROOT,
  configFile: false,
  appType: "spa",
  plugins: [react()],
  server: {
    middlewareMode: true,
    hmr: { port: hmrPort, clientPort: hmrPort },
  },
});

const server = http.createServer(async (req, res) => {
  try {
    enforceUtf8ContentType(res);
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || `${requestedHost}:${requestedPort}`}`);
    if (requestUrl.pathname.startsWith("/api/")) {
      await handleApi(req, res, requestUrl);
      return;
    }
    vite.middlewares(req, res, (error) => {
      if (error) sendJson(res, 500, { error: error.message || "Page rendering failed" });
    });
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || "Internal server error" });
  }
});

function enforceUtf8ContentType(res) {
  const setHeader = res.setHeader;
  res.setHeader = function setUtf8Header(name, value) {
    if (String(name).toLowerCase() === "content-type") {
      value = addUtf8Charset(value);
    }
    return setHeader.call(this, name, value);
  };
}

function addUtf8Charset(value) {
  if (typeof value !== "string" || /;\s*charset=/i.test(value)) return value;
  if (/^(?:text\/(?:html|css|javascript|plain)|application\/(?:javascript|json))(?:\s*;|$)/i.test(value)) {
    return `${value}; charset=utf-8`;
  }
  return value;
}

server.listen(requestedPort, requestedHost, () => {
  const urls = getConsoleUrls(requestedHost, requestedPort);
  console.log(`[ok] ChatGPT onboarding console: ${urls[0]}`);
  for (const url of urls.slice(1)) console.log(`[ok] LAN access: ${url}`);
  console.log(`[info] Output directory: ${OUTPUT_ROOT}`);
  if (isWildcardHost(requestedHost)) {
    console.log("[note] LAN access is enabled without authentication. Keep downloaded OAuth files private.");
  } else {
    console.log("[note] This server only listens on the configured host. Keep downloaded OAuth files private.");
  }
});

function isWildcardHost(host) {
  return host === "0.0.0.0" || host === "::";
}

function getConsoleUrls(host, port) {
  if (!isWildcardHost(host)) return [`http://${host}:${port}`];
  const addresses = Object.values(os.networkInterfaces())
    .flatMap((entries) => entries || [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  return [
    `http://127.0.0.1:${port}`,
    ...[...new Set(addresses)].map((address) => `http://${address}:${port}`),
  ];
}

async function handleApi(req, res, requestUrl) {
  if (req.method === "GET" && requestUrl.pathname === "/api/bootstrap") {
    sendJson(res, 200, {
      token: consoleToken,
      features: {
        retry: true,
        regenerate: true,
        phoneContext: true,
        batchDownload: true,
        bulkActions: true,
        pagination: true,
        uniqueEmail: true,
        smsProviders: publicSmsProviderDefinitions(),
        queue: true,
        sourceExport: true,
        cancelAll: true,
        sub2apiUpload: true,
        tlsFingerprint: true,
        totpSetup: true,
        forceRelogin: true,
      },
    });
    return;
  }

  if (req.headers["x-console-token"] !== consoleToken) {
    sendJson(res, 403, { error: "Invalid console token" });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/jobs") {
    const requestedPage = Math.max(1, Number.parseInt(requestUrl.searchParams.get("page") || "1", 10) || 1);
    await sendJobsPage(res, requestedPage);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/query") {
    const body = await readJson(req);
    const requestedPage = Math.max(1, Number.parseInt(body.page || "1", 10) || 1);
    await sendJobsPage(res, requestedPage, normalizeEmailFilter(body.emails));
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs") {
    const body = await readJson(req);
    const email = String(body.email || "").trim();
    if (!isEmail(email)) {
      sendJson(res, 400, { error: "Please enter a valid email address" });
      return;
    }
    const hasCredentialUpdate = ["password", "mailApiUrl", "totpSecret"].some((key) => Object.hasOwn(body, key));
    const credentials = normalizeLoginCredentials(body);
    const hasProxyUpdate = Object.hasOwn(body, "proxyUrl");
    const proxyUrl = hasProxyUpdate ? normalizeProxyUrl(body.proxyUrl) : null;
    const result = await withEmailJobLock(email, async () => {
      const existing = findJobByEmail(email);
      if (existing) {
        if (hasCredentialUpdate) await updateJobCredentials(existing, credentials, { proxyUrl, hasProxyUpdate });
        else if (hasProxyUpdate) await updateJobProxy(existing, proxyUrl);
        return { job: existing, created: false, updated: hasCredentialUpdate || hasProxyUpdate };
      }
      return { job: await startJob(email, credentials, proxyUrl), created: true, updated: false };
    });
    sendJson(res, result.created ? 201 : 200, { ...result, job: publicJob(result.job) });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/batch") {
    const body = await readJson(req);
    const entries = parseBatchEntries(body.text);
    const proxyUrl = normalizeProxyUrl(body.proxyUrl);
    const results = await Promise.all(entries.map((entry) => withEmailJobLock(entry.email, async () => {
      const existing = findJobByEmail(entry.email);
      if (existing) {
        await updateJobCredentials(existing, entry, { proxyUrl, hasProxyUpdate: true });
        return { job: existing, updated: true };
      }
      return { job: await startJob(entry.email, entry, proxyUrl), updated: false };
    })));
    sendJson(res, 201, {
      jobs: results.map((item) => publicJob(item.job)),
      created: results.filter((item) => !item.updated).length,
      updated: results.filter((item) => item.updated).length,
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/download-batch") {
    const body = await readJson(req);
    await downloadBatchResult(res, body.ids);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/export-source") {
    const body = await readJson(req);
    await exportSourceAccounts(res, body.ids);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/delete-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids);
    const emails = [...new Set(selected.map((job) => job.email.toLowerCase()))];
    await Promise.all(emails.map((email) => withEmailJobLock(email, () => deleteJobsByEmail(email))));
    sendJson(res, 200, { deleted: emails.length });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/reauthorize-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids);
    const unsupported = selected.find(
      (job) => !["completed", "failed", "canceled", "reauth_required", "resume_available"].includes(job.status),
    );
    if (unsupported) throw httpError(409, `${unsupported.email} 当前仍在进行中，不能重新授权`);
    await Promise.all(selected.map(async (job) => {
      if (job.status === "completed") await regenerateJob(job, body);
      else await retryJob(job, body);
    }));
    sendJson(res, 200, { jobs: selected.map(publicJob), started: selected.length });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/relogin-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids);
    const eligible = selected.filter(canForceRelogin);
    if (!eligible.length) throw httpError(409, "选中的账号当前都不能重新登录");
    await Promise.all(eligible.map((job) => forceReloginJob(job, body)));
    sendJson(res, 200, {
      jobs: eligible.map(publicJob),
      started: eligible.length,
      skipped: selected.length - eligible.length,
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/setup-2fa-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids);
    const eligible = selected.filter(canSetupTotp);
    if (!eligible.length) throw httpError(409, "选中的账号都不能设置 2FA");
    await Promise.all(eligible.map((job) => startTotpSetup(job, body)));
    sendJson(res, 200, {
      jobs: eligible.map(publicJob),
      started: eligible.length,
      skipped: selected.length - eligible.length,
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/cancel-all") {
    const canceled = await cancelAllJobs();
    sendJson(res, 200, { canceled });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sub2api/groups") {
    const body = await readJson(req);
    const config = normalizeSub2ApiConfig(body.config);
    const payload = await requestSub2Api(config, "/api/v1/admin/groups/all?platform=openai");
    const groups = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
    sendJson(res, 200, {
      groups: groups
        .filter((group) => group && Number.isInteger(Number(group.id)))
        .map((group) => ({
          id: Number(group.id),
          name: String(group.name || `号池 ${group.id}`),
          status: String(group.status || "active"),
        })),
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sub2api/options") {
    const body = await readJson(req);
    const config = normalizeSub2ApiConfig(body.config);
    const [groupPayload, proxyPayload] = await Promise.all([
      requestSub2Api(config, "/api/v1/admin/groups/all?platform=openai"),
      requestSub2Api(config, "/api/v1/admin/proxies/all"),
    ]);
    const groups = Array.isArray(groupPayload) ? groupPayload : Array.isArray(groupPayload?.data) ? groupPayload.data : [];
    const proxies = Array.isArray(proxyPayload) ? proxyPayload : Array.isArray(proxyPayload?.data) ? proxyPayload.data : [];
    sendJson(res, 200, {
      groups: groups
        .filter((group) => group && Number.isInteger(Number(group.id)))
        .map((group) => ({ id: Number(group.id), name: String(group.name || `号池 ${group.id}`), status: String(group.status || "active") })),
      proxies: proxies
        .filter((proxy) => proxy && Number.isInteger(Number(proxy.id)))
        .map((proxy) => ({
          id: Number(proxy.id),
          name: String(proxy.name || `代理 ${proxy.id}`),
          protocol: String(proxy.protocol || ""),
          host: String(proxy.host || ""),
          port: Number(proxy.port || 0),
          ipAddress: String(proxy.ip_address || ""),
          status: String(proxy.status || "active"),
        })),
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sub2api/upload") {
    const body = await readJson(req);
    const config = normalizeSub2ApiConfig(body.config);
    const selected = resolveSelectedJobs(body.ids);
    const downloadable = selected.filter((job) => job.resultSaved);
    if (downloadable.length === 0) throw httpError(409, "选中的任务里没有已完成的导入文件");
    const payload = await buildSub2ApiUploadPayload(downloadable);
    const idempotencyKey = `tosub2-upload-${crypto.randomUUID()}`;

    const accounts = payload.accounts.map((account) => {
      const { proxy_key: _proxyKey, ...accountData } = account;
      const credentials = { ...(account.credentials || {}) };
      if (config.modelWhitelist.length) {
        credentials.model_mapping = Object.fromEntries(config.modelWhitelist.map((model) => [model, model]));
      }
      return {
        ...accountData,
        credentials,
        group_ids: config.groupIds.length ? config.groupIds : (account.group_ids || []),
        ...(config.proxyId ? { proxy_id: config.proxyId } : {}),
        ...(config.concurrency !== null ? { concurrency: config.concurrency } : {}),
        ...(config.loadFactor !== null ? { load_factor: config.loadFactor } : {}),
        ...(config.priority !== null ? { priority: config.priority } : {}),
      };
    });
    const result = await requestSub2Api(config, "/api/v1/admin/accounts/batch", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ accounts }),
    });

    sendJson(res, 200, {
      selected: selected.length,
      uploaded: downloadable.length,
      skipped: selected.length - downloadable.length,
      groupIds: config.groupIds,
      result,
    });
    return;
  }

  const providerOptionsMatch = /^\/api\/sms-providers\/([a-z0-9_-]+)\/options$/.exec(requestUrl.pathname);
  if (req.method === "POST" && providerOptionsMatch) {
    const body = await readJson(req);
    let smsClient;
    try {
      smsClient = createSmsProvider(providerOptionsMatch[1], body.config, {
        lubanApiBase: process.env.LUBAN_SMS_API_BASE,
        smsBowerApiBase: process.env.SMSBOWER_API_BASE,
      });
      if (!smsClient.listNumberOptions) throw httpError(400, "该接码平台不支持价格查询");
      const options = await smsClient.listNumberOptions();
      sendJson(res, 200, { providerId: smsClient.id, options });
    } catch (error) {
      if (error?.status) throw error;
      throw httpError(502, safeSmsProviderError(error, body.config?.apiKey));
    }
    return;
  }

  const match = /^\/api\/jobs\/([a-f0-9-]+)(?:\/(input|cancel|retry|regenerate|relogin|setup-2fa|logs|download|sms-number|luban-number))?$/.exec(requestUrl.pathname);
  if (!match) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const job = jobs.get(match[1]);
  if (!job) {
    sendJson(res, 404, { error: "Login flow not found" });
    return;
  }

  const action = match[2];
  if (req.method === "GET" && action === "logs") {
    sendJson(res, 200, { id: job.id, logs: job.logs });
    return;
  }
  if (req.method === "GET" && action === "download") {
    await downloadResult(res, job);
    return;
  }
  if (req.method === "POST" && ["sms-number", "luban-number"].includes(action)) {
    const body = await readJson(req);
    const providerId = action === "luban-number" ? "luban" : body.providerId;
    const config = action === "luban-number"
      ? { apiKey: body.apiKey, serviceId: body.serviceId }
      : body.config;
    await acquireSmsNumber(job, providerId, config);
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "cancel") {
    await cancelJob(job);
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "retry") {
    const body = await readJson(req);
    await retryJob(job, body);
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "regenerate") {
    const body = await readJson(req);
    await regenerateJob(job, body);
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "relogin") {
    const body = await readJson(req);
    await forceReloginJob(job, body);
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "setup-2fa") {
    const body = await readJson(req);
    await startTotpSetup(job, body);
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "input") {
    const body = await readJson(req);
    await submitJobInput(job, body);
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

async function sendJobsPage(res, requestedPage, emailFilter = null) {
  await syncCompletedOutputs();
  const allJobs = listUniqueJobs();
  const emailSet = emailFilter?.length ? new Set(emailFilter) : null;
  const visibleJobs = emailSet
    ? allJobs.filter((job) => emailSet.has(job.email.toLowerCase()))
    : allJobs;
  const total = visibleJobs.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  const start = (page - 1) * PAGE_SIZE;
  sendJson(res, 200, {
    jobs: visibleJobs.slice(start, start + PAGE_SIZE).map(publicJob),
    selection: visibleJobs.map(publicSelectionJob),
    pagination: { page, pageSize: PAGE_SIZE, total, totalPages, totalAll: allJobs.length },
    filter: { active: Boolean(emailSet), requested: emailFilter?.length || 0, matched: total },
    stats: {
      active: allJobs.filter(occupiesActiveSlot).length,
      queued: allJobs.filter((job) => job.status === "queued").length,
      completed: allJobs.filter((job) => job.status === "completed").length,
    },
  });
}

function normalizeEmailFilter(value) {
  if (!Array.isArray(value) || value.length === 0) throw httpError(400, "请至少输入一个筛选邮箱");
  if (value.length > MAX_BATCH_JOBS) throw httpError(400, `一次最多筛选 ${MAX_BATCH_JOBS} 个邮箱`);
  const unique = new Set();
  value.forEach((item, index) => {
    const email = String(item || "").trim().toLowerCase();
    if (!isEmail(email)) throw httpError(400, `第 ${index + 1} 个筛选邮箱格式错误`);
    unique.add(email);
  });
  return [...unique];
}

async function startJob(email, credentials = {}, proxyUrl = null) {
  const { loginMode, mailApiUrl, password, totpSecret } = normalizeLoginCredentials(credentials);
  await saveStoredLoginCredentials(email, { password, totpSecret, proxyUrl });
  const id = crypto.randomUUID();
  const outputDir = path.join(OUTPUT_ROOT, id);
  const outputPath = path.join(outputDir, "sub2api-import-oauth.json");
  const checkpointPath = path.join(outputDir, LOGIN_CHECKPOINT_FILENAME);
  const totpResultPath = path.join(outputDir, TOTP_SETUP_RESULT_FILENAME);
  await fs.mkdir(outputDir, { recursive: true });

  const job = {
    id,
    email,
    status: "queued",
    prompt: "已加入任务队列",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    outputPath,
    checkpointPath,
    totpResultPath,
    logs: "",
    lastError: null,
    child: null,
    parserTail: "",
    resultSaved: false,
    loginMode,
    password,
    totpSecret,
    hasPasswordCredential: Boolean(password),
    hasTotpCredential: Boolean(totpSecret),
    proxyUrl,
    mailApiUrl,
    mailSeenCandidateKeys: new Set(),
    mailCandidateCounts: new Map(),
    mailStatus: mailApiUrl ? "baseline" : "manual",
    mailApiError: null,
    mailPollRunning: false,
    mailPollToken: null,
    currentPhone: null,
    phoneError: null,
    restartRequired: false,
    attempt: 1,
    runId: null,
    runMode: null,
    queuedMode: "full",
    queuedAt: new Date().toISOString(),
    queuedStartPrompt: "正在建立登录会话",
    fallbackInProgress: false,
    totpSetupSecret: null,
    totpSetupUri: null,
    totpSetupError: null,
    totpKnownEnabled: false,
    totpSetupAttempt: 0,
    totpResultLoading: false,
    proxyRiskRetryCount: 0,
    proxyConnectionFailureCount: 0,
    proxyRiskRestarting: false,
    proxySessionAttemptIds: new Set(),
    proxyAttemptParserTail: "",
    queueRunId: null,
    ...newSmsState(),
  };
  jobs.set(id, job);
  await saveJobMetadata(job);
  scheduleQueuedJobs();
  return job;
}

function scheduleQueuedJobs() {
  if (shuttingDown || queueSchedulingPaused) return;
  let availableSlots = MAX_ACTIVE_JOBS - [...jobs.values()].filter(occupiesActiveSlot).length;
  if (availableSlots <= 0) return;
  const queuedJobs = [...jobs.values()]
    .filter((job) => job.status === "queued")
    .sort((a, b) => String(a.queuedAt || a.createdAt).localeCompare(String(b.queuedAt || b.createdAt)));
  for (const job of queuedJobs.slice(0, availableSlots)) {
    const mode = job.queuedMode || "full";
    const queueRunId = crypto.randomUUID();
    job.queueRunId = queueRunId;
    job.status = mode === "refresh" ? "refreshing" : mode === "totp_setup" ? "totp_starting" : "starting";
    job.prompt = job.queuedStartPrompt || (mode === "refresh"
      ? "正在使用已有刷新令牌直接生成新授权"
      : mode === "totp_setup" ? "正在重新验证账号并准备设置 2FA" : "正在建立登录会话");
    job.queuedAt = null;
    touch(job);
    void saveJobMetadata(job).catch(() => {});
    void prepareAndLaunchJob(job, mode, queueRunId);
    availableSlots -= 1;
    if (availableSlots <= 0) break;
  }
}

async function prepareAndLaunchJob(job, mode, queueRunId) {
  try {
    if (["full", "totp_setup"].includes(mode) && job.mailApiUrl) await loadMailboxBaseline(job);
    if (!isActive(job.status) || job.status === "queued" || job.queueRunId !== queueRunId) return;
    launchJob(job, { mode });
  } catch (error) {
    if (mode === "totp_setup") {
      restoreTotpSetupFailure(job, `准备 2FA 设置失败：${error.message}`);
    } else {
      failJob(job, `准备登录任务失败：${error.message}`);
    }
    scheduleQueuedJobs();
  }
}

function enqueueJob(job, mode, startPrompt) {
  job.queueRunId = null;
  job.status = "queued";
  job.prompt = "已加入任务队列";
  job.queuedMode = mode;
  job.queuedAt = new Date().toISOString();
  job.queuedStartPrompt = startPrompt;
  touch(job);
  void saveJobMetadata(job).catch(() => {});
  scheduleQueuedJobs();
}

function launchJob(job, options = {}) {
  const mode = options.mode || "full";
  const runId = crypto.randomUUID();
  job.runId = runId;
  job.runMode = mode;
  const args = mode === "refresh"
    ? [
        PROTOCOL_SCRIPT,
        "--refresh-sub2api",
        job.outputPath,
        "--sub2api-out",
        job.outputPath,
        "--verbose",
      ]
    : mode === "totp_setup"
      ? [
          PROTOCOL_SCRIPT,
          "--email",
          job.email,
          "--setup-totp",
          "--totp-result",
          job.totpResultPath,
          "--verbose",
        ]
    : [
        PROTOCOL_SCRIPT,
        "--email",
        job.email,
        "--output-mode",
        "sub2api",
        "--sub2api-out",
        job.outputPath,
        "--checkpoint",
        job.checkpointPath,
        "--resume-checkpoint",
        job.checkpointPath,
        "--verbose",
      ];
  const child = spawn(process.execPath, args, {
    cwd: WORKSPACE_ROOT,
    env: {
      ...process.env,
      CHATGPT_LOGIN_PASSWORD: job.password || "",
      CHATGPT_TOTP_SECRET: job.totpSecret || "",
      CHATGPT_PROXY_URL: job.proxyUrl || "",
      CHATGPT_PROXY_MAX_ATTEMPTS: String(Math.max(0, MAX_PROXY_RISK_RETRIES - (job.proxyRiskRetryCount || 0))),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  job.child = child;

  child.stdout.on("data", (chunk) => {
    if (job.runId === runId) consumeOutput(job, chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk) => {
    if (job.runId === runId) consumeOutput(job, chunk.toString("utf8"));
  });
  child.on("error", (error) => {
    if (job.runId !== runId) return;
    if (mode === "totp_setup") restoreTotpSetupFailure(job, `无法启动 2FA 设置进程：${error.message}`);
    else failJob(job, `无法启动登录进程：${error.message}`);
  });
  child.on("close", (code, signal) => {
    void handleChildClose(job, { code, signal, mode, runId }).catch((error) => {
      handleChildCloseFailure(job, mode, runId, error);
    });
  });
}

async function handleChildClose(job, { code, signal, mode, runId }) {
  if (job.runId !== runId) return;
  stopMailPolling(job);
  job.child = null;
  if (mode === "totp_setup") {
    await finishTotpSetup(job, code, signal);
    scheduleQueuedJobs();
    return;
  }
  if (["canceled", "reauth_required"].includes(job.status)) {
    scheduleQueuedJobs();
    return;
  }
  if (code === 0 && job.resultSaved && (await fileExists(job.outputPath))) {
    job.status = "completed";
    job.prompt = "授权完成，可以下载导入文件";
    job.completedAt = new Date().toISOString();
    touch(job);
    await saveJobMetadata(job);
    scheduleQueuedJobs();
    return;
  }
  if (job.status !== "failed") {
    if (await fileExists(job.checkpointPath)) {
      markResumeAvailable(job, signal ? `登录进程被 ${signal} 终止` : "登录流程中断");
    } else {
      failJob(job, signal ? `登录进程被 ${signal} 终止` : `登录进程退出，代码 ${code ?? "未知"}`);
    }
  }
  scheduleQueuedJobs();
}

function handleChildCloseFailure(job, mode, runId, error) {
  if (job.runId !== runId && !(mode === "totp_setup" && job.runId === null)) return;
  const message = `收尾处理失败：${error.message}`;
  if (mode === "totp_setup") {
    job.status = "completed";
    job.prompt = "原授权文件仍然可用，2FA 密钥尚未完成安全保存";
    job.totpSetupError = `${message}；已保留 2FA 结果文件，请重试保存`;
    job.runMode = null;
    job.runId = null;
  } else {
    failJob(job, message);
  }
  touch(job);
  void saveJobMetadata(job).catch(() => {});
  scheduleQueuedJobs();
}

async function retryJob(job, options = {}) {
  if (!["failed", "canceled", "reauth_required", "resume_available"].includes(job.status)) {
    throw httpError(409, "当前任务不需要重新授权");
  }
  const retryingSecurityCheck = Boolean(job.securityCheckRequired);
  if (Object.hasOwn(options, "proxyUrl")) {
    job.proxyUrl = normalizeProxyUrl(options.proxyUrl);
    const persisted = await saveStoredLoginCredentials(job.email, job);
  }
  const resumingCheckpoint = job.status === "resume_available"
    || (retryingSecurityCheck && await fileExists(job.checkpointPath));
  stopMailPolling(job);
  if (resumingCheckpoint) stopSmsPolling(job);
  else releaseSmsNumber(job, "idle");
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  const startPrompt = retryingSecurityCheck && resumingCheckpoint
    ? "正在使用已有登录状态重试手机号绑定"
    : "正在重新建立登录会话";
  job.lastError = null;
  job.parserTail = "";
  job.completedAt = null;
  job.currentPhone = resumingCheckpoint ? (job.currentPhone || job.smsNumber) : null;
  job.phoneError = null;
  job.securityCheckRequired = false;
  job.restartRequired = false;
  job.attempt += 1;
  job.proxyRiskRetryCount = 0;
  job.proxyConnectionFailureCount = 0;
  job.proxyRiskRestarting = false;
  job.proxySessionAttemptIds.clear();
  job.proxyAttemptParserTail = "";
  job.mailCandidateCounts.clear();
  appendJobLog(
    job,
    retryingSecurityCheck
      ? `\n[retry] 开始第 ${job.attempt} 次手动重试；优先复用已有登录检查点。\n`
      : `\n[retry] 开始第 ${job.attempt} 次授权登录。\n`,
  );
  enqueueJob(job, "full", startPrompt);
}

async function regenerateJob(job, options = {}) {
  if (job.status !== "completed" || !job.resultSaved) {
    throw httpError(409, "只能为已经完成的任务重新生成授权");
  }
  if (Object.hasOwn(options, "proxyUrl")) {
    job.proxyUrl = normalizeProxyUrl(options.proxyUrl);
    await saveStoredLoginCredentials(job.email, job);
  }
  job.lastError = null;
  job.parserTail = "";
  job.currentPhone = null;
  job.phoneError = null;
  releaseSmsNumber(job, "idle");
  job.restartRequired = false;
  job.completedAt = null;
  job.attempt += 1;
  job.proxyRiskRetryCount = 0;
  job.proxyConnectionFailureCount = 0;
  job.proxyRiskRestarting = false;
  job.proxySessionAttemptIds.clear();
  job.proxyAttemptParserTail = "";
  appendJobLog(job, `\n[refresh] 第 ${job.attempt} 次生成：优先使用已有刷新令牌。\n`);
  enqueueJob(job, "refresh", "正在使用已有刷新令牌直接生成新授权");
}

async function forceReloginJob(job, options = {}) {
  if (!canForceRelogin(job)) {
    throw httpError(409, "当前任务正在进行中，不能重新登录");
  }
  await reloadMissingJobCredentials(job);
  if (Object.hasOwn(options, "proxyUrl")) {
    job.proxyUrl = normalizeProxyUrl(options.proxyUrl);
    await saveStoredLoginCredentials(job.email, job);
  }
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.queueRunId = null;
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  await Promise.all([
    removePrivateFile(job.checkpointPath),
    removePrivateFile(job.totpResultPath),
  ]);
  job.lastError = null;
  job.parserTail = "";
  job.completedAt = null;
  job.currentPhone = null;
  job.phoneError = null;
  job.securityCheckRequired = false;
  job.restartRequired = false;
  job.totpSetupSecret = null;
  job.totpSetupUri = null;
  job.totpSetupError = null;
  job.proxyRiskRetryCount = 0;
  job.proxyConnectionFailureCount = 0;
  job.proxyRiskRestarting = false;
  job.proxySessionAttemptIds.clear();
  job.proxyAttemptParserTail = "";
  job.mailCandidateCounts.clear();
  job.attempt += 1;
  appendJobLog(job, `\n[relogin] 第 ${job.attempt} 次授权：跳过刷新令牌并强制重新登录。\n`);
  if (job.hasTotpCredential && !job.totpSecret) {
    appendJobLog(job, "[mfa] 本地未能读取已记录的 2FA 密钥，遇到 2FA 时需要手动输入验证码。\n");
  }
  enqueueJob(job, "full", "正在强制重新登录并完成授权");
}

async function reloadMissingJobCredentials(job) {
  if (
    (job.password || !job.hasPasswordCredential)
    && (job.totpSecret || !job.hasTotpCredential)
    && job.proxyUrl
  ) return;
  const stored = await loadStoredLoginCredentials(job.email);
  job.password ||= stored.password;
  job.totpSecret ||= stored.totpSecret;
  job.proxyUrl ||= stored.proxyUrl;
  if (job.password) job.hasPasswordCredential = true;
  if (job.totpSecret) job.hasTotpCredential = true;
  if (stored.password || stored.totpSecret || stored.proxyUrl) {
    await saveStoredLoginCredentials(job.email, job);
  }
}

async function startTotpSetup(job, options = {}) {
  if (job.status !== "completed" || !job.resultSaved) {
    throw httpError(409, "只能为已经完成授权的账号设置 2FA");
  }
  if (job.totpSecret || job.hasTotpCredential) {
    throw httpError(409, "该账号已经保存了 2FA 密钥，无需重复设置");
  }
  if (job.totpKnownEnabled) {
    throw httpError(409, "该账号已经启用 2FA，但本地没有它的原始密钥，无法重复创建");
  }
  if (Object.hasOwn(options, "proxyUrl")) {
    job.proxyUrl = normalizeProxyUrl(options.proxyUrl);
    await saveStoredLoginCredentials(job.email, job);
  }
  await removePrivateFile(job.totpResultPath);
  job.totpSetupSecret = null;
  job.totpSetupUri = null;
  job.totpSetupError = null;
  job.totpSetupAttempt = (job.totpSetupAttempt || 0) + 1;
  job.proxyRiskRetryCount = 0;
  job.proxyConnectionFailureCount = 0;
  job.proxyRiskRestarting = false;
  job.proxySessionAttemptIds.clear();
  job.proxyAttemptParserTail = "";
  job.lastError = null;
  job.parserTail = "";
  appendJobLog(job, `\n[2fa] 开始第 ${job.totpSetupAttempt} 次 2FA 设置，原授权文件保持不变。\n`);
  enqueueJob(job, "totp_setup", "正在重新验证账号并准备设置 2FA");
}

async function loadTotpSetupResult(job) {
  const data = JSON.parse(await fs.readFile(job.totpResultPath, "utf8"));
  if (data?.version !== 1) throw new Error("2FA 设置结果文件格式不正确");
  if (data.already_enabled) {
    job.totpKnownEnabled = true;
    job.totpSetupSecret = null;
    job.totpSetupUri = null;
    return data;
  }
  const secret = normalizeTotpSecret(data.secret);
  const uri = String(data.otpauth_uri || "");
  if (!uri.startsWith("otpauth://totp/")) throw new Error("2FA 设置地址格式不正确");
  job.totpSetupSecret = secret;
  job.totpSetupUri = uri;
  if (data.activation_mode === "automatic") {
    if (job.status !== "totp_setup_otp") setStage(job, "working", "2FA 密钥已生成，正在自动激活");
  } else {
    setStage(job, "totp_setup_otp", "密钥已生成，请添加到验证器后输入当前 6 位验证码");
  }
  return data;
}

async function finishTotpSetup(job, code, signal) {
  let result = null;
  try {
    result = await loadTotpSetupResult(job);
  } catch (error) {
    if (error?.code !== "ENOENT" && !job.totpSetupError) job.totpSetupError = error.message;
  }

  const activationSucceeded = result?.activation_succeeded === true;
  let removeResult = false;
  if (code === 0 && result?.already_enabled) {
    job.totpKnownEnabled = true;
    job.prompt = "账号已经启用 2FA，但服务端不会返回原始密钥";
    job.totpSetupError = "如需自动登录，请重新导入这个账号原有的 2FA 密钥";
    removeResult = true;
  } else if ((code === 0 || activationSucceeded) && result?.secret) {
    const secret = normalizeTotpSecret(result.secret);
    job.totpSecret = secret;
    job.hasTotpCredential = true;
    job.totpKnownEnabled = true;
    const persisted = await saveStoredLoginCredentials(job.email, job);
    job.prompt = activationSucceeded && code !== 0
      ? "2FA 已激活并保存，但最终状态确认未完成"
      : "2FA 已设置并安全保存，可以继续下载或重新授权";
    job.totpSetupError = !persisted
      ? "当前系统不支持持久凭据存储，2FA 密钥已保留在私有结果文件中，请不要删除该任务目录"
      : activationSucceeded && code !== 0
      ? "激活接口已返回成功，但后续确认请求失败；密钥已保留"
      : null;
    appendJobLog(job, persisted
      ? "[2fa] 2FA 设置成功，密钥已写入系统凭据存储，未写入协议日志。\n"
      : "[2fa] 2FA 设置成功，但当前系统不支持持久凭据存储；密钥已保留在私有结果文件中。\n");
    removeResult = persisted;
  } else {
    job.prompt = "授权文件仍然可用，本次 2FA 设置未完成";
    job.totpSetupError ||= signal
      ? `2FA 设置进程被 ${signal} 终止`
      : `2FA 设置进程退出，代码 ${code ?? "未知"}`;
  }

  job.status = "completed";
  job.runMode = null;
  job.runId = null;
  job.totpSetupSecret = null;
  job.totpSetupUri = null;
  if (removeResult || !result?.secret || result?.activation_succeeded === false) {
    await removePrivateFile(job.totpResultPath);
  }
  touch(job);
  await saveJobMetadata(job);
}

async function removePrivateFile(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function restoreTotpSetupFailure(job, message) {
  job.status = "completed";
  job.prompt = "授权文件仍然可用，本次 2FA 设置未完成";
  job.totpSetupError = message;
  job.totpSetupSecret = null;
  job.totpSetupUri = null;
  job.runMode = null;
  job.child?.kill("SIGTERM");
  job.child = null;
  void removePrivateFile(job.totpResultPath).catch(() => {});
  touch(job);
  void saveJobMetadata(job).catch(() => {});
}

async function fallbackFromRefresh(job) {
  if (job.runMode !== "refresh" || job.fallbackInProgress) return;
  job.fallbackInProgress = true;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  job.status = "starting";
  job.prompt = "已有授权状态已过期，正在重新进行邮箱登录";
  job.lastError = null;
  job.parserTail = "";
  job.currentPhone = null;
  job.phoneError = null;
  appendJobLog(job, "[refresh] 刷新令牌已失效，自动回退到邮箱验证码登录。\n");
  if (job.mailApiUrl) await loadMailboxBaseline(job);
  job.fallbackInProgress = false;
  if (job.status !== "canceled") launchJob(job, { mode: "full" });
  touch(job);
}

function consumeOutput(job, rawText) {
  const proxyAttemptScan = `${job.proxyAttemptParserTail || ""}${rawText}`;
  job.proxyAttemptParserTail = proxyAttemptScan.slice(-160);
  let proxyAttemptNotices = "";
  for (const match of proxyAttemptScan.matchAll(/\[proxy-session-attempt\]\s+([a-f0-9-]{36})/gi)) {
    const attemptId = match[1].toLowerCase();
    if (job.proxySessionAttemptIds.has(attemptId)) continue;
    job.proxySessionAttemptIds.add(attemptId);
    job.proxyRiskRetryCount = Math.min(MAX_PROXY_RISK_RETRIES, (job.proxyRiskRetryCount || 0) + 1);
    job.proxyConnectionFailureCount = 0;
    proxyAttemptNotices += `[proxy] 正在检测第 ${job.proxyRiskRetryCount}/${MAX_PROXY_RISK_RETRIES} 个新代理会话。\n`;
    void saveJobMetadata(job).catch(() => {});
  }
  const text = `${proxyAttemptNotices}${sanitizeLog(rawText)}`
    .replace(/^\[proxy-session-attempt\][^\r\n]*(?:\r?\n)?/gim, "");
  job.logs = `${job.logs}${text}`.slice(-MAX_LOG_CHARS);
  const scan = `${job.parserTail}${text}`;
  job.parserTail = scan.slice(-2_000);

  if (scan.includes("[proxy-risk-retry]")) {
    void restartAfterProxyRisk(job, {
      connectionFailure: scan.includes("PROXY_CONNECTION_RETRY"),
    }).catch((error) => {
      finishProxyRiskRetries(job, `自动更换代理会话失败：${error.message}`);
    });
    return;
  }

  if (job.runMode === "refresh" && scan.includes("REFRESH_TOKEN_INVALID")) {
    void fallbackFromRefresh(job);
    return;
  }

  if (job.runMode === "totp_setup" && scan.includes("[2fa-setup-ready]") && !job.totpResultLoading && !job.totpSetupSecret) {
    job.totpResultLoading = true;
    setStage(job, "working", "2FA 密钥已经生成，正在安全读取");
    void loadTotpSetupResult(job)
      .catch((error) => {
        job.totpSetupError = `无法读取 2FA 密钥：${error.message}`;
        job.child?.kill("SIGTERM");
        touch(job);
      })
      .finally(() => {
        job.totpResultLoading = false;
      });
  }

  if (job.runMode === "totp_setup" && scan.includes("[2fa-already-enabled]")) {
    job.totpKnownEnabled = true;
    setStage(job, "working", "账号已经启用 2FA，正在收尾");
  }

  if (job.runMode === "totp_setup" && scan.includes("[ok] 2FA setup activated")) {
    setStage(job, "working", "2FA 已激活，正在安全保存密钥");
  }

  if (scan.includes("[security-check-required]")) {
    if (job.runMode === "totp_setup") {
      job.totpSetupError = "本次登录需要浏览器安全校验，2FA 尚未设置";
      touch(job);
      return;
    }
    requireBrowserSecurityCheck(job);
    return;
  }

  if (scan.includes("[profile-security-check-required]")) {
    if (job.runMode === "totp_setup") {
      job.totpSetupError = "账号资料校验未通过，2FA 尚未设置";
      touch(job);
      return;
    }
    requireProfileSecurityCheck(job);
    return;
  }

  if (scan.includes("ACCOUNT_PROFILE_REQUIRED")) {
    failAccountProfileRequired(job);
    return;
  }

  if (/Your sign-in session is no longer valid|["']code["']\s*:\s*["']invalid_state["']/i.test(scan)) {
    if (job.runMode === "totp_setup") {
      job.totpSetupError = "设置 2FA 时登录状态失效，请稍后重试";
      touch(job);
      return;
    }
    requireReauthorization(job, "当前登录状态已经失效，继续更换手机号也无法发送验证码");
    return;
  }

  if (scan.includes("[auth-expired]")) {
    stopSmsPolling(job);
    releaseSmsNumber(job, "idle");
    job.currentPhone = null;
    job.phoneError = null;
    setStage(job, "starting", "新登录状态被服务端拒绝，正在自动重新获取邮箱验证码");
  }

  if (scan.includes("Email OTP (r=resend, q=quit):")) {
    setStage(
      job,
      "email_otp",
      job.mailApiUrl ? "正在等待收码接口返回新验证码，也可以手动输入" : "请输入邮箱验证码",
    );
    if (job.mailApiUrl) void beginMailPolling(job);
  }
  if (scan.includes("Password (q=quit):")) {
    stopMailPolling(job);
    setStage(job, "password", "请输入账号密码");
  }
  if (scan.includes("2FA setup OTP (6 digits, q=quit):")) {
    setStage(job, "totp_setup_otp", "请将密钥添加到验证器后输入当前 6 位验证码");
  }
  const mfaReachedIndex = scan.lastIndexOf("[mfa] TOTP 2FA challenge reached.");
  const mfaPromptIndex = scan.lastIndexOf("2FA OTP (6 digits, q=quit):");
  if (mfaReachedIndex > mfaPromptIndex) {
    setStage(job, "working", job.totpSecret ? "正在自动完成 2FA 验证" : "正在准备 2FA 验证");
  } else if (mfaPromptIndex > mfaReachedIndex) {
    setStage(job, "mfa_otp", "请输入 6 位 2FA 验证码");
  }
  const phoneNumberPromptIndex = scan.lastIndexOf("Phone number, E.164 format");
  const phoneOtpPromptIndex = scan.lastIndexOf("Phone OTP (r=resend, p=change phone, q=quit):");
  if (phoneNumberPromptIndex > phoneOtpPromptIndex) {
    stopMailPolling(job);
    setStage(job, "phone", "请输入需要绑定的手机号");
  } else if (phoneOtpPromptIndex > phoneNumberPromptIndex) {
    if (job.smsStatus !== "error") job.phoneError = null;
    setStage(
      job,
      "phone_otp",
      job.currentPhone ? `短信验证码已发送至 ${job.currentPhone}` : "请输入手机短信验证码",
    );
    if (job.smsOrderId && job.smsNumber === job.currentPhone) void beginSmsPolling(job);
  }

  const sendFailures = [...scan.matchAll(/\[warn\] Could not send SMS to (\+\d+):\s*([^\r\n]+)/g)];
  if (sendFailures.length) {
    const latest = sendFailures.at(-1);
    job.currentPhone = latest[1];
    job.phoneError = friendlyPhoneError(latest[2]);
    if (job.smsOrderId && job.smsNumber === job.currentPhone) {
      releaseSmsNumber(job, "error", "该平台手机号无法接收验证码，请重新取号或手动输入其他手机号");
    }
    setStage(job, "phone", `手机号 ${job.currentPhone} 无法接收验证码，请更换手机号`);
  }

  const validationFailures = [...scan.matchAll(/\[warn\] Phone OTP validation failed:\s*([^\r\n]+)/g)];
  if (validationFailures.length) {
    const validationMessage = validationFailures.at(-1)[1];
    job.phoneError = friendlyPhoneOtpError(validationMessage);
    stopSmsPolling(job);
    if (job.smsStatus === "submitted") {
      job.smsStatus = "error";
      job.smsError = "平台返回的验证码未通过验证，请重新发送或更换手机号";
    }
    setStage(
      job,
      "phone_otp",
      job.currentPhone ? `请重新输入发送至 ${job.currentPhone} 的验证码` : "请重新输入手机验证码",
    );
    if (shouldChangePhoneAfterOtpFailure(validationMessage)) {
      job.smsError = job.phoneError;
      appendJobLog(job, "[sms] 当前手机号已被服务端拒绝，停止提交旧验证码并自动返回换号步骤。\n");
      void submitJobInput(job, { action: "change_phone", value: "" }, {
        preservePhoneError: true,
      }).catch((error) => {
        failJob(job, `无法自动返回换号步骤：${error.message}`);
      });
      touch(job);
      return;
    }
  }
  if (scan.includes("[ok] Phone OTP validated")) {
    completeSmsNumber(job);
  }
  if (scan.includes("[5/5] Select workspace") || scan.includes("[6/6] Convert OAuth callback")) {
    setStage(job, "finalizing", "正在完成授权并生成文件");
  }
  if (scan.includes("[4/5] Existing workspace/session selected")) {
    setStage(job, "finalizing", "账号已绑定手机号，正在继续授权");
  }
  if (scan.includes("[ok] Saved sub2api import:")) {
    job.resultSaved = true;
    setStage(job, "finalizing", "导入文件已生成，正在收尾");
  }

  const errorMatches = [...scan.matchAll(/\[error\]\s*([^\r\n]+)/g)];
  if (errorMatches.length) {
    if (job.runMode === "totp_setup") {
      job.totpSetupError = extractResponseMessage(errorMatches.at(-1)[1]);
    } else {
      failJob(job, extractResponseMessage(errorMatches.at(-1)[1]));
    }
  }
  touch(job);
}

async function restartAfterProxyRisk(job, options = {}) {
  if (job.proxyRiskRestarting || isTerminalStatus(job.status)) return;
  job.proxyRiskRestarting = true;
  const mode = job.runMode || job.queuedMode || "full";
  try {
    if (!job.proxyUrl || !proxySupportsSessionRotation(job.proxyUrl)) {
      finishProxyRiskRetries(
        job,
        job.proxyUrl
          ? "当前代理没有可识别的会话编号，无法自动轮换；请更换代理配置后重试"
          : "当前使用本地 IP，无法自动更换出口；请配置可轮换代理后重试",
      );
      return;
    }
    if ((job.proxyRiskRetryCount || 0) >= MAX_PROXY_RISK_RETRIES) {
      finishProxyRiskRetries(job, `代理会话已自动更换 ${MAX_PROXY_RISK_RETRIES} 次，仍然触发安全校验`);
      return;
    }
    if (options.connectionFailure) {
      job.proxyConnectionFailureCount = (job.proxyConnectionFailureCount || 0) + 1;
      if (job.proxyConnectionFailureCount >= MAX_PROXY_CONNECTION_FAILURES) {
        finishProxyRiskRetries(
          job,
          `代理连接连续失败 ${MAX_PROXY_CONNECTION_FAILURES} 次，已停止自动重试`,
        );
        return;
      }
    }

    stopMailPolling(job);
    stopSmsPolling(job);
    releaseSmsNumber(job, "idle");
    job.queueRunId = null;
    job.runId = crypto.randomUUID();
    const restartRunId = job.runId;
    job.child?.kill("SIGTERM");
    job.child = null;
    if (mode === "full") await removePrivateFile(job.checkpointPath);
    job.parserTail = "";
    job.lastError = null;
    job.currentPhone = null;
    job.phoneError = null;
    job.securityCheckRequired = false;
    job.restartRequired = false;
    appendJobLog(
      job,
      options.connectionFailure
        ? `[proxy] 代理连接失败，HTTP 检测次数仍为 ${job.proxyRiskRetryCount}/${MAX_PROXY_RISK_RETRIES}；连接失败 ${job.proxyConnectionFailureCount}/${MAX_PROXY_CONNECTION_FAILURES}。\n`
        : `[proxy] 登录阶段触发安全校验，已使用 ${job.proxyRiskRetryCount}/${MAX_PROXY_RISK_RETRIES} 个代理会话，正在继续更换。\n`,
    );
    if (options.connectionFailure) {
      const retryDelay = Math.min(
        PROXY_CONNECTION_RETRY_MAX_MS,
        PROXY_CONNECTION_RETRY_BASE_MS * (2 ** Math.min(job.proxyConnectionFailureCount - 1, 4)),
      );
      job.status = "starting";
      job.prompt = `代理连接失败，${Math.ceil(retryDelay / 1_000)} 秒后更换会话`;
      touch(job);
      await saveJobMetadata(job);
      await delay(retryDelay);
      if (job.runId !== restartRunId || isTerminalStatus(job.status)) return;
    }
    job.proxyRiskRestarting = false;
    enqueueJob(
      job,
      mode,
      options.connectionFailure
        ? `代理连接失败，正在更换会话；HTTP 检测次数仍为 ${job.proxyRiskRetryCount}/${MAX_PROXY_RISK_RETRIES}`
        : `代理触发安全校验，已使用 ${job.proxyRiskRetryCount}/${MAX_PROXY_RISK_RETRIES} 个代理会话`,
    );
  } finally {
    job.proxyRiskRestarting = false;
  }
}

function finishProxyRiskRetries(job, message) {
  job.proxyRiskRestarting = false;
  if (job.runMode === "totp_setup" || job.queuedMode === "totp_setup") {
    restoreTotpSetupFailure(job, message);
    return;
  }
  if (job.resultSaved) {
    job.status = "completed";
    job.prompt = "原授权文件仍然可用，自动更换代理未能完成本次操作";
    job.lastError = message;
    job.runMode = null;
    job.child?.kill("SIGTERM");
    job.child = null;
    touch(job);
    void saveJobMetadata(job).catch(() => {});
    scheduleQueuedJobs();
    return;
  }
  failJob(job, message);
  job.child?.kill("SIGTERM");
  job.child = null;
  scheduleQueuedJobs();
}

function requireReauthorization(job, message) {
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "reauth_required";
  job.prompt = "登录状态已失效，需要重新授权";
  job.lastError = message;
  job.phoneError = null;
  job.restartRequired = true;
  job.child?.kill("SIGTERM");
  touch(job);
}

function requireBrowserSecurityCheck(job) {
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "failed";
  job.prompt = "手机号绑定需要浏览器安全校验";
  job.lastError = "邮箱登录已经成功，但服务端拒绝了本次纯协议短信请求；可以手动重试，若仍被拒绝则需要稍后再试";
  job.phoneError = null;
  job.securityCheckRequired = true;
  job.child?.kill("SIGTERM");
  touch(job);
}

function requireProfileSecurityCheck(job) {
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "failed";
  job.prompt = "账号资料创建需要安全校验";
  job.lastError = "邮箱验证码已经通过，但账号资料创建仍被 Sentinel 安全校验拒绝；可以点击重新授权再次生成动态校验令牌";
  job.phoneError = null;
  job.securityCheckRequired = true;
  job.child?.kill("SIGTERM");
  touch(job);
  void saveJobMetadata(job).catch(() => {});
}

function failAccountProfileRequired(job) {
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "failed";
  job.prompt = "账号注册资料未完成";
  job.lastError = "邮箱验证已经成功，但该邮箱还没有完成账号资料填写。请先在官方页面完成姓名和出生日期后再重新授权。";
  job.phoneError = null;
  job.child?.kill("SIGTERM");
  touch(job);
  void saveJobMetadata(job).catch(() => {});
}

function markResumeAvailable(job, reason = "登录流程中断") {
  stopMailPolling(job);
  stopSmsPolling(job);
  job.status = "resume_available";
  job.prompt = "邮箱登录检查点仍然有效，可以继续手机号绑定";
  job.lastError = `${reason}，继续时会优先恢复已保存状态；状态失效才重新获取邮箱验证码`;
  job.child = null;
  job.currentPhone = null;
  touch(job);
}

function friendlyPhoneError(message) {
  const text = String(message || "");
  if (/suspicious behavior/i.test(text)) return "该手机号触发了风控，请更换手机号或稍后重试";
  if (/too many|rate.?limit|HTTP 429/i.test(text)) return "短信发送过于频繁，请稍后重试或更换手机号";
  if (/already|used|unsupported|invalid phone/i.test(text)) return "该手机号不可用或已被使用，请更换手机号";
  return "短信验证码发送失败，请更换手机号后重试";
}

function extractResponseMessage(value) {
  const text = String(value || "").trim();
  const jsonAt = text.indexOf("{");
  if (jsonAt >= 0) {
    try {
      const payload = JSON.parse(text.slice(jsonAt));
      const message = payload?.error?.message || payload?.message;
      if (typeof message === "string" && message.trim()) return message.trim();
    } catch {}
  }
  const match = text.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/i);
  if (match) {
    try {
      return JSON.parse(`"${match[1]}"`).trim();
    } catch {
      return match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").trim();
    }
  }
  return text;
}

function friendlyPhoneOtpError(message) {
  const text = String(message || "");
  if (/phone_recently_used|phone number was recently used/i.test(text)) {
    return "该手机号近期已被使用，已停止重复提交，请更换手机号";
  }
  if (/phone_number_in_use|phone number already in use/i.test(text)) {
    return "该手机号已绑定其他账号，请更换手机号";
  }
  if (/expired/i.test(text)) return "手机验证码已过期，请重新发送或更换手机号";
  if (/too many|rate.?limit|HTTP 429/i.test(text)) {
    return "验证次数过多，已停止自动提交，请稍后更换手机号";
  }
  return "手机验证码不正确，请重新输入；也可以重新发送或更换手机号";
}

function shouldChangePhoneAfterOtpFailure(message) {
  return /phone_recently_used|phone number was recently used|phone_number_in_use|phone number already in use|too many|rate.?limit|HTTP 429/i
    .test(String(message || ""));
}

function acquireCustomSmsEntry(entries) {
  const poolKey = crypto.createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("base64url");
  const nextIndex = customSmsPoolPositions.get(poolKey) || 0;
  if (nextIndex >= entries.length) return null;
  customSmsPoolPositions.set(poolKey, nextIndex + 1);
  return entries[nextIndex];
}

async function acquireSmsNumber(job, providerId, config) {
  requireStage(job, "phone");
  if (job.smsStatus === "requesting") throw httpError(409, "正在获取手机号，请不要重复提交");

  let smsClient;
  try {
    smsClient = createSmsProvider(providerId, config, {
      lubanApiBase: process.env.LUBAN_SMS_API_BASE,
      smsBowerApiBase: process.env.SMSBOWER_API_BASE,
      acquireCustomSmsEntry,
    });
  } catch (error) {
    throw httpError(400, safeSmsProviderError(error, config?.apiKey));
  }

  releaseSmsNumber(job, "idle");
  job.smsClient = smsClient;
  job.smsProviderId = smsClient.id;
  job.smsProviderName = smsClient.name;
  job.smsServiceLabel = smsClient.serviceLabel;
  job.smsStatus = "requesting";
  job.smsError = null;
  touch(job);

  let order;
  try {
    order = await smsClient.getNumber();
    if (job.status !== "phone" || !job.child) {
      void smsClient.release(order.requestId).catch(() => {});
      throw httpError(409, "任务已经不在手机号输入步骤，平台号码已释放");
    }
    job.smsOrderId = order.requestId;
    job.smsNumber = order.number;
    job.smsStatus = "number_acquired";
    job.smsError = null;
    await saveJobMetadata(job);
    appendJobLog(job, `[sms] 已从 ${smsClient.name} 获取手机号并提交，等待短信发送结果。\n`);
    await submitJobInput(job, { action: "phone", value: order.number }, { source: "sms-provider" });
  } catch (error) {
    if (order?.requestId && job.smsOrderId === order.requestId) releaseSmsNumber(job, "error");
    if (job.status === "phone") {
      job.smsStatus = "error";
      job.smsError = safeSmsProviderError(error, smsClient.apiKey);
      if (!order) job.smsClient = null;
      touch(job);
    }
    if (error?.status) throw error;
    throw httpError(502, safeSmsProviderError(error, smsClient.apiKey));
  }
}

async function beginSmsPolling(job) {
  if (
    !job.smsClient
    || !job.smsOrderId
    || job.smsPollToken
    || job.status !== "phone_otp"
    || !["number_acquired", "waiting_sms"].includes(job.smsStatus)
  ) return;
  const pollToken = crypto.randomUUID();
  const requestId = job.smsOrderId;
  const smsClient = job.smsClient;
  const startedAt = Date.now();
  job.smsPollToken = pollToken;
  job.smsStatus = "waiting_sms";
  job.smsError = null;
  touch(job);

  try {
    if (smsClient.markReady) {
      await smsClient.markReady(requestId).catch((error) => {
        appendJobLog(job, `[sms] ${smsClient.name} 更新号码就绪状态失败：${safeSmsProviderError(error)}\n`);
      });
    }
    while (
      job.smsPollToken === pollToken &&
      job.smsOrderId === requestId &&
      job.status === "phone_otp" &&
      job.child &&
      Date.now() - startedAt < SMS_POLL_TIMEOUT_MS
    ) {
      try {
        const result = await smsClient.getSms(requestId);
        if (job.smsPollToken !== pollToken || job.status !== "phone_otp" || !job.child) return;
        if (result.status === "received") {
          if (job.smsLastSubmittedCode === result.code) {
            job.smsStatus = "error";
            job.smsError = "接码平台仍返回已提交过的验证码，已停止重复提交";
            appendJobLog(job, `[sms] ${smsClient.name} 返回了已提交过的验证码，已停止本次自动轮询。\n`);
            touch(job);
            return;
          }
          job.smsLastSubmittedCode = result.code;
          job.smsStatus = "submitting";
          job.smsError = null;
          appendJobLog(job, `[sms] 已从 ${smsClient.name} 获取短信验证码并自动提交。\n`);
          await submitJobInput(job, { action: "phone_otp", value: result.code }, { source: "sms-provider" });
          return;
        }
        job.smsStatus = "waiting_sms";
        job.smsError = null;
      } catch (error) {
        if (job.smsPollToken !== pollToken) return;
        if (error?.terminal) {
          job.smsStatus = "error";
          job.smsError = `${safeSmsProviderError(error)}，可以手动输入验证码或更换手机号`;
          touch(job);
          return;
        }
        job.smsStatus = "waiting_sms";
        job.smsError = `${safeSmsProviderError(error)}，正在自动重试`;
        touch(job);
      }
      await delay(SMS_POLL_INTERVAL_MS);
    }

    if (job.smsPollToken === pollToken && job.status === "phone_otp") {
      job.smsStatus = "error";
      job.smsError = "等待平台短信超时，可以手动输入验证码或更换手机号";
      touch(job);
    }
  } finally {
    if (job.smsPollToken === pollToken) {
      job.smsPollToken = null;
      touch(job);
    }
  }
}

function stopSmsPolling(job) {
  job.smsPollToken = null;
}

function releaseSmsNumber(job, nextStatus = "idle", errorMessage = null) {
  const requestId = job.smsOrderId;
  const smsClient = job.smsClient;
  const providerName = job.smsProviderName || smsClient?.name || "接码平台";
  stopSmsPolling(job);
  job.smsOrderId = null;
  job.smsNumber = null;
  job.smsClient = null;
  job.smsLastSubmittedCode = null;
  job.smsStatus = nextStatus;
  job.smsError = errorMessage;
  if (nextStatus === "idle") {
    job.smsProviderId = null;
    job.smsProviderName = null;
    job.smsServiceLabel = null;
  }
  if (requestId && smsClient) {
    void smsClient.release(requestId).catch(() => {
      appendJobLog(job, `[sms] ${providerName} 号码释放请求失败，请在平台控制台检查订单。\n`);
    });
  }
  if (job.outputPath) void saveJobMetadata(job).catch(() => {});
}

function completeSmsNumber(job) {
  const requestId = job.smsOrderId;
  const smsClient = job.smsClient;
  if (!requestId || !smsClient) return;
  stopSmsPolling(job);
  job.smsOrderId = null;
  job.smsClient = null;
  job.smsLastSubmittedCode = null;
  job.smsStatus = "completed";
  job.smsError = null;
  appendJobLog(job, `[sms] 手机验证码已通过，正在完成 ${smsClient.name} 订单。\n`);
  if (smsClient.complete) {
    void smsClient.complete(requestId).catch((error) => {
      appendJobLog(job, `[sms] ${smsClient.name} 完成订单失败：${safeSmsProviderError(error)}\n`);
      touch(job);
    });
  }
  touch(job);
  if (job.outputPath) void saveJobMetadata(job).catch(() => {});
}

function newSmsState() {
  return {
    smsProviderId: null,
    smsProviderName: null,
    smsServiceLabel: null,
    smsOrderId: null,
    smsNumber: null,
    smsClient: null,
    smsStatus: "idle",
    smsError: null,
    smsPollToken: null,
    smsLastSubmittedCode: null,
  };
}

function restoredSmsState(metadata = {}) {
  const orderId = metadata.sms_order_id || metadata.luban_request_id;
  const number = metadata.sms_number || metadata.luban_number;
  if (!orderId || !number) return newSmsState();
  return {
    smsProviderId: metadata.sms_provider_id || "luban",
    smsProviderName: metadata.sms_provider_name || (metadata.sms_provider_id === "smsbower" ? "SMSBower" : "LubanSMS"),
    smsServiceLabel: metadata.sms_service_label || metadata.luban_service_id || null,
    smsOrderId: String(orderId),
    smsNumber: String(number),
    smsClient: null,
    smsStatus: "error",
    smsError: "服务重启后已停止自动收短信，可手动输入验证码或换号",
    smsPollToken: null,
    smsLastSubmittedCode: null,
  };
}

function safeSmsProviderError(error, apiKey = "") {
  let message = String(error?.message || "接码平台请求失败");
  if (apiKey) message = message.replaceAll(apiKey, "<已隐藏密钥>");
  return message
    .replace(/apikey=[^&\s]+/gi, "apikey=<已隐藏>")
    .replace(/api_key=[^&\s]+/gi, "api_key=<已隐藏>")
    .replace(/https?:\/\/\S+/gi, "<已隐藏接口地址>")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 220);
}

async function submitJobInput(job, body, options = {}) {
  if (!job.child || !isActive(job.status)) {
    throw httpError(409, "This login flow is not waiting for input");
  }
  const action = String(body.action || "");
  const rawValue = String(body.value || "");
  const value = rawValue.trim();
  let inputValue = "";

  if (action === "password") {
    requireStage(job, "password");
    if (!rawValue) throw httpError(400, "密码不能为空");
    await saveStoredLoginCredentials(job.email, {
      password: rawValue,
      totpSecret: job.totpSecret,
      proxyUrl: job.proxyUrl,
    });
    job.loginMode = "password";
    job.password = rawValue;
    job.hasPasswordCredential = true;
    await saveJobMetadata(job);
    inputValue = rawValue;
    setStage(job, "working", "正在验证账号密码");
  } else if (action === "mfa_otp") {
    requireStage(job, "mfa_otp");
    if (!/^\d{6}$/.test(value)) throw httpError(400, "2FA 验证码必须是 6 位数字");
    inputValue = value;
    setStage(job, "working", "正在验证 2FA 验证码");
  } else if (action === "totp_setup_otp") {
    requireStage(job, "totp_setup_otp");
    if (!/^\d{6}$/.test(value)) throw httpError(400, "设置 2FA 的验证码必须是 6 位数字");
    inputValue = value;
    setStage(job, "working", "正在激活新的 2FA");
  } else if (action === "email_otp") {
    requireStage(job, "email_otp");
    if (!/^\d{6}$/.test(value)) throw httpError(400, "Email code must be 6 digits");
    stopMailPolling(job);
    inputValue = value;
    setStage(job, "working", "正在验证邮箱验证码");
  } else if (action === "resend_email") {
    requireStage(job, "email_otp");
    stopMailPolling(job);
    inputValue = "r";
    setStage(job, "working", "正在重新发送邮箱验证码");
  } else if (action === "phone") {
    requireStage(job, "phone");
    if (!/^\+[1-9]\d{6,14}$/.test(value)) throw httpError(400, "Phone number must use E.164 format, for example +60123456789");
    if (options.source !== "sms-provider") releaseSmsNumber(job, "idle");
    job.currentPhone = value;
    job.phoneError = null;
    inputValue = value;
    setStage(job, "working", `正在向 ${value} 发送手机验证码`);
  } else if (action === "phone_otp") {
    requireStage(job, "phone_otp");
    if (!/^\d{4,8}$/.test(value)) throw httpError(400, "Phone code must be 4 to 8 digits");
    stopSmsPolling(job);
    if (job.smsOrderId) job.smsStatus = options.source === "sms-provider" ? "submitted" : "manual_submitted";
    job.phoneError = null;
    inputValue = value;
    setStage(job, "working", "正在验证手机验证码");
  } else if (action === "resend_phone") {
    requireStage(job, "phone_otp");
    stopSmsPolling(job);
    if (job.smsOrderId) job.smsStatus = "number_acquired";
    job.phoneError = null;
    inputValue = "r";
    setStage(job, "working", job.currentPhone ? `正在向 ${job.currentPhone} 重新发送验证码` : "正在重新发送手机验证码");
  } else if (action === "change_phone") {
    requireStage(job, "phone_otp");
    const preservedPhoneError = options.preservePhoneError ? job.phoneError : null;
    releaseSmsNumber(
      job,
      options.preservePhoneError ? "error" : "idle",
      options.preservePhoneError ? preservedPhoneError : null,
    );
    job.currentPhone = null;
    job.phoneError = preservedPhoneError;
    inputValue = "p";
    setStage(
      job,
      "working",
      options.preservePhoneError ? "当前手机号不可用，正在返回换号步骤" : "正在返回手机号输入",
    );
  } else {
    throw httpError(400, "Unsupported input action");
  }

  job.parserTail = "";
  job.child.stdin.write(`${inputValue}\n`);
  touch(job);
}

async function cancelJob(job) {
  if (!isActive(job.status)) return;
  if (job.runMode === "totp_setup" || job.queuedMode === "totp_setup") {
    stopMailPolling(job);
    job.runId = crypto.randomUUID();
    job.child?.kill("SIGTERM");
    job.child = null;
    await finishTotpSetup(job, 1, "SIGTERM");
    if (!job.totpKnownEnabled) {
      job.prompt = "授权文件仍然可用，2FA 设置已取消";
      job.totpSetupError = "用户取消了本次 2FA 设置";
      touch(job);
      await saveJobMetadata(job);
    }
    scheduleQueuedJobs();
    return;
  }
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "canceled";
  job.prompt = "流程已取消";
  job.child?.kill("SIGTERM");
  job.child = null;
  touch(job);
  void saveJobMetadata(job).catch(() => {});
  scheduleQueuedJobs();
}

async function cancelAllJobs() {
  const activeJobs = [...jobs.values()].filter((job) => isActive(job.status));
  if (!activeJobs.length) return 0;
  queueSchedulingPaused = true;
  try {
    await Promise.all(activeJobs.map((job) => cancelJob(job)));
    await Promise.all(activeJobs.map((job) => saveJobMetadata(job)));
  } finally {
    queueSchedulingPaused = false;
  }
  scheduleQueuedJobs();
  return activeJobs.length;
}

async function downloadResult(res, job) {
  if (!job.resultSaved || !(await fileExists(job.outputPath))) {
    sendJson(res, 409, { error: "The sub2api import file is not ready" });
    return;
  }
  const safeEmail = job.email.replace(/[^a-zA-Z0-9@._+-]/g, "_");
  const data = await fs.readFile(job.outputPath);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="${safeEmail}-sub2api-import-oauth-${downloadTimestamp()}.json"`,
    "content-length": data.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(data);
}

async function downloadBatchResult(res, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw httpError(400, "请至少选择一个已完成任务");
  }
  const uniqueIds = [...new Set(ids.map((id) => String(id)))];
  if (uniqueIds.length > MAX_BATCH_JOBS) throw httpError(400, `一次最多下载 ${MAX_BATCH_JOBS} 个账号`);

  const selected = uniqueIds.map((id) => jobs.get(id));
  if (selected.some((job) => !job)) throw httpError(404, "部分任务不存在，请刷新页面后重试");
  const downloadable = selected.filter((job) => job.resultSaved);
  if (downloadable.length === 0) throw httpError(409, "选中的任务里没有已完成的导入文件");

  const accounts = [];
  const proxies = [];
  for (const job of downloadable) {
    if (!(await fileExists(job.outputPath))) throw httpError(409, `${job.email} 的导入文件不存在`);
    const data = JSON.parse(await fs.readFile(job.outputPath, "utf8"));
    if (data.type !== "sub2api-data" || !Array.isArray(data.accounts)) {
      throw httpError(409, `${job.email} 的导入文件格式不正确`);
    }
    accounts.push(...data.accounts);
    if (Array.isArray(data.proxies)) proxies.push(...data.proxies);
  }

  const payload = Buffer.from(`${JSON.stringify({
    type: "sub2api-data",
    version: 1,
    exported_at: new Date().toISOString(),
    proxies: uniqueByJson(proxies),
    accounts,
  }, null, 2)}\n`);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="sub2api-import-oauth-${accounts.length}-accounts-${downloadTimestamp()}.json"`,
    "content-length": payload.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

async function buildSub2ApiUploadPayload(downloadable) {
  const accounts = [];
  const proxies = [];
  for (const job of downloadable) {
    if (!(await fileExists(job.outputPath))) throw httpError(409, `${job.email} 的导入文件不存在`);
    const data = JSON.parse(await fs.readFile(job.outputPath, "utf8"));
    if (data.type !== "sub2api-data" || !Array.isArray(data.accounts)) {
      throw httpError(409, `${job.email} 的导入文件格式不正确`);
    }
    accounts.push(...data.accounts);
    if (Array.isArray(data.proxies)) proxies.push(...data.proxies);
  }
  return {
    type: "sub2api-data",
    version: 1,
    exported_at: new Date().toISOString(),
    proxies: uniqueByJson(proxies),
    accounts,
  };
}

function normalizeSub2ApiConfig(value) {
  const config = value && typeof value === "object" ? value : {};
  const baseUrl = String(config.baseUrl || "").trim().replace(/\/+$/, "");
  const adminApiKey = String(config.adminApiKey || "").trim();
  if (!baseUrl) throw httpError(400, "请填写 Sub2API 后端地址");
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw httpError(400, "Sub2API 后端地址格式不正确");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw httpError(400, "Sub2API 后端地址必须使用 HTTP 或 HTTPS");
  }
  if (!adminApiKey || adminApiKey.length > 512 || /[\r\n]/.test(adminApiKey)) {
    throw httpError(400, "请填写有效的 Sub2API 管理员 API Key");
  }
  const rawGroupIds = Array.isArray(config.groupIds)
    ? config.groupIds
    : String(config.groupId || "").trim() ? [config.groupId] : [];
  const groupIds = [...new Set(rawGroupIds.map((value) => String(value).trim()).filter(Boolean))].map((value) => {
    if (!/^\d+$/.test(value) || Number(value) <= 0 || Number(value) > Number.MAX_SAFE_INTEGER) {
      throw httpError(400, "目标号池 ID 无效");
    }
    return Number(value);
  });
  const proxyText = String(config.proxyId || "").trim();
  if (proxyText && (!/^\d+$/.test(proxyText) || Number(proxyText) <= 0 || Number(proxyText) > Number.MAX_SAFE_INTEGER)) {
    throw httpError(400, "代理 ID 无效");
  }
  const proxyId = proxyText ? Number(proxyText) : 0;
  const concurrency = parseOptionalSub2ApiInteger(config.concurrency, "并发数", 0, 10000);
  const loadFactor = parseOptionalSub2ApiInteger(config.loadFactor, "负载因子", 0, 10000);
  const priority = parseOptionalSub2ApiInteger(config.priority, "优先级", 0, 10000);
  const modelWhitelist = parseSub2ApiModelWhitelist(config.modelWhitelist);
  return { baseUrl, adminApiKey, groupIds, proxyId, concurrency, loadFactor, priority, modelWhitelist };
}

function parseOptionalSub2ApiInteger(value, label, min, max) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) throw httpError(400, `${label}必须是数字`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw httpError(400, `${label}范围必须是 ${min} 到 ${max}`);
  return parsed;
}

function parseSub2ApiModelWhitelist(value) {
  const models = String(value || "")
    .split(/[\r\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (models.length > 200) throw httpError(400, "支持模型最多填写 200 个");
  if (models.some((model) => model.length > 200 || /[\r\n]/.test(model))) throw httpError(400, "支持模型名称格式不正确");
  return [...new Set(models)];
}

async function requestSub2Api(config, endpoint, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(`${config.baseUrl}${endpoint}`, {
      ...options,
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": config.adminApiKey,
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const message = sub2ApiResponseMessage(payload, text).slice(0, 500);
      throw httpError(502, `Sub2API 返回 HTTP ${response.status}${message ? `：${message}` : ""}`);
    }
    return payload;
  } catch (error) {
    if (error?.status) throw error;
    if (error?.name === "AbortError") throw httpError(504, "Sub2API 请求超时");
    throw httpError(502, `无法连接 Sub2API 后端：${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function sub2ApiResponseMessage(payload, text) {
  const message = payload?.error?.message || payload?.message || payload?.error || "";
  return typeof message === "string" && message.trim()
    ? message.trim()
    : extractResponseMessage(text);
}

async function exportSourceAccounts(res, ids) {
  const selected = resolveSelectedJobs(ids);
  const lines = [];
  for (const job of selected) {
    let password = job.password || "";
    let totpSecret = job.totpSecret || "";
    if ((!password && job.hasPasswordCredential) || (!totpSecret && job.hasTotpCredential)) {
      const storedCredentials = await loadStoredLoginCredentials(job.email);
      password ||= storedCredentials.password;
      totpSecret ||= storedCredentials.totpSecret;
    }
    if ((job.loginMode === "password" || job.hasPasswordCredential) && !password) {
      throw httpError(409, `${job.email} 的密码未能从系统安全凭据存储读取，请重新导入该账号资料`);
    }
    if (job.hasTotpCredential && !totpSecret) {
      throw httpError(409, `${job.email} 的 2FA 密钥未能从系统安全凭据存储读取，请重新导入该账号资料`);
    }
    if (password) {
      const parts = [job.email, password];
      if (job.mailApiUrl) parts.push(job.mailApiUrl);
      if (totpSecret) parts.push(totpSecret);
      lines.push(parts.join("----"));
      continue;
    }
    if (job.mailApiUrl) {
      lines.push(totpSecret
        ? `${job.email}----${job.mailApiUrl}----${totpSecret}`
        : `${job.email}----${job.mailApiUrl}`);
      continue;
    }
    if (job.loginMode === "manual") {
      throw httpError(409, `${job.email} 是旧版本任务，原始登录资料未保存，请重新导入该账号资料后再导出`);
    }
    lines.push(totpSecret ? `${job.email}--------${totpSecret}` : job.email);
  }
  const payload = Buffer.from(`\uFEFF${lines.join("\n")}\n`, "utf8");
  res.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "content-disposition": `attachment; filename="chatgpt-account-source-${lines.length}-accounts-${downloadTimestamp()}.txt"`,
    "content-length": payload.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

function publicJob(job) {
  return {
    id: job.id,
    email: job.email,
    status: job.status,
    prompt: job.status === "queued"
      ? `排队中，前方还有 ${Math.max(0, getQueuePosition(job) - 1)} 条任务`
      : job.prompt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    lastError: job.lastError,
    canDownload: Boolean(job.resultSaved),
    loginMode: job.loginMode || (job.mailApiUrl ? "email_otp" : "manual"),
    hasTotpKey: Boolean(job.totpSecret || job.hasTotpCredential),
    autoEmailOtp: Boolean(job.mailApiUrl),
    mailStatus: job.mailStatus,
    mailApiError: job.mailApiError,
    currentPhone: job.currentPhone,
    phoneError: job.phoneError,
    totpSetupSecret: job.status === "totp_setup_otp" ? job.totpSetupSecret : null,
    totpSetupUri: job.status === "totp_setup_otp" ? job.totpSetupUri : null,
    totpSetupError: job.totpSetupError || null,
    smsProviderId: job.smsProviderId,
    smsProviderName: job.smsProviderName,
    smsServiceLabel: job.smsServiceLabel,
    smsStatus: job.smsStatus,
    smsError: job.smsError,
    securityCheckRequired: Boolean(job.securityCheckRequired),
    canRetry: ["failed", "canceled", "reauth_required", "resume_available"].includes(job.status),
    canResume: job.status === "resume_available",
    canRegenerate: job.status === "completed" && job.resultSaved,
    canForceRelogin: canForceRelogin(job),
    canSetupTotp: canSetupTotp(job),
    restartRequired: job.restartRequired,
    proxyConfigured: Boolean(job.proxyUrl),
    attempt: job.attempt,
    queuePosition: job.status === "queued" ? getQueuePosition(job) : 0,
  };
}

function publicSelectionJob(job) {
  return {
    id: job.id,
    email: job.email,
    status: job.status,
    canDownload: Boolean(job.resultSaved),
    canRetry: ["failed", "canceled", "reauth_required", "resume_available"].includes(job.status),
    canRegenerate: job.status === "completed" && job.resultSaved,
    canForceRelogin: canForceRelogin(job),
    canSetupTotp: canSetupTotp(job),
  };
}

function canForceRelogin(job) {
  return ["completed", "failed", "canceled", "reauth_required", "resume_available"].includes(job.status);
}

function canSetupTotp(job) {
  return job.status === "completed"
    && job.resultSaved
    && !job.totpSecret
    && !job.hasTotpCredential
    && !job.totpKnownEnabled;
}

function setStage(job, status, prompt) {
  if (isTerminalStatus(job.status)) return;
  job.status = status;
  job.prompt = prompt;
  job.lastError = null;
  touch(job);
}

function failJob(job, message) {
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "failed";
  job.prompt = "流程失败";
  job.lastError = message;
  touch(job);
  void saveJobMetadata(job).catch(() => {});
}

function requireStage(job, expected) {
  if (job.status !== expected) {
    throw httpError(409, `The flow is currently at ${job.status}, not ${expected}`);
  }
}

function touch(job) {
  job.updatedAt = new Date().toISOString();
}

function sanitizeLog(text) {
  return String(text)
    .replace(/([?&](?:code|token|state|csrf|nonce|otp|login_hint|code_challenge)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/(access_token|refresh_token|id_token|password|totp_secret|2fa_key)\s*[=:]\s*[^\s,}]+/gi, "$1=<redacted>");
}

function isActive(status) {
  return !isTerminalStatus(status);
}

function occupiesActiveSlot(job) {
  return isActive(job.status) && job.status !== "queued";
}

function getQueuePosition(job) {
  if (job.status !== "queued") return 0;
  return [...jobs.values()]
    .filter((item) => item.status === "queued")
    .sort((a, b) => String(a.queuedAt || a.createdAt).localeCompare(String(b.queuedAt || b.createdAt)))
    .findIndex((item) => item.id === job.id) + 1;
}

function isTerminalStatus(status) {
  return ["completed", "failed", "canceled", "reauth_required", "resume_available"].includes(status);
}

function uniqueByJson(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function listUniqueJobs() {
  const seen = new Set();
  return [...jobs.values()].sort(sortNewestFirst).filter((job) => {
    const key = job.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findJobByEmail(email) {
  const key = String(email || "").toLowerCase();
  return listUniqueJobs().find((job) => job.email.toLowerCase() === key) || null;
}

async function withEmailJobLock(email, operation) {
  const key = String(email || "").trim().toLowerCase();
  const previous = emailJobLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  emailJobLocks.set(key, current);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (emailJobLocks.get(key) === current) emailJobLocks.delete(key);
  }
}

function resolveSelectedJobs(ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw httpError(400, "请至少选择一条任务");
  const uniqueIds = [...new Set(ids.map((id) => String(id)))];
  if (uniqueIds.length > MAX_BATCH_JOBS) throw httpError(400, `一次最多操作 ${MAX_BATCH_JOBS} 条任务`);
  const selected = uniqueIds.map((id) => jobs.get(id));
  if (selected.some((job) => !job)) throw httpError(404, "部分任务不存在，请刷新页面后重试");
  return selected;
}

async function deleteJobsByEmail(email) {
  const matching = [...jobs.values()].filter((job) => job.email.toLowerCase() === email);
  const directories = new Set();
  matching.forEach((job) => {
    job.deleted = true;
    stopMailPolling(job);
    releaseSmsNumber(job, "idle");
    job.runId = crypto.randomUUID();
    job.child?.kill("SIGTERM");
    job.child = null;
    directories.add(path.dirname(job.outputPath));
    jobs.delete(job.id);
  });
  await Promise.allSettled(matching.map((job) => job.metadataWritePromise).filter(Boolean));
  await Promise.all([
    ...[...directories].map((directory) => fs.rm(directory, { recursive: true, force: true })),
    deleteStoredLoginCredentials(email),
  ]);
  scheduleQueuedJobs();
}

function downloadTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function syncCompletedOutputs(force = false) {
  if (!force && Date.now() - lastOutputSyncAt < 2_000) return;
  if (outputSyncPromise) return outputSyncPromise;
  outputSyncPromise = (async () => {
    lastOutputSyncAt = Date.now();
    let entries = [];
    try {
      entries = await fs.readdir(OUTPUT_ROOT, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      if (jobs.has(entry.name)) return;
      const outputDir = path.join(OUTPUT_ROOT, entry.name);
      const outputPath = path.join(outputDir, "sub2api-import-oauth.json");
      const checkpointPath = path.join(outputDir, LOGIN_CHECKPOINT_FILENAME);
      const totpResultPath = path.join(outputDir, TOTP_SETUP_RESULT_FILENAME);
      let metadata = {};
      try {
        metadata = JSON.parse(await fs.readFile(path.join(outputDir, JOB_META_FILENAME), "utf8"));
      } catch {}

      try {
        const [raw, stat] = await Promise.all([fs.readFile(outputPath, "utf8"), fs.stat(outputPath)]);
        const data = JSON.parse(raw);
        if (data.type !== "sub2api-data" || !Array.isArray(data.accounts) || !data.accounts.length) throw new Error("invalid output");
        const account = data.accounts[0];
        const email = metadata.email || account?.credentials?.email || account?.extra?.email || account?.name || `restored-${entry.name}`;
        const mailApiUrl = validateMailApiUrl(metadata.mail_api_url) ? metadata.mail_api_url : null;
        let storedCredentials = await loadStoredLoginCredentials(email);
        const completedAt = stat.mtime.toISOString();
        const updatedAt = metadata.updated_at || completedAt;
        const totpRecovery = await recoverActivatedTotpCredential({
          email,
          resultPath: totpResultPath,
          credentials: storedCredentials,
        });
        storedCredentials = totpRecovery.credentials;
        const restoredOperation = restoredOutputOperationState(metadata, completedAt, totpRecovery);
        jobs.set(entry.name, {
          id: entry.name,
          email,
          status: restoredOperation.status,
          prompt: restoredOperation.prompt,
          createdAt: metadata.created_at || completedAt,
          updatedAt,
          completedAt: metadata.completed_at || completedAt,
          outputPath,
          checkpointPath,
          totpResultPath,
          logs: restoredOperation.log,
          lastError: restoredOperation.lastError,
          child: null,
          parserTail: "",
          resultSaved: true,
          loginMode: metadata.login_mode === "password" || storedCredentials.password ? "password" : (mailApiUrl ? "email_otp" : metadata.login_mode || "manual"),
          password: storedCredentials.password,
          totpSecret: storedCredentials.totpSecret,
          ...restoredCredentialFlags(metadata, storedCredentials),
          mailApiUrl,
          proxyUrl: storedCredentials.proxyUrl,
          mailSeenCandidateKeys: new Set(),
          mailCandidateCounts: new Map(),
          mailStatus: mailApiUrl ? "ready" : "manual",
          mailApiError: null,
          mailPollRunning: false,
          mailPollToken: null,
          currentPhone: metadata.sms_number || metadata.luban_number || null,
          phoneError: null,
          restartRequired: false,
          attempt: Math.max(1, Number(metadata.attempt || 1)),
          runId: null,
          runMode: null,
          fallbackInProgress: false,
          ...restoredTotpSetupState(metadata, storedCredentials),
          ...restoredProxyRiskState(metadata),
          totpSetupError: restoredOperation.totpSetupError,
          securityCheckRequired: Boolean(metadata.security_check_required),
          ...newSmsState(),
        });
        return;
      } catch {}

      try {
        const [raw, stat] = await Promise.all([fs.readFile(checkpointPath, "utf8"), fs.stat(checkpointPath)]);
        const checkpoint = JSON.parse(raw);
        if (checkpoint?.version !== 1 || typeof checkpoint.email !== "string" || !checkpoint.email) return;
        const mailApiUrl = validateMailApiUrl(metadata.mail_api_url) ? metadata.mail_api_url : null;
        const email = metadata.email || checkpoint.email;
        const storedCredentials = await loadStoredLoginCredentials(email);
        const restoredAt = stat.mtime.toISOString();
        const savedStatus = String(metadata.status || "");
        const restoredStatus = isTerminalStatus(savedStatus) ? savedStatus : "resume_available";
        jobs.set(entry.name, {
          id: entry.name,
          email,
          status: restoredStatus,
          prompt: metadata.prompt || (restoredStatus === "resume_available"
            ? "检测到邮箱登录检查点，可以继续手机号绑定"
            : "已恢复上次操作状态，登录检查点仍然保留"),
          createdAt: metadata.created_at || restoredAt,
          updatedAt: metadata.updated_at || restoredAt,
          completedAt: null,
          outputPath,
          checkpointPath,
          totpResultPath,
          logs: `[restore] 已恢复 ${checkpoint.stage || "unknown"} 阶段的登录检查点。\n`,
          lastError: metadata.last_error || (restoredStatus === "resume_available"
            ? "上次流程在生成授权文件前中断"
            : null),
          child: null,
          parserTail: "",
          resultSaved: false,
          loginMode: metadata.login_mode === "password" || storedCredentials.password ? "password" : (mailApiUrl ? "email_otp" : metadata.login_mode || "manual"),
          password: storedCredentials.password,
          totpSecret: storedCredentials.totpSecret,
          ...restoredCredentialFlags(metadata, storedCredentials),
          mailApiUrl,
          proxyUrl: storedCredentials.proxyUrl,
          mailSeenCandidateKeys: new Set(),
          mailCandidateCounts: new Map(),
          mailStatus: mailApiUrl ? "ready" : "manual",
          mailApiError: null,
          mailPollRunning: false,
          mailPollToken: null,
          currentPhone: checkpoint.oauth?.phone || metadata.sms_number || metadata.luban_number || null,
          phoneError: null,
          restartRequired: false,
          attempt: Math.max(1, Number(metadata.attempt || 1)),
          runId: null,
          runMode: null,
          fallbackInProgress: false,
          ...restoredTotpSetupState(metadata, storedCredentials),
          ...restoredProxyRiskState(metadata),
          securityCheckRequired: Boolean(metadata.security_check_required),
          ...restoredSmsState(metadata),
        });
      } catch {
        if (
          !metadata.email
          || !isEmail(metadata.email)
        ) return;
        const storedCredentials = await loadStoredLoginCredentials(metadata.email);
        const mailApiUrl = validateMailApiUrl(metadata.mail_api_url) ? metadata.mail_api_url : null;
        const restoredAt = metadata.updated_at || new Date().toISOString();
        const missingStoredCredentials = restoredMissingCredentials(metadata, storedCredentials);
        const storedCredentialsMissing = missingStoredCredentials.length > 0;
        const savedStatus = String(metadata.status || "");
        const restartable = ["queued", "starting"].includes(savedStatus);
        const interrupted = Boolean(savedStatus) && !isTerminalStatus(savedStatus) && !restartable;
        const restoredStatus = storedCredentialsMissing && restartable
          ? "reauth_required"
          : restartable
            ? "queued"
            : interrupted || !savedStatus
              ? "failed"
              : savedStatus;
        const restoredPrompt = storedCredentialsMissing && restartable
          ? "登录资料需要重新确认"
          : restartable
            ? "服务重启后已恢复，等待任务槽位"
            : interrupted || !savedStatus
              ? "上次流程因服务重启中断，可以重新授权"
              : metadata.prompt || "已恢复上次任务状态";
        const restoredError = storedCredentialsMissing && restartable
          ? `请重新导入或填写${missingStoredCredentials.join("、")}后重试，任务不会使用缺失的资料自动登录`
          : interrupted || !savedStatus
            ? metadata.last_error || `上次 ${savedStatus || "未知"} 阶段未完成`
            : metadata.last_error || null;
        jobs.set(entry.name, {
          id: entry.name,
          email: metadata.email,
          status: restoredStatus,
          prompt: restoredPrompt,
          createdAt: metadata.created_at || restoredAt,
          updatedAt: restoredAt,
          completedAt: metadata.completed_at || null,
          outputPath,
          checkpointPath,
          totpResultPath,
          logs: storedCredentialsMissing && restartable
            ? `[restore] 系统安全凭据存储中无法恢复${missingStoredCredentials.join("、")}，已停止自动启动。\n`
            : restartable
              ? "[restore] 已恢复排队任务，等待可用任务槽位。\n"
              : interrupted || !savedStatus
                ? "[restore] 上次任务在生成授权文件前中断，已恢复为可重试状态。\n"
                : "[restore] 已恢复上次任务状态。\n",
          lastError: restoredError,
          child: null,
          parserTail: "",
          resultSaved: false,
          loginMode: metadata.login_mode === "password" || storedCredentials.password ? "password" : (mailApiUrl ? "email_otp" : metadata.login_mode || "manual"),
          password: storedCredentials.password,
          totpSecret: storedCredentials.totpSecret,
          ...restoredCredentialFlags(metadata, storedCredentials),
          mailApiUrl,
          proxyUrl: storedCredentials.proxyUrl,
          mailSeenCandidateKeys: new Set(),
          mailCandidateCounts: new Map(),
          mailStatus: mailApiUrl ? "baseline" : "manual",
          mailApiError: null,
          mailPollRunning: false,
          mailPollToken: null,
          currentPhone: metadata.sms_number || null,
          phoneError: null,
          restartRequired: restoredStatus === "reauth_required",
          attempt: Math.max(1, Number(metadata.attempt || 1)),
          runId: null,
          runMode: null,
          queuedMode: restoredStatus === "queued" && metadata.queued_mode === "refresh" ? "refresh" : "full",
          queuedAt: restoredStatus === "queued" ? metadata.queued_at || restoredAt : null,
          queuedStartPrompt: metadata.queued_mode === "refresh"
            ? "正在使用已有刷新令牌直接生成新授权"
            : "正在建立登录会话",
          fallbackInProgress: false,
          ...restoredTotpSetupState(metadata, storedCredentials),
          ...restoredProxyRiskState(metadata),
          securityCheckRequired: Boolean(metadata.security_check_required),
          ...newSmsState(),
        });
      }
    }));
  })().finally(() => {
    outputSyncPromise = null;
  });
  return outputSyncPromise;
}

async function recoverActivatedTotpCredential({ email, resultPath, credentials }) {
  let result;
  try {
    result = JSON.parse(await fs.readFile(resultPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { credentials, recovered: false, error: null };
    return { credentials, recovered: false, error: `2FA 结果文件无法读取：${error.message}` };
  }
  if (result?.activation_succeeded !== true || !result?.secret) {
    return { credentials, recovered: false, error: null };
  }
  try {
    const secret = normalizeTotpSecret(result.secret);
    const nextCredentials = { ...credentials, totpSecret: secret };
    const persisted = await saveStoredLoginCredentials(email, nextCredentials);
    if (!persisted) {
      return {
        credentials: nextCredentials,
        recovered: false,
        error: "2FA 已激活，但当前系统不支持持久凭据存储；结果文件已保留",
      };
    }
    await removePrivateFile(resultPath);
    return { credentials: nextCredentials, recovered: true, error: null };
  } catch (error) {
    return {
      credentials,
      recovered: false,
      error: `2FA 已激活，但密钥恢复失败：${error.message}；结果文件已保留`,
    };
  }
}

function restoredOutputOperationState(metadata, completedAt, totpRecovery) {
  const savedStatus = String(metadata.status || "");
  const interrupted = savedStatus && !isTerminalStatus(savedStatus);
  const status = !savedStatus || savedStatus === "completed"
    ? "completed"
    : interrupted ? "failed" : savedStatus;
  if (totpRecovery.recovered) {
    return {
      status: "completed",
      prompt: "已恢复上次成功激活的 2FA 密钥，原授权文件仍可下载",
      lastError: null,
      totpSetupError: null,
      log: "[restore] 已从中断的 2FA 设置流程恢复并安全保存密钥。\n",
    };
  }
  if (totpRecovery.error) {
    return {
      status: "completed",
      prompt: "原授权文件仍可下载，2FA 密钥需要重试恢复",
      lastError: metadata.last_error || null,
      totpSetupError: totpRecovery.error,
      log: `[restore] ${totpRecovery.error}\n`,
    };
  }
  if (interrupted) {
    return {
      status,
      prompt: "上次操作因服务重启中断，旧授权文件仍可下载",
      lastError: metadata.last_error || `上次 ${savedStatus} 阶段未完成`,
      totpSetupError: savedStatus.startsWith("totp_") ? "服务重启时 2FA 设置未完成" : null,
      log: "[restore] 检测到旧授权文件，同时保留了上次中断的操作状态。\n",
    };
  }
  return {
    status,
    prompt: metadata.prompt || (status === "completed"
      ? "已从本地输出目录恢复，可以下载导入文件"
      : "旧授权文件仍可下载，已恢复最近一次操作状态"),
    lastError: metadata.last_error || null,
    totpSetupError: savedStatus.startsWith("totp_") ? "服务重启时 2FA 设置未完成" : null,
    log: `[restore] 已恢复任务状态，旧授权文件时间 ${completedAt}。\n`,
  };
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

function normalizeProxyUrl(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw httpError(400, "账号代理必须是完整的 http://、https://、socks5:// 或 socks5h:// 地址");
  }
  if (!["http:", "https:", "socks5:", "socks5h:"].includes(parsed.protocol) || !parsed.hostname) {
    throw httpError(400, "账号代理只支持 http、https、socks5 和 socks5h 协议");
  }
  return parsed.toString();
}

function normalizeLoginCredentials(value = {}) {
  const password = typeof value.password === "string" ? value.password : "";
  const mailApiUrl = validateMailApiUrl(value.mailApiUrl) ? String(value.mailApiUrl).trim() : null;
  const totpSecret = value.totpSecret ? normalizeTotpSecret(value.totpSecret) : "";
  const loginMode = password ? "password" : "email_otp";
  return { loginMode, mailApiUrl, password, totpSecret };
}

function restoredCredentialFlags(metadata = {}, credentials = {}) {
  const hasExplicitPasswordFlag = Object.hasOwn(metadata, "has_password");
  const hasExplicitTotpFlag = Object.hasOwn(metadata, "has_totp_key");
  return {
    hasPasswordCredential: Boolean(
      credentials.password
      || (hasExplicitPasswordFlag ? metadata.has_password : metadata.login_mode === "password" && metadata.has_stored_credentials),
    ),
    hasTotpCredential: Boolean(
      credentials.totpSecret
      || (hasExplicitTotpFlag ? metadata.has_totp_key : metadata.has_stored_credentials),
    ),
  };
}

function restoredTotpSetupState(metadata = {}, credentials = {}) {
  return {
    totpSetupSecret: null,
    totpSetupUri: null,
    totpSetupError: null,
    totpKnownEnabled: Boolean(metadata.totp_known_enabled || credentials.totpSecret),
    totpSetupAttempt: 0,
    totpResultLoading: false,
  };
}

function restoredProxyRiskState(metadata = {}) {
  const count = Number(metadata.proxy_risk_retry_count || 0);
  const connectionFailures = Number(metadata.proxy_connection_failure_count || 0);
  return {
    proxyRiskRetryCount: Number.isInteger(count) && count >= 0 ? Math.min(count, MAX_PROXY_RISK_RETRIES) : 0,
    proxyConnectionFailureCount: Number.isInteger(connectionFailures) && connectionFailures >= 0
      ? Math.min(connectionFailures, MAX_PROXY_CONNECTION_FAILURES)
      : 0,
    proxyRiskRestarting: false,
    proxySessionAttemptIds: new Set(),
    proxyAttemptParserTail: "",
  };
}

function restoredMissingCredentials(metadata = {}, credentials = {}) {
  const missing = [];
  const passwordRequired = Object.hasOwn(metadata, "has_password")
    ? metadata.has_password
    : metadata.login_mode === "password" && metadata.has_stored_credentials;
  const totpRequired = Object.hasOwn(metadata, "has_totp_key")
    ? metadata.has_totp_key
    : metadata.has_stored_credentials && !passwordRequired;
  if (passwordRequired && !credentials.password) missing.push("密码");
  if (totpRequired && !credentials.totpSecret) missing.push("2FA 密钥");
  if (metadata.proxy_configured && !credentials.proxyUrl) missing.push("代理 IP");
  return missing;
}

function normalizeTotpSecret(value, lineNumber = null) {
  const normalized = String(value || "").toUpperCase().replace(/[\s=]/g, "");
  if (!/^[A-Z2-7]{16,128}$/.test(normalized)) {
    const prefix = lineNumber ? `第 ${lineNumber} 行` : "";
    throw httpError(400, `${prefix}2FA 密钥格式错误，只能包含 Base32（基础三十二进制）的 A-Z 和 2-7`);
  }
  return normalized;
}

function parseBatchEntries(value) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) throw httpError(400, "请至少输入一行账号信息");
  if (lines.length > MAX_BATCH_JOBS) throw httpError(400, `一次最多添加 ${MAX_BATCH_JOBS} 条任务`);

  const entries = lines.map((line, index) => {
    const split = splitAccountLine(line);
    if (!split) {
      if (!isEmail(line)) throw httpError(400, `第 ${index + 1} 行邮箱格式错误`);
      return {
        email: line,
        loginMode: "email_otp",
        mailApiUrl: null,
        password: "",
        totpSecret: "",
        preserveExistingCredentials: true,
      };
    }
    const { email, remainder } = split;
    if (!isEmail(email)) throw httpError(400, `第 ${index + 1} 行邮箱格式错误`);

    const passwordMailSeparator = /----(?=https?:\/\/)/i.exec(remainder);
    if (passwordMailSeparator && passwordMailSeparator.index > 0) {
      const password = remainder.slice(0, passwordMailSeparator.index).trim();
      const mailAndTotp = remainder.slice(passwordMailSeparator.index + 4).trim();
      let mailApiUrl = mailAndTotp;
      let totpSecret = "";
      const totpDelimiterAt = mailAndTotp.lastIndexOf("----");
      if (totpDelimiterAt >= 0) {
        const candidateUrl = mailAndTotp.slice(0, totpDelimiterAt).trim();
        if (validateMailApiUrl(candidateUrl)) {
          mailApiUrl = candidateUrl;
          totpSecret = normalizeTotpSecret(mailAndTotp.slice(totpDelimiterAt + 4), index + 1);
        }
      }
      if (!password) throw httpError(400, `第 ${index + 1} 行密码不能为空`);
      if (!validateMailApiUrl(mailApiUrl)) throw httpError(400, `第 ${index + 1} 行邮件接收 API 格式错误`);
      return { email, loginMode: "password", mailApiUrl, password, totpSecret };
    }

    const lastDelimiterAt = remainder.lastIndexOf("----");
    if (lastDelimiterAt < 0) {
      const loginValue = remainder.trim();
      if (!loginValue) throw httpError(400, `第 ${index + 1} 行密码或收码接口不能为空`);
      if (validateMailApiUrl(loginValue)) {
        return { email, loginMode: "email_otp", mailApiUrl: loginValue, password: "", totpSecret: "" };
      }
      return { email, loginMode: "password", mailApiUrl: null, password: loginValue, totpSecret: "" };
    }

    if (lastDelimiterAt === 0) {
      const totpSecret = normalizeTotpSecret(remainder.slice(4), index + 1);
      return { email, loginMode: "email_otp", mailApiUrl: null, password: "", totpSecret };
    }

    const loginValue = remainder.slice(0, lastDelimiterAt).trim();
    const totpSecret = normalizeTotpSecret(remainder.slice(lastDelimiterAt + 4), index + 1);
    if (!loginValue) throw httpError(400, `第 ${index + 1} 行密码或收码接口不能为空`);
    if (validateMailApiUrl(loginValue)) {
      return { email, loginMode: "email_otp", mailApiUrl: loginValue, password: "", totpSecret };
    }
    return { email, loginMode: "password", mailApiUrl: null, password: loginValue, totpSecret };
  });

  const unique = new Map();
  entries.forEach((entry) => unique.set(entry.email.toLowerCase(), entry));
  return [...unique.values()];
}

function splitAccountLine(line) {
  const separators = line.matchAll(/-{3,4}/g);
  for (const separator of separators) {
    const email = line.slice(0, separator.index).trim();
    if (!isEmail(email)) continue;
    return {
      email,
      remainder: line.slice(separator.index + separator[0].length),
    };
  }
  return null;
}

async function updateJobCredentials(job, credentials, options = {}) {
  if (credentials.preserveExistingCredentials) await reloadMissingJobCredentials(job);
  const normalized = credentials.preserveExistingCredentials
    ? normalizeLoginCredentials({
        password: job.password,
        mailApiUrl: job.mailApiUrl,
        totpSecret: job.totpSecret,
      })
    : normalizeLoginCredentials(credentials);
  const nextProxyUrl = options.hasProxyUpdate ? normalizeProxyUrl(options.proxyUrl) : job.proxyUrl;
  const changed = job.loginMode !== normalized.loginMode
    || job.mailApiUrl !== normalized.mailApiUrl
    || job.password !== normalized.password
    || job.totpSecret !== normalized.totpSecret
    || job.proxyUrl !== nextProxyUrl;
  await saveStoredLoginCredentials(job.email, { ...normalized, proxyUrl: nextProxyUrl });
  if (!changed) return;
  stopMailPolling(job);
  job.loginMode = normalized.loginMode;
  job.mailApiUrl = normalized.mailApiUrl;
  job.password = normalized.password;
  job.totpSecret = normalized.totpSecret;
  job.hasPasswordCredential = Boolean(normalized.password);
  job.hasTotpCredential = Boolean(normalized.totpSecret);
  job.proxyUrl = nextProxyUrl;
  job.mailSeenCandidateKeys.clear();
  job.mailCandidateCounts.clear();
  job.mailStatus = job.mailApiUrl ? "baseline" : "manual";
  job.mailApiError = null;
  appendJobLog(job, "[account] 登录方式与验证资料已按邮箱唯一键更新，敏感字段未写入日志。\n");
  if (isActive(job.status) && job.status !== "queued") {
    restartJobAfterConfigurationUpdate(job);
  } else {
    touch(job);
    await saveJobMetadata(job);
  }
}

async function updateJobProxy(job, proxyUrl) {
  if (job.proxyUrl === proxyUrl) return;
  job.proxyUrl = proxyUrl;
  await saveStoredLoginCredentials(job.email, job);
  appendJobLog(job, "[proxy] 账号代理配置已更新。\n");
  if (isActive(job.status) && job.status !== "queued") {
    restartJobAfterConfigurationUpdate(job);
  } else {
    touch(job);
    await saveJobMetadata(job);
  }
}

function restartJobAfterConfigurationUpdate(job) {
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.queueRunId = null;
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  job.lastError = null;
  job.parserTail = "";
  job.currentPhone = null;
  job.phoneError = null;
  job.securityCheckRequired = false;
  job.restartRequired = false;
  job.attempt += 1;
  appendJobLog(job, "[account] 已停止使用旧配置的登录进程，并使用新配置重新排队。\n");
  enqueueJob(job, "full", "账号资料已更新，正在重新建立登录会话");
}

async function saveJobMetadata(job) {
  if (job.deleted) return;
  job.metadataWritePromise = (job.metadataWritePromise || Promise.resolve())
    .catch(() => {})
    .then(async () => {
      if (job.deleted) return;
      const metadataPath = path.join(path.dirname(job.outputPath), JOB_META_FILENAME);
      const data = {
        version: 1,
        email: job.email,
        status: job.status,
        prompt: job.prompt || null,
        last_error: job.lastError || null,
        result_saved: Boolean(job.resultSaved),
        completed_at: job.completedAt || null,
        attempt: Number(job.attempt || 1),
        security_check_required: Boolean(job.securityCheckRequired),
        queued_mode: job.queuedMode || null,
        queued_at: job.queuedAt || null,
        created_at: job.createdAt,
        login_mode: job.loginMode || null,
        has_stored_credentials: Boolean(job.password || job.totpSecret),
        has_password: Boolean(job.password || job.hasPasswordCredential),
        has_totp_key: Boolean(job.totpSecret || job.hasTotpCredential),
        totp_known_enabled: Boolean(job.totpKnownEnabled || job.totpSecret || job.hasTotpCredential),
        proxy_risk_retry_count: Number(job.proxyRiskRetryCount || 0),
        proxy_connection_failure_count: Number(job.proxyConnectionFailureCount || 0),
        proxy_configured: Boolean(job.proxyUrl),
        mail_api_url: job.mailApiUrl || null,
        sms_provider_id: job.smsProviderId || null,
        sms_provider_name: job.smsProviderName || null,
        sms_service_label: job.smsServiceLabel || null,
        sms_order_id: job.smsOrderId || null,
        sms_number: job.smsNumber || null,
        sms_status: job.smsStatus || null,
        updated_at: new Date().toISOString(),
      };
      const tempPath = `${metadataPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(tempPath, metadataPath);
    });
  return job.metadataWritePromise;
}

async function saveStoredLoginCredentials(email, credentials = {}) {
  const password = typeof credentials.password === "string" ? credentials.password : "";
  const totpSecret = credentials.totpSecret ? normalizeTotpSecret(credentials.totpSecret) : "";
  const proxyUrl = credentials.proxyUrl ? normalizeProxyUrl(credentials.proxyUrl) : "";
  if (!password && !totpSecret && !proxyUrl) {
    await deleteStoredLoginCredentials(email);
    return true;
  }
  try {
    await credentialStore.save(email, { password, totpSecret, proxyUrl });
  } catch (error) {
    if (error?.status === 501) return false;
    throw error;
  }
  return true;
}

async function loadStoredLoginCredentials(email) {
  try {
    const data = await credentialStore.load(email);
    return {
      password: typeof data.password === "string" ? data.password : "",
      totpSecret: data.totpSecret ? normalizeTotpSecret(data.totpSecret) : "",
      proxyUrl: data.proxyUrl ? normalizeProxyUrl(data.proxyUrl) : null,
    };
  } catch {
    return { password: "", totpSecret: "", proxyUrl: null };
  }
}

async function deleteStoredLoginCredentials(email) {
  await credentialStore.delete(email);
}

async function loadMailboxBaseline(job) {
  try {
    const candidates = await fetchMailboxOtpCandidates(job.mailApiUrl);
    candidates.forEach((candidate) => job.mailSeenCandidateKeys.add(candidate.key));
    job.mailStatus = "ready";
    job.mailApiError = null;
    appendJobLog(job, `[mail] 已记录收码接口中的 ${candidates.length} 个旧邮件验证码标识，等待新邮件。\n`);
  } catch (error) {
    job.mailStatus = "error";
    job.mailApiError = safeMailError(error);
    appendJobLog(job, `[mail] 首次读取收码接口失败：${job.mailApiError}\n`);
  }
  touch(job);
}

async function beginMailPolling(job) {
  if (!job.mailApiUrl || job.mailPollRunning || job.status !== "email_otp") return;
  job.mailPollRunning = true;
  job.mailStatus = "polling";
  job.mailApiError = null;
  const pollToken = crypto.randomUUID();
  const startedAt = Date.now();
  job.mailPollToken = pollToken;
  touch(job);

  try {
    while (
      job.mailPollToken === pollToken &&
      job.status === "email_otp" &&
      job.child &&
      Date.now() - startedAt < MAIL_POLL_TIMEOUT_MS
    ) {
      try {
        const candidates = await fetchMailboxOtpCandidates(job.mailApiUrl);
        if (job.mailPollToken !== pollToken || job.status !== "email_otp" || !job.child) return;
        const unseen = candidates.filter((candidate) => !job.mailSeenCandidateKeys.has(candidate.key));
        let fresh = unseen.find((candidate) => candidate.score >= 12);
        if (!fresh) {
          unseen.forEach((candidate) => {
            job.mailCandidateCounts.set(candidate.key, (job.mailCandidateCounts.get(candidate.key) || 0) + 1);
          });
          fresh = unseen.find((candidate) => (job.mailCandidateCounts.get(candidate.key) || 0) >= 2);
        }
        job.mailApiError = null;
        if (fresh) {
          job.mailSeenCandidateKeys.add(fresh.key);
          job.mailCandidateCounts.delete(fresh.key);
          job.mailStatus = "found";
          job.parserTail = "";
          appendJobLog(job, "[mail] 已从收码接口自动取得新验证码并提交。\n");
          setStage(job, "working", "已自动获取邮箱验证码，正在验证");
          job.child.stdin.write(`${fresh.code}\n`);
          return;
        }
      } catch (error) {
        if (job.mailPollToken !== pollToken) return;
        job.mailStatus = "error";
        job.mailApiError = safeMailError(error);
        touch(job);
      }
      await delay(MAIL_POLL_INTERVAL_MS);
    }

    if (job.mailPollToken === pollToken && job.status === "email_otp") {
      job.mailStatus = "timeout";
      job.mailApiError = "自动收码等待超时，请手动输入或重新发送";
      job.prompt = "自动收码等待超时，请手动输入邮箱验证码";
      touch(job);
    }
  } finally {
    if (job.mailPollToken === pollToken) {
      job.mailPollRunning = false;
      job.mailPollToken = null;
      touch(job);
    }
  }
}

function stopMailPolling(job) {
  if (!job.mailApiUrl) return;
  job.mailPollToken = null;
  job.mailPollRunning = false;
  if (job.mailStatus === "polling") job.mailStatus = "stopped";
}

function appendJobLog(job, text) {
  job.logs = `${job.logs}${sanitizeLog(text)}`.slice(-MAX_LOG_CHARS);
}

function safeMailError(error) {
  const message = String(error?.message || "读取收码接口失败");
  return message.replace(/https?:\/\/\S+/gi, "<已隐藏接口地址>").slice(0, 180);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sortNewestFirst(a, b) {
  return b.createdAt.localeCompare(a.createdAt);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw httpError(413, "Request body is too large");
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw httpError(400, "Invalid JSON body");
  }
}

function sendJson(res, status, data) {
  if (res.headersSent) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

process.on("SIGINT", () => void shutdown().catch(reportShutdownFailure));
process.on("SIGTERM", () => void shutdown().catch(reportShutdownFailure));

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    shuttingDown = true;
    queueSchedulingPaused = true;
    const activeJobs = [...jobs.values()].filter((job) => isActive(job.status));
    const childWaits = activeJobs
      .map((job) => job.child)
      .filter(Boolean)
      .map((child) => waitForChildExit(child, 3_000));
    await Promise.allSettled(activeJobs.map((job) => cancelJob(job)));
    await Promise.allSettled([
      ...childWaits,
      ...[...jobs.values()].map((job) => job.metadataWritePromise).filter(Boolean),
    ]);
    await vite.close();
    await closeHttpServer(server);
  })();
  return shutdownPromise;
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("close", finish);
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, timeoutMs);
  });
}

function closeHttpServer(httpServer) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      httpServer.closeAllConnections?.();
      resolve();
    }, 3_000);
    httpServer.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function reportShutdownFailure(error) {
  console.error(`[shutdown] ${error.message}`);
  process.exitCode = 1;
}
