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
import { fetchMailboxOtpCandidates, validateMailApiUrl } from "./mail-otp.mjs";
import { createLubanSmsClient } from "./luban-sms.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4399;
const MAX_ACTIVE_JOBS = 20;
const MAX_BATCH_JOBS = 500;
const PAGE_SIZE = 20;
const MAX_LOG_CHARS = 80_000;
const JOB_META_FILENAME = "job-meta.json";
const LOGIN_CHECKPOINT_FILENAME = "login-checkpoint.json";
const MAIL_POLL_INTERVAL_MS = 2_500;
const MAIL_POLL_TIMEOUT_MS = 10 * 60_000;
const KEYCHAIN_SERVICE = "com.local.chatgpt-onboarding.credentials";
const LUBAN_SMS_POLL_INTERVAL_MS = Number(process.env.LUBAN_SMS_POLL_INTERVAL_MS || 3_000);
const LUBAN_SMS_POLL_TIMEOUT_MS = Number(process.env.LUBAN_SMS_POLL_TIMEOUT_MS || 10 * 60_000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(__dirname, "..");
const WEB_ROOT = path.join(TOOL_ROOT, "web");
const PROTOCOL_SCRIPT = path.resolve(process.env.ONBOARDING_PROTOCOL_SCRIPT || path.join(__dirname, "protocol-login.mjs"));
const WORKSPACE_ROOT = TOOL_ROOT;
const OUTPUT_ROOT = path.resolve(
  process.env.ONBOARDING_OUTPUT_ROOT || path.join(WORKSPACE_ROOT, "tmp", "chatgpt-onboarding-console"),
);
const consoleToken = crypto.randomBytes(24).toString("base64url");
const jobs = new Map();
let outputSyncPromise = null;
let lastOutputSyncAt = 0;
let shuttingDown = false;
let queueSchedulingPaused = false;

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
        lubanSms: true,
        queue: true,
        sourceExport: true,
        cancelAll: true,
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
    const existing = findJobByEmail(email);
    if (existing) {
      if (hasCredentialUpdate) await updateJobCredentials(existing, credentials);
      sendJson(res, 200, { job: publicJob(existing), created: false, updated: hasCredentialUpdate });
      return;
    }
    const job = await startJob(email, credentials);
    sendJson(res, 201, { job: publicJob(job), created: true, updated: false });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/batch") {
    const body = await readJson(req);
    const entries = parseBatchEntries(body.text);
    const existingByEmail = new Map(entries.map((entry) => [entry.email, findJobByEmail(entry.email)]));
    const results = await Promise.all(entries.map(async (entry) => {
      const existing = existingByEmail.get(entry.email);
      if (existing) {
        await updateJobCredentials(existing, entry);
        return { job: existing, updated: true };
      }
      return { job: await startJob(entry.email, entry), updated: false };
    }));
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
    await Promise.all(emails.map((email) => deleteJobsByEmail(email)));
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
      if (job.status === "completed") regenerateJob(job);
      else await retryJob(job);
    }));
    sendJson(res, 200, { jobs: selected.map(publicJob), started: selected.length });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/cancel-all") {
    const canceled = await cancelAllJobs();
    sendJson(res, 200, { canceled });
    return;
  }

  const match = /^\/api\/jobs\/([a-f0-9-]+)(?:\/(input|cancel|retry|regenerate|logs|download|luban-number))?$/.exec(requestUrl.pathname);
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
  if (req.method === "POST" && action === "luban-number") {
    const body = await readJson(req);
    await acquireLubanNumber(job, body.serviceId, body.apiKey);
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "cancel") {
    cancelJob(job);
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "retry") {
    await retryJob(job);
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "regenerate") {
    regenerateJob(job);
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

async function startJob(email, credentials = {}) {
  const { loginMode, mailApiUrl, password, totpSecret } = normalizeLoginCredentials(credentials);
  await saveStoredLoginCredentials(email, { password, totpSecret });
  const id = crypto.randomUUID();
  const outputDir = path.join(OUTPUT_ROOT, id);
  const outputPath = path.join(outputDir, "sub2api-import-oauth.json");
  const checkpointPath = path.join(outputDir, LOGIN_CHECKPOINT_FILENAME);
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
    ...newLubanState(),
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
    job.status = mode === "refresh" ? "refreshing" : "starting";
    job.prompt = job.queuedStartPrompt || (mode === "refresh"
      ? "正在使用已有刷新令牌直接生成新授权"
      : "正在建立登录会话");
    job.queuedAt = null;
    touch(job);
    void saveJobMetadata(job).catch(() => {});
    void prepareAndLaunchJob(job, mode);
    availableSlots -= 1;
    if (availableSlots <= 0) break;
  }
}

