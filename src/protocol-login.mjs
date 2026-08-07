#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const DEFAULT_CHATGPT_BASE = "https://chatgpt.com";
const DEFAULT_AUTH_BASE = "https://auth.openai.com";
const DEFAULT_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
const DEFAULT_OUT = "tmp/chatgpt-protocol-session.json";
const DEFAULT_SUB2API_OUT = "tmp/sub2api-import-oauth.json";
const DEFAULT_TIMEOUT_MS = 30_000;
const HAR_ADD_PHONE_COOKIE_NAMES = new Set([
  "oai-login-csrf_dev_3772291445",
  "oai-did",
  "rg_context",
  "iss_context",
  "oaicom-stable-id",
  "_cfuvid",
  "cf_clearance",
  "__cf_bm",
  "auth_provider",
  "login_session",
  "hydra_redirect",
  "oai-client-auth-session",
  "oai-client-auth-info",
  "usc_o1a21GmV3HrblEv81QfM5Rd2",
  "unified_session_manifest",
  "auth-session-minimized",
  "auth-session-minimized-client-checksum",
  "__cflb",
  "oai-sc",
  "_dd_s",
]);
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

class CookieJar {
  constructor(cookies = []) {
    this.cookies = Array.isArray(cookies)
      ? cookies.filter(isStoredCookie).map((cookie) => ({ ...cookie }))
      : [];
  }

  setFromResponse(url, headers) {
    for (const line of getSetCookie(headers)) {
      const cookie = parseSetCookie(line, url);
      if (!cookie) continue;
      const idx = this.cookies.findIndex(
        (item) =>
          item.name === cookie.name &&
          item.domain === cookie.domain &&
          item.path === cookie.path,
      );
      if (cookie.expires && cookie.expires <= Date.now()) {
        if (idx >= 0) this.cookies.splice(idx, 1);
        continue;
      }
      if (idx >= 0) this.cookies[idx] = cookie;
      else this.cookies.push(cookie);
    }
  }

  headerFor(url) {
    const target = new URL(url);
    const now = Date.now();
    this.cookies = this.cookies.filter((item) => !item.expires || item.expires > now);
    return this.cookies
      .filter((item) => cookieMatches(item, target))
      .map((item) => `${item.name}=${item.value}`)
      .join("; ");
  }

  namesFor(url) {
    const target = new URL(url);
    const now = Date.now();
    this.cookies = this.cookies.filter((item) => !item.expires || item.expires > now);
    return this.cookies
      .filter((item) => cookieMatches(item, target))
      .map((item) => item.name);
  }

  has(name) {
    return this.cookies.some((item) => item.name === name);
  }

  value(name, url = null) {
    const target = url ? new URL(url) : null;
    const found = this.cookies.find((item) => item.name === name && (!target || cookieMatches(item, target)));
    return found?.value || null;
  }

  toJSON() {
    return this.cookies;
  }

  static fromJSON(cookies) {
    return new CookieJar(cookies);
  }
}

class ProtocolClient {
  constructor(options = {}) {
    this.jar = options.jar || new CookieJar();
    this.verbose = Boolean(options.verbose);
    this.debugAuth = Boolean(options.debugAuth);
  }

