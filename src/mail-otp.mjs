import crypto from "node:crypto";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const OTP_PATTERN = /(?:^|\s)(\d{6})(?=$|\s)/g;
const CONTENT_KEY_PATTERN = /(?:body|content|text|html|message|subject|snippet|preview|payload|data|mail)/i;
const CODE_KEY_PATTERN = /(?:code|otp|verification|verify|验证码|校验码)/i;
const CODE_CONTEXT_PATTERN = /(?:openai|chatgpt|verification|verify|security\s*code|one[- ]time|\botp\b|验证码|校验码|一次性)/i;
const MESSAGE_ID_KEY_PATTERN = /^(?:id|uid|uuid|message_?id|mail_?id|email_?id)$/i;
const MESSAGE_TIME_KEY_PATTERN = /(?:created|received|delivered|sent|arrival|timestamp|date|time|updated)(?:_?at|_?on|_?time)?$/i;
const TEXT_TIME_PATTERN = /\b(20\d{2}[-\/.]\d{1,2}[-\/.]\d{1,2}[T\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:\s?(?:Z|[+-]\d{2}:?\d{2}))?)\b/g;

export function validateMailApiUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export async function fetchMailboxOtpCandidates(url, options = {}) {
  if (!validateMailApiUrl(url)) throw new Error("收码接口必须是有效的 HTTP 或 HTTPS 地址");

  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json, text/plain, text/html, */*",
        "user-agent": "Mozilla/5.0 ChatGPT-Onboarding-Console/1.0",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`收码接口返回 HTTP ${response.status}`);
    const raw = await readLimitedText(response, MAX_RESPONSE_BYTES);
    return extractMailboxOtpCandidates(raw);
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("收码接口请求超时");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function extractMailboxOtpCandidates(raw) {
  const input = String(raw || "");
  const sources = [{ path: "$raw", text: input, messageId: null, receivedAt: null }];

  try {
    collectTextSources(JSON.parse(input), "$", sources, new WeakSet(), {});
  } catch {
    // Plain text and HTML responses are scanned through the raw source.
  }

  const candidates = new Map();
  sources.forEach((source, sourceIndex) => {
    for (const variant of textVariants(source.text)) {
      const normalized = normalizeText(variant);
      OTP_PATTERN.lastIndex = 0;
      let match;
      while ((match = OTP_PATTERN.exec(normalized))) {
        const code = match[1];
        const start = Math.max(0, match.index - 120);
        const end = Math.min(normalized.length, match.index + match[0].length + 120);
        const context = normalized.slice(start, end);
        let score = 0;
        if (CODE_CONTEXT_PATTERN.test(context)) score += 40;
        if (CODE_KEY_PATTERN.test(source.path)) score += 40;
        if (CONTENT_KEY_PATTERN.test(source.path)) score += 12;
        if (normalized.trim() === code) score += 30;
        if (normalized.length <= 500) score += 4;
        score -= Math.min(sourceIndex, 20) * 0.01;

        const nearbyTime = findNearestTimestamp(normalized, match.index);
        const receivedAt = source.receivedAt || nearbyTime?.timestamp || null;
        const messageIdentity = source.messageId
          ? `id:${source.messageId}|time:${receivedAt || "unknown"}`
          : receivedAt
            ? `time:${receivedAt}`
            : `context:${fingerprint(context)}`;
        const key = fingerprint(`${code}|${messageIdentity}`);
        const existing = candidates.get(key);
        if (!existing || score > existing.score) {
          candidates.set(key, { code, score, key, receivedAt, path: source.path });
        }
      }
    }
  });

  return [...candidates.values()]
    .sort((a, b) => b.score - a.score || (b.receivedAt || 0) - (a.receivedAt || 0))
    .map(({ code, score, key, receivedAt }) => ({ code, score, key, receivedAt }));
}

function collectTextSources(value, currentPath, output, seen, inheritedMetadata) {
  if (typeof value === "string") {
    output.push({ path: currentPath, text: value, ...inheritedMetadata });
    return;
  }
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100000 &&
    value <= 999999 &&
    CODE_KEY_PATTERN.test(currentPath)
  ) {
    output.push({ path: currentPath, text: String(value), ...inheritedMetadata });
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectTextSources(item, `${currentPath}[${index}]`, output, seen, inheritedMetadata));
    return;
  }
  const metadata = { ...inheritedMetadata, ...extractMessageMetadata(value) };
  Object.entries(value).forEach(([key, item]) => {
    collectTextSources(item, `${currentPath}.${key}`, output, seen, metadata);
  });
}

function extractMessageMetadata(value) {
  let messageId = null;
  let receivedAt = null;
  Object.entries(value).forEach(([key, item]) => {
    if (item == null || !["string", "number", "bigint"].includes(typeof item)) return;
    if (!messageId && MESSAGE_ID_KEY_PATTERN.test(key)) messageId = String(item).trim() || null;
    if (!receivedAt && MESSAGE_TIME_KEY_PATTERN.test(key)) receivedAt = parseTimestamp(item);
  });
  return {
    ...(messageId ? { messageId } : {}),
    ...(receivedAt ? { receivedAt } : {}),
  };
}

function findNearestTimestamp(text, targetIndex) {
  TEXT_TIME_PATTERN.lastIndex = 0;
  let nearest = null;
  let match;
  while ((match = TEXT_TIME_PATTERN.exec(text))) {
    const timestamp = parseTimestamp(match[1]);
    if (!timestamp) continue;
    const distance = Math.abs(match.index - targetIndex);
    if (!nearest || distance < nearest.distance) nearest = { timestamp, distance };
  }
  return nearest;
}

function parseTimestamp(value) {
  if (typeof value === "number" || typeof value === "bigint" || /^\d{10,13}$/.test(String(value).trim())) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    const timestamp = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return isReasonableTimestamp(timestamp) ? timestamp : null;
  }
  const normalized = String(value || "").trim().replace(/^(\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2})\s+/, "$1T");
  const timestamp = Date.parse(normalized);
  return isReasonableTimestamp(timestamp) ? timestamp : null;
}

function isReasonableTimestamp(value) {
  return Number.isFinite(value) && value >= Date.UTC(2000, 0, 1) && value <= Date.UTC(2100, 0, 1);
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(String(value)).digest("base64url").slice(0, 24);
}

function textVariants(text) {
  const variants = [String(text)];
  const compact = String(text).replace(/\s+/g, "");
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(compact) && compact.length >= 24 && compact.length % 4 === 0) {
    try {
      const decoded = Buffer.from(compact, "base64").toString("utf8");
      const printable = [...decoded].filter((char) => /[\s\x20-\x7e\u4e00-\u9fff]/.test(char)).length;
      if (decoded && printable / decoded.length > 0.85) variants.push(decoded);
    } catch {
      // Ignore values that only resemble base64.
    }
  }
  return variants;
}

function normalizeText(text) {
  return decodeEntities(String(text))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/[\u00a0\u2000-\u200b\u2028\u2029\u3000]/g, " ");
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
    .replace(/&NewLine;|&#10;|&#x0a;/gi, "\n")
    .replace(/&Tab;|&#9;|&#x09;/gi, "\t")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

async function readLimitedText(response, limit) {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > limit) throw new Error("收码接口响应超过 2 MB 限制");
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new Error("收码接口响应超过 2 MB 限制");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
