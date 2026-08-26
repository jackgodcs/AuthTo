import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";

import {
  browserIdentityForTlsProfile,
  DirectTlsProfileProbe,
  proxySupportsSessionRotation,
  rotateProxySession,
  TlsFingerprintTransport,
} from "../src/tls-transport.mjs";

const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  res.setHeader("content-type", "application/json");
  res.setHeader("set-cookie", ["transport_a=1; Max-Age=3600; Path=/", "transport_b=2; Path=/"]);
  if (req.url === "/sentinel") {
    res.end(JSON.stringify({ token: "test-sentinel", proofofwork: { required: false }, turnstile: { required: false } }));
    return;
  }
  if (req.url === "/identity") {
    res.end(JSON.stringify({ headers: req.headers }));
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

  const fallbackTransport = new TlsFingerprintTransport({ enabled: true, profile: "chrome999" });
  const fallbackResponse = await fallbackTransport.request("GET", `http://127.0.0.1:${address.port}/fallback`);
  assert.equal(fallbackResponse.status, 200, "unsupported TLS profiles should fall back to a supported profile");
  await fallbackTransport.close();
  await testConfigureStageProfileFallback();
  testCloudflareWorkerSessionReuse();
  testSentinelWorkerSessionReuse();
  testProfileProbeWorker();
  testBrowserIdentity();
  await testSharedDirectProfileProbe();

  const autoProfileTransport = new TlsFingerprintTransport({ enabled: true, profile: "auto" });
  autoProfileTransport.send = async (message) => {
    assert.equal(message.operation, "probe_profiles");
    assert.equal(message.url, "https://chatgpt.com/");
    assert.equal(message.concurrency, 4, "the dedicated TLS profile probe must use at most four requests");
    return { profile: "chrome142", attempts: 3 };
  };
  await autoProfileTransport.prepareProxy(null, "https://chatgpt.com/");
  assert.equal(autoProfileTransport.profile, "chrome142");
  assert.equal(autoProfileTransport.configuredProxy, null);
  assert.equal(autoProfileTransport.configuredProfile, "chrome142");

  const identityTransport = new TlsFingerprintTransport({ enabled: true, profile: "chrome142" });
  const identityResponse = await identityTransport.request("GET", `http://127.0.0.1:${address.port}/identity`);
  const identityHeaders = (await identityResponse.json()).headers;
  assert.match(identityHeaders["user-agent"], /Chrome\/142\.0\.0\.0/);
  assert.equal(identityHeaders["sec-ch-ua-platform"], '"macOS"');
  assert.match(identityHeaders["sec-ch-ua"], /"Chromium";v="142"/);
  await identityTransport.close();

  const postResponse = await transport.request("POST", `http://127.0.0.1:${address.port}/post`, {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ value: "ok" }),
  });
  assert.deepEqual(JSON.parse(await postResponse.text()), { method: "POST", body: "value=ok" });

  await testDynamicSentinelTransportMessage();

  const original = "socks5h://account-region-JP-sid-oldValue-t-20:password@proxy.example:5000";
  const rotated = new URL(rotateProxySession(original));
  assert.match(decodeURIComponent(rotated.username), /^account-region-JP-sid-[A-Za-z0-9]{8}-t-20$/);
  assert.notEqual(decodeURIComponent(rotated.username), "account-region-JP-sid-oldValue-t-20");
  assert.equal(rotated.password, "password");
  const rotatedSessions = new Set(Array.from({ length: 10 }, () => (
    decodeURIComponent(new URL(rotateProxySession(original)).username)
  )));
  assert.equal(rotatedSessions.size, 10);

  const kookeey = "socks5h://account-id:proxy-secret-JP-91977332-20m@proxy.example.com:1000";
  assert.equal(proxySupportsSessionRotation(kookeey), true);
  const rotatedKookeey = new URL(rotateProxySession(kookeey));
  assert.match(decodeURIComponent(rotatedKookeey.password), /^proxy-secret-JP-[0-9]{8}-20m$/);
  assert.notEqual(decodeURIComponent(rotatedKookeey.password), "proxy-secret-JP-91977332-20m");

  const fixed = "socks5h://user:password@proxy.example:5000";
  assert.equal(proxySupportsSessionRotation(fixed), false);
  assert.equal(rotateProxySession(fixed), fixed);

  const sameProxyRetry = new TlsFingerprintTransport({
    enabled: true,
    sameProxyRiskRetries: 3,
    sameProxyRiskRetryDelayMs: 0,
  });
  const riskResult = {
    status: 409,
    headers: [["content-type", "application/json"], ["cf-mitigated", "challenge"]],
    body: Buffer.from('{"error":"managed challenge"}').toString("base64"),
    cookies: [],
  };
  let sameProxyRequests = 0;
  sameProxyRetry.send = async (message) => {
    if (message.operation === "configure") return {};
    sameProxyRequests += 1;
    if (sameProxyRequests <= 3) return riskResult;
    return {
      status: 200,
      headers: [["content-type", "application/json"]],
      body: Buffer.from('{"ok":true}').toString("base64"),
      cookies: [],
    };
  };
  await sameProxyRetry.configure(fixed);
  const recoveredResponse = await sameProxyRetry.request("GET", "https://chatgpt.com/test", {
    retryRiskControl: true,
  });
  assert.equal(recoveredResponse.status, 200);
  assert.equal(sameProxyRequests, 4, "the initial request plus three same-proxy retries should be allowed");

  const exhaustedRetry = new TlsFingerprintTransport({
    enabled: true,
    sameProxyRiskRetries: 3,
    sameProxyRiskRetryDelayMs: 0,
  });
  let exhaustedRequests = 0;
  exhaustedRetry.send = async (message) => {
    if (message.operation === "configure") return {};
    exhaustedRequests += 1;
    return riskResult;
  };
  await exhaustedRetry.configure(fixed);
  await assert.rejects(
    exhaustedRetry.request("POST", "https://auth.openai.com/api/accounts/add-phone/send", {
      retryRiskControl: true,
    }),
    /PROXY_RISK_CONTROL.*after 3 same-proxy retries/,
  );
  assert.equal(exhaustedRequests, 4);

  const ordinaryBadRequest = new TlsFingerprintTransport({
    enabled: true,
    sameProxyRiskRetries: 3,
    sameProxyRiskRetryDelayMs: 0,
  });
  let ordinaryBadRequestCount = 0;
  ordinaryBadRequest.send = async (message) => {
    if (message.operation === "configure") return {};
    ordinaryBadRequestCount += 1;
    return {
      status: 400,
      headers: [["content-type", "application/json"]],
      body: Buffer.from('{"error":{"message":"phone number unavailable"}}').toString("base64"),
      cookies: [],
    };
  };
  await ordinaryBadRequest.configure(fixed);
  const badRequestResponse = await ordinaryBadRequest.request(
    "POST",
    "https://auth.openai.com/api/accounts/add-phone/send",
    { retryRiskControl: true },
  );
  assert.equal(badRequestResponse.status, 400);
  assert.equal(ordinaryBadRequestCount, 1, "ordinary JSON 400 responses must not be retried as proxy risk control");

  const solvedChallenge = new TlsFingerprintTransport({
    enabled: true,
    sameProxyRiskRetries: 3,
    sameProxyRiskRetryDelayMs: 0,
  });
  const supportedChallenge = {
    status: 403,
    headers: [["content-type", "text/html"], ["cf-mitigated", "challenge"]],
    body: Buffer.from("<html><script>window._cf_chl_opt={};</script><div>Just a moment</div></html>").toString("base64"),
    cookies: [],
  };
  let solvedChallengeRequests = 0;
  let solveOperations = 0;
  solvedChallenge.send = async (message) => {
    if (message.operation === "configure") return {};
    if (message.operation === "solve_cloudflare") {
      solveOperations += 1;
      assert.equal(message.url, "https://chatgpt.com/");
      assert.match(Buffer.from(message.challengeBody, "base64").toString("utf8"), /_cf_chl_opt/);
      assert.match(message.userAgent, /Chrome\/146/);
      assert.equal(message.browserIdentity.platform, "MacIntel");
      assert.equal(message.browserIdentity.locale, "zh-CN");
      assert.equal(message.browserIdentity.languages[0], "zh-CN");
      return { ok: true, status: 200, clearance: true };
    }
    solvedChallengeRequests += 1;
    return solvedChallengeRequests === 1
      ? supportedChallenge
      : {
          status: 200,
          headers: [["content-type", "text/html"]],
          body: Buffer.from("<html>ChatGPT</html>").toString("base64"),
          cookies: [],
        };
  };
  await solvedChallenge.configure(fixed);
  const solvedChallengeResponse = await solvedChallenge.request("GET", "https://chatgpt.com/", {
    retryRiskControl: true,
  });
  assert.equal(solvedChallengeResponse.status, 200);
  assert.equal(solveOperations, 1, "a supported challenge should invoke the solver once");
  assert.equal(solvedChallengeRequests, 2, "successful solving should replay the original request once");

  const challenge400 = new TlsFingerprintTransport({
    enabled: true,
    sameProxyRiskRetries: 3,
    sameProxyRiskRetryDelayMs: 0,
  });
  let challenge400Count = 0;
  challenge400.send = async (message) => {
    if (message.operation === "configure") return {};
    challenge400Count += 1;
    return {
      status: 400,
      headers: [["content-type", "text/html"]],
      body: Buffer.from("<html><div id=\"challenge-platform\"></div></html>").toString("base64"),
      cookies: [],
    };
  };
  await challenge400.configure(fixed);
  await assert.rejects(
    challenge400.request("POST", "https://auth.openai.com/api/accounts/add-phone/send", {
      retryRiskControl: true,
    }),
    /PROXY_RISK_CONTROL.*after 3 same-proxy retries/,
  );
  assert.equal(challenge400Count, 4, "a 400 challenge page should use three same-proxy retries");

  const invalidState409 = new TlsFingerprintTransport({
    enabled: true,
    sameProxyRiskRetries: 3,
    sameProxyRiskRetryDelayMs: 0,
  });
  let invalidState409Count = 0;
  invalidState409.send = async (message) => {
    if (message.operation === "configure") return {};
    invalidState409Count += 1;
    return {
      status: 409,
      headers: [["content-type", "application/json"]],
      body: Buffer.from('{"error":{"code":"invalid_state"}}').toString("base64"),
      cookies: [],
    };
  };
  await invalidState409.configure(fixed);
  const invalidStateResponse = await invalidState409.request(
    "POST",
    "https://auth.openai.com/api/accounts/add-phone/send",
    { retryRiskControl: true },
  );
  assert.equal(invalidStateResponse.status, 409);
  assert.equal(invalidState409Count, 1, "JSON invalid_state must remain a phone-specific error");

  const requestTimeout = new TlsFingerprintTransport({ enabled: true });
  let timeoutRequests = 0;
  requestTimeout.send = async (message) => {
    if (message.operation === "configure") return {};
    timeoutRequests += 1;
    throw new Error(
      "Timeout: Failed to perform, curl: (28) Operation timed out after 30002 milliseconds with 63538 bytes received",
    );
  };
  await requestTimeout.configure(fixed);
  await assert.rejects(
    requestTimeout.request("GET", "https://chatgpt.com/", { retryRiskControl: true }),
    /PROXY_CONNECTION_RETRY: GET https:\/\/chatgpt\.com\/ failed:.*curl: \(28\)/,
  );
  assert.equal(timeoutRequests, 1, "a timed-out login request should rotate the proxy instead of retrying it in place");

  const ordinaryRequestFailure = new TlsFingerprintTransport({ enabled: true });
  ordinaryRequestFailure.send = async (message) => {
    if (message.operation === "configure") return {};
    throw new Error("application payload parsing failed");
  };
  await ordinaryRequestFailure.configure(fixed);
  await assert.rejects(
    ordinaryRequestFailure.request("GET", "https://chatgpt.com/", { retryRiskControl: true }),
    /^Error: application payload parsing failed$/,
  );
  console.log("TLS fingerprint transport tests passed");
} finally {
  await transport.close();
  await new Promise((resolve) => server.close(resolve));
}