  async request(method, url, options = {}) {
    const targetUrl = new URL(url);
    const headers = new Headers(options.headers || {});
    headers.set("user-agent", options.userAgent || UA);
    headers.set("accept-language", "zh-CN,zh;q=0.9,en;q=0.8");
    headers.set("sec-ch-ua", '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"');
    headers.set("sec-ch-ua-mobile", "?0");
    headers.set("sec-ch-ua-platform", '"macOS"');

    if (!headers.has("accept")) {
      headers.set("accept", options.accept || "application/json, text/plain, */*");
    }
    if (options.referer) headers.set("referer", options.referer);
    if (options.origin) headers.set("origin", options.origin);

    const cookie = this.jar.headerFor(url);
    if (cookie) headers.set("cookie", cookie);

    if (
      method !== "GET" &&
      (targetUrl.hostname === "auth.openai.com" || targetUrl.pathname.startsWith("/api/accounts/"))
    ) {
      headers.set("x-access-flow-invocation-id", crypto.randomUUID());
      headers.set("sec-fetch-site", "same-origin");
      headers.set("sec-fetch-mode", "cors");
      headers.set("sec-fetch-dest", "empty");
      headers.set("priority", "u=1, i");
      if (options.json) headers.set("accept", "application/json");
    }

    let body = options.body;
    if (options.json) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.json);
    } else if (options.form) {
      headers.set("content-type", "application/x-www-form-urlencoded");
      body = new URLSearchParams(options.form).toString();
    }

    if (this.verbose) {
      console.error(`> ${method} ${safeUrl(url)}`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
    let res;
    let text;
    try {
      res = await fetch(url, {
        method,
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
      });
      this.jar.setFromResponse(url, res.headers);
      text = await res.text();
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`${method} ${safeUrl(url)} timed out after ${options.timeoutMs || DEFAULT_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const location = res.headers.get("location");
    if (this.verbose) {
      const suffix = location ? ` -> ${safeUrl(new URL(location, url).toString())}` : "";
      console.error(`< ${method} ${safeUrl(url)} ${res.status}${suffix}`);
    }

    return { res, text, location: location ? new URL(location, url).toString() : null, url };
  }

  async follow(url, options = {}) {
    let current = url;
    let last = null;
    for (let i = 0; i < (options.maxRedirects || 12); i += 1) {
      if (isLocalCallback(current)) return { finalUrl: current, last };
      last = await this.request("GET", current, {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        referer: options.referer,
      });
      if (![301, 302, 303, 307, 308].includes(last.res.status) || !last.location) {
        return { finalUrl: current, last };
      }
      current = last.location;
    }
    throw new Error(`Too many redirects from ${url}`);
  }

  async getJson(method, url, options = {}) {
    const result = await this.request(method, url, options);
    assertOk(result, `${method} ${url}`);
    try {
      return { data: JSON.parse(result.text), result };
    } catch {
      throw new Error(`Expected JSON from ${url}, got: ${result.text.slice(0, 160)}`);
    }
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const chatgptBase = trimSlash(args.chatgptBase || process.env.CHATGPT_BASE || DEFAULT_CHATGPT_BASE);
  const authBase = trimSlash(args.authBase || process.env.AUTH_BASE || DEFAULT_AUTH_BASE);
  const outputMode = args.outputMode || "both";
  if (!["both", "session", "sub2api"].includes(outputMode)) {
    throw new Error("--output-mode must be one of: both, session, sub2api");
  }
  const outPath = path.resolve(args.out || DEFAULT_OUT);
  const sub2apiOutPath = path.resolve(args.sub2apiOut || DEFAULT_SUB2API_OUT);
  if (args.refreshSub2api) {
    const sourcePath = path.resolve(args.refreshSub2api);
    const targetPath = path.resolve(args.sub2apiOut || sourcePath);
    const refreshed = await refreshSub2apiOauthExport({
      authBase,
      sourcePath,
      targetPath,
      fallbackClientId: args.codexClientId || DEFAULT_CODEX_CLIENT_ID,
    });
    console.log(`[ok] Saved sub2api import: ${targetPath}`);
    console.log(`[ok] Refreshed OAuth account: ${refreshed.email || "<unknown>"}`);
    return;
  }
  const rl = readline.createInterface({ input, output });
  const checkpointPath = path.resolve(args.checkpoint || args.resumeCheckpoint || `${sub2apiOutPath}.checkpoint.json`);

  try {
    let client = null;
    let email = args.email || "";
    let web = null;
    let codex = null;
    const codexOptions = {
      authBase,
      rl,
      phone: args.phone,
      codexClientId: args.codexClientId || DEFAULT_CODEX_CLIENT_ID,
      codexRedirectUri: args.codexRedirectUri || DEFAULT_CODEX_REDIRECT_URI,
      debugAuth: Boolean(args.debugAuth),
    };
    let checkpoint = null;

    if (args.resumeCheckpoint) {
      try {
        checkpoint = await readProtocolCheckpoint(path.resolve(args.resumeCheckpoint));
      } catch (error) {
        if (error?.code !== "ENOENT") {
          console.log("[resume] Saved login checkpoint is unreadable; restarting email login.");
          await removeProtocolCheckpoint(checkpointPath);
        }
      }
    }
    if (checkpoint && args.webOnly) checkpoint = null;

    if (checkpoint && !args.webOnly) {
      email = checkpoint.email || email;
      client = new ProtocolClient({ verbose: args.verbose, jar: CookieJar.fromJSON(checkpoint.cookies) });
      const saveCheckpoint = createCheckpointWriter(checkpointPath, {
        client,
        email,
        chatgptBase,
        authBase,
      });
      console.log(`[resume] Continue saved login flow from ${checkpoint.stage}.`);
      try {
        codex = await resumeCodexOauth(client, { ...codexOptions, saveCheckpoint }, checkpoint);
        web = checkpoint.web || null;
      } catch (error) {
        if (isSecurityCheckRequiredError(error)) throw error;
        if (!isExpiredCheckpointError(error)) throw error;
        console.log("[auth-expired] Saved login state expired; restarting email login.");
        await removeProtocolCheckpoint(checkpointPath);
        checkpoint = null;
        client = null;
        codex = null;
      }
    }

    let freshLoginRestartCount = 0;
    while (!checkpoint && !codex) {
      client = new ProtocolClient({ verbose: args.verbose });
      email = email || (await ask(rl, "Email: "));
      if (!email) throw new Error("Email is required");

      console.log("[1/5] Start ChatGPT web login");
      web = await loginChatgptWeb(client, {
        chatgptBase,
        authBase,
        email,
        rl,
        password: process.env.CHATGPT_LOGIN_PASSWORD || "",
        totpSecret: process.env.CHATGPT_TOTP_SECRET || "",
      });
      console.log(
        client.jar.has("__Secure-next-auth.session-token")
          ? "[ok] ChatGPT web session cookie received"
          : "[warn] ChatGPT session cookie not found; continue with auth cookies",
      );

      const saveCheckpoint = createCheckpointWriter(checkpointPath, {
        client,
        email,
        chatgptBase,
        authBase,
        web,
      });
      await saveCheckpoint("email_verified", {});
      console.log("[checkpoint] Saved verified email login state.");

      if (!args.webOnly) {
        console.log("[2/5] Start Codex OAuth flow");
        try {
          codex = await runCodexOauth(client, { ...codexOptions, saveCheckpoint });
        } catch (error) {
          if (isSecurityCheckRequiredError(error)) throw error;
          if (!isExpiredCheckpointError(error)) throw error;
          await removeProtocolCheckpoint(checkpointPath);
          if (freshLoginRestartCount >= 1) throw error;
          freshLoginRestartCount += 1;
          console.log("[auth-expired] Newly verified login state was rejected; restarting email login once.");
          client = null;
          web = null;
          codex = null;
          continue;
        }
      }
      break;
    }

    if (outputMode !== "sub2api") {
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(
        outPath,
        JSON.stringify(
          {
            generated_at: new Date().toISOString(),
            chatgpt_base: chatgptBase,
            auth_base: authBase,
            warning: "This file contains login cookies and OAuth data. Do not share it.",
            cookies: client.jar.toJSON(),
            web,
            codex,
          },
          null,
          2,
        ),
      );
      console.log(`[ok] Saved session data: ${outPath}`);
    }

    if (codex?.callbackUrl) {
      console.log("[ok] Codex callback URL:");
      console.log(codex.callbackUrl);
    }
    if (codex?.callbackUrl && codex?.codeVerifier && !args.noSub2apiExport && outputMode !== "session") {
      console.log("[6/6] Convert OAuth callback to sub2api import");
      const sub2apiExport = await buildSub2apiOauthExport({
        authBase,
        callbackUrl: codex.callbackUrl,
        codeVerifier: codex.codeVerifier,
        clientId: args.codexClientId || DEFAULT_CODEX_CLIENT_ID,
        redirectUri: args.codexRedirectUri || DEFAULT_CODEX_REDIRECT_URI,
        accountName: args.sub2apiName,
        concurrency: args.concurrency,
        priority: args.priority,
        rateMultiplier: args.rateMultiplier,
      });
      await fs.mkdir(path.dirname(sub2apiOutPath), { recursive: true });
      await fs.writeFile(sub2apiOutPath, `${JSON.stringify(sub2apiExport.data, null, 2)}\n`);
      await removeProtocolCheckpoint(checkpointPath);
      console.log(`[ok] Saved sub2api import: ${sub2apiOutPath}`);
      console.log(`[ok] Account: ${sub2apiExport.account.name}`);
      console.log(`[ok] Email: ${sub2apiExport.account.credentials.email || "<unknown>"}`);
      console.log(`[ok] chatgpt_account_id: ${mask(sub2apiExport.account.credentials.chatgpt_account_id)}`);
      console.log(`[ok] chatgpt_user_id: ${mask(sub2apiExport.account.extra.chatgpt_user_id)}`);
      console.log("[note] sub2api import JSON contains access_token, refresh_token and id_token. Do not share it.");
    } else if (outputMode === "sub2api") {
      throw new Error("Cannot output only sub2api import without Codex OAuth. Remove --web-only and --no-sub2api-export.");
    } else if (args.webOnly) {
      await removeProtocolCheckpoint(checkpointPath);
    }
  } finally {
    rl.close();
  }
}

async function loginChatgptWeb(client, { chatgptBase, authBase, email, rl, password, totpSecret }) {
  await client.follow(`${chatgptBase}/`, { referer: `${chatgptBase}/` });
  await client.getJson("GET", `${chatgptBase}/api/auth/providers`, {
    referer: `${chatgptBase}/`,
  });

  const { data: csrf } = await client.getJson("GET", `${chatgptBase}/api/auth/csrf`, {
    referer: `${chatgptBase}/`,
  });
  if (!csrf.csrfToken) throw new Error("Missing csrfToken");
  if (!client.jar.has("__Host-next-auth.csrf-token")) {
    throw new Error("Missing __Host-next-auth.csrf-token cookie; open the ChatGPT home page first or retry.");
  }

  const deviceId = client.jar.value("oai-did", `${chatgptBase}/`) || crypto.randomUUID();
  const authSessionLoggingId = crypto.randomUUID();
  const signinUrl =
    `${chatgptBase}/api/auth/signin/openai?` +
    new URLSearchParams({
      prompt: "login",
      "ext-oai-did": deviceId,
      auth_session_logging_id: authSessionLoggingId,
      screen_hint: "login_or_signup",
      login_hint: email,
    }).toString();

  const { data: signin } = await client.getJson("POST", signinUrl, {
    origin: chatgptBase,
    referer: `${chatgptBase}/`,
    form: {
      callbackUrl: `${chatgptBase}/`,
      csrfToken: csrf.csrfToken,
      json: "true",
    },
  });
  if (!signin.url) throw new Error("signin/openai did not return url");

  const authPage = await client.follow(signin.url, { referer: `${chatgptBase}/` });
  console.log(`[info] Auth page: ${safeUrl(authPage.finalUrl)}`);
  if (authPage.last?.text) {
    console.log(`[info] Page text: ${summarizeHtml(authPage.last.text)}`);
  }

  let authenticated;
  let loginMethod;
  if (isPasswordLoginPage(authPage.finalUrl)) {
    loginMethod = "password";
    console.log("[3/5] Password login page reached.");
    authenticated = await verifyPassword(client, {
      authBase,
      rl,
      password,
      referer: authPage.finalUrl,
    });
  } else {
    loginMethod = "email_otp";
    console.log("[3/5] Email OTP page reached. Enter code, or type r to resend.");
    const emailCode = await askEmailOtp(rl, client, authBase);
    const { data } = await authJsonStep(client, authBase, "POST", "/api/accounts/email-otp/validate", {
      code: emailCode,
    }, { referer: authPage.finalUrl });
    authenticated = data;
  }

  const mfaRequired = isMfaChallengePayload(authenticated);
  authenticated = await completeTotpMfaIfNeeded(client, {
    authBase,
    rl,
    payload: authenticated,
    totpSecret,
    referer: authPage.finalUrl,
  });
  authenticated = await selectChatgptLoginWorkspaceIfNeeded(client, {
    authBase,
    payload: authenticated,
  });
  const callback = await continueFlow(client, authenticated);
  return {
    deviceId,
    authSessionLoggingId,
    callbackUrl: callback?.finalUrl || null,
    emailVerified: true,
    loginMethod,
    mfaVerified: mfaRequired,
  };
}

async function selectChatgptLoginWorkspaceIfNeeded(client, { authBase, payload }) {
  if (!isWorkspaceSelectionPayload(payload)) return payload;
  const workspaces = payload?.["oai-client-auth-session"]?.workspaces;
  const workspaceId = Array.isArray(workspaces) ? workspaces.find((item) => item?.id)?.id : null;
  if (!workspaceId) {
    console.log("[web] Workspace page did not include a selectable workspace; skipping selection.");
    return payload;
  }
  const workspaceUrl = getContinueUrl(payload) || `${authBase}/workspace`;
  console.log("[web] Select ChatGPT login workspace");
  const { data } = await authJsonStep(client, authBase, "POST", "/api/accounts/workspace/select", {
    workspace_id: workspaceId,
  }, { referer: workspaceUrl });
  return data;
}

async function verifyPassword(client, { authBase, rl, password, referer }) {
  let nextPassword = password;
  for (;;) {
    const value = nextPassword || (await ask(rl, "Password (q=quit): "));
    nextPassword = "";
    if (!value || value.toLowerCase() === "q") throw new Error("Stopped before password validation");
    try {
      const { data } = await authJsonStep(client, authBase, "POST", "/api/accounts/password/verify", {
        password: value,
      }, { referer });
      console.log("[ok] Password accepted");
      return data;
    } catch (error) {
      if (!/HTTP 401|invalid.*password|incorrect.*password/i.test(String(error?.message || ""))) throw error;
      console.log("[warn] Password was rejected. Enter it again, or q to quit.");
    }
  }
}

async function completeTotpMfaIfNeeded(client, { authBase, rl, payload, totpSecret, referer }) {
  if (!isMfaChallengePayload(payload)) return payload;
  const factor = pickTotpFactor(payload);
  if (!factor?.id) throw new Error("2FA is required, but the response does not contain a TOTP factor ID");

  console.log("[mfa] TOTP 2FA challenge reached.");
  await authJsonStep(client, authBase, "POST", "/api/accounts/mfa/issue_challenge", {
    type: "totp",
    id: factor.id,
    force_fresh_challenge: false,
  }, { referer });

  let code;
  let generatedFromSecret = false;
  if (totpSecret) {
    code = generateTotp(totpSecret);
    generatedFromSecret = true;
    console.log("[mfa] Generated a 6-digit code from the configured 2FA key.");
  } else {
    code = await askTotpOtp(rl);
  }
  const challengeUrl = getContinueUrl(payload) || `${authBase}/mfa-challenge/${factor.id}`;
  for (;;) {
    try {
      const { data } = await authJsonStep(client, authBase, "POST", "/api/accounts/mfa/verify", {
        type: "totp",
        id: factor.id,
        code,
      }, { referer: challengeUrl });
      console.log("[ok] 2FA verification accepted");
      return data;
    } catch (error) {
      if (!/HTTP (400|401)|invalid.*(?:totp|code)|incorrect.*code/i.test(String(error?.message || ""))) throw error;
      console.log(
        generatedFromSecret
          ? "[warn] The code generated from the configured 2FA key was rejected; enter a current code manually."
          : "[warn] The 2FA code was rejected; enter a new code.",
      );
      generatedFromSecret = false;
      code = await askTotpOtp(rl);
    }
  }
}

function isPasswordLoginPage(url) {
  try {
    return new URL(url).pathname === "/log-in/password";
  } catch {
    return false;
  }
}

function isMfaChallengePayload(payload) {
  if (payload?.page?.type === "mfa_challenge") return true;
  try {
    return new URL(getContinueUrl(payload)).pathname.startsWith("/mfa-challenge/");
  } catch {
    return false;
  }
}

function isWorkspaceSelectionPayload(payload) {
  if (payload?.page?.type === "workspace") return true;
  try {
    return new URL(getContinueUrl(payload)).pathname === "/workspace";
  } catch {
    return false;
  }
}

function pickTotpFactor(payload) {
  const session = payload?.["oai-client-auth-session"] || {};
  const factors = [
    ...(Array.isArray(session.mfa_challenge_factors) ? session.mfa_challenge_factors : []),
    ...(Array.isArray(session.mfa_factors) ? session.mfa_factors : []),
  ];
  return factors.find((factor) => factor?.factor_type === "totp" && typeof factor.id === "string") || null;
}

async function askTotpOtp(rl) {
  for (;;) {
    const value = await ask(rl, "2FA OTP (6 digits, q=quit): ");
    if (value.toLowerCase() === "q") throw new Error("Stopped before 2FA validation");
    if (/^\d{6}$/.test(value)) return value;
    console.log("[warn] 2FA OTP should be exactly 6 digits.");
  }
}

function generateTotp(secret, timestamp = Date.now()) {
  const key = decodeBase32Secret(secret);
  const counter = BigInt(Math.floor(timestamp / 30_000));
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);
  const digest = crypto.createHmac("sha1", key).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

function decodeBase32Secret(value) {
  const normalized = String(value || "").toUpperCase().replace(/[\s=]/g, "");
  if (!/^[A-Z2-7]{16,128}$/.test(normalized)) {
    throw new Error("2FA key must be a Base32 string containing only A-Z and 2-7");
  }
  let bits = "";
  for (const char of normalized) {
    const index = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char);
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

async function runCodexOauth(client, options) {
  const codeVerifier = base64Url(crypto.randomBytes(48));
  const codeChallenge = base64Url(crypto.createHash("sha256").update(codeVerifier).digest());
  const state = base64Url(crypto.randomBytes(24));
  const authUrl =
    `${options.authBase}/oauth/authorize?` +
    new URLSearchParams({
      client_id: options.codexClientId,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      codex_cli_simplified_flow: "true",
      id_token_add_organizations: "true",
      redirect_uri: options.codexRedirectUri,
      response_type: "code",
      scope: "openid profile email offline_access",
      state,
    }).toString();

  const authorized = await client.follow(authUrl);
  if (isLocalCallback(authorized.finalUrl)) {
    const result = { callbackUrl: authorized.finalUrl, codeVerifier, state };
    await options.saveCheckpoint?.("callback_ready", { oauth: result });
    return result;
  }

  const html = authorized.last?.text || "";
  const sessionId = extractFirstSessionId(html);
  if (!sessionId) {
    if (isAuthLoginPage(authorized.finalUrl)) {
      throw new Error(
        "CODEX_AUTH_LOGIN_REQUIRED: Codex authorization returned to the login page because the ChatGPT web session is missing or expired.",
      );
    }
    throw new Error(
      "SESSION_SELECTION_INVALID: Could not find a us_ account session on choose-account page. " +
        "The authorization page may require a browser security check.",
    );
  }
  if (options.debugAuth || client.verbose) {
    console.log(`[debug] selected account session_id: ${maskSessionId(sessionId)}`);
  }

  const { data: selected } = await authJsonStep(client, options.authBase, "POST", "/api/accounts/session/select", {
    session_id: sessionId,
  }, { referer: `${options.authBase}/choose-an-account` });
  let current = selected;
  const addPhoneUrl = getContinueUrl(selected);
  const oauth = { codeVerifier, state, sessionId, addPhoneUrl };
  if (options.debugAuth) {
    logAuthSnapshot(client, "session/select", `${options.authBase}/api/accounts/session/select`, HAR_ADD_PHONE_COOKIE_NAMES);
    console.log(`[debug] session/select continue_url: ${addPhoneUrl || "<none>"}`);
  }

  if (isPhoneBindingRequired(current)) {
    await options.saveCheckpoint?.("phone_required", { oauth });
    current = await bindPhoneIfNeeded(client, { ...options, checkpointOauth: oauth }, current, addPhoneUrl);
  } else if (hasWorkspace(current)) {
    console.log("[4/5] Existing workspace/session selected; phone binding was not requested");
  } else if (isLocalCallback(getContinueUrl(current))) {
    console.log("[4/5] Account selected; phone binding and workspace selection were not requested");
  } else {
    throw unexpectedSessionSelectionError(current);
  }

  await options.saveCheckpoint?.("oauth_continue", { oauth: { ...oauth, current } });
  return finishCodexOauth(client, options, current, oauth);
}

async function resumeCodexOauth(client, options, checkpoint) {
  if (checkpoint.stage === "email_verified") {
    console.log("[resume] Email login is still available; starting Codex OAuth without a new email code.");
    return runCodexOauth(client, options);
  }

  const oauth = checkpoint.oauth || {};
  if (!oauth.codeVerifier || !oauth.state) throw new Error("CHECKPOINT_INVALID: missing OAuth PKCE state");
  if (checkpoint.stage === "callback_ready" && oauth.callbackUrl) {
    return {
      callbackUrl: oauth.callbackUrl,
      codeVerifier: oauth.codeVerifier,
      state: oauth.state,
      workspaceId: oauth.workspaceId || null,
    };
  }

  if (checkpoint.stage === "oauth_continue" && oauth.current) {
    return finishCodexOauth(client, options, oauth.current, oauth);
  }

  if (["phone_required", "phone_otp"].includes(checkpoint.stage)) {
    if (!isPhoneBindingUrl(oauth.addPhoneUrl)) {
      throw new Error("SESSION_SELECTION_INVALID: saved phone checkpoint does not point to an add-phone page");
    }
    console.log("[resume] Email verification already completed; continuing phone binding.");
    const current = await bindPhoneIfNeeded(
      client,
      {
        ...options,
        checkpointOauth: oauth,
        resumePhone: checkpoint.stage === "phone_otp"
          ? { phone: oauth.phone, phoneReferer: oauth.phoneReferer }
          : null,
      },
      null,
      oauth.addPhoneUrl,
    );
    await options.saveCheckpoint?.("oauth_continue", { oauth: { ...oauth, current, phone: null, phoneReferer: null } });
    return finishCodexOauth(client, options, current, oauth);
  }

  throw new Error(`CHECKPOINT_INVALID: unsupported stage ${checkpoint.stage || "unknown"}`);
}

async function finishCodexOauth(client, options, initial, oauth) {
  let current = initial;

  const workspaceId = pickWorkspaceId(current);
  if (workspaceId) {
    console.log("[5/5] Select workspace");
    const consentUrl = getContinueUrl(current);
    const consentReferer = consentUrl || `${options.authBase}/sign-in-with-chatgpt/codex/consent`;
    const selectedWorkspace = await authJsonStep(client, options.authBase, "POST", "/api/accounts/workspace/select", {
      workspace_id: workspaceId,
    }, { referer: consentReferer });
    current = selectedWorkspace.data;
  }

  const continued = await continueFlow(client, current);
  const result = {
    callbackUrl: continued?.finalUrl || current?.continue_url || null,
    codeVerifier: oauth.codeVerifier,
    state: oauth.state,
    workspaceId: workspaceId || null,
  };
  await options.saveCheckpoint?.("callback_ready", { oauth: result });
  return result;
}

async function bindPhoneIfNeeded(client, options, current, addPhoneUrl) {
  console.log("[4/5] Phone binding is required");
  const addPhonePageUrl = addPhoneUrl || `${options.authBase}/add-phone`;
  const addPhoneReferer = await prepareAddPhonePage(client, addPhonePageUrl);
  if (options.debugAuth) {
    console.log(`[debug] add-phone referer: ${addPhoneReferer}`);
    logAuthSnapshot(client, "before add-phone/send", `${options.authBase}/api/accounts/add-phone/send`, HAR_ADD_PHONE_COOKIE_NAMES);
    const sessionKeys = Object.keys(current?.["oai-client-auth-session"] || {});
    console.log(`[debug] session keys: ${sessionKeys.join(", ")}`);
  }

  let nextPhone = options.phone || "";
  let resumePhone = options.resumePhone || null;
  for (;;) {
    let phone;
    let phoneReferer;
    if (resumePhone?.phone && resumePhone?.phoneReferer) {
      phone = resumePhone.phone;
      phoneReferer = resumePhone.phoneReferer;
      resumePhone = null;
      console.log(`[resume] Continue waiting for the SMS sent to ${phone}.`);
    } else {
      phone = nextPhone || (await ask(options.rl, "Phone number, E.164 format (p=quit): "));
      nextPhone = "";
      if (!phone || phone.toLowerCase() === "p" || phone.toLowerCase() === "q") {
        throw new Error("Stopped before phone binding");
      }

      const sent = await trySendPhoneOtp(client, options.authBase, phone, addPhoneReferer);
      if (!sent.ok) {
        const sendError = new Error(sent.message);
        if (isAddPhoneSecurityCheckError(sendError)) throw securityCheckRequiredError();
        if (isExpiredCheckpointError(sendError)) throw sendError;
        console.log(`[warn] Could not send SMS to ${phone}: ${sent.message}`);
        console.log("[info] Enter another phone number, or q to quit.");
        continue;
      }
      const phoneUrl = getContinueUrl(sent.data);
      phoneReferer = phoneUrl || `${options.authBase}/phone-verification`;
      await options.saveCheckpoint?.("phone_otp", {
        oauth: { ...options.checkpointOauth, phone, phoneReferer },
      });
    }
    for (;;) {
      const phoneCode = await ask(options.rl, "Phone OTP (r=resend, p=change phone, q=quit): ");
      const lower = phoneCode.toLowerCase();
      if (lower === "q") throw new Error("Stopped before phone OTP validation");
      if (lower === "p") {
        console.log("[info] Change phone number.");
        await options.saveCheckpoint?.("phone_required", { oauth: options.checkpointOauth });
        break;
      }
      if (lower === "r") {
        const resent = await trySendPhoneOtp(client, options.authBase, phone, addPhoneReferer);
        if (resent.ok) {
          console.log("[ok] SMS resend request accepted.");
        } else {
          const resendError = new Error(resent.message);
          if (isAddPhoneSecurityCheckError(resendError)) throw securityCheckRequiredError();
          if (isExpiredCheckpointError(resendError)) throw resendError;
          console.log(`[warn] SMS resend failed: ${resent.message}`);
          console.log("[info] Use p to change phone number, or q to quit.");
        }
        continue;
      }
      if (!/^\d{4,8}$/.test(phoneCode)) {
        console.log("[warn] Phone OTP should be digits, or type r/p/q.");
        continue;
      }

      const validated = await tryValidatePhoneOtp(client, options.authBase, phoneCode, phoneReferer);
      if (validated.ok) return validated.data;
      if (isExpiredCheckpointError(new Error(validated.message))) {
        throw new Error(validated.message);
      }

      console.log(`[warn] Phone OTP validation failed: ${validated.message}`);
      console.log("[info] Enter another code, r to resend, p to change phone, or q to quit.");
    }
  }
}

async function trySendPhoneOtp(client, authBase, phone, referer) {
  const primary = await postAddPhoneSend(client, authBase, phone, referer, {
    phone_number: phone,
    channel: "sms",
  });
  if (primary.ok) return primary;

  if (shouldRetryAddPhoneWithoutChannel(primary.message)) {
    const fallback = await postAddPhoneSend(client, authBase, phone, referer, {
      phone_number: phone,
    });
    if (fallback.ok) {
      console.log("[info] add-phone/send accepted without channel field.");
      return fallback;
    }
    return {
      ok: false,
      message: `${primary.message}; fallback without channel also failed: ${fallback.message}`,
    };
  }

  return primary;
}

async function postAddPhoneSend(client, authBase, phone, referer, payload) {
  try {
    const { data } = await authJsonStep(client, authBase, "POST", "/api/accounts/add-phone/send", payload, { referer });
    return { ok: true, data };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

async function tryValidatePhoneOtp(client, authBase, code, referer) {
  try {
    const { data } = await authJsonStep(client, authBase, "POST", "/api/accounts/phone-otp/validate", {
      code,
    }, { referer });
    return { ok: true, data };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

async function authJsonStep(client, authBase, method, pathname, body, options = {}) {
  return client.getJson(method, `${authBase}${pathname}`, {
    origin: authBase,
    referer: options.referer || `${authBase}/`,
    json: body,
  });
}

async function prepareAddPhonePage(client, addPhoneUrl) {
  const opened = await client.follow(addPhoneUrl, { referer: addPhoneUrl });
  return opened.finalUrl || addPhoneUrl;
}

async function buildSub2apiOauthExport({
  authBase,
  callbackUrl,
  codeVerifier,
  clientId,
  redirectUri,
  accountName,
  concurrency,
  priority,
  rateMultiplier,
}) {
  const callback = new URL(callbackUrl);
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("Codex callback URL does not contain OAuth code.");

  const tokenSet = await exchangeOAuthCode({
    authBase,
    clientId,
    code,
    codeVerifier,
    redirectUri,
  });

  const claims = decodeJwtPayload(tokenSet.id_token);
  const authClaims = claims["https://api.openai.com/auth"] || {};
  const email = claims.email || "";
  const chatgptAccountId = claims.sid || "";
  const chatgptUserId = authClaims.user_id || claims.sub || "";
  const account = {
    name: accountName || buildAccountName(email),
    platform: "openai",
    type: "oauth",
    credentials: {
      access_token: tokenSet.access_token,
      chatgpt_account_id: chatgptAccountId,
      email,
      id_token: tokenSet.id_token,
      refresh_token: tokenSet.refresh_token,
    },
    extra: {
      account_id: chatgptAccountId,
      chatgpt_account_id: chatgptAccountId,
      chatgpt_user_id: chatgptUserId,
      client_id: clientId,
      email,
      openai_long_context_billing_enabled: false,
      openai_oauth_responses_websockets_v2_enabled: false,
      openai_oauth_responses_websockets_v2_mode: "off",
      privacy_mode: "training_set_failed",
    },
    concurrency: Number(concurrency || 10),
    priority: Number(priority || 1),
    rate_multiplier: Number(rateMultiplier || 1),
    auto_pause_on_expired: true,
  };

  return {
    account,
    data: {
      type: "sub2api-data",
      version: 1,
      exported_at: new Date().toISOString(),
      proxies: [],
      accounts: [account],
    },
  };
}

async function exchangeOAuthCode({ authBase, clientId, code, codeVerifier, redirectUri }) {
  const res = await fetch(`${authBase}/oauth/token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": UA,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Token endpoint returned non-JSON HTTP ${res.status}: ${text.slice(0, 180)}`);
  }
  if (!res.ok) {
    const message = data?.error_description || data?.error || JSON.stringify(data).slice(0, 180);
    throw new Error(`Token exchange failed with HTTP ${res.status}: ${message}`);
  }
  for (const key of ["access_token", "refresh_token", "id_token"]) {
    if (!data[key]) throw new Error(`Token response missing ${key}.`);
  }
  return data;
}

async function refreshSub2apiOauthExport({ authBase, sourcePath, targetPath, fallbackClientId }) {
  let data;
  try {
    data = JSON.parse(await fs.readFile(sourcePath, "utf8"));
  } catch (error) {
    throw new Error(`REFRESH_TOKEN_INVALID: 无法读取原 sub2api 文件：${error.message}`);
  }
  const account = data?.accounts?.[0];
  const credentials = account?.credentials;
  const refreshToken = credentials?.refresh_token;
  const clientId = account?.extra?.client_id || fallbackClientId;
  if (data?.type !== "sub2api-data" || !account || !refreshToken) {
    throw new Error("REFRESH_TOKEN_INVALID: 原文件缺少 OAuth 账号或 refresh_token");
  }

  const tokenSet = await refreshOAuthToken({ authBase, clientId, refreshToken });
  credentials.access_token = tokenSet.access_token;
  credentials.refresh_token = tokenSet.refresh_token || refreshToken;
  if (tokenSet.id_token) credentials.id_token = tokenSet.id_token;

  if (credentials.id_token) {
    try {
      const claims = decodeJwtPayload(credentials.id_token);
      const authClaims = claims["https://api.openai.com/auth"] || {};
      const accountId = claims.sid || credentials.chatgpt_account_id || "";
      const userId = authClaims.user_id || claims.sub || account?.extra?.chatgpt_user_id || "";
      const email = claims.email || credentials.email || account?.extra?.email || "";
      credentials.chatgpt_account_id = accountId;
      credentials.email = email;
      account.extra = {
        ...(account.extra || {}),
        account_id: accountId,
        chatgpt_account_id: accountId,
        chatgpt_user_id: userId,
        client_id: clientId,
        email,
      };
      if (email) account.name = buildAccountName(email);
    } catch {
      // Keep the existing account metadata if the provider omits or changes the ID token format.
    }
  }

  data.type = "sub2api-data";
  data.version = 1;
  data.exported_at = new Date().toISOString();
  if (!Array.isArray(data.proxies)) data.proxies = [];
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`);
  await fs.rename(tempPath, targetPath);
  return { email: credentials.email || "" };
}

async function refreshOAuthToken({ authBase, clientId, refreshToken }) {
  const res = await fetch(`${authBase}/oauth/token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": UA,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`REFRESH_TOKEN_INVALID: OAuth 刷新接口返回非 JSON，HTTP ${res.status}`);
  }
  if (!res.ok) {
    const message = data?.error_description || data?.error?.message || data?.error || "刷新令牌已失效";
    throw new Error(`REFRESH_TOKEN_INVALID: OAuth 刷新失败，HTTP ${res.status}：${String(message).slice(0, 180)}`);
  }
  if (!data.access_token) throw new Error("REFRESH_TOKEN_INVALID: OAuth 刷新响应缺少 access_token");
  return data;
}