async function prepareAndLaunchJob(job, mode) {
  try {
    if (mode === "full" && job.mailApiUrl) await loadMailboxBaseline(job);
    if (!isActive(job.status) || job.status === "queued") return;
    launchJob(job, { mode });
  } catch (error) {
    failJob(job, `准备登录任务失败：${error.message}`);
    scheduleQueuedJobs();
  }
}

function enqueueJob(job, mode, startPrompt) {
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
    if (job.runId === runId) failJob(job, `无法启动登录进程：${error.message}`);
  });
  child.on("close", async (code, signal) => {
    if (job.runId !== runId) return;
    stopMailPolling(job);
    job.child = null;
    if (["canceled", "reauth_required"].includes(job.status)) {
      scheduleQueuedJobs();
      return;
    }
    if (code === 0 && job.resultSaved && (await fileExists(job.outputPath))) {
      job.status = "completed";
      job.prompt = "授权完成，可以下载导入文件";
      job.completedAt = new Date().toISOString();
      touch(job);
      void saveJobMetadata(job).catch(() => {});
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
  });
}

async function retryJob(job) {
  if (!["failed", "canceled", "reauth_required", "resume_available"].includes(job.status)) {
    throw httpError(409, "当前任务不需要重新授权");
  }
  const retryingSecurityCheck = Boolean(job.securityCheckRequired);
  const resumingCheckpoint = job.status === "resume_available"
    || (retryingSecurityCheck && await fileExists(job.checkpointPath));
  stopMailPolling(job);
  if (resumingCheckpoint) stopLubanSmsPolling(job);
  else releaseLubanNumber(job, "idle");
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  const startPrompt = retryingSecurityCheck && resumingCheckpoint
    ? "正在使用已有登录状态重试手机号绑定"
    : "正在重新建立登录会话";
  job.lastError = null;
  job.parserTail = "";
  job.resultSaved = false;
  job.completedAt = null;
  job.currentPhone = resumingCheckpoint ? (job.currentPhone || job.lubanNumber) : null;
  job.phoneError = null;
  job.securityCheckRequired = false;
  job.restartRequired = false;
  job.attempt += 1;
  job.mailCandidateCounts.clear();
  appendJobLog(
    job,
    retryingSecurityCheck
      ? `\n[retry] 开始第 ${job.attempt} 次手动重试；优先复用已有登录检查点。\n`
      : `\n[retry] 开始第 ${job.attempt} 次授权登录。\n`,
  );
  enqueueJob(job, "full", startPrompt);
}

function regenerateJob(job) {
  if (job.status !== "completed" || !job.resultSaved) {
    throw httpError(409, "只能为已经完成的任务重新生成授权");
  }
  job.lastError = null;
  job.parserTail = "";
  job.currentPhone = null;
  job.phoneError = null;
  releaseLubanNumber(job, "idle");
  job.restartRequired = false;
  job.completedAt = null;
  job.attempt += 1;
  appendJobLog(job, `\n[refresh] 第 ${job.attempt} 次生成：优先使用已有刷新令牌。\n`);
  enqueueJob(job, "refresh", "正在使用已有刷新令牌直接生成新授权");
}

