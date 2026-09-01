import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createProtectedStore } from "./protected-store.mjs";

const CONFIG_FILENAME = "cpamp-sync.json";
const MANAGEMENT_KEY_ID = "cpamp-management-key";
const REQUEST_TIMEOUT_MS = 30_000;

async function main() {
  const key = await readStdin();
  const result = await validateAndSaveCpampManagementKey(key);
  if (result.ok) {
    console.log("CPAMP 管理密钥已验证并加密保存，现在可以重启 toSub2。");
    return;
  }
  console.error(result.message);
  process.exitCode = 1;
}

export async function validateAndSaveCpampManagementKey(key, options = {}) {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) return { ok: false, message: "未输入 CPAMP 管理密钥，未修改任何内容。" };

  const configPath = options.configPath || defaultConfigPath();
  const secretStore = options.secretStore || createProtectedStore();
  const fetchImpl = options.fetchImpl || fetch;
  let config;
  try {
    config = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch {
    return { ok: false, message: "未找到 CPAMP 配置，请先启动一次 toSub2 后再修复密钥。" };
  }

  const baseUrl = String(config?.baseUrl || "").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { ok: false, message: "已保存的 CPAMP API 地址无效，未修改任何内容。" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(baseUrl + "/auth-files", {
      headers: { authorization: "Bearer " + normalizedKey, accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error) {
    const message = error?.name === "AbortError"
      ? "CPAMP 验证超时，未修改任何内容。"
      : "无法连接 CPAMP，未修改任何内容。";
    return { ok: false, message };
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    return { ok: false, message: "CPAMP 拒绝了此密钥，HTTP " + response.status + "；未修改任何内容。" };
  }

  await secretStore.save(MANAGEMENT_KEY_ID, normalizedKey);
  return { ok: true, message: "CPAMP 管理密钥已验证并加密保存。" };
}

function defaultConfigPath() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "toSub2", "chatgpt-onboarding-console", CONFIG_FILENAME);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk; });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(value));
  });
}

if (import.meta.url === "file:///" + process.argv[1]?.replace(/\\/g, "/")) {
  await main();
}
