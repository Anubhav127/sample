"use strict";

/**
 * mock-agent uninstaller
 *
 * Flow:
 *   1. If running as --do-uninstall (from %TEMP%):
 *      - Find ProductCode from registry
 *      - Run msiexec /x {ProductCode} /quiet
 *      - Exit
 *
 *   2. Otherwise (launched from Program Files):
 *      - Read BACKEND_URL from .env next to this EXE
 *      - Prompt for password (up to 3 attempts) via terminal
 *      - Call backend /verify-uninstall
 *      - On success: copy self to %TEMP%, re-launch with --do-uninstall, exit
 *      - On failure: exit with error
 */

const fs        = require("fs");
const path      = require("path");
const os        = require("os");
const readline  = require("readline");
const { execSync, spawn } = require("child_process");
const axios     = require("axios");

// ── Constants ─────────────────────────────────────────────────────────────────
const INSTALL_DIR       = "C:\\Program Files\\MockAgent";
const ENV_PATH          = path.join(INSTALL_DIR, ".env");
const DEFAULT_BACKEND   = "http://127.0.0.1:3000";
const MAX_ATTEMPTS      = 3;
const PRODUCT_NAME      = "Mock Agent";
const TEMP_UNINSTALLER  = path.join(os.tmpdir(), "mock-agent-uninstall.exe");

// ── Registry key paths to search for ProductCode ──────────────────────────────
const UNINSTALL_KEYS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(msg);
}

function die(msg) {
  console.error(`\n[ERROR] ${msg}`);
  process.exit(1);
}

// ── Read .env ─────────────────────────────────────────────────────────────────
function readBackendUrl() {
  try {
    if (!fs.existsSync(ENV_PATH)) return DEFAULT_BACKEND;
    const lines = fs.readFileSync(ENV_PATH, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key === "BACKEND_URL") return val.replace(/\/$/, "");
    }
  } catch (_) {}
  return DEFAULT_BACKEND;
}

// ── Find ProductCode from registry ────────────────────────────────────────────
function findProductCode() {
  for (const baseKey of UNINSTALL_KEYS) {
    try {
      // List all subkeys under the Uninstall key
      const output = execSync(`reg query "${baseKey}" /f "" /k`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      const subkeys = output
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith("HKEY_"));

      for (const subkey of subkeys) {
        try {
          const values = execSync(`reg query "${subkey}" /v DisplayName`, {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });

          if (values.includes(PRODUCT_NAME)) {
            // Extract the GUID from the subkey path — last segment
            const parts = subkey.split("\\");
            const guid = parts[parts.length - 1];
            if (guid.startsWith("{") && guid.endsWith("}")) {
              return guid;
            }
          }
        } catch (_) {
          // subkey has no DisplayName — skip
        }
      }
    } catch (_) {
      // base key query failed — try next
    }
  }
  return null;
}

// ── Prompt password (hidden input via readline) ───────────────────────────────
function promptPassword(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Hide input by overriding _writeToOutput
    rl._writeToOutput = function (str) {
      // Only write the prompt itself, not the typed characters
      if (str === prompt) rl.output.write(str);
      else if (str === "\r\n" || str === "\n") rl.output.write("\n");
      else rl.output.write("*");
    };

    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ── Verify password with backend ──────────────────────────────────────────────
async function verifyPassword(backendUrl, password) {
  const response = await axios.post(
    `${backendUrl}/verify-uninstall`,
    { password },
    { timeout: 10000 }
  );
  return response.data;
}

// ── Copy self to %TEMP% and re-launch with --do-uninstall ─────────────────────
function relaunchFromTemp() {
  const self = process.execPath;

  log("\nCopying uninstaller to temp location...");
  fs.copyFileSync(self, TEMP_UNINSTALLER);

  log("Launching uninstall process...");
  const child = spawn(TEMP_UNINSTALLER, ["--do-uninstall"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  log("Uninstall initiated. This window will close.");
  process.exit(0);
}

// ── Run msiexec uninstall ─────────────────────────────────────────────────────
function runMsiExec(productCode) {
  log(`\nRunning msiexec /x ${productCode} /quiet /norestart ...`);
  try {
    execSync(`msiexec /x "${productCode}" /quiet /norestart`, {
      stdio: "inherit",
    });
    log("Uninstallation complete.");
  } catch (err) {
    die(`msiexec failed with exit code ${err.status}. You may need to uninstall manually.`);
  }

  // Clean up this temp copy after msiexec finishes
  setTimeout(() => {
    try { fs.unlinkSync(TEMP_UNINSTALLER); } catch (_) {}
    process.exit(0);
  }, 2000);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const isDoUninstall = process.argv.includes("--do-uninstall");

  // ── Phase 2: running from %TEMP%, do the actual uninstall ─────────────────
  if (isDoUninstall) {
    log("Mock Agent Uninstaller");
    log("----------------------");
    log("Locating installation record...");

    const productCode = findProductCode();
    if (!productCode) {
      die(
        `Could not find "${PRODUCT_NAME}" in the Windows registry. ` +
        `It may already be uninstalled, or try running as Administrator.`
      );
    }

    log(`Found ProductCode: ${productCode}`);
    runMsiExec(productCode);
    return;
  }

  // ── Phase 1: launched from Program Files, collect and verify password ──────
  console.clear();
  log("================================================");
  log("  Mock Agent — Uninstall Verification");
  log("================================================");
  log("Administrator password is required to uninstall.");
  log("");

  const backendUrl = readBackendUrl();

  let attemptsUsed = 0;

  while (attemptsUsed < MAX_ATTEMPTS) {
    const remaining = MAX_ATTEMPTS - attemptsUsed;
    const password = await promptPassword(
      `Password (${remaining} attempt${remaining > 1 ? "s" : ""} remaining): `
    );

    if (!password.trim()) {
      log("Password cannot be empty.\n");
      continue;
    }

    try {
      const result = await verifyPassword(backendUrl, password);

      if (result.success) {
        log("\nPassword verified. Preparing uninstall...");
        relaunchFromTemp();
        return;
      }

      attemptsUsed++;
      log(`\n${result.message}\n`);

      if (result.attemptsRemaining === 0) {
        die("Maximum attempts exceeded. Contact your administrator.");
      }

    } catch (err) {
      if (err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT") {
        die(`Cannot reach backend at ${backendUrl}. Ensure the server is running and try again.`);
      }
      die(`Verification error: ${err.message}`);
    }
  }

  die("Maximum attempts exceeded. Uninstall aborted.");
}

main();