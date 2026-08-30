import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createCpampSync } from "../src/cpamp-sync.mjs";

const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-cpamp-sync-"));
const files = new Map();
let storedManagementKey = "";
const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== "Bearer test-management-key") {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "invalid management key" }));
    return;
  }

  const requestUrl = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET" && requestUrl.pathname === "/auth-files") {
    const listed = [...files.entries()].map(([name, payload]) => ({
      name,
      email: Array.isArray(payload) ? payload[0]?.email : payload?.email,
      disabled: Array.isArray(payload) ? payload[0]?.disabled : payload?.disabled,
    }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ files: listed }));
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/auth-files/download") {
    const payload = files.get(requestUrl.searchParams.get("name"));
    if (!payload) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "not found" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/auth-files") {
    const raw = await readBody(req);
    const parsed = parseMultipartJson(raw, String(req.headers["content-type"] || ""));
    files.set(parsed.name, parsed.payload);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ message: "not found" }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const secretStore = {
    async save(_name, value) { storedManagementKey = value; },
    async load() { return storedManagementKey || null; },
    async delete() { storedManagementKey = ""; },
  };
  const sync = createCpampSync({ outputRoot, secretStore });
  await sync.load();
  const configured = await sync.configure({
    baseUrl: `${baseUrl}/management.html#/accounts?status=problem`,
    managementKey: "test-management-key",
    autoSyncEnabled: false,
  });
  assert.equal(configured.configured, true);
  assert.equal(configured.autoSyncEnabled, false);
  assert.equal(configured.baseUrl, baseUrl);

  const primary = await writeJob("primary-job", "user@example.com", "access-1", "refresh-1");
  const created = await sync.syncManual([primary]);
  assert.equal(created.created, 1);
  assert.equal(created.updated, 0);
  const primaryFileName = created.results[0].remoteFileName;
  assert.equal(files.get(primaryFileName).access_token, "access-1");

  files.set(primaryFileName, {
    ...files.get(primaryFileName),
    priority: 42,
    proxy_url: "socks5://proxy.example:1080",
    note: "keep this CPAMP setting",
    disabled: true,
  });
  files.set("duplicate-user.json", {
    ...files.get(primaryFileName),
    access_token: "old-duplicate-token",
  });
  const primaryUpdate = await writeJob("primary-update", "user@example.com", "access-2", "refresh-2");
  const updated = await sync.syncManual([primaryUpdate]);
  assert.equal(updated.updated, 1);
  assert.equal(updated.duplicates, 1);
  const preserved = files.get(primaryFileName);
  assert.equal(preserved.access_token, "access-2");
  assert.equal(preserved.refresh_token, "refresh-2");
  assert.equal(preserved.priority, 42);
  assert.equal(preserved.proxy_url, "socks5://proxy.example:1080");
  assert.equal(preserved.note, "keep this CPAMP setting");
  assert.equal(preserved.disabled, true);

  files.set("codex-wrong-xxnear@example.com-plus.json", {
    email: "xxnear@example.com",
    access_token: "wrong-account-token",
  });
  const distinct = await writeJob("distinct-job", "near@example.com", "access-3", "refresh-3");
  const distinctUpdate = await sync.syncManual([distinct]);
  assert.equal(distinctUpdate.created, 1);
  assert.equal(files.get("codex-wrong-xxnear@example.com-plus.json").access_token, "wrong-account-token");

  await sync.configure({ baseUrl, managementKey: "", autoSyncEnabled: true });
  const automaticFirst = await writeJob("automatic-first", "auto@example.com", "auto-access-1", "auto-refresh-1", new Date(Date.now() + 1_000).toISOString());
  await sync.queueCompleted(automaticFirst);
  assert.equal(sync.status().pendingCount, 1);
  assert.equal([...files.values()].some((payload) => payload.email === "auto@example.com"), false);

  const approved = await sync.approvePending([automaticFirst]);
  assert.equal(approved.created, 1);
  assert.equal(sync.status().pendingCount, 0);
  const autoFileName = approved.results[0].remoteFileName;
  const automaticUpdate = await writeJob("automatic-update", "auto@example.com", "auto-access-2", "auto-refresh-2", new Date(Date.now() + 2_000).toISOString());
  await sync.queueCompleted(automaticUpdate);
  assert.equal(files.get(autoFileName).access_token, "auto-access-2");
  assert.equal(sync.recordFor("auto@example.com").state, "synced");

  await sync.shutdown();
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(outputRoot, { recursive: true, force: true });
}

console.log("cpamp sync tests passed");

async function writeJob(id, email, accessToken, refreshToken, completedAt = new Date().toISOString()) {
  const outputPath = path.join(outputRoot, `${id}.json`);
  await fs.writeFile(outputPath, `${JSON.stringify({
    type: "sub2api-data",
    accounts: [{
      name: email,
      credentials: {
        email,
        account_id: `account-${id}`,
        chatgpt_user_id: `user-${id}`,
        organization_id: `org-${id}`,
        plan_type: "plus",
        access_token: accessToken,
        refresh_token: refreshToken,
      },
    }],
  }, null, 2)}\n`);
  return { id, email, outputPath, resultSaved: true, completedAt };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function parseMultipartJson(raw, contentType) {
  const boundary = /boundary=([^;]+)/i.exec(contentType)?.[1]?.replace(/^\"|\"$/g, "");
  assert.ok(boundary, "expected multipart boundary");
  const name = /filename=\"([^\"]+)\"/i.exec(raw)?.[1];
  assert.ok(name, "expected uploaded file name");
  const contentStart = raw.indexOf("\r\n\r\n");
  const contentEnd = raw.indexOf(`\r\n--${boundary}`, contentStart);
  assert.ok(contentStart >= 0 && contentEnd > contentStart, "expected uploaded JSON body");
  return { name, payload: JSON.parse(raw.slice(contentStart + 4, contentEnd)) };
}