async function testConfigureStageProfileFallback() {
  const python = findTestPython();
  assert.ok(python, "a Python interpreter with curl_cffi is required for TLS tests");
  const workerPath = fileURLToPath(new URL("../src/tls_transport.py", import.meta.url));
  const script = String.raw`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("tosub2_tls_transport", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class FakeSession:
    def close(self):
        pass

class FakeRequests:
    attempts = []

    @classmethod
    def Session(cls, impersonate, proxy):
        cls.attempts.append(impersonate)
        if impersonate == "chrome146":
            raise RuntimeError("Impersonating chrome146 is not supported")
        return FakeSession()

module.requests = FakeRequests
worker = module.Worker()
worker.configure(None, "chrome146")
assert worker.impersonate == "chrome145", worker.impersonate
assert FakeRequests.attempts[:2] == ["chrome146", "chrome145"], FakeRequests.attempts
`;
  const result = spawnSync(python.command, [...python.args, "-c", script, workerPath], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    windowsHide: true,
  });
  assert.equal(result.status, 0, `configure-stage TLS fallback failed:\n${result.stderr || result.stdout}`);

  const transport = new TlsFingerprintTransport({ enabled: true, profile: "chrome146" });
  transport.send = async (message) => {
    assert.equal(message.operation, "configure");
    assert.equal(message.impersonate, "chrome146");
    assert.equal(message.verifyTls, true);
    return { configured: true, profile: "chrome145" };
  };
  await transport.configure(null);
  assert.equal(transport.profile, "chrome145");
  assert.equal(transport.configuredProfile, "chrome145");
}

