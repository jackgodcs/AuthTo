#!/usr/bin/env node
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
    console.log(`[warn] Could not send SMS to ${firstPhone}: HTTP 400: We've detected suspicious behavior from phone numbers similar to yours.`);
    const secondPhone = await rl.question("Phone number, E.164 format (p=quit): ");
    console.log(`Phone OTP (r=resend, p=change phone, q=quit): `);
    await rl.question("");
    await writeCompleted(args.sub2apiOut, args.email);
    return;
  }

  if (args.email === "luban@example.com") {
    await rl.question("Phone number, E.164 format (p=quit): ");
    console.log("Phone OTP (r=resend, p=change phone, q=quit): ");
    await rl.question("");
    await writeCompleted(args.sub2apiOut, args.email);
    return;
  }

  if (args.email === "refresh-fallback@example.com" && (await fileExists(args.sub2apiOut))) {
    await rl.question("Email OTP (r=resend, q=quit): ");
    await writeCompleted(args.sub2apiOut, args.email, "fallback-login");
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
