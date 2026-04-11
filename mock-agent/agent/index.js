/**
 * mock-agent — index.js
 *
 * Single-file agent. Reads config from .env, collects system info,
 * and POSTs a heartbeat to the backend every 3 minutes.
 *
 * VERSION is stamped here by build.js before pkg compilation.
 * DO NOT edit the version line manually.
 */

"use strict";

const path = require("path");
const os = require("os");
const fs = require("fs");
const axios = require("axios");

// ── Version ───────────────────────────────────────────────────────────────────
// build.js replaces this line before compiling with pkg.
const AGENT_VERSION = "1.0.0";

// ── Config (.env) ─────────────────────────────────────────────────────────────
// When running as a pkg binary, __dirname points inside the snapshot.
// The .env lives next to the EXE on disk, so we resolve from process.execPath.
(function loadEnv() {
  const envPath = path.join(path.dirname(process.execPath), ".env");

  // Fallback to local .env during development (node index.js)
  const devEnvPath = path.join(__dirname, ".env");
  const target = fs.existsSync(envPath) ? envPath : devEnvPath;

  if (!fs.existsSync(target)) {
    log("WARN", `.env not found at ${target}. Using defaults.`);
    return;
  }

  const lines = fs.readFileSync(target, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
})();

const BACKEND_URL = (process.env.BACKEND_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const HEARTBEAT_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

// ── Logger ────────────────────────────────────────────────────────────────────
function log(level, message) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${message}`);
}

// ── System Info ───────────────────────────────────────────────────────────────
function collectSystemInfo() {
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    osRelease: os.release(),
    arch: os.arch(),
    cpu: cpus.length > 0 ? cpus[0].model : "unknown",
    cpuCount: cpus.length,
    totalRamMB: Math.round(os.totalmem() / (1024 * 1024)),
    freeRamMB: Math.round(os.freemem() / (1024 * 1024)),
    uptimeSeconds: Math.round(os.uptime()),
  };
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────
async function sendHeartbeat() {
  const payload = {
    version: AGENT_VERSION,
    timestamp: new Date().toISOString(),
    ...collectSystemInfo(),
  };

  try {
    const response = await axios.post(`${BACKEND_URL}/heartbeat`, payload, {
      timeout: 10000, // 10 second timeout
      headers: { "Content-Type": "application/json" },
    });
    log("INFO", `Heartbeat sent. Backend response: ${response.data?.message}`);
  } catch (err) {
    if (err.code === "ECONNREFUSED") {
      log("WARN", `Heartbeat failed — backend unreachable at ${BACKEND_URL}. Will retry in 3 minutes.`);
    } else if (err.code === "ETIMEDOUT") {
      log("WARN", "Heartbeat failed — request timed out. Will retry in 3 minutes.");
    } else {
      log("WARN", `Heartbeat failed — ${err.message}. Will retry in 3 minutes.`);
    }
  }
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────────
function setupShutdownHandlers(intervalId) {
  function shutdown(signal) {
    log("INFO", `Received ${signal}. Shutting down gracefully...`);
    clearInterval(intervalId);
    log("INFO", "Agent stopped.");
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM")); // NSSM stop
  process.on("SIGINT", () => shutdown("SIGINT"));   // Ctrl+C during dev
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log("INFO", "─────────────────────────────────────────");
  log("INFO", `Mock Agent starting — v${AGENT_VERSION}`);
  log("INFO", `Backend URL : ${BACKEND_URL}`);
  log("INFO", `Heartbeat   : every 3 minutes`);
  log("INFO", `Hostname    : ${os.hostname()}`);
  log("INFO", `Platform    : ${os.platform()} ${os.release()}`);
  log("INFO", "─────────────────────────────────────────");

  // Send immediately on startup
  await sendHeartbeat();

  // Then every 3 minutes
  const intervalId = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

  setupShutdownHandlers(intervalId);
}

main();