async function fallbackFromRefresh(job) {
  if (job.runMode !== "refresh" || job.fallbackInProgress) return;
  job.fallbackInProgress = true;
  stopMailPolling(job);
  releaseLubanNumber(job, "idle");
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
  const text = sanitizeLog(rawText);
  job.logs = `${job.logs}${text}`.slice(-MAX_LOG_CHARS);
  const scan = `${job.parserTail}${text}`;
  job.parserTail = scan.slice(-2_000);

  if (job.runMode === "refresh" && scan.includes("REFRESH_TOKEN_INVALID")) {
    void fallbackFromRefresh(job);
    return;
  }

  if (scan.includes("[security-check-required]")) {
    requireBrowserSecurityCheck(job);
    return;
  }

  if (/Your sign-in session is no longer valid|["']code["']\s*:\s*["']invalid_state["']/i.test(scan)) {
    requireReauthorization(job, "当前登录状态已经失效，继续更换手机号也无法发送验证码");
    return;
  }

  if (scan.includes("[auth-expired]")) {
    stopLubanSmsPolling(job);
    releaseLubanNumber(job, "idle");
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
  if (scan.includes("2FA OTP (6 digits, q=quit):")) {
    setStage(job, "mfa_otp", "请输入 6 位 2FA 验证码");
  }
  if (scan.includes("[mfa] TOTP 2FA challenge reached.")) {
    setStage(job, "working", job.totpSecret ? "正在自动完成 2FA 验证" : "正在准备 2FA 验证");
  }
  if (scan.includes("Phone number, E.164 format")) {
    stopMailPolling(job);
    setStage(job, "phone", "请输入需要绑定的手机号");
  }
  if (scan.includes("Phone OTP (r=resend, p=change phone, q=quit):")) {
    job.phoneError = null;
    setStage(
      job,
      "phone_otp",
      job.currentPhone ? `短信验证码已发送至 ${job.currentPhone}` : "请输入手机短信验证码",
    );
    if (job.lubanRequestId && job.lubanNumber === job.currentPhone) void beginLubanSmsPolling(job);
  }

  const sendFailures = [...scan.matchAll(/\[warn\] Could not send SMS to (\+\d+):\s*([^\r\n]+)/g)];
  if (sendFailures.length) {
    const latest = sendFailures.at(-1);
    job.currentPhone = latest[1];
    job.phoneError = friendlyPhoneError(latest[2]);
    if (job.lubanRequestId && job.lubanNumber === job.currentPhone) {
      releaseLubanNumber(job, "error", "该平台手机号无法接收验证码，请重新取号或手动输入其他手机号");
    }
    setStage(job, "phone", `手机号 ${job.currentPhone} 无法接收验证码，请更换手机号`);
  }

  const validationFailures = [...scan.matchAll(/\[warn\] Phone OTP validation failed:\s*([^\r\n]+)/g)];
  if (validationFailures.length) {
    job.phoneError = friendlyPhoneOtpError(validationFailures.at(-1)[1]);
    if (job.lubanStatus === "submitted") {
      job.lubanStatus = "error";
      job.lubanError = "平台返回的验证码未通过验证，请重新发送或更换手机号";
    }
    setStage(
      job,
      "phone_otp",
      job.currentPhone ? `请重新输入发送至 ${job.currentPhone} 的验证码` : "请重新输入手机验证码",
    );
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
    failJob(job, extractResponseMessage(errorMatches.at(-1)[1]));
  }
  touch(job);
}

function requireReauthorization(job, message) {
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  releaseLubanNumber(job, "idle");
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
  releaseLubanNumber(job, "idle");
  job.status = "failed";
  job.prompt = "手机号绑定需要浏览器安全校验";
  job.lastError = "邮箱登录已经成功，但服务端拒绝了本次纯协议短信请求；可以手动重试，若仍被拒绝则需要稍后再试";
  job.phoneError = null;
  job.securityCheckRequired = true;
  job.child?.kill("SIGTERM");
  touch(job);
}

function markResumeAvailable(job, reason = "登录流程中断") {
  stopMailPolling(job);
  stopLubanSmsPolling(job);
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
  if (/expired/i.test(text)) return "手机验证码已过期，请重新发送或更换手机号";
  if (/too many|rate.?limit|HTTP 429/i.test(text)) return "验证次数过多，请重新发送或更换手机号";
  return "手机验证码不正确，请重新输入；也可以重新发送或更换手机号";
}

async function acquireLubanNumber(job, serviceIdValue, apiKeyValue) {
  requireStage(job, "phone");
  const serviceId = String(serviceIdValue || "").trim();
  const apiKey = String(apiKeyValue || "").trim();
  if (!/^[a-zA-Z0-9._:-]{1,80}$/.test(serviceId)) throw httpError(400, "请输入有效的接码平台服务编号");
  if (!/^[a-zA-Z0-9._-]{8,256}$/.test(apiKey)) throw httpError(400, "请在页面上方输入有效的 LubanSMS API Key");
  if (job.lubanStatus === "requesting") throw httpError(409, "正在获取手机号，请不要重复提交");

  releaseLubanNumber(job, "idle");
  const lubanClient = createLubanSmsClient({ apiKey, apiBase: process.env.LUBAN_SMS_API_BASE });
  job.lubanClient = lubanClient;
  job.lubanServiceId = serviceId;
  job.lubanStatus = "requesting";
  job.lubanError = null;
  touch(job);

  let order;
  try {
    order = await lubanClient.getNumber(serviceId);
    if (job.status !== "phone" || !job.child) {
      void lubanClient.release(order.requestId).catch(() => {});
      throw httpError(409, "任务已经不在手机号输入步骤，平台号码已释放");
    }
    job.lubanRequestId = order.requestId;
    job.lubanNumber = order.number;
    job.lubanStatus = "number_acquired";
    job.lubanError = null;
    await saveJobMetadata(job);
    appendJobLog(job, "[sms] 已从 LubanSMS 获取手机号并提交，等待短信发送结果。\n");
    await submitJobInput(job, { action: "phone", value: order.number }, { source: "luban" });
  } catch (error) {
    if (order?.requestId && job.lubanRequestId === order.requestId) releaseLubanNumber(job, "error");
    if (job.status === "phone") {
      job.lubanStatus = "error";
      job.lubanError = safeLubanError(error, apiKey);
      if (!order) job.lubanClient = null;
      touch(job);
    }
    if (error?.status) throw error;
    throw httpError(502, safeLubanError(error, apiKey));
  }
}

async function beginLubanSmsPolling(job) {
  if (!job.lubanClient || !job.lubanRequestId || job.lubanPollToken || job.status !== "phone_otp") return;
  const pollToken = crypto.randomUUID();
  const requestId = job.lubanRequestId;
  const lubanClient = job.lubanClient;
  const startedAt = Date.now();
  job.lubanPollToken = pollToken;
  job.lubanStatus = "waiting_sms";
  job.lubanError = null;
  touch(job);

  try {
    while (
      job.lubanPollToken === pollToken &&
      job.lubanRequestId === requestId &&
      job.status === "phone_otp" &&
      job.child &&
      Date.now() - startedAt < LUBAN_SMS_POLL_TIMEOUT_MS
    ) {
      try {
        const result = await lubanClient.getSms(requestId);
        if (job.lubanPollToken !== pollToken || job.status !== "phone_otp" || !job.child) return;
        if (result.status === "received") {
          job.lubanStatus = "submitting";
          job.lubanError = null;
          appendJobLog(job, "[sms] 已从 LubanSMS 获取短信验证码并自动提交。\n");
          await submitJobInput(job, { action: "phone_otp", value: result.code }, { source: "luban" });
          return;
        }
        job.lubanStatus = "waiting_sms";
        job.lubanError = null;
      } catch (error) {
        if (job.lubanPollToken !== pollToken) return;
        if (error?.terminal) {
          job.lubanStatus = "error";
          job.lubanError = `${safeLubanError(error)}，可以手动输入验证码或更换手机号`;
          touch(job);
          return;
        }
        job.lubanStatus = "waiting_sms";
        job.lubanError = `${safeLubanError(error)}，正在自动重试`;
        touch(job);
      }
      await delay(LUBAN_SMS_POLL_INTERVAL_MS);
    }

    if (job.lubanPollToken === pollToken && job.status === "phone_otp") {
      job.lubanStatus = "error";
      job.lubanError = "等待平台短信超时，可以手动输入验证码或更换手机号";
      touch(job);
    }
  } finally {
    if (job.lubanPollToken === pollToken) {
      job.lubanPollToken = null;
      touch(job);
    }
  }
}

function stopLubanSmsPolling(job) {
  job.lubanPollToken = null;
}

function releaseLubanNumber(job, nextStatus = "idle", errorMessage = null) {
  const requestId = job.lubanRequestId;
  const lubanClient = job.lubanClient;
  stopLubanSmsPolling(job);
  job.lubanRequestId = null;
  job.lubanNumber = null;
  job.lubanClient = null;
  job.lubanStatus = nextStatus;
  job.lubanError = errorMessage;
  if (requestId && lubanClient) {
    void lubanClient.release(requestId).catch(() => {
      appendJobLog(job, "[sms] LubanSMS 号码释放请求失败，请在平台控制台检查订单。\n");
    });
  }
  if (job.outputPath) void saveJobMetadata(job).catch(() => {});
}

function newLubanState() {
  return {
    lubanServiceId: null,
    lubanRequestId: null,
    lubanNumber: null,
    lubanClient: null,
    lubanStatus: "idle",
    lubanError: null,
    lubanPollToken: null,
  };
}

function restoredLubanState(metadata = {}) {
  if (!metadata.luban_request_id || !metadata.luban_number) return newLubanState();
  return {
    lubanServiceId: null,
    lubanRequestId: String(metadata.luban_request_id),
    lubanNumber: String(metadata.luban_number),
    lubanClient: null,
    lubanStatus: "error",
    lubanError: "服务重启后已停止自动收短信，可手动输入验证码或换号",
    lubanPollToken: null,
  };
}

function safeLubanError(error, apiKey = "") {
  let message = String(error?.message || "接码平台请求失败");
  if (apiKey) message = message.replaceAll(apiKey, "<已隐藏密钥>");
  return message
    .replace(/apikey=[^&\s]+/gi, "apikey=<已隐藏>")
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
    await saveStoredLoginCredentials(job.email, { password: rawValue, totpSecret: job.totpSecret });
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
    if (options.source !== "luban") releaseLubanNumber(job, "idle");
    job.currentPhone = value;
    job.phoneError = null;
    inputValue = value;
    setStage(job, "working", `正在向 ${value} 发送手机验证码`);
  } else if (action === "phone_otp") {
    requireStage(job, "phone_otp");
    if (!/^\d{4,8}$/.test(value)) throw httpError(400, "Phone code must be 4 to 8 digits");
    stopLubanSmsPolling(job);
    if (job.lubanRequestId) job.lubanStatus = options.source === "luban" ? "submitted" : "manual_submitted";
    job.phoneError = null;
    inputValue = value;
    setStage(job, "working", "正在验证手机验证码");
  } else if (action === "resend_phone") {
    requireStage(job, "phone_otp");
    stopLubanSmsPolling(job);
    if (job.lubanRequestId) job.lubanStatus = "number_acquired";
    job.phoneError = null;
    inputValue = "r";
    setStage(job, "working", job.currentPhone ? `正在向 ${job.currentPhone} 重新发送验证码` : "正在重新发送手机验证码");
  } else if (action === "change_phone") {
    requireStage(job, "phone_otp");
    releaseLubanNumber(job, "idle");
    job.currentPhone = null;
    job.phoneError = null;
    inputValue = "p";
    setStage(job, "working", "正在返回手机号输入");
  } else {
    throw httpError(400, "Unsupported input action");
  }

  job.parserTail = "";
  job.child.stdin.write(`${inputValue}\n`);
  touch(job);
}

function cancelJob(job) {
  if (!isActive(job.status)) return;
  stopMailPolling(job);
  releaseLubanNumber(job, "idle");
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
    activeJobs.forEach(cancelJob);
    await Promise.all(activeJobs.map((job) => saveJobMetadata(job)));
  } finally {
    queueSchedulingPaused = false;
  }
  scheduleQueuedJobs();
  return activeJobs.length;
}

