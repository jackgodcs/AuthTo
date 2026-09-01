import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const WINDOWS_ENTROPY = "toSub2.protected-store.v1";

const WINDOWS_PROTECT_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$plainBytes = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())
$entropy = [Text.Encoding]::UTF8.GetBytes("${WINDOWS_ENTROPY}")
$cipherBytes = [Security.Cryptography.ProtectedData]::Protect($plainBytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($cipherBytes))
`;

const WINDOWS_UNPROTECT_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$cipherBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$entropy = [Text.Encoding]::UTF8.GetBytes("${WINDOWS_ENTROPY}")
$plainBytes = [Security.Cryptography.ProtectedData]::Unprotect($cipherBytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plainBytes))
`;

export function createProtectedStore(options = {}) {
  const platform = options.platform || process.platform;
  const root = path.resolve(options.root || defaultRoot());
  const powerShellRunner = options.powerShellRunner || runPowerShell;

  return {
    async save(name, value) {
      if (platform !== "win32") throw protectedStoreError(501, "CPAMP 管理密钥目前仅支持 Windows DPAPI 加密保存");
      const result = await powerShellRunner(WINDOWS_PROTECT_SCRIPT, String(value || ""));
      if (result.code !== 0 || !isBase64(result.stdout)) {
        throw protectedStoreError(500, "无法使用 Windows DPAPI 加密保存 CPAMP 管理密钥，请确认 PowerShell 可正常运行");
      }
      await fs.mkdir(root, { recursive: true });
      const target = secretPath(root, name);
      const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temp, `${result.stdout.trim()}\n`, { mode: 0o600 });
      await fs.rename(temp, target);
    },

    async load(name) {
      if (platform !== "win32") return null;
      let cipherText;
      try {
        cipherText = await fs.readFile(secretPath(root, name), "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw protectedStoreError(500, "无法读取本机加密的 CPAMP 管理密钥");
      }
      try {
        const result = await powerShellRunner(WINDOWS_UNPROTECT_SCRIPT, cipherText);
        if (result.code !== 0) throw new Error(result.stderr || "DPAPI 解密失败");
        return result.stdout;
      } catch {
        throw protectedStoreError(500, "无法解密本机保存的 CPAMP 管理密钥；请重新配置");
      }
    },

    async delete(name) {
      try {
        await fs.rm(secretPath(root, name), { force: true });
      } catch (error) {
        throw protectedStoreError(500, `无法删除 CPAMP 管理密钥：${error.message}`);
      }
    },
  };
}

function defaultRoot() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "toSub2", "secrets");
}

function secretPath(root, name) {
  const id = crypto.createHash("sha256").update(String(name || "")).digest("hex");
  return path.join(root, `${id}.dpapi`);
}

function isBase64(value) {
  const text = String(value || "").trim();
  return text.length > 0 && text.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(text);
}

function protectedStoreError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function runPowerShell(script, input = "") {
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  return runChild(
    process.env.TOSUB2_POWERSHELL || "pwsh.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
    input,
  );
}

function runChild(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-65_536); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.stdin.end(input);
  });
}
