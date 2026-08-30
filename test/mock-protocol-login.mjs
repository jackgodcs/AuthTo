#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const args = parseArgs(process.argv.slice(2));
const rl = readline.createInterface({ input, output });

await run();

async function run() {
try {
  if (args.refreshSub2api) {
    const existing = JSON.parse(await fs.readFile(args.refreshSub2api, "utf8"));
    const email = existing.accounts?.[0]?.credentials?.email || "unknown@example.com";
    if (email === "refresh-fallback@example.com") {
      console.error("[error] REFRESH_TOKEN_INVALID: simulated expired refresh token");
      process.exitCode = 1;
      return;
    }
    await writeCompleted(args.sub2apiOut || args.refreshSub2api, email, "refreshed");
    return;
  }

  if (args.setupTotp) {
    const secret = "NB2W45DFOIZAQWER";
    const reusingCheckpoint = Boolean(args.resumeCheckpoint && await fileExists(args.resumeCheckpoint));
    if (reusingCheckpoint) {
      const checkpoint = JSON.parse(await fs.readFile(args.resumeCheckpoint, "utf8"));
      console.log(`[2fa] Reusing verified login checkpoint from ${checkpoint.stage}.`);
    }
    await fs.mkdir(path.dirname(args.totpResult), { recursive: true });
    await fs.writeFile(args.totpResult, `${JSON.stringify({
      version: 1,
      already_enabled: false,
      activation_mode: "automatic",
      activation_succeeded: true,
      email: args.email,
      secret,
      otpauth_uri: `otpauth://totp/OpenAI%3A${encodeURIComponent(args.email)}?secret=${secret}&issuer=OpenAI`,
    }, null, 2)}\n`, { mode: 0o600 });
    console.log("[2fa-setup-ready] 2FA key created; activating it automatically.");
    console.log("[2fa] Generated a current 6-digit activation code from the new 2FA key.");
    console.log("[ok] 2FA setup activated");
    if (reusingCheckpoint) {
      const checkpoint = JSON.parse(await fs.readFile(args.resumeCheckpoint, "utf8"));
      await fs.writeFile(args.resumeCheckpoint, `${JSON.stringify({
        ...checkpoint,
        stage: "email_verified",
        updated_at: new Date().toISOString(),
        oauth: undefined,
      }, null, 2)}\n`, { mode: 0o600 });
      console.log("[checkpoint] Updated verified login state after setting 2FA.");
    }
    return;
  }

  if (args.addPassword) {
    const newPassword = process.env.CHATGPT_NEW_PASSWORD || "";
    if (!newPassword) throw new Error("missing CHATGPT_NEW_PASSWORD");
    const reusingCheckpoint = Boolean(args.resumeCheckpoint && await fileExists(args.resumeCheckpoint));
    if (reusingCheckpoint) {
      const checkpoint = JSON.parse(await fs.readFile(args.resumeCheckpoint, "utf8"));
      console.log(`[password-add] Reusing verified login checkpoint from ${checkpoint.stage}.`);
    } else {
      await rl.question("Email OTP (r=resend, q=quit): ");
    }
    await rl.question("Email OTP (r=resend, q=quit): ");
    await fs.mkdir(path.dirname(args.passwordAddResult), { recursive: true });
    await fs.writeFile(args.passwordAddResult, `${JSON.stringify({
      version: 1,
      email: args.email,
      password: newPassword,
      added_at: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
    if (reusingCheckpoint) {
      const checkpoint = JSON.parse(await fs.readFile(args.resumeCheckpoint, "utf8"));
      await fs.writeFile(args.resumeCheckpoint, `${JSON.stringify({
        ...checkpoint,
        stage: "email_verified",
        updated_at: new Date().toISOString(),
        oauth: undefined,
      }, null, 2)}\n`, { mode: 0o600 });
      console.log("[checkpoint] Updated verified login state after adding the password.");
    }
    console.log("[ok] Account password added and saved securely");
    return;
  }

  if (["proxy-risk-retry@example.com", "proxy-risk-always@example.com", "direct-risk-retry@example.com"].includes(args.email)) {
    console.log(`[proxy-session-attempt] ${crypto.randomUUID()}`);
    const attemptPath = `${args.sub2apiOut}.proxy-risk-attempt`;
    let attempt = 0;
    try {
      attempt = Number(await fs.readFile(attemptPath, "utf8")) || 0;
    } catch {}
    attempt += 1;
    await fs.writeFile(attemptPath, String(attempt));
    if (args.email === "proxy-risk-always@example.com" || attempt <= 2) {
      console.error("[proxy-risk-retry] PROXY_RISK_CONTROL: simulated security-check page");
      process.exitCode = 1;
      return;
    }
    await writeCompleted(args.sub2apiOut, args.email, "proxy-retried");
    return;
  }

  if (["proxy-connection-retry@example.com", "proxy-connection-always@example.com"].includes(args.email)) {
    const attemptPath = `${args.sub2apiOut}.proxy-connection-attempt`;
    let attempt = 0;
    try {
      attempt = Number(await fs.readFile(attemptPath, "utf8")) || 0;
    } catch {}
    attempt += 1;
    await fs.writeFile(attemptPath, String(attempt));
    if (args.email === "proxy-connection-always@example.com" || attempt === 1) {
      console.error("[proxy-risk-retry] PROXY_CONNECTION_RETRY: simulated TLS connection failure");
      process.exitCode = 1;
      return;
    }
    console.log(`[proxy-session-attempt] ${crypto.randomUUID()}`);
    await writeCompleted(args.sub2apiOut, args.email, "proxy-connected");
    return;
  }

  if (["resume@example.com", "resume-phone@example.com"].includes(args.email)) {
    const checkpointPath = args.checkpoint || args.resumeCheckpoint;
    let checkpoint = null;
    if (checkpointPath && (await fileExists(checkpointPath))) {
      checkpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
      console.log(`[resume] Continue saved login flow from ${checkpoint.stage}.`);
      console.log("[resume] Email verification already completed; continuing phone binding.");
    } else if (checkpointPath) {
      await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
      checkpoint = {
        version: 1,
        stage: "phone_required",
        updated_at: new Date().toISOString(),
        email: args.email,
        cookies: [{ name: "mock-session", value: "saved", domain: "auth.openai.com", path: "/" }],
        oauth: { codeVerifier: "mock-verifier", state: "mock-state", addPhoneUrl: "https://auth.openai.com/add-phone" },
      };
      await fs.writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
      console.log("[checkpoint] Saved verified email login state.");
    }

    if (checkpoint?.stage === "phone_otp") {
      console.log(`[resume] Continue waiting for the SMS sent to ${checkpoint.oauth.phone}.`);
    } else {
      const phone = await rl.question("Phone number, E.164 format (p=quit): ");
      if (checkpointPath) {
        checkpoint = {
          ...checkpoint,
          stage: "phone_otp",
          updated_at: new Date().toISOString(),
          oauth: {
            ...checkpoint.oauth,
            phone,
            phoneReferer: "https://auth.openai.com/phone-verification",
          },
        };
        await fs.writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
      }
    }
    console.log("Phone OTP (r=resend, p=change phone, q=quit): ");
    await rl.question("");
    await writeCompleted(args.sub2apiOut, args.email);
    await removeCheckpoint(checkpointPath);
    return;
  }

  if (args.email === "retry@example.com") {
    const attemptPath = `${args.sub2apiOut}.attempt`;
    let attempt = 0;
    try {
      attempt = Number(await fs.readFile(attemptPath, "utf8")) || 0;
    } catch {}
    attempt += 1;
    await fs.writeFile(attemptPath, String(attempt));
    if (attempt === 1) {
      const phone = await rl.question("Phone number, E.164 format (p=quit): ");
      console.log(`> POST https://auth.openai.com/api/accounts/add-phone/send`);
      console.log(`< POST https://auth.openai.com/api/accounts/add-phone/send 409`);
      console.log(`[warn] Could not send SMS to ${phone}: { "error": { "message": "Your sign-in session is no longer valid. Please start over to continue.", "code": "invalid_state" } }`);
      return;
    }
    await writeCompleted(args.sub2apiOut, args.email);
    return;
  }

  if (args.email === "phone@example.com") {
    const firstPhone = await rl.question("Phone number, E.164 format (p=quit): ");
    console.log(
      `[warn] Could not send SMS to ${firstPhone}: HTTP 409: ` +
      `{ "error": { "message": "Your sign-in session is no longer valid. Please start over to continue.", "code": "invalid_state" } }; ` +
      `fallback without channel also failed: HTTP 400: ` +
      `{ "error": { "message": "We've detected suspicious behavior from phone numbers similar to yours.", "code": "phone_suspicious_behavior" } }`,
    );
    const secondPhone = await rl.question("Phone number, E.164 format (p=quit): ");
    console.log(`Phone OTP (r=resend, p=change phone, q=quit): `);
    await rl.question("");
    await writeCompleted(args.sub2apiOut, args.email);
    return;
  }

  if (["luban@example.com", "sms-provider@example.com", "custom-sms@example.com", "manual-phone-automation@example.com"].includes(args.email)) {
    await rl.question("Phone number, E.164 format (p=quit): ");
    console.log("Phone OTP (r=resend, p=change phone, q=quit): ");
    await rl.question("");
    console.log("[ok] Phone OTP validated");
    await writeCompleted(args.sub2apiOut, args.email);
    return;
  }

  if (args.email === "sms-recently-used@example.com") {
    await rl.question("Phone number, E.164 format (p=quit): ");
    console.log("Phone OTP (r=resend, p=change phone, q=quit): ");
    await rl.question("");
    console.log('[warn] Phone OTP validation failed: HTTP 429: { "error": { "message": "This phone number was recently used. Please try again later.", "code": "phone_recently_used" } }');
    const action = await rl.question("Phone OTP (r=resend, p=change phone, q=quit): ");
    if (action !== "p") throw new Error(`expected automatic phone change, received ${action}`);
    console.log("[info] Change phone number.");
    await rl.question("Phone number, E.164 format (p=quit): ");
    return;
  }

  if (args.email === "refresh-fallback@example.com" && (await fileExists(args.sub2apiOut))) {
    await rl.question("Email OTP (r=resend, q=quit): ");
    await writeCompleted(args.sub2apiOut, args.email, "fallback-login");
    return;
  }

  if (args.email === "wrong-email-otp-console@example.com") {
    await rl.question("Email OTP (r=resend, q=quit): ");
    console.log("[email-otp-rejected] 邮箱验证码错误，请重新输入，或输入 r 重新发送。");
    await rl.question("Email OTP (r=resend, q=quit): ");
    await writeCompleted(args.sub2apiOut, args.email, "email-otp-retried");
    return;
  }

  if (args.email === "mfa-prompt@example.com") {
    process.stdout.write("[mfa] TOTP 2FA challenge reached.\n2FA OTP (6 digits, q=quit): ");
    await rl.question("");
    await writeCompleted(args.sub2apiOut, args.email, "mfa-login");
    return;
  }

  if (args.email === "monitor-banned@example.com" && (await fileExists(args.sub2apiOut))) {
    console.error('[error] HTTP 403: { "error": { "message": "Your account has been deactivated.", "code": "account_deactivated" } }');
    process.exitCode = 1;
    return;
  }

  await writeCompleted(args.sub2apiOut, args.email);
} finally {
  rl.close();
}
}

async function writeCompleted(outputPath, email, tokenPrefix = "test") {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const account = {
    name: `oauth---${email}`,
    platform: "openai",
    type: "oauth",
    credentials: {
      access_token: `${tokenPrefix}-access-${email}`,
      chatgpt_account_id: `test-account-${email}`,
      email,
      id_token: `${tokenPrefix}-id-${email}`,
      refresh_token: `${tokenPrefix}-refresh-${email}`,
    },
    extra: { email },
    concurrency: 10,
    priority: 1,
    rate_multiplier: 1,
    auto_pause_on_expired: true,
  };
  await fs.writeFile(outputPath, `${JSON.stringify({
    type: "sub2api-data",
    version: 1,
    exported_at: new Date().toISOString(),
    proxies: [],
    accounts: [account],
  }, null, 2)}\n`);
  console.log(`[ok] Saved sub2api import: ${outputPath}`);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--email") parsed.email = argv[++index];
    else if (argv[index] === "--sub2api-out") parsed.sub2apiOut = argv[++index];
    else if (argv[index] === "--refresh-sub2api") parsed.refreshSub2api = argv[++index];
    else if (argv[index] === "--checkpoint") parsed.checkpoint = argv[++index];
    else if (argv[index] === "--resume-checkpoint") parsed.resumeCheckpoint = argv[++index];
    else if (argv[index] === "--setup-totp") parsed.setupTotp = true;
    else if (argv[index] === "--totp-result") parsed.totpResult = argv[++index];
    else if (argv[index] === "--add-password") parsed.addPassword = true;
    else if (argv[index] === "--password-add-result") parsed.passwordAddResult = argv[++index];
  }
  return parsed;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function removeCheckpoint(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