async function downloadResult(res, job) {
  if (job.status !== "completed" || !(await fileExists(job.outputPath))) {
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
  const downloadable = selected.filter((job) => job.status === "completed" && job.resultSaved);
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
      throw httpError(409, `${job.email} 的密码未能从 Keychain（钥匙串）读取，请重新导入该账号资料`);
    }
    if (job.hasTotpCredential && !totpSecret) {
      throw httpError(409, `${job.email} 的 2FA 密钥未能从 Keychain（钥匙串）读取，请重新导入该账号资料`);
    }
    if (password) {
      lines.push(totpSecret
        ? `${job.email}----${password}----${totpSecret}`
        : `${job.email}----${password}`);
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
    lines.push(job.email);
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
    canDownload: job.status === "completed" && job.resultSaved,
    loginMode: job.loginMode || (job.mailApiUrl ? "email_otp" : "manual"),
    hasTotpKey: Boolean(job.totpSecret || job.hasTotpCredential),
    autoEmailOtp: Boolean(job.mailApiUrl),
    mailStatus: job.mailStatus,
    mailApiError: job.mailApiError,
    currentPhone: job.currentPhone,
    phoneError: job.phoneError,
    lubanServiceId: job.lubanServiceId,
    lubanStatus: job.lubanStatus,
    lubanError: job.lubanError,
    securityCheckRequired: Boolean(job.securityCheckRequired),
    canRetry: ["failed", "canceled", "reauth_required", "resume_available"].includes(job.status),
    canResume: job.status === "resume_available",
    canRegenerate: job.status === "completed" && job.resultSaved,
    restartRequired: job.restartRequired,
    attempt: job.attempt,
    queuePosition: job.status === "queued" ? getQueuePosition(job) : 0,
  };
}

