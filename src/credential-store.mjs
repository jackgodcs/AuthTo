import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const KEYCHAIN_SERVICE = "com.local.chatgpt-onboarding.credentials";
const MAC_CREDENTIAL_ROOT = path.join(os.homedir(), "Library", "Application Support", "toSub2", "credentials");
const WINDOWS_ENTROPY = "toSub2.credentials.v1";

const WINDOWS_PROTECT_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$plainText = [Console]::In.ReadToEnd()
$plainBytes = [Text.Encoding]::UTF8.GetBytes($plainText)
$entropy = [Text.Encoding]::UTF8.GetBytes("${WINDOWS_ENTROPY}")
$cipherBytes = [Security.Cryptography.ProtectedData]::Protect(
  $plainBytes,
  $entropy,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Convert]::ToBase64String($cipherBytes))
`;

const WINDOWS_UNPROTECT_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$cipherText = [Console]::In.ReadToEnd().Trim()
$cipherBytes = [Convert]::FromBase64String($cipherText)
$entropy = [Text.Encoding]::UTF8.GetBytes("${WINDOWS_ENTROPY}")
$plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
  $cipherBytes,
  $entropy,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plainBytes))
`;

export function createCredentialStore(options = {}) {
  const platform = options.platform || process.platform;
  const windowsRoot = path.resolve(options.windowsRoot || defaultWindowsCredentialRoot());
  const macRoot = path.resolve(options.macRoot || process.env.TOSUB2_MAC_CREDENTIAL_ROOT || MAC_CREDENTIAL_ROOT);
  const securityRunner = options.securityRunner || runSecurity;
  const powerShellRunner = options.powerShellRunner || runPowerShell;

  return {
    async save(email, credentials) {
      const payload = JSON.stringify({
        version: 2,
        password: typeof credentials.password === "string" ? credentials.password : "",
        totpSecret: typeof credentials.totpSecret === "string" ? credentials.totpSecret : "",
        proxyUrl: typeof credentials.proxyUrl === "string" ? credentials.proxyUrl : "",
      });
      if (platform === "darwin") {
        await saveMacCredential(macRoot, email, payload, securityRunner);
        return;
      }
      if (platform === "win32") {
        let result;
        try {
          result = await powerShellRunner(WINDOWS_PROTECT_SCRIPT, payload);
        } catch {
          result = { code: 1, stdout: "" };
        }
        if (result.code !== 0 || !isBase64(result.stdout)) {
          throw credentialError(500, "无法使用 Windows DPAPI（数据保护接口）保存登录凭据和代理配置，请确认 PowerShell 可正常运行");
        }
        await fs.mkdir(windowsRoot, { recursive: true });
        const filePath = windowsCredentialPath(windowsRoot, email);
        await fs.writeFile(filePath, `${result.stdout.trim()}\n`, { mode: 0o600 });
        return;
      }
      throw credentialError(501, "持久保存登录凭据和代理配置目前支持 macOS Keychain（钥匙串）和 Windows DPAPI（数据保护接口）");
    },

    async load(email) {
      if (platform === "darwin") {
        return loadMacCredential(macRoot, email, securityRunner);
      }
      if (platform === "win32") {
        let cipherText;
        try {
          cipherText = await fs.readFile(windowsCredentialPath(windowsRoot, email), "utf8");
        } catch (error) {
          if (error?.code === "ENOENT") return emptyCredentials();
          return emptyCredentials();
        }
        try {
          const result = await powerShellRunner(WINDOWS_UNPROTECT_SCRIPT, cipherText);
          return result.code === 0 ? parseCredentialPayload(result.stdout) : emptyCredentials();
        } catch {
          return emptyCredentials();
        }
      }
      return emptyCredentials();
    },

    async delete(email) {
      if (platform === "darwin") {
        const result = await securityRunner([
          "delete-generic-password",
          "-a",
          credentialAccount(email),
          "-s",
          KEYCHAIN_SERVICE,
        ]);
        if (![0, 44].includes(result.code)) {
          throw credentialError(500, "无法从 macOS Keychain（钥匙串）删除该邮箱的登录凭据");
        }
        await fs.rm(macCredentialPath(macRoot, email), { force: true });
        return;
      }
      if (platform === "win32") {
        try {
          await fs.unlink(windowsCredentialPath(windowsRoot, email));
        } catch (error) {
          if (error?.code !== "ENOENT") {
            throw credentialError(500, "无法删除 Windows DPAPI（数据保护接口）凭据文件");
          }
        }
      }
    },
  };
}

function defaultWindowsCredentialRoot() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "toSub2", "credentials");
}

