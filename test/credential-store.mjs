import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createCredentialStore } from "../src/credential-store.mjs";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-credentials-"));

try {
  const powerShellRunner = async (script, input) => {
    if (script.includes("ProtectedData]::Protect")) {
      return { code: 0, stdout: Buffer.from(input, "utf8").toString("base64"), stderr: "" };
    }
    if (script.includes("ProtectedData]::Unprotect")) {
      return { code: 0, stdout: Buffer.from(input.trim(), "base64").toString("utf8"), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected script" };
  };
  const store = createCredentialStore({ platform: "win32", windowsRoot: tempRoot, powerShellRunner });
  const email = "Windows.User@example.com";
  const credentials = {
    password: "test-password",
    totpSecret: "JBSWY3DPEHPK3PXP",
    proxyUrl: "socks5h://user:secret@proxy.example:5000",
  };

  assert.deepEqual(await store.load(email), { password: "", totpSecret: "", proxyUrl: "" });
  await store.save(email, credentials);
  assert.deepEqual(await store.load(email.toLowerCase()), credentials);

  const updatedCredentials = {
    password: "更新后的密码",
    totpSecret: "NB2W45DFOIZAQWER",
    proxyUrl: "http://updated:secret@proxy.example:8080",
  };
  await store.save(email, updatedCredentials);
  assert.deepEqual(await store.load(email), updatedCredentials);

  const storedFiles = await fs.readdir(tempRoot);
  assert.equal(storedFiles.length, 1);
  const encryptedAtRest = await fs.readFile(path.join(tempRoot, storedFiles[0]), "utf8");
  assert.equal(encryptedAtRest.includes(updatedCredentials.password), false);
  assert.equal(encryptedAtRest.includes(updatedCredentials.proxyUrl), false);

  await store.delete(email);
  assert.deepEqual(await store.load(email), { password: "", totpSecret: "", proxyUrl: "" });

  if (process.platform === "win32") {
    const realStore = createCredentialStore({ windowsRoot: path.join(tempRoot, "real-dpapi") });
    await realStore.save(email, credentials);
    assert.deepEqual(await realStore.load(email), credentials);
    await realStore.delete(email);
    assert.deepEqual(await realStore.load(email), { password: "", totpSecret: "", proxyUrl: "" });
  }

  let macPayload = "";
  const macStore = createCredentialStore({
    platform: "darwin",
    securityRunner: async (args, input) => {
      if (args[0] === "add-generic-password") {
        macPayload = input.trim().split("\n")[0];
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "find-generic-password") return { code: 0, stdout: macPayload, stderr: "" };
      if (args[0] === "delete-generic-password") return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected command" };
    },
  });
  await macStore.save(email, credentials);
  assert.deepEqual(await macStore.load(email), credentials);
  await macStore.delete(email);

  const unsupportedStore = createCredentialStore({ platform: "linux" });
  await assert.rejects(
    unsupportedStore.save(email, credentials),
    (error) => error.status === 501 && error.message.includes("Windows DPAPI"),
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("credential store tests passed");