function testCloudflareWorkerSessionReuse() {
  const python = findTestPython();
  assert.ok(python, "a Python interpreter is required for Cloudflare worker tests");
  const workerPath = fileURLToPath(new URL("../src/tls_transport.py", import.meta.url));
  const script = String.raw`
import base64
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("tosub2_tls_transport", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

active_session = object()
captured = {}

class FakeSolver:
    @staticmethod
    def solve_challenge(session, **kwargs):
        assert session is active_session
        captured.update(kwargs)
        return {"ok": True, "status": 200, "clearance": True}

module.CLOUDFLARE_SOLVER = FakeSolver()
worker = module.Worker()
worker.session = active_session
result = worker.solve_cloudflare({
    "url": "https://chatgpt.com/api/test",
    "challengeBody": base64.b64encode(b"<script>window._cf_chl_opt={}</script>").decode("ascii"),
    "userAgent": "Mozilla/5.0 Chrome/146.0.0.0 Safari/537.36",
    "nodeCommand": "/usr/local/bin/node",
    "solverTimeoutMs": 70000,
})
assert result["ok"] is True
assert captured["challenge_url"] == "https://chatgpt.com/api/test"
assert captured["verification_url"] == "https://chatgpt.com/"
assert captured["timeout_seconds"] == 70
assert captured["node_command"] == "/usr/local/bin/node"
`;
  const result = spawnSync(python.command, [...python.args, "-c", script, workerPath], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    windowsHide: true,
  });
  assert.equal(result.status, 0, `Cloudflare worker session reuse test failed:\n${result.stderr || result.stdout}`);
}

