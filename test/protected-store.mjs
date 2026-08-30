import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createProtectedStore } from "../src/protected-store.mjs";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-protected-store-"));

try {
  const simulatedStore = createProtectedStore({
    platform: "win32",
    root: path.join(tempRoot, "simulated"),
    powerShellRunner: async (script, input) => {
      if (script.includes("ProtectedData]::Protect")) {
        return { code: 0, stdout: Buffer.from(input, "utf8").toString("base64"), stderr: "" };
      }
      if (script.includes("ProtectedData]::Unprotect")) {
        return { code: 0, stdout: Buffer.from(input.trim(), "base64").toString("utf8"), stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected script" };
    },
  });
  const key = "test-management-key";
  assert.equal(await simulatedStore.load("cpamp"), null);
  await simulatedStore.save("cpamp", key);
  assert.equal(await simulatedStore.load("cpamp"), key);
  const storedFiles = await fs.readdir(path.join(tempRoot, "simulated"));
  assert.equal(storedFiles.length, 1);
  const storedValue = await fs.readFile(path.join(tempRoot, "simulated", storedFiles[0]), "utf8");
  assert.equal(storedValue.includes(key), false);
  await simulatedStore.delete("cpamp");
  assert.equal(await simulatedStore.load("cpamp"), null);

  if (process.platform === "win32") {
    const realStore = createProtectedStore({ root: path.join(tempRoot, "real-dpapi") });
    await realStore.save("cpamp", key);
    assert.equal(await realStore.load("cpamp"), key);
    await realStore.delete("cpamp");
    assert.equal(await realStore.load("cpamp"), null);
  }

  const unsupportedStore = createProtectedStore({ platform: "linux", root: path.join(tempRoot, "linux") });
  await assert.rejects(
    unsupportedStore.save("cpamp", key),
    (error) => error.status === 501 && error.message.includes("Windows DPAPI"),
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("protected store tests passed");
