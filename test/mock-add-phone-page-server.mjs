#!/usr/bin/env node
import http from "node:http";

const port = Number(process.argv[2] || 4492);
const base = `http://127.0.0.1:${port}`;
const publicBase = process.argv[3] || base;

const idTokenPayload = Buffer.from(JSON.stringify({
  email: "add-phone-page@example.com",
  sid: "mock-account-id",
  sub: "mock-user-id",
})).toString("base64url");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", base);
  const body = await readBody(req);

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
    return redirect(res, `${publicBase}/choose-an-account`);
  }
  if (req.method === "GET" && url.pathname === "/choose-an-account") {
    return sendText(res, 200, '<html><input name="session_id" value="us_1234567890abcdef"></html>', "text/html");
  }
  if (req.method === "POST" && url.pathname === "/api/accounts/session/select") {
    res.setHeader("set-cookie", "oai-client-auth-session=mock-auth-session; Path=/");
    return sendJson(res, 200, {
      continue_url: `${publicBase}/add-phone`,
      "oai-client-auth-session": {},
    });
  }
  if (req.method === "GET" && url.pathname === "/add-phone") {
    res.setHeader("set-cookie", "add_phone_ready=1; Path=/");
    return sendText(res, 200, "<html><title>Add phone</title></html>", "text/html");
  }
  if (req.method === "POST" && url.pathname === "/api/accounts/add-phone/send") {
    const payload = JSON.parse(body || "{}");
    if (!/\badd_phone_ready=1\b/.test(req.headers.cookie || "")) {
      return sendJson(res, 409, { error: { message: "missing add-phone page state", code: "invalid_state" } });
    }
    if ("channel" in payload) {
      return sendJson(res, 400, { error: { message: "unexpected channel field" } });
    }
    return sendJson(res, 200, {
      continue_url: `${publicBase}/phone-verification`,
      page: { type: "phone_otp_verification" },
    });
  }
  if (req.method === "POST" && url.pathname === "/api/accounts/phone-otp/validate") {
    return sendJson(res, 200, {
      "oai-client-auth-session": {
        workspaces: [{ id: "workspace-personal", kind: "personal" }],
      },
    });
  }
  if (req.method === "POST" && url.pathname === "/api/accounts/workspace/select") {
    const callback = new URL("http://localhost:1455/auth/callback");
    callback.searchParams.set("code", "mock-authorization-code");
    callback.searchParams.set("state", "mock-state");
    return sendJson(res, 200, { continue_url: callback.toString() });
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
  console.log(`[ok] Mock add-phone page server: ${base}`);
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
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
