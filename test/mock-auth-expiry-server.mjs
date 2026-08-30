#!/usr/bin/env node
import http from "node:http";

const port = Number(process.argv[2] || 4491);
const base = `http://127.0.0.1:${port}`;
const publicBase = process.argv[3] || base;
let codexAuthorizeCount = 0;
let sessionSelectInvocationId = null;

const idTokenPayload = Buffer.from(JSON.stringify({
  email: "expiry-test@example.com",
  sid: "mock-account-id",
  sub: "mock-user-id",
})).toString("base64url");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", base);
  await readBody(req);

  if (req.method === "GET" && url.pathname === "/") {
    res.setHeader("set-cookie", [
      "__Host-next-auth.csrf-token=mock-csrf; Path=/",
      "__Secure-next-auth.session-token=mock-session; Path=/",
    ]);
    return sendText(res, 200, "ok");
  }
  if (req.method === "GET" && url.pathname === "/api/auth/providers") return sendJson(res, 200, {});
  if (req.method === "GET" && url.pathname === "/api/auth/csrf") return sendJson(res, 200, { csrfToken: "mock-csrf" });
  if (req.method === "POST" && url.pathname === "/api/auth/signin/openai") {
    return sendJson(res, 200, { url: `${publicBase}/api/accounts/authorize` });
  }
  if (req.method === "GET" && url.pathname === "/api/accounts/authorize") {
    return redirect(res, `${publicBase}/email-verification`);
  }
  if (req.method === "GET" && url.pathname === "/email-verification") {
    return sendText(res, 200, "<html><title>Check your inbox</title></html>", "text/html");
  }
  if (req.method === "POST" && url.pathname === "/api/accounts/email-otp/validate") {
    return sendJson(res, 200, {
      continue_url: `${publicBase}/web-callback`,
      "oai-client-auth-session": { email_verified: true },
    });
  }
  if (req.method === "GET" && url.pathname === "/web-callback") return redirect(res, `${publicBase}/`);
  if (req.method === "GET" && url.pathname === "/oauth/authorize") {
    codexAuthorizeCount += 1;
    if (codexAuthorizeCount === 1) return redirect(res, `${publicBase}/choose-an-account`);
    const callback = new URL("http://localhost:1455/auth/callback");
    callback.searchParams.set("code", "mock-authorization-code");
    callback.searchParams.set("state", url.searchParams.get("state") || "mock-state");
    return redirect(res, callback.toString());
  }
  if (req.method === "GET" && url.pathname === "/choose-an-account") {
    return sendText(res, 200, '<html><input name="session_id" value="us_1234567890abcdef"></html>', "text/html");
  }
  if (req.method === "POST" && url.pathname === "/api/accounts/session/select") {
    sessionSelectInvocationId = req.headers["x-access-flow-invocation-id"] || null;
    return sendJson(res, 200, {
      continue_url: `${publicBase}/add-phone`,
      "oai-client-auth-session": {},
    });
  }
  if (req.method === "POST" && url.pathname === "/api/accounts/add-phone/send") {
    const addPhoneInvocationId = req.headers["x-access-flow-invocation-id"] || null;
    if (!addPhoneInvocationId || addPhoneInvocationId === sessionSelectInvocationId) {
      return sendJson(res, 400, {
        error: { message: "x-access-flow-invocation-id must be unique for each request" },
      });
    }
    return sendJson(res, 409, {
      error: {
        message: "Your sign-in session is no longer valid. Please start over to continue.",
        code: "invalid_state",
      },
    });
  }
  if (req.method === "POST" && url.pathname === "/oauth/token") {
    return sendJson(res, 200, {
      access_token: "mock-access-token",
      refresh_token: "mock-refresh-token",
      id_token: `e30.${idTokenPayload}.signature`,
    });
  }
  return sendJson(res, 404, { error: "not found" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[ok] Mock auth expiry server: ${base}`);
});

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text, contentType = "text/plain") {
  res.writeHead(status, { "content-type": contentType });
  res.end(text);
}

async function readBody(req) {
  for await (const _chunk of req) {
    // Drain the request so keep-alive connections can be reused.
  }
}
