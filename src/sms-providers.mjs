import { createLubanSmsClient } from "./luban-sms.mjs";
import { createSmsBowerClient } from "./smsbower.mjs";
import { createCustomSmsClient } from "./custom-sms.mjs";

export const SMS_PROVIDER_DEFINITIONS = [
  {
    id: "luban",
    name: "LubanSMS",
    description: "使用供应商编号获取手机号",
    fields: [
      { key: "apiKey", label: "API Key", type: "password", placeholder: "输入 LubanSMS API Key" },
      { key: "serviceId", label: "供应商编号", type: "text", placeholder: "例如 121949", summary: true },
    ],
  },
  {
    id: "smsbower",
    name: "SMSBower",
    description: "查询 OpenAI 实时价格和库存后选择国家",
    optionsEndpoint: "/api/sms-providers/smsbower/options",
    fields: [
      { key: "apiKey", label: "API Key", type: "password", placeholder: "输入 SMSBower API Key" },
      { key: "service", label: "服务代码", type: "hidden", defaultValue: "dr" },
      { key: "country", label: "国家与价格", type: "price-select", defaultValue: "1001", summaryKey: "countryLabel" },
      { key: "maxPrice", label: "最高价格", type: "hidden", required: false },
      { key: "countryLabel", label: "国家名称", type: "hidden", required: false },
    ],
  },
  {
    id: "custom",
    name: "自定义接码",
    description: "批量粘贴手机号和对应的接码 API",
    fields: [
      {
        key: "entries",
        label: "手机号与接码 API",
        type: "textarea",
        placeholder: "+861871291167----https://example.com/messages/1871291167",
      },
    ],
  },
];

export function publicSmsProviderDefinitions() {
  return SMS_PROVIDER_DEFINITIONS.map((provider) => ({
    ...provider,
    fields: provider.fields.map((field) => ({ ...field })),
  }));
}

export function createSmsProvider(providerIdValue, configValue = {}, options = {}) {
  const providerId = String(providerIdValue || "").trim().toLowerCase();
  const config = configValue && typeof configValue === "object" ? configValue : {};

  if (providerId === "luban") {
    const apiKey = validateApiKey(config.apiKey, "LubanSMS");
    const serviceId = String(config.serviceId || "").trim();
    if (!/^[a-zA-Z0-9._:-]{1,80}$/.test(serviceId)) throw new Error("请输入有效的 LubanSMS 供应商编号");
    const client = createLubanSmsClient({ apiKey, apiBase: options.lubanApiBase, fetchImpl: options.fetchImpl });
    return {
      id: "luban",
      name: "LubanSMS",
      apiKey,
      serviceLabel: serviceId,
      getNumber: () => client.getNumber(serviceId),
      getSms: (requestId) => client.getSms(requestId),
      release: (requestId) => client.release(requestId),
    };
  }

  if (providerId === "smsbower") {
    const apiKey = validateApiKey(config.apiKey, "SMSBower");
    const service = String(config.service || "dr").trim().toLowerCase();
    const country = String(config.country || "").trim();
    const maxPrice = String(config.maxPrice || "").trim();
    if (!/^[a-z0-9_]{1,32}$/.test(service)) throw new Error("请输入有效的 SMSBower 服务代码");
    if (!/^\d{1,5}$/.test(country)) throw new Error("请输入有效的 SMSBower 国家 ID");
    if (maxPrice && (!/^\d+(?:\.\d{1,6})?$/.test(maxPrice) || Number(maxPrice) <= 0)) {
      throw new Error("请重新查询 SMSBower 国家价格");
    }
    const client = createSmsBowerClient({ apiKey, apiBase: options.smsBowerApiBase, fetchImpl: options.fetchImpl });
    return {
      id: "smsbower",
      name: "SMSBower",
      apiKey,
      serviceLabel: config.countryLabel || `${service} / ${country}`,
      getNumber: () => client.getNumber(service, country, maxPrice),
      listNumberOptions: () => client.getPriceOptions(service),
      getSms: (requestId) => client.getSms(requestId),
      markReady: (requestId) => client.markReady(requestId),
      complete: (requestId) => client.complete(requestId),
      release: (requestId) => client.release(requestId),
    };
  }

  if (providerId === "custom") {
    const client = createCustomSmsClient({
      entries: config.entries,
      fetchImpl: options.fetchImpl,
      acquireEntry: options.acquireCustomSmsEntry,
    });
    return {
      id: "custom",
      name: "自定义接码",
      apiKey: "",
      serviceLabel: `${client.entryCount} 个号码`,
      getNumber: () => client.getNumber(),
      getSms: (requestId) => client.getSms(requestId),
      release: (requestId) => client.release(requestId),
    };
  }

  throw new Error("请选择受支持的接码平台");
}

function validateApiKey(value, providerName) {
  const apiKey = String(value || "").trim();
  if (!/^[a-zA-Z0-9._-]{8,256}$/.test(apiKey)) throw new Error(`请输入有效的 ${providerName} API Key`);
  return apiKey;
}
