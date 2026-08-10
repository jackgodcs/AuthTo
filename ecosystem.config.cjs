const path = require("node:path");

const host = String(process.env.ONBOARDING_HOST || "127.0.0.1").trim();
const port = String(process.env.ONBOARDING_PORT || "4399").trim();
const outputRoot = process.env.ONBOARDING_OUTPUT_ROOT
  || path.join(__dirname, "tmp", "chatgpt-onboarding-console");

module.exports = {
  apps: [{
    name: "tosub2",
    cwd: __dirname,
    script: "src/console-server.mjs",
    args: ["--host", host, "--port", port],
    interpreter: process.execPath,
    autorestart: true,
    exp_backoff_restart_delay: 1_000,
    max_restarts: 20,
    min_uptime: "10s",
    kill_timeout: 15_000,
    time: true,
    env: {
      NODE_ENV: "production",
      ONBOARDING_OUTPUT_ROOT: outputRoot,
    },
  }],
};
