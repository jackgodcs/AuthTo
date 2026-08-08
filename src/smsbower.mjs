const DEFAULT_API_BASE = "https://smsbower.page/stubs/handler_api.php";
const DEFAULT_TIMEOUT_MS = 12_000;

export class SmsBowerError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "SmsBowerError";
    this.code = options.code ?? null;
    this.terminal = Boolean(options.terminal);
  }
}

export function createSmsBowerClient(options = {}) {
  const apiKey = String(options.apiKey || "").trim();
  const apiBase = new URL(options.apiBase || DEFAULT_API_BASE);
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!apiKey) return null;
  if (!/^https?:$/.test(apiBase.protocol)) throw new Error("SMSBower API 地址必须使用 HTTP 或 HTTPS");

  async function request(action, params = {}) {
    const url = new URL(apiBase);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("action", action);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "text/plain,application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      const text = (await response.text()).trim();
      if (!response.ok) throw new SmsBowerError(`接码平台返回 HTTP ${response.status}`, { terminal: response.status < 500 });
      if (!text) throw new SmsBowerError("接码平台返回了空响应");
      return text;
    } catch (error) {
      if (error?.name === "AbortError") throw new SmsBowerError("接码平台请求超时");
      if (error instanceof SmsBowerError) throw error;
      throw new SmsBowerError(`接码平台请求失败：${safeMessage(error?.message)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function setStatus(activationId, status) {
    const text = await request("setStatus", { id: activationId, status });
    if (["ACCESS_READY", "ACCESS_RETRY_GET", "ACCESS_ACTIVATION", "ACCESS_CANCEL"].includes(text)) return true;
    throw responseError(text, "更新号码状态失败");
  }

  return {
    async getNumber(service, country, maxPrice = "") {
      const params = { service, country };
      if (maxPrice !== "") params.maxPrice = maxPrice;
      const text = await request("getNumber", params);
      const match = /^ACCESS_NUMBER:([^:]+):(\+?\d+)$/.exec(text);
      if (!match) throw responseError(text, "获取手机号失败");
      return {
        number: normalizePhoneNumber(match[2]),
        requestId: match[1],
      };
    },

    async getPriceOptions(service) {
      const [pricesText, countriesText] = await Promise.all([
        request("getPrices", { service }),
        request("getCountries"),
      ]);
      return normalizePriceOptions(
        parseJsonResponse(pricesText, "价格接口返回格式不正确"),
        parseJsonResponse(countriesText, "国家接口返回格式不正确"),
        service,
      );
    },

    async getSms(activationId) {
      const text = await request("getStatus", { id: activationId });
      if (text === "STATUS_WAIT_CODE" || text.startsWith("STATUS_WAIT_RETRY")) return { status: "waiting" };
      if (text === "STATUS_CANCEL") throw new SmsBowerError("号码激活已被平台取消", { code: text, terminal: true });
      if (text.startsWith("STATUS_OK:")) {
        const code = findSixDigitCode(text.slice("STATUS_OK:".length));
        if (!code) throw new SmsBowerError("接码平台返回内容中没有找到独立的 6 位数字验证码", { terminal: true });
        return { status: "received", code };
      }
      throw responseError(text, "获取短信失败");
    },

    markReady(activationId) {
      return setStatus(activationId, 1);
    },

    complete(activationId) {
      return setStatus(activationId, 6);
    },

    release(activationId) {
      return setStatus(activationId, 8);
    },
  };
}

function responseError(value, fallback) {
  const code = safeMessage(value) || "UNKNOWN_ERROR";
  const descriptions = {
    BAD_KEY: "API Key 不正确",
    BAD_ACTION: "接口动作不正确",
    BAD_SERVICE: "服务代码不正确",
    NO_NUMBERS: "当前国家和服务暂无可用号码",
    NO_BALANCE: "账户余额不足",
    NO_ACTIVATION: "激活订单不存在",
    BAD_STATUS: "号码状态不正确",
    EARLY_CANCEL_DENIED: "当前订单暂时不允许取消",
  };
  const terminal = /^(?:BAD_KEY|BAD_ACTION|BAD_SERVICE|NO_BALANCE|NO_ACTIVATION|BAD_STATUS|BANNED)/.test(code);
  return new SmsBowerError(`${fallback}：${descriptions[code] || code}`, { code, terminal });
}

function findSixDigitCode(value) {
  return /(?:^|\D)(\d{6})(?!\d)/.exec(String(value || ""))?.[1] || null;
}

function parseJsonResponse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    throw responseError(value, fallback);
  }
}

function normalizePriceOptions(prices, countries, service) {
  if (!prices || typeof prices !== "object" || Array.isArray(prices)) {
    throw new SmsBowerError("价格接口返回格式不正确", { terminal: true });
  }
  const countryList = collectCountryRecords(countries);
  const countryIndex = new Map();
  countryList.forEach((country) => {
    const keys = [country.activate_org_code, country.id, country.slug, country.title, country.eng, country.chn, country.iso, country.__alias];
    keys.filter((key) => key !== undefined && key !== null && key !== "").forEach((key) => {
      countryIndex.set(String(key).toLowerCase(), country);
    });
  });

  const options = new Map();
  Object.entries(prices).forEach(([countryKey, services]) => {
    const details = services?.[service] || services;
    const cost = Number(details?.cost);
    const count = Number(details?.count);
    if (!Number.isFinite(cost) || cost < 0 || !Number.isFinite(count) || count <= 0) return;
    const countryInfo = countryIndex.get(String(countryKey).toLowerCase()) || {};
    const country = String(countryInfo.activate_org_code ?? countryKey);
    if (!/^\d{1,5}$/.test(country)) return;
    const option = {
      country,
      title: safeMessage(countryInfo.chn || countryInfo.title || countryInfo.eng || fallbackCountryName(country)),
      iso: /^[A-Z]{2}$/.test(String(countryInfo.iso || "").toUpperCase())
        ? String(countryInfo.iso).toUpperCase()
        : "",
      prefix: String(countryInfo.prefix || "").replace(/\D/g, "").slice(0, 4),
      price: cost,
      count: Math.floor(count),
    };
    const existing = options.get(country);
    if (!existing || option.price < existing.price) options.set(country, option);
  });

  const result = [...options.values()].sort((left, right) => (
    left.price - right.price
    || right.count - left.count
    || left.title.localeCompare(right.title)
  ));
  if (!result.length) throw new SmsBowerError("OpenAI 当前没有可购买的国家号码", { terminal: true });
  return result;
}

function collectCountryRecords(value) {
  const records = [];
  const visit = (item, alias = "", depth = 0) => {
    if (!item || depth > 5) return;
    if (Array.isArray(item)) {
      item.forEach((entry, index) => visit(entry, String(index), depth + 1));
      return;
    }
    if (typeof item !== "object") return;
    if (item.id !== undefined && (item.chn || item.eng || item.title || item.iso)) {
      records.push({ ...item, __alias: alias });
      return;
    }
    Object.entries(item).forEach(([key, entry]) => visit(entry, key, depth + 1));
  };
  visit(value);
  return records;
}

function fallbackCountryName(country) {
  return {
    7: "马来西亚",
    12: "美国（虚拟号码）",
    16: "英国",
    187: "美国",
    1001: "日本",
  }[country] || `国家 ${country}`;
}

function normalizePhoneNumber(value) {
  let phone = String(value || "").trim().replace(/[\s()-]/g, "");
  if (phone.startsWith("00")) phone = `+${phone.slice(2)}`;
  else if (!phone.startsWith("+")) phone = `+${phone}`;
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
    throw new SmsBowerError("接码平台返回的手机号不是有效的国际格式", { terminal: true });
  }
  return phone;
}

function safeMessage(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, 240);
}