async function askEmailOtp(rl, client, authBase) {
  for (;;) {
    const value = await ask(rl, "Email OTP (r=resend, q=quit): ");
    if (value.toLowerCase() === "q") throw new Error("Stopped before email OTP validation");
    if (value.toLowerCase() === "r") {
      console.log("[info] Resending email OTP...");
      await resendEmailOtp(client, authBase);
      console.log("[ok] Resend request accepted. Check inbox and spam folder.");
      continue;
    }
    if (/^\d{6}$/.test(value)) return value;
    console.log("[warn] Email OTP should be 6 digits, or type r to resend.");
  }
}

async function resendEmailOtp(client, authBase) {
  const result = await client.request("POST", `${authBase}/api/accounts/email-otp/resend`, {
    origin: authBase,
    referer: `${authBase}/email-verification`,
    headers: {
      accept: "application/json, text/plain, */*",
    },
  });
  if (result.res.status === 429) {
    throw new Error("Too many email OTP resend attempts. Wait a while before retrying.");
  }
  assertOk(result, `POST ${authBase}/api/accounts/email-otp/resend`);
}

async function continueFlow(client, payload) {
  const url = payload?.continue_url || payload?.page?.payload?.url;
  if (!url) return null;
  if (isLocalCallback(url)) return { finalUrl: url, last: null };
  return client.follow(url);
}

