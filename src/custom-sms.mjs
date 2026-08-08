import crypto from "node:crypto";

import { fetchMailboxOtpCandidates, validateMailApiUrl } from "./mail-otp.mjs";

const MAX_CUSTOM_SMS_ENTRIES = 500;

export class CustomSmsError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "CustomSmsError";
    this.terminal = Boolean(options.terminal);
  }
}

export function parseCustomSmsEntries(value) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) throw new CustomSmsError("请粘贴至少一条手机号和接码 API", { terminal: true });
  if (lines.length > MAX_CUSTOM_SMS_ENTRIES) {
    throw new CustomSmsError(`自定义接码一次最多导入 ${MAX_CUSTOM_SMS_ENTRIES} 条`, { terminal: true });
  }

  const entries = new Map();
  lines.forEach((line, index) => {
    const delimiterAt = line.indexOf("----");
    if (delimiterAt < 0) {
      throw new CustomSmsError(`第 ${index + 1} 行格式错误，请使用 手机号----接码API`, { terminal: true });
    }
    const phone = line.slice(0, delimiterAt).trim();
    const apiUrl = line.slice(delimiterAt + 4).trim();
    if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
      throw new CustomSmsError(`第 ${index + 1} 行手机号必须使用 E.164 国际格式`, { terminal: true });
    }
    if (!validateMailApiUrl(apiUrl)) {
      throw new CustomSmsError(`第 ${index + 1} 行接码 API 必须是有效的 HTTP 或 HTTPS 地址`, { terminal: true });
    }
    entries.set(phone, { phone, apiUrl });
  });
  return [...entries.values()];
}

export function createCustomSmsClient(options = {}) {
  const entries = parseCustomSmsEntries(options.entries);
  const fetchImpl = options.fetchImpl || fetch;
  const acquireEntry = options.acquireEntry || ((available) => available[0] || null);
  let selected = null;
  let requestId = null;
  const seenCandidateKeys = new Set();

  return {
    entryCount: entries.length,
    async getNumber() {
      selected = acquireEntry(entries);
      if (!selected) {
        throw new CustomSmsError("这批自定义手机号已全部分配，请补充新号码", { terminal: true });
      }
      requestId = `custom-${crypto.randomUUID()}`;
      let baseline;
      try {
        baseline = await fetchMailboxOtpCandidates(selected.apiUrl, { fetchImpl });
      } catch (error) {
        throw new CustomSmsError(`读取 ${selected.phone} 的接码 API 失败：${error.message}`);
      }
      baseline.forEach((candidate) => seenCandidateKeys.add(candidate.key));
      return { requestId, number: selected.phone };
    },

    async getSms(currentRequestId) {
      if (!selected || !requestId || currentRequestId !== requestId) {
        throw new CustomSmsError("自定义接码任务不存在", { terminal: true });
      }
      let candidates;
      try {
        candidates = await fetchMailboxOtpCandidates(selected.apiUrl, { fetchImpl });
      } catch (error) {
        throw new CustomSmsError(`读取接码 API 失败：${error.message}`);
      }
      const fresh = candidates.find((candidate) => !seenCandidateKeys.has(candidate.key));
      candidates.forEach((candidate) => seenCandidateKeys.add(candidate.key));
      return fresh ? { status: "received", code: fresh.code } : { status: "waiting" };
    },

    async release() {
      return true;
    },
  };
}
