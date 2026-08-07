import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const KEYCHAIN_SERVICE = "com.local.chatgpt-onboarding.credentials";
const WINDOWS_ENTROPY = "toSub2.credentials.v1";

const WINDOWS_PROTECT_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
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
  const securityRunner = options.securityRunner || runSecurity;
  const powerShellRunner = options.powerShellRunner || runPowerShell;

  return {
    async save(email, credentials) {
      const payload = JSON.stringify({
        version: 1,
        password: typeof credentials.password === "string" ? credentials.password : "",
        totpSecret: typeof credentials.totpSecret === "string" ? credentials.totpSecret : "",
      });
      if (platform === "darwin") {
        const result = await securityRunner([
          "add-generic-password",
          "-a",
          credentialAccount(email),
          "-s",
          KEYCHAIN_SERVICE,
          "-U",
          "-w",
        ], `${payload}\n${payload}\n`);
        if (result.code !== 0) {
          throw credentialError(500, "无法将密码和 2FA 密钥保存到 macOS Keychain（钥匙串），请先解锁登录钥匙串");
        }
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
          throw credentialError(500, "无法使用 Windows DPAPI（数据保护接口）保存密码和 2FA 密钥，请确认 PowerShell 可正常运行");
        }
        await fs.mkdir(windowsRoot, { recursive: true });
        const filePath = windowsCredentialPath(windowsRoot, email);
        await fs.writeFile(filePath, `${result.stdout.trim()}\n`, { mode: 0o600 });
        return;
      }
      throw credentialError(501, "持久保存密码和 2FA 密钥目前支持 macOS Keychain（钥匙串）和 Windows DPAPI（数据保护接口）");
    },

    async load(email) {
      if (platform === "darwin") {
        const result = await securityRunner([
          "find-generic-password",
          "-a",
          credentialAccount(email),
          "-s",
          KEYCHAIN_SERVICE,
          "-w",
        ]);
        return result.code === 0 ? parseCredentialPayload(result.stdout) : emptyCredentials();
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

function credentialAccount(email) {
  return String(email || "").trim().toLowerCase();
}

function parseCredentialPayload(value) {
  try {
    const data = JSON.parse(String(value || "").trim());
    return {
      password: typeof data.password === "string" ? data.password : "",
      totpSecret: typeof data.totpSecret === "string" ? data.totpSecret : "",
    };
  } catch {
    return emptyCredentials();
  }
}

function emptyCredentials() {
  return { password: "", totpSecret: "" };
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
