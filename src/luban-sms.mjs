const DEFAULT_API_BASE = "https://lubansms.com/v2/api/";
const DEFAULT_TIMEOUT_MS = 12_000;

export class LubanSmsError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "LubanSmsError";
    this.code = options.code ?? null;
    this.terminal = Boolean(options.terminal);
  }
}

export function createLubanSmsClient(options = {}) {
  const apiKey = String(options.apiKey || "").trim();
  const apiBase = new URL(options.apiBase || DEFAULT_API_BASE);
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!apiKey) return null;
  if (!/^https?:$/.test(apiBase.protocol)) throw new Error("LubanSMS API 地址必须使用 HTTP 或 HTTPS");

  async function request(endpoint, params = {}) {
    const url = new URL(endpoint, apiBase);
    url.searchParams.set("apikey", apiKey);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw new LubanSmsError(`接码平台返回 HTTP ${response.status}`, { terminal: response.status < 500 });
      const data = await response.json();
      if (!data || typeof data !== "object") throw new LubanSmsError("接码平台返回了无效数据");
      return data;
    } catch (error) {
      if (error?.name === "AbortError") throw new LubanSmsError("接码平台请求超时");
      if (error instanceof LubanSmsError) throw error;
      throw new LubanSmsError(`接码平台请求失败：${safeMessage(error?.message)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async getNumber(serviceId) {
      const data = await request("getNumber", { service_id: serviceId });
      if (Number(data.code) !== 0 || !data.number || !data.request_id) {
        throw apiError(data, "获取手机号失败");
      }
      return {
        number: normalizePhoneNumber(data.number),
        requestId: String(data.request_id),
      };
    },

    async getSms(requestId) {
      const data = await request("getSms", { request_id: requestId });
      if (Number(data.code) === 0 && String(data.msg || "").toLowerCase() === "wait") {
        return { status: "waiting" };
      }
      if (Number(data.code) === 0) {
        const code = extractLubanSmsCode(data);
        if (code) return { status: "received", code };
        if (data.sms_code != null || String(data.msg || "").toLowerCase() === "success") {
          throw new LubanSmsError("接码平台返回内容中没有找到独立的 6 位数字验证码", { terminal: true });
        }
      }
      throw apiError(data, "获取短信失败");
    },

    async release(requestId) {
      const data = await request("setStatus", { request_id: requestId, status: "reject" });
      if (Number(data.code) !== 0) throw apiError(data, "释放手机号失败");
      return true;
    },
  };
}

export function extractLubanSmsCode(data) {
  const candidates = [];
  collectCodeCandidates(data?.sms_code, candidates, 100, "sms_code");
  collectCodeCandidates(data?.sms_msg, candidates, 20, "sms_msg");
  collectCodeCandidates(data?.message, candidates, 20, "message");
  collectCodeCandidates(data?.text, candidates, 20, "text");
  collectCodeCandidates(data?.msg, candidates, 0, "msg");
  collectCodeCandidates(data, candidates, -20, "root");

  return candidates
    .map((candidate, index) => ({ ...candidate, index, code: findSixDigitCode(candidate.text) }))
    .filter((candidate) => candidate.code)
    .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.code || null;
}

function collectCodeCandidates(value, output, baseScore, key, seen = new WeakSet()) {
  if (value == null) return;
  if (["string", "number", "bigint"].includes(typeof value)) {
    const text = String(value).trim();
    if (!text) return;
    const keyScore = /^(?:sms_?)?(?:code|otp|verification_code)$/i.test(key) ? 100 : 0;
    const exactScore = /^\d{6}$/.test(text) ? 40 : 0;
    output.push({ text, score: baseScore + keyScore + exactScore });
    return;
  }
  if (typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => collectCodeCandidates(item, output, baseScore, key, seen));
    return;
  }
  Object.entries(value).forEach(([childKey, childValue]) => {
    if (/^(?:request_?id|application_?id|country_?id|service_?id|number|phone)$/i.test(childKey)) return;
    collectCodeCandidates(childValue, output, baseScore, childKey, seen);
  });
}

function findSixDigitCode(value) {
  const match = /(?:^|\D)(\d{6})(?!\d)/.exec(String(value || ""));
  return match?.[1] || null;
}

function normalizePhoneNumber(value) {
  let phone = String(value || "").trim().replace(/[\s()-]/g, "");
  if (phone.startsWith("00")) phone = `+${phone.slice(2)}`;
  else if (!phone.startsWith("+")) phone = `+${phone}`;
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
    throw new LubanSmsError("接码平台返回的手机号不是有效的国际格式", { terminal: true });
  }
  return phone;
}

function apiError(data, fallback) {
  const message = safeMessage(data?.msg) || fallback;
  const code = data?.code ?? null;
  const terminal = Number(code) === 400 || Number(code) === 401;
  return new LubanSmsError(`${fallback}：${message}`, { code, terminal });
}

function safeMessage(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, 240);
}