function testSentinelWorkerSessionReuse() {
  const python = findTestPython();
  assert.ok(python, "a Python interpreter is required for Sentinel worker tests");
  const workerPath = fileURLToPath(new URL("../src/tls_transport.py", import.meta.url));
  const script = String.raw`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("tosub2_tls_transport", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

active_session = object()
captured = {}

class FakeSentinelClient:
    def __init__(self, **kwargs):
        assert kwargs["client"] is active_session
        captured.update(kwargs)
    def token(self, flow):
        return '{"p":"proof","t":null,"c":"token","id":"device","flow":"' + flow + '"}'
    def session_observer_token(self, flow):
        return '{"so":{"required":true},"c":"collector","id":"device","flow":"' + flow + '"}'
    def close(self):
        captured["closed"] = True

module.SentinelClient = FakeSentinelClient
worker = module.Worker()
worker.session = active_session
result = worker.generate_sentinel_tokens({
    "flow": "password_verify",
    "deviceID": "device",
    "pageUrl": "https://auth.openai.com/log-in/password",
    "userAgent": "Mozilla/5.0 Chrome/145.0.0.0 Safari/537.36",
    "browserIdentity": {"platform": "MacIntel", "languages": ["zh-CN", "zh"]},
    "nodeCommand": "/usr/local/bin/node",
})
assert '"flow":"password_verify"' in result["token"]
assert result["soToken"] is not None
assert captured["device_id"] == "device"
assert captured["page_url"].endswith("/log-in/password")
assert captured["closed"] is True
`;
  const result = spawnSync(python.command, [...python.args, "-c", script, workerPath], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    windowsHide: true,
  });
  assert.equal(result.status, 0, `Sentinel worker session reuse test failed:\n${result.stderr || result.stdout}`);
}

