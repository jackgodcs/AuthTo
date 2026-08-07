#!/usr/bin/env node

const emailIndex = process.argv.indexOf("--email");
const email = emailIndex >= 0 ? process.argv[emailIndex + 1] : "unknown@example.invalid";
console.log(`[1/5] Mock queued login started for ${email}`);
console.log("Email OTP (r=resend, q=quit):");

await new Promise((resolve) => {
  const timer = setTimeout(resolve, 60_000);
  process.once("SIGTERM", () => {
    clearTimeout(timer);
    resolve();
  });
});