function getContinueUrl(payload) {
  return payload?.continue_url || payload?.page?.payload?.url || null;
}

function logAuthSnapshot(client, label, url, expectedNames) {
  const actualNames = new Set(client.jar.namesFor(url));
  const actualSorted = [...actualNames].sort();
  const missing = [...expectedNames].filter((name) => !actualNames.has(name)).sort();
  const extra = actualSorted.filter((name) => !expectedNames.has(name)).sort();
  console.log(`[debug] ${label} cookie names: ${actualSorted.join(", ")}`);
  console.log(`[debug] ${label} missing vs HAR: ${missing.length ? missing.join(", ") : "<none>"}`);
  console.log(`[debug] ${label} extra vs HAR: ${extra.length ? extra.join(", ") : "<none>"}`);
  console.log(`[debug] ${label} target: ${url}`);
}

function extractFirstSessionId(html) {
  const text = decodeHtml(html);
  return (
    /"session_id"\s*:\s*"(us_[^"]+)"/.exec(text)?.[1] ||
    /session_id\\",\\"(us_[^"\\]+)/.exec(text)?.[1] ||
    /name="session_id"[^>]+value="(us_[^"]+)"/.exec(text)?.[1] ||
    /value="(us_[^"]+)"[^>]+name="session_id"/.exec(text)?.[1] ||
    /\bus_[A-Za-z0-9_-]{10,}\b/.exec(text)?.[0] ||
    null
  );
}

