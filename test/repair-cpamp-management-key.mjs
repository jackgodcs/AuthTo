import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { validateAndSaveCpampManagementKey } from "../src/repair-cpamp-management-key.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-repair-cpamp-key-"));
const configPath = path.join(root, "cpamp-sync.json");
await fs.writeFile(configPath, JSON.stringify({ baseUrl: "https://cpamp.example/v0/management" }));

try {
  let saved = null;
  const secretStore = { async save(name, value) { saved = { name, value }; } };
  const success = await validateAndSaveCpampManagementKey(" valid-key ", {
    configPath,
    secretStore,
    async fetchImpl(url, init) {
      assert.equal(url, "https://cpamp.example/v0/management/auth-files");
      assert.equal(init.headers.authorization, "Bearer valid-key");
      return { ok: true, status: 200 };
    },
  });
  assert.equal(success.ok, true);
  assert.deepEqual(saved, { name: "cpamp-management-key", value: "valid-key" });

  saved = null;
  const rejected = await validateAndSaveCpampManagementKey("invalid-key", {
    configPath,
    secretStore,
    async fetchImpl() { return { ok: false, status: 401 }; },
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /HTTP 401/);
  assert.equal(saved, null);

  const empty = await validateAndSaveCpampManagementKey("", { configPath, secretStore });
  assert.equal(empty.ok, false);
  assert.equal(saved, null);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("CPAMP management key repair tests passed");