function publicSelectionJob(job) {
  return {
    id: job.id,
    email: job.email,
    status: job.status,
    canDownload: job.status === "completed" && job.resultSaved,
    canRetry: ["failed", "canceled", "reauth_required", "resume_available"].includes(job.status),
    canRegenerate: job.status === "completed" && job.resultSaved,
  };
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
  releaseLubanNumber(job, "idle");
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
    stopMailPolling(job);
    releaseLubanNumber(job, "idle");
    job.runId = crypto.randomUUID();
    job.child?.kill("SIGTERM");
    job.child = null;
    directories.add(path.dirname(job.outputPath));
    jobs.delete(job.id);
  });
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
        const storedCredentials = await loadStoredLoginCredentials(email);
        const completedAt = stat.mtime.toISOString();
        const updatedAt = metadata.updated_at || completedAt;
        jobs.set(entry.name, {
          id: entry.name,
          email,
          status: "completed",
          prompt: "已从本地输出目录恢复，可以下载导入文件",
          createdAt: metadata.created_at || completedAt,
          updatedAt,
          completedAt,
          outputPath,
          checkpointPath,
          logs: "[restore] 已从本地输出目录恢复完成任务。\n",
          lastError: null,
          child: null,
          parserTail: "",
          resultSaved: true,
          loginMode: metadata.login_mode === "password" || storedCredentials.password ? "password" : (mailApiUrl ? "email_otp" : metadata.login_mode || "manual"),
          password: storedCredentials.password,
          totpSecret: storedCredentials.totpSecret,
          ...restoredCredentialFlags(metadata, storedCredentials),
          mailApiUrl,
          mailSeenCandidateKeys: new Set(),
          mailCandidateCounts: new Map(),
          mailStatus: mailApiUrl ? "ready" : "manual",
          mailApiError: null,
          mailPollRunning: false,
          mailPollToken: null,
          currentPhone: metadata.luban_number || null,
          phoneError: null,
          restartRequired: false,
          attempt: 1,
          runId: null,
          runMode: null,
          fallbackInProgress: false,
          ...newLubanState(),
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
        jobs.set(entry.name, {
          id: entry.name,
          email,
          status: "resume_available",
          prompt: "检测到邮箱登录检查点，可以继续手机号绑定",
          createdAt: metadata.created_at || restoredAt,
          updatedAt: metadata.updated_at || restoredAt,
          completedAt: null,
          outputPath,
          checkpointPath,
          logs: `[restore] 已恢复 ${checkpoint.stage || "unknown"} 阶段的登录检查点。\n`,
          lastError: "上次流程在生成授权文件前中断",
          child: null,
          parserTail: "",
          resultSaved: false,
          loginMode: metadata.login_mode === "password" || storedCredentials.password ? "password" : (mailApiUrl ? "email_otp" : metadata.login_mode || "manual"),
          password: storedCredentials.password,
          totpSecret: storedCredentials.totpSecret,
          ...restoredCredentialFlags(metadata, storedCredentials),
          mailApiUrl,
          mailSeenCandidateKeys: new Set(),
          mailCandidateCounts: new Map(),
          mailStatus: mailApiUrl ? "ready" : "manual",
          mailApiError: null,
          mailPollRunning: false,
          mailPollToken: null,
          currentPhone: checkpoint.oauth?.phone || metadata.luban_number || null,
          phoneError: null,
          restartRequired: false,
          attempt: 1,
          runId: null,
          runMode: null,
          fallbackInProgress: false,
          ...restoredLubanState(metadata),
        });
      } catch {
        if (
          !metadata.email
          || !isEmail(metadata.email)
          || !["queued", "starting", "refreshing"].includes(metadata.status)
        ) return;
        const storedCredentials = await loadStoredLoginCredentials(metadata.email);
        const mailApiUrl = validateMailApiUrl(metadata.mail_api_url) ? metadata.mail_api_url : null;
        const restoredAt = metadata.updated_at || new Date().toISOString();
        jobs.set(entry.name, {
          id: entry.name,
          email: metadata.email,
          status: "queued",
          prompt: "服务重启后已恢复，等待任务槽位",
          createdAt: metadata.created_at || restoredAt,
          updatedAt: restoredAt,
          completedAt: null,
          outputPath,
          checkpointPath,
          logs: "[restore] 已恢复排队任务，等待可用任务槽位。\n",
          lastError: null,
          child: null,
          parserTail: "",
          resultSaved: false,
          loginMode: metadata.login_mode === "password" || storedCredentials.password ? "password" : (mailApiUrl ? "email_otp" : metadata.login_mode || "manual"),
          password: storedCredentials.password,
          totpSecret: storedCredentials.totpSecret,
          ...restoredCredentialFlags(metadata, storedCredentials),
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
          queuedMode: metadata.queued_mode === "refresh" ? "refresh" : "full",
          queuedAt: metadata.queued_at || restoredAt,
          queuedStartPrompt: "正在建立登录会话",
          fallbackInProgress: false,
          ...newLubanState(),
        });
      }
    }));
  })().finally(() => {
    outputSyncPromise = null;
  });
  return outputSyncPromise;
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