function windowsCredentialPath(root, email) {
  const id = crypto.createHash("sha256").update(credentialAccount(email)).digest("hex");
  return path.join(root, `${id}.dpapi`);
}

function macCredentialPath(root, email) {
  const id = crypto.createHash("sha256").update(credentialAccount(email)).digest("hex");
  return path.join(root, `${id}.enc`);
}

async function saveMacCredential(root, email, payload, securityRunner) {
  const filePath = macCredentialPath(root, email);
  const existingFile = await fileExists(filePath);
  const keychainValue = await readMacKeychainValue(email, securityRunner);
  let key = keychainValue.key;
  if (!key) {
    if (existingFile) {
      throw credentialError(500, "macOS Keychain（钥匙串）中的加密密钥无法读取，已保留现有凭据文件");
    }
    key = crypto.randomBytes(32);
    const keyResult = await securityRunner([
      "add-generic-password",
      "-a",
      credentialAccount(email),
      "-s",
      KEYCHAIN_SERVICE,
      "-U",
      "-w",
    ], `${key.toString("base64")}\n${key.toString("base64")}\n`);
    if (keyResult.code !== 0) {
      throw credentialError(500, "无法将登录凭据密钥保存到 macOS Keychain（钥匙串），请先解锁登录钥匙串");
    }
  }
  const encrypted = encryptCredentialPayload(key, payload);
  await fs.mkdir(root, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(encrypted)}\n`, { mode: 0o600 });
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw credentialError(500, `无法写入 macOS 凭据文件：${error.message}`);
  }
}

async function loadMacCredential(root, email, securityRunner) {
  let encrypted;
  try {
    encrypted = JSON.parse(await fs.readFile(macCredentialPath(root, email), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") return emptyCredentials();
    const legacy = await readMacKeychainValue(email, securityRunner);
    return legacy.payload ? parseCredentialPayload(legacy.payload) : emptyCredentials();
  }
  const keychainValue = await readMacKeychainValue(email, securityRunner);
  if (!keychainValue.key) return emptyCredentials();
  try {
    return parseCredentialPayload(decryptCredentialPayload(keychainValue.key, encrypted));
  } catch {
    return emptyCredentials();
  }
}

async function readMacKeychainValue(email, securityRunner) {
  const result = await securityRunner([
    "find-generic-password",
    "-a",
    credentialAccount(email),
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
  ]);
  if (result.code !== 0) return { key: null, payload: null };
  const value = String(result.stdout || "").trim();
  if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(value)) {
    try {
      const key = Buffer.from(value, "base64");
      if (key.length === 32) return { key, payload: null };
    } catch {}
  }
  return { key: null, payload: value };
}

function encryptCredentialPayload(key, payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: ciphertext.toString("base64"),
  };
}

function decryptCredentialPayload(key, encrypted) {
  if (encrypted?.version !== 1) throw new Error("Unsupported encrypted credential version");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function credentialAccount(email) {
  return String(email || "").trim().toLowerCase();
}

function parseCredentialPayload(value) {
  const raw = String(value || "").trim();
  try {
    const data = JSON.parse(raw);
    return {
      password: typeof data.password === "string" ? data.password : "",
      totpSecret: typeof data.totpSecret === "string" ? data.totpSecret : "",
      proxyUrl: typeof data.proxyUrl === "string" ? data.proxyUrl : "",
    };
  } catch {
    // Older macOS writes used the interactive `security -w` prompt, which
    // truncated long payloads at 128 bytes. Recover fields that were fully
    // written before the truncated tail so users do not lose passwords or
    // TOTP keys after upgrading.
    return {
      password: extractCompleteJsonString(raw, "password"),
      totpSecret: extractCompleteJsonString(raw, "totpSecret"),
      proxyUrl: extractCompleteJsonString(raw, "proxyUrl"),
    };
  }
}

function extractCompleteJsonString(raw, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`"${escapedKey}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`).exec(raw);
  if (!match) return "";
  try {
    const value = JSON.parse(match[1]);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function emptyCredentials() {
  return { password: "", totpSecret: "", proxyUrl: "" };
}

function isBase64(value) {
  const normalized = String(value || "").trim();
  return normalized.length > 0 && normalized.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(normalized);
}

function credentialError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function runSecurity(args, input = "") {
  return runChild("/usr/bin/security", args, input, { detached: true });
}

function runPowerShell(script, input = "") {
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  return runChild(
    process.env.TOSUB2_POWERSHELL || "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
    input,
    { windowsHide: true },
  );
}

function runChild(command, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-65_536);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.stdin.end(input);
  });
}
