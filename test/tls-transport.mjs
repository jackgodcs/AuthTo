import assert from "node:assert/strict";
import http from "node:http";

import { proxySupportsSessionRotation, rotateProxySession, TlsFingerprintTransport } from "../src/tls-transport.mjs";
import { fetchSentinelToken } from "../src/sentinel.mjs";

const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  res.setHeader("content-type", "application/json");
  res.setHeader("set-cookie", ["transport_a=1; Max-Age=3600; Path=/", "transport_b=2; Path=/"]);
  if (req.url === "/sentinel") {
    res.end(JSON.stringify({ token: "test-sentinel", proofofwork: { required: false }, turnstile: { required: false } }));
    return;
  }
  res.end(JSON.stringify({ method: req.method, body }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const transport = new TlsFingerprintTransport({ enabled: true, profile: "chrome146" });

try {
  const getResponse = await transport.request("GET", `http://127.0.0.1:${address.port}/get`);
  assert.equal(getResponse.status, 200);
  assert.deepEqual(JSON.parse(await getResponse.text()), { method: "GET", body: "" });
  assert.deepEqual(await getResponse.json(), { method: "GET", body: "" });
  assert.equal(getResponse.headers.rawSetCookie.length, 2);
  assert.deepEqual(
    getResponse.headers.transportCookies
      .filter((cookie) => cookie.domain === "127.0.0.1")
      .map((cookie) => cookie.name)
      .sort(),
    ["transport_a", "transport_b"],
  );
  const expiringCookie = getResponse.headers.transportCookies.find((cookie) => cookie.name === "transport_a");
  assert.ok(expiringCookie.expires > Date.now() + 3_000_000, "cookie expiry should use Unix milliseconds");

  const postResponse = await transport.request("POST", `http://127.0.0.1:${address.port}/post`, {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ value: "ok" }),
  });
  assert.deepEqual(JSON.parse(await postResponse.text()), { method: "POST", body: "value=ok" });

  const sentinelToken = JSON.parse(await fetchSentinelToken({
    deviceID: "test-device-id",
    flow: "oauth_create_account",
    fetch: transport.fetch.bind(transport),
    reqEndpoint: `http://127.0.0.1:${address.port}/sentinel`,
  }));
  assert.equal(sentinelToken.c, "test-sentinel");
  assert.equal(sentinelToken.flow, "oauth_create_account");

  const original = "socks5h://account-region-JP-sid-oldValue-t-20:password@proxy.example:5000";
  const rotated = new URL(rotateProxySession(original));
  assert.match(decodeURIComponent(rotated.username), /^account-region-JP-sid-[A-Za-z0-9]{8}-t-20$/);
  assert.notEqual(decodeURIComponent(rotated.username), "account-region-JP-sid-oldValue-t-20");
  assert.equal(rotated.password, "password");

  const kookeey = "socks5h://account-id:proxy-secret-JP-91977332-20m@proxy.example.com:1000";
  assert.equal(proxySupportsSessionRotation(kookeey), true);
  const rotatedKookeey = new URL(rotateProxySession(kookeey));
  assert.match(decodeURIComponent(rotatedKookeey.password), /^proxy-secret-JP-[0-9]{8}-20m$/);
  assert.notEqual(decodeURIComponent(rotatedKookeey.password), "proxy-secret-JP-91977332-20m");

  const fixed = "socks5h://user:password@proxy.example:5000";
  assert.equal(proxySupportsSessionRotation(fixed), false);
  assert.equal(rotateProxySession(fixed), fixed);
  console.log("TLS fingerprint transport tests passed");
} finally {
  await transport.close();
  await new Promise((resolve) => server.close(resolve));
}