function maskSessionId(value) {
  if (!value || value.length <= 10) return "<redacted>";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function mask(value) {
  if (!value) return "<none>";
  if (value.length <= 12) return "<redacted>";
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function decodeJwtPayload(jwt) {
  const [, payload] = String(jwt).split(".");
  if (!payload) throw new Error("Invalid id_token JWT.");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

function buildAccountName(email) {
  return email ? `oauth---${email}` : `oauth---${new Date().toISOString()}`;
}

function pickWorkspaceId(payload) {
  const workspaces = payload?.["oai-client-auth-session"]?.workspaces;
  if (!Array.isArray(workspaces) || workspaces.length === 0) return null;
  const personal = workspaces.find((item) => item.kind === "personal");
  return (personal || workspaces[0]).id || null;
}

function hasWorkspace(payload) {
  const workspaces = payload?.["oai-client-auth-session"]?.workspaces;
  return Array.isArray(workspaces) && workspaces.length > 0;
}

function isPhoneBindingRequired(payload) {
  return payload?.page?.type === "add_phone" || isPhoneBindingUrl(getContinueUrl(payload));
}

function isPhoneBindingUrl(value) {
  try {
    return new URL(value).pathname === "/add-phone";
  } catch {
    return false;
  }
}

function unexpectedSessionSelectionError(payload) {
  let continuePath = "<none>";
  try {
    continuePath = new URL(getContinueUrl(payload)).pathname;
  } catch {}
  const pageType = payload?.page?.type || "<none>";
  return new Error(
    `SESSION_SELECTION_INVALID: session/select returned page=${pageType}, continue_path=${continuePath}; ` +
      "the selected account session is not ready for Codex authorization",
  );
}

function assertOk(result, label) {
  const { res, text } = result;
  if (res.status >= 200 && res.status < 300) return;
  const body = text.replace(/\s+/g, " ").slice(0, 220);
  throw new Error(`${label} failed with HTTP ${res.status}: ${body}`);
}

function getSetCookie(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const combined = headers.get("set-cookie");
  if (!combined) return [];
  return combined.split(/,(?=\s*[^;,=\s]+=)/g).map((item) => item.trim());
}

function parseSetCookie(line, requestUrl) {
  const target = new URL(requestUrl);
  const parts = line.split(";").map((part) => part.trim());
  const [nameValue, ...attrs] = parts;
  const splitAt = nameValue.indexOf("=");
  if (splitAt <= 0) return null;
  const cookie = {
    name: nameValue.slice(0, splitAt),
    value: nameValue.slice(splitAt + 1),
    domain: target.hostname,
    path: "/",
    secure: false,
    expires: null,
  };
  for (const attr of attrs) {
    const [rawKey, ...rawValue] = attr.split("=");
    const key = rawKey.toLowerCase();
    const value = rawValue.join("=");
    if (key === "domain" && value) cookie.domain = value.replace(/^\./, "").toLowerCase();
    if (key === "path" && value) cookie.path = value;
    if (key === "secure") cookie.secure = true;
    if (key === "expires" && value) {
      const expires = Date.parse(value);
      if (!Number.isNaN(expires)) cookie.expires = expires;
    }
    if (key === "max-age" && value) {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) cookie.expires = Date.now() + seconds * 1000;
    }
  }
  return cookie;
}

function cookieMatches(cookie, target) {
  const domain = cookie.domain.toLowerCase();
  const host = target.hostname.toLowerCase();
  const domainOk = host === domain || host.endsWith(`.${domain}`);
  const pathOk = target.pathname.startsWith(cookie.path || "/");
  const secureOk = !cookie.secure || target.protocol === "https:";
  return domainOk && pathOk && secureOk;
}

function isStoredCookie(cookie) {
  return Boolean(
    cookie &&
    typeof cookie === "object" &&
    typeof cookie.name === "string" &&
    typeof cookie.value === "string" &&
    typeof cookie.domain === "string" &&
    (!cookie.expires || Number.isFinite(Number(cookie.expires))),
  );
}

function createCheckpointWriter(checkpointPath, context) {
  return async (stage, payload = {}) => {
    const data = {
      version: 1,
      stage,
      updated_at: new Date().toISOString(),
      email: context.email,
      chatgpt_base: context.chatgptBase,
      auth_base: context.authBase,
      warning: "This file contains login cookies and OAuth state. Do not share it.",
      cookies: context.client.jar.toJSON(),
      web: context.web || null,
      ...payload,
    };
    await writePrivateJson(checkpointPath, data);
  };
}

async function readProtocolCheckpoint(checkpointPath) {
  const data = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
  if (
    data?.version !== 1 ||
    typeof data.stage !== "string" ||
    typeof data.email !== "string" ||
    !Array.isArray(data.cookies)
  ) {
    throw new Error("CHECKPOINT_INVALID: malformed login checkpoint");
  }
  return data;
}

async function writePrivateJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, 0o600);
}