function testProfileProbeWorker() {
  const python = findTestPython();
  assert.ok(python, "a Python interpreter with curl_cffi is required for TLS tests");
  const workerPath = fileURLToPath(new URL("../src/tls_transport.py", import.meta.url));
  const script = String.raw`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("tosub2_tls_transport", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class FakeHeaders(dict):
    pass

class FakeResponse:
    def __init__(self, status, headers=None, content=b""):
        self.status_code = status
        self.headers = FakeHeaders(headers or {})
        self.content = content

class FakeSession:
    def __init__(self, profile):
        self.profile = profile
        self.closed = False

    def get(self, url, timeout, allow_redirects):
        assert url == "https://chatgpt.com/"
        if self.profile == "chrome146":
            return FakeResponse(403, {"content-type": "text/html", "cf-mitigated": "challenge"}, b"Just a moment")
        return FakeResponse(200, {"content-type": "text/html"}, b"ChatGPT")

    def close(self):
        self.closed = True

class FakeRequests:
    attempts = []

    @classmethod
    def Session(cls, impersonate, proxy):
        assert proxy is None
        cls.attempts.append(impersonate)
        return FakeSession(impersonate)

module.requests = FakeRequests
worker = module.Worker()
result = worker.probe_profiles("https://chatgpt.com/", ["chrome146", "chrome142"], 1000)
assert result == {"profile": "chrome142", "attempts": 2}, result
assert worker.impersonate == "chrome142"
assert FakeRequests.attempts == ["chrome146", "chrome142"]
FakeRequests.attempts = []
bounded = module.Worker().probe_profiles(
    "https://chatgpt.com/",
    ["chrome146", "chrome142", "chrome141", "chrome140", "chrome139"],
    1000,
    80,
)
assert bounded == {"profile": "chrome142", "attempts": 4}, bounded
assert FakeRequests.attempts == ["chrome146", "chrome142", "chrome141", "chrome140"]
profiles = worker._supported_chrome_profiles()
assert profiles[0] == "chrome146", profiles
assert "chrome142" in profiles
assert "chrome131_android" not in profiles
assert "chrome" not in profiles
assert worker._is_usable_probe_response(
    FakeResponse(302, {"location": "/cdn-cgi/challenge-platform/test"}),
    "https://chatgpt.com/",
) is False
assert worker._is_usable_probe_response(
    FakeResponse(302, {"location": "https://example.com/"}),
    "https://chatgpt.com/",
) is False
assert worker._is_usable_probe_response(
    FakeResponse(302, {"location": "/auth/login"}),
    "https://chatgpt.com/",
) is True
`;
  const result = spawnSync(python.command, [...python.args, "-c", script, workerPath], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    windowsHide: true,
  });
  assert.equal(result.status, 0, `TLS profile probe test failed:\n${result.stderr || result.stdout}`);
}

