import assert from "node:assert/strict";

import { createSmsProvider, publicSmsProviderDefinitions } from "../src/sms-providers.mjs";
import { createSmsBowerClient, SmsBowerError } from "../src/smsbower.mjs";
import { createCustomSmsClient, parseCustomSmsEntries } from "../src/custom-sms.mjs";

const requests = [];
let smsChecks = 0;
const fetchImpl = async (url) => {
  const requestUrl = new URL(url);
  requests.push(requestUrl);
  const action = requestUrl.searchParams.get("action");
  let body;
  if (action === "getNumber") body = "ACCESS_NUMBER:activation-1:60123456789";
  else if (action === "getStatus") body = ++smsChecks === 1 ? "STATUS_WAIT_CODE" : "STATUS_OK:OpenAI code 654321";
  else if (action === "getPrices") body = JSON.stringify({
    12: { dr: { cost: 0.004, count: 366063 } },
    1001: { dr: { cost: 0.42, count: 12 } },
    7: { dr: { cost: 0.18, count: 8 } },
    0: { dr: { cost: 0.08, count: 0 } },
  });
  else if (action === "getCountries") body = JSON.stringify({ data: [
    { id: 12, rus: "США (виртуальные)", eng: "United States (virtual)", chn: "美国（虚拟号码）" },
    { id: 1001, rus: "Япония", eng: "Japan", chn: "日本" },
    { id: 7, rus: "Малайзия", eng: "Malaysia", chn: "马来西亚" },
    { id: 0, rus: "Unavailable", eng: "Unavailable", chn: "无库存" },
  ] });
  else if (action === "setStatus") {
    body = {
      "1": "ACCESS_READY",
      "6": "ACCESS_ACTIVATION",
      "8": "ACCESS_CANCEL",
    }[requestUrl.searchParams.get("status")];
  }
  return new Response(body || "BAD_ACTION", { status: 200 });
};

const client = createSmsBowerClient({ apiKey: "test-api-key", fetchImpl });
const order = await client.getNumber("dr", "1001", "0.42");
assert.deepEqual(order, { requestId: "activation-1", number: "+60123456789" });
assert.equal((await client.getSms(order.requestId)).status, "waiting");
assert.deepEqual(await client.getSms(order.requestId), { status: "received", code: "654321" });
assert.equal(await client.markReady(order.requestId), true);
assert.equal(await client.complete(order.requestId), true);
assert.equal(await client.release(order.requestId), true);
assert.equal(requests[0].searchParams.get("api_key"), "test-api-key");
assert.equal(requests[0].searchParams.get("service"), "dr");
assert.equal(requests[0].searchParams.get("country"), "1001");
assert.equal(requests[0].searchParams.get("maxPrice"), "0.42");
assert.deepEqual(await client.getPriceOptions("dr"), [
  { country: "12", title: "美国（虚拟号码）", iso: "", prefix: "", price: 0.004, count: 366063 },
  { country: "7", title: "马来西亚", iso: "", prefix: "", price: 0.18, count: 8 },
  { country: "1001", title: "日本", iso: "", prefix: "", price: 0.42, count: 12 },
]);

const badClient = createSmsBowerClient({
  apiKey: "test-api-key",
  fetchImpl: async () => new Response("NO_NUMBERS", { status: 200 }),
});
await assert.rejects(() => badClient.getNumber("dr", "1001"), /暂无可用号码/);
await assert.rejects(
  () => createSmsBowerClient({
    apiKey: "test-api-key",
    fetchImpl: async () => new Response("STATUS_OK:order 123456789", { status: 200 }),
  }).getSms("activation-2"),
  (error) => error instanceof SmsBowerError && error.terminal && /没有找到独立的 6 位/.test(error.message),
);

const definitions = publicSmsProviderDefinitions();
assert.deepEqual(definitions.map((provider) => provider.id), ["luban", "smsbower", "custom"]);
const provider = createSmsProvider("smsbower", {
  apiKey: "test-api-key",
  service: "dr",
  country: "1001",
  maxPrice: "0.42",
  countryLabel: "日本",
}, { fetchImpl });
assert.equal(provider.name, "SMSBower");
assert.equal(provider.serviceLabel, "日本");
assert.deepEqual(await provider.getNumber(), { requestId: "activation-1", number: "+60123456789" });
assert.equal((await provider.listNumberOptions())[0].country, "12");
assert.throws(() => createSmsProvider("smsbower", { apiKey: "short", service: "dr", country: "1001" }), /API Key/);
assert.deepEqual(parseCustomSmsEntries([
  "+8613711111111----https://sms.example/first",
  "+8613822222222----https://sms.example/second",
  "+8613711111111----https://sms.example/updated",
].join("\n")), [
  { phone: "+8613711111111", apiUrl: "https://sms.example/updated" },
  { phone: "+8613822222222", apiUrl: "https://sms.example/second" },
]);
assert.throws(() => parseCustomSmsEntries("8613711111111----https://sms.example/code"), /E\.164/);
assert.throws(() => parseCustomSmsEntries("+8613711111111----ftp://sms.example/code"), /HTTP 或 HTTPS/);

let customInboxChecks = 0;
const customFetch = async () => {
  customInboxChecks += 1;
  return new Response(JSON.stringify({ messages: customInboxChecks === 1
    ? [{ id: "old-message", text: "OpenAI code\n111111\n" }]
    : [
        { id: "new-message", text: "OpenAI code\n654321\n" },
        { id: "old-message", text: "OpenAI code\n111111\n" },
      ] }), { status: 200 });
};
const customClient = createCustomSmsClient({
  entries: [
    "+8613711111111----https://sms.example/first",
    "+8613822222222----https://sms.example/second",
  ].join("\n"),
  fetchImpl: customFetch,
  acquireEntry: (entries) => entries[1],
});
assert.equal(customClient.entryCount, 2);
const customOrder = await customClient.getNumber();
assert.equal(customOrder.number, "+8613822222222");
assert.deepEqual(await customClient.getSms(customOrder.requestId), { status: "received", code: "654321" });
assert.equal(await customClient.release(customOrder.requestId), true);
assert.throws(() => createSmsProvider("unknown", {}), /受支持/);

console.log("sms provider tests passed");