async function removeProtocolCheckpoint(checkpointPath) {
  try {
    await fs.unlink(checkpointPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function isExpiredCheckpointError(error) {
  return /CHECKPOINT_INVALID|SESSION_SELECTION_INVALID|CODEX_AUTH_LOGIN_REQUIRED|invalid_state|no longer valid|session.+(?:invalid|expired)|expired.+session/i.test(
    String(error?.message || ""),
  );
}

function isAddPhoneSecurityCheckError(error) {
  const message = String(error?.message || "");
  return (
    message.includes("/api/accounts/add-phone/send") &&
    /HTTP 409/i.test(message) &&
    /invalid_state|no longer valid/i.test(message)
  );
}

function shouldRetryAddPhoneWithoutChannel(message) {
  const text = String(message || "");
  return (
    text.includes("/api/accounts/add-phone/send") &&
    /HTTP (400|409)/i.test(text) &&
    /channel|invalid_state|no longer valid|session/i.test(text)
  );
}

function securityCheckRequiredError() {
  return new Error(
    "[security-check-required] Phone binding was rejected because the browser security-check state is missing. " +
      "The verified email checkpoint was kept, but repeating email login will not fix this response.",
  );
}

function isSecurityCheckRequiredError(error) {
  return String(error?.message || "").includes("[security-check-required]");
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--help" || item === "-h") args.help = true;
    else if (item === "--verbose" || item === "-v") args.verbose = true;
    else if (item === "--debug-auth") args.debugAuth = true;
    else if (item === "--web-only") args.webOnly = true;
    else if (item.startsWith("--email=")) args.email = item.slice("--email=".length);
    else if (item === "--email") args.email = argv[++i];
    else if (item.startsWith("--phone=")) args.phone = item.slice("--phone=".length);
    else if (item === "--phone") args.phone = argv[++i];
    else if (item.startsWith("--out=")) args.out = item.slice("--out=".length);
    else if (item === "--out") args.out = argv[++i];
    else if (item.startsWith("--sub2api-out=")) args.sub2apiOut = item.slice("--sub2api-out=".length);
    else if (item === "--sub2api-out") args.sub2apiOut = argv[++i];
    else if (item.startsWith("--output-mode=")) args.outputMode = item.slice("--output-mode=".length);
    else if (item === "--output-mode") args.outputMode = argv[++i];
    else if (item === "--no-sub2api-export") args.noSub2apiExport = true;
    else if (item.startsWith("--refresh-sub2api=")) args.refreshSub2api = item.slice("--refresh-sub2api=".length);
    else if (item === "--refresh-sub2api") args.refreshSub2api = argv[++i];
    else if (item.startsWith("--checkpoint=")) args.checkpoint = item.slice("--checkpoint=".length);
    else if (item === "--checkpoint") args.checkpoint = argv[++i];
    else if (item.startsWith("--resume-checkpoint=")) args.resumeCheckpoint = item.slice("--resume-checkpoint=".length);
    else if (item === "--resume-checkpoint") args.resumeCheckpoint = argv[++i];
    else if (item.startsWith("--sub2api-name=")) args.sub2apiName = item.slice("--sub2api-name=".length);
    else if (item === "--sub2api-name") args.sub2apiName = argv[++i];
    else if (item.startsWith("--concurrency=")) args.concurrency = item.slice("--concurrency=".length);
    else if (item === "--concurrency") args.concurrency = argv[++i];
    else if (item.startsWith("--priority=")) args.priority = item.slice("--priority=".length);
    else if (item === "--priority") args.priority = argv[++i];
    else if (item.startsWith("--rate-multiplier=")) args.rateMultiplier = item.slice("--rate-multiplier=".length);
    else if (item === "--rate-multiplier") args.rateMultiplier = argv[++i];
    else if (item.startsWith("--chatgpt-base=")) args.chatgptBase = item.slice("--chatgpt-base=".length);
    else if (item === "--chatgpt-base") args.chatgptBase = argv[++i];
    else if (item.startsWith("--auth-base=")) args.authBase = item.slice("--auth-base=".length);
    else if (item === "--auth-base") args.authBase = argv[++i];
    else if (item.startsWith("--codex-client-id=")) args.codexClientId = item.slice("--codex-client-id=".length);
    else if (item === "--codex-client-id") args.codexClientId = argv[++i];
    else if (item.startsWith("--codex-redirect-uri=")) {
      args.codexRedirectUri = item.slice("--codex-redirect-uri=".length);
    } else if (item === "--codex-redirect-uri") args.codexRedirectUri = argv[++i];
    else throw new Error(`Unknown argument: ${item}`);
  }
  return args;
}

async function ask(rl, prompt) {
  return (await rl.question(prompt)).trim();
}

function trimSlash(value) {
  return value.replace(/\/+$/, "");
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function safeUrl(url) {
  try {
    const parsed = new URL(url);
    for (const key of parsed.searchParams.keys()) {
      if (/code|token|state|csrf|nonce|otp|email|phone|login_hint|challenge/i.test(key)) {
        parsed.searchParams.set(key, "<redacted>");
      }
    }
    return parsed.toString();
  } catch {
    return String(url);
  }
}

function summarizeHtml(html) {
  const title = /<title[^>]*>(.*?)<\/title>/is.exec(html)?.[1];
  const heading = /<h1[^>]*>.*?<span[^>]*>(.*?)<\/span>.*?<\/h1>/is.exec(html)?.[1];
  const text = decodeHtml((heading || title || "").replace(/<[^>]*>/g, "").trim());
  if (text) return text;
  if (/cdn-cgi|challenge-platform|cf-challenge/i.test(html)) return "Cloudflare challenge page";
  if (/sentinel/i.test(html)) return "Sentinel challenge page";
  return "HTML page";
}

function decodeHtml(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function isLocalCallback(url) {
  try {
    const parsed = new URL(url);
    return (
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
      parsed.pathname === "/auth/callback"
    );
  } catch {
    return false;
  }
}

function isAuthLoginPage(value) {
  try {
    return ["/log-in", "/log-in/password", "/log-in-or-create-account"].includes(new URL(value).pathname);
  } catch {
    return false;
  }
}

function printHelp() {
  console.log(`Usage:
  node src/protocol-login.mjs [options]

Options:
  --email <email>                 Email address. If omitted, prompt manually.
  --phone <phone>                 Phone number in E.164 format. If omitted, prompt when needed.
  --web-only                      Only complete ChatGPT web login, skip Codex OAuth.
  --out <file>                    Output JSON path. Default: ${DEFAULT_OUT}
  --sub2api-out <file>            sub2api import JSON path. Default: ${DEFAULT_SUB2API_OUT}
  --output-mode <mode>            both, session, or sub2api. Default: both
  --no-sub2api-export             Do not exchange OAuth code or write sub2api import JSON.
  --refresh-sub2api <file>        Refresh an existing sub2api OAuth file without email login.
  --checkpoint <file>             Save resumable login state after email verification.
  --resume-checkpoint <file>      Resume a saved login state before requesting a new email code.
  --sub2api-name <name>           Account name in sub2api. Default: oauth---<email>
  --concurrency <number>          sub2api concurrency. Default: 10
  --priority <number>             sub2api priority. Default: 1
  --rate-multiplier <number>      sub2api rate_multiplier. Default: 1
  --chatgpt-base <url>            Default: ${DEFAULT_CHATGPT_BASE}
  --auth-base <url>               Default: ${DEFAULT_AUTH_BASE}
  --codex-client-id <id>          Default: ${DEFAULT_CODEX_CLIENT_ID}
  --codex-redirect-uri <url>      Default: ${DEFAULT_CODEX_REDIRECT_URI}
  --verbose                       Print HTTP request status lines.
  --debug-auth                    Print auth cookie/page state diagnostics.

Notes:
  Set CHATGPT_LOGIN_PASSWORD for password login and CHATGPT_TOTP_SECRET for automatic
  6-digit TOTP generation. These values are read from the environment and are not logged.
  Existing phone-bound accounts are supported. If session/select returns workspaces,
  the script skips add-phone/send and goes directly to workspace selection.
  OAuth code can only be exchanged once; rerun login if token exchange fails with invalid_grant.
`);
}

run().catch((error) => {
  console.error(`[error] ${error.message}`);
  process.exitCode = 1;
});