async function testSharedDirectProfileProbe() {
  let factoryCalls = 0;
  let prepareCalls = 0;
  let closeCalls = 0;
  let releaseProbe;
  const gate = new Promise((resolve) => { releaseProbe = resolve; });
  const probe = new DirectTlsProfileProbe({
    transportFactory: () => {
      factoryCalls += 1;
      return {
        profile: "auto",
        async prepareProxy(proxy, url) {
          prepareCalls += 1;
          assert.equal(proxy, null);
          assert.equal(url, "https://chatgpt.com/");
          await gate;
          this.profile = "chrome142";
        },
        async close() {
          closeCalls += 1;
        },
      };
    },
  });

  const pending = Array.from({ length: 20 }, () => probe.resolve());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(factoryCalls, 1, "20 concurrent jobs must share one TLS profile probe");
  assert.equal(prepareCalls, 1, "the shared probe must only start one profile scan");
  releaseProbe();
  assert.deepEqual(await Promise.all(pending), Array(20).fill("chrome142"));
  assert.equal(closeCalls, 1);
  assert.equal(await probe.resolve(), "chrome142");
  assert.equal(factoryCalls, 1, "a successful profile must remain cached");

  let retryFactoryCalls = 0;
  const retryProbe = new DirectTlsProfileProbe({
    transportFactory: () => {
      retryFactoryCalls += 1;
      const attempt = retryFactoryCalls;
      return {
        profile: "auto",
        async prepareProxy() {
          if (attempt === 1) throw new Error("temporary probe failure");
          this.profile = "chrome141";
        },
        async close() {},
      };
    },
  });
  await assert.rejects(retryProbe.resolve(), /temporary probe failure/);
  assert.equal(await retryProbe.resolve(), "chrome141");
  assert.equal(retryFactoryCalls, 2, "a failed shared probe must be retryable");
}

function testBrowserIdentity() {
  const modern = browserIdentityForTlsProfile("chrome145");
  assert.match(modern.userAgent, /Macintosh; Intel Mac OS X 10_15_7/);
  assert.match(modern.userAgent, /Chrome\/145\.0\.0\.0/);
  assert.equal(modern.secChUaPlatform, '"macOS"');
  assert.equal(modern.platform, "MacIntel");
  assert.equal(modern.browserMajorVersion, 145);
  const legacy = browserIdentityForTlsProfile("chrome116");
  assert.match(legacy.userAgent, /Windows NT 10\.0; Win64; x64/);
  assert.match(legacy.userAgent, /Chrome\/116\.0\.0\.0/);
  assert.equal(legacy.secChUaPlatform, '"Windows"');
  assert.equal(legacy.platform, "Win32");
}

async function testDynamicSentinelTransportMessage() {
  const sentinelTransport = new TlsFingerprintTransport({ enabled: true, profile: "chrome145" });
  sentinelTransport.send = async (message) => {
    assert.equal(message.operation, "generate_sentinel_tokens");
    assert.equal(message.flow, "oauth_create_account");
    assert.equal(message.deviceID, "identity-device-id");
    assert.equal(message.pageUrl, "https://auth.openai.com/about-you");
    assert.match(message.userAgent, /Chrome\/145\.0\.0\.0/);
    assert.equal(message.browserIdentity.platform, "MacIntel");
    assert.equal(message.browserIdentity.languages[0], "zh-CN");
    return { token: '{"c":"dynamic-token"}', soToken: '{"so":true}' };
  };
  const tokens = await sentinelTransport.generateSentinelTokens({
    flow: "oauth_create_account",
    deviceID: "identity-device-id",
    pageUrl: "https://auth.openai.com/about-you",
  });
  assert.deepEqual(tokens, { token: '{"c":"dynamic-token"}', soToken: '{"so":true}' });
}

function findTestPython() {
  const configured = String(process.env.TOSUB2_PYTHON || "").trim();
  const candidates = configured
    ? [{ command: configured, args: [] }]
    : process.platform === "win32"
      ? [{ command: "python", args: [] }, { command: "py", args: ["-3"] }]
      : [{ command: "python3", args: [] }, { command: "python", args: [] }];
  return candidates.find((candidate) => spawnSync(candidate.command, [...candidate.args, "-c", "import curl_cffi"], {
    stdio: "ignore",
    windowsHide: true,
  }).status === 0) || null;
}
