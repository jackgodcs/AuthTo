#!/usr/bin/env node
import http from "node:http";

const port = Number(process.argv[2] || 4488);
let smsChecks = 0;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
  let payload;
  if (url.pathname.endsWith("/getNumber")) {
    payload = url.searchParams.get("service_id") === "121949"
      ? { code: 0, msg: "", number: "60123456789", request_id: "mock-request-1" }
      : { code: 400, msg: "service_id error" };
  } else if (url.pathname.endsWith("/getSms")) {
    smsChecks += 1;
    payload = smsChecks < 2
      ? { code: 0, msg: "wait", sms_msg: { request_id: "mock-request-1" } }
      : { code: 0, msg: "success", sms_code: { code: "654321", text: "OpenAI code: 654321" } };
  } else if (url.pathname.endsWith("/setStatus")) {
    payload = { code: 0, msg: "success" };
  } else {
    payload = { code: 404, msg: "not found" };
  }
  const body = JSON.stringify(payload);
  res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[ok] Mock LubanSMS API: http://127.0.0.1:${port}/v2/api/`);
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