function normalizeLoginCredentials(value = {}) {
  const password = typeof value.password === "string" ? value.password : "";
  const mailApiUrl = validateMailApiUrl(value.mailApiUrl) ? String(value.mailApiUrl).trim() : null;
  const totpSecret = value.totpSecret ? normalizeTotpSecret(value.totpSecret) : "";
  const loginMode = password ? "password" : "email_otp";
  return { loginMode, mailApiUrl: loginMode === "email_otp" ? mailApiUrl : null, password, totpSecret };
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
    const delimiterAt = line.indexOf("----");
    if (delimiterAt < 0) {
      if (!isEmail(line)) throw httpError(400, `第 ${index + 1} 行邮箱格式错误`);
      return { email: line, loginMode: "email_otp", mailApiUrl: null, password: "", totpSecret: "" };
    }
    if (delimiterAt === 0) throw httpError(400, `第 ${index + 1} 行邮箱格式错误`);
    const email = line.slice(0, delimiterAt).trim();
    const remainder = line.slice(delimiterAt + 4);
    if (!isEmail(email)) throw httpError(400, `第 ${index + 1} 行邮箱格式错误`);

    const lastDelimiterAt = remainder.lastIndexOf("----");
    if (lastDelimiterAt < 0) {
      const loginValue = remainder.trim();
      if (!loginValue) throw httpError(400, `第 ${index + 1} 行密码或收码接口不能为空`);
      if (validateMailApiUrl(loginValue)) {
        return { email, loginMode: "email_otp", mailApiUrl: loginValue, password: "", totpSecret: "" };
      }
      return { email, loginMode: "password", mailApiUrl: null, password: loginValue, totpSecret: "" };
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

async function updateJobCredentials(job, credentials) {
  const normalized = normalizeLoginCredentials(credentials);
  await saveStoredLoginCredentials(job.email, normalized);
  stopMailPolling(job);
  job.loginMode = normalized.loginMode;
  job.mailApiUrl = normalized.mailApiUrl;
  job.password = normalized.password;
  job.totpSecret = normalized.totpSecret;
  job.hasPasswordCredential = Boolean(normalized.password);
  job.hasTotpCredential = Boolean(normalized.totpSecret);
  job.mailSeenCandidateKeys.clear();
  job.mailCandidateCounts.clear();
  job.mailStatus = job.mailApiUrl ? "baseline" : "manual";
  job.mailApiError = null;
  appendJobLog(job, "[account] 登录方式与验证资料已按邮箱唯一键更新，敏感字段未写入日志。\n");
  await saveJobMetadata(job);
  if (job.mailApiUrl) await loadMailboxBaseline(job);
  if (job.status === "email_otp") void beginMailPolling(job);
  touch(job);
}

async function saveJobMetadata(job) {
  job.metadataWritePromise = (job.metadataWritePromise || Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const metadataPath = path.join(path.dirname(job.outputPath), JOB_META_FILENAME);
      const data = {
        version: 1,
        email: job.email,
        status: job.status,
        queued_mode: job.queuedMode || null,
        queued_at: job.queuedAt || null,
        created_at: job.createdAt,
        login_mode: job.loginMode || null,
        has_stored_credentials: Boolean(job.password || job.totpSecret),
        has_password: Boolean(job.password || job.hasPasswordCredential),
        has_totp_key: Boolean(job.totpSecret || job.hasTotpCredential),
        mail_api_url: job.mailApiUrl || null,
        luban_service_id: job.lubanServiceId || null,
        luban_request_id: job.lubanRequestId || null,
        luban_number: job.lubanNumber || null,
        luban_status: job.lubanStatus || null,
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
  if (!password && !totpSecret) {
    await deleteStoredLoginCredentials(email);
    return;
  }
  ensureKeychainAvailable();
  const payload = JSON.stringify({ version: 1, password, totpSecret });
  const result = await runSecurity([
    "add-generic-password",
    "-a",
    keychainAccount(email),
    "-s",
    KEYCHAIN_SERVICE,
    "-U",
    "-w",
  ], `${payload}\n${payload}\n`);
  if (result.code !== 0) {
    throw httpError(500, "无法将密码和 2FA 密钥保存到 macOS Keychain（钥匙串），请先解锁登录钥匙串");
  }
}

async function loadStoredLoginCredentials(email) {
  if (process.platform !== "darwin") return { password: "", totpSecret: "" };
  const result = await runSecurity([
    "find-generic-password",
    "-a",
    keychainAccount(email),
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
  ]);
  if (result.code !== 0) return { password: "", totpSecret: "" };
  try {
    const data = JSON.parse(result.stdout);
    return {
      password: typeof data.password === "string" ? data.password : "",
      totpSecret: data.totpSecret ? normalizeTotpSecret(data.totpSecret) : "",
    };
  } catch {
    return { password: "", totpSecret: "" };
  }
}

async function deleteStoredLoginCredentials(email) {
  if (process.platform !== "darwin") return;
  const result = await runSecurity([
    "delete-generic-password",
    "-a",
    keychainAccount(email),
    "-s",
    KEYCHAIN_SERVICE,
  ]);
  if (![0, 44].includes(result.code)) {
    throw httpError(500, "无法从 macOS Keychain（钥匙串）删除该邮箱的登录凭据");
  }
}

function ensureKeychainAvailable() {
  if (process.platform !== "darwin") {
    throw httpError(501, "持久保存密码和 2FA 密钥目前需要 macOS Keychain（钥匙串）");
  }
}

function keychainAccount(email) {
  return String(email || "").trim().toLowerCase();
}

function runSecurity(args, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-16_384);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.stdin.end(input);
  });
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

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  shuttingDown = true;
  for (const job of jobs.values()) {
    if (isActive(job.status)) cancelJob(job);
  }
  await vite.close();
  server.close(() => process.exit(0));
}
