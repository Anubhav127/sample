"use strict";

/**
 * mock-agent uninstaller
 *
 * Interactive mode (launched from Program Files via Add/Remove Programs):
 *   uninstall.exe
 *   - Prompts for password (up to 3 attempts)
 *   - Verifies with backend
 *   - Copies self to %TEMP%, relaunches with --do-uninstall, exits
 *
 * Silent mode (SCCM remote uninstall):
 *   uninstall.exe --silent --password <plaintext-password>
 *   - Verifies password with backend
 *   - Calls msiexec /x directly (no temp copy needed)
 *   - Exits with msiexec exit code (0 = success, 1 = failure)
 *
 * Internal relaunch (copy running from %TEMP%):
 *   uninstall.exe --do-uninstall
 *   - Finds ProductCode from registry
 *   - Calls msiexec /x {ProductCode} /quiet /norestart
 *   - Passes msiexec exit code through
 */

const fs                      = require("fs");
const path                    = require("path");
const os                      = require("os");
const readline                = require("readline");
const { execSync, spawnSync, spawn } = require("child_process");
const axios                   = require("axios");

// -- Constants -----------------------------------------------------------------
const INSTALL_DIR      = "C:\\Program Files\\MockAgent";
const ENV_PATH         = path.join(INSTALL_DIR, ".env");
const DEFAULT_BACKEND  = "http://127.0.0.1:3000";
const MAX_ATTEMPTS     = 3;
const PRODUCT_NAME     = "Mock Agent";
const TEMP_UNINSTALLER = path.join(os.tmpdir(), "mock-agent-uninstall.exe");

const UNINSTALL_KEYS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];

// -- Argument Parsing ----------------------------------------------------------
const args        = process.argv.slice(2);
const IS_SILENT   = args.includes("--silent");
const IS_RELAUNCH = args.includes("--do-uninstall");

function getArgValue(flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

const CLI_PASSWORD = getArgValue("--password");

// -- Logging -------------------------------------------------------------------
function log(msg) {
  // Always log — SCCM captures stdout into its deployment logs
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function die(msg, code = 1) {
  console.error(`[${new Date().toISOString()}] [ERROR] ${msg}`);
  process.exit(code);
}

// -- Read .env -----------------------------------------------------------------
function readBackendUrl() {
  try {
    if (!fs.existsSync(ENV_PATH)) return DEFAULT_BACKEND;
    const lines = fs.readFileSync(ENV_PATH, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq  = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key === "BACKEND_URL") return val.replace(/\/$/, "");
    }
  } catch (_) {}
  return DEFAULT_BACKEND;
}

// -- Find ProductCode from registry --------------------------------------------
function findProductCode() {
  for (const baseKey of UNINSTALL_KEYS) {
    try {
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
            const parts = subkey.split("\\");
            const guid  = parts[parts.length - 1];
            if (guid.startsWith("{") && guid.endsWith("}")) {
              return guid;
            }
          }
        } catch (_) {}
      }
    } catch (_) {}
  }
  return null;
}

// -- Run msiexec and passthrough exit code -------------------------------------
function runMsiExec(productCode) {
  log(`Running: msiexec /x "${productCode}" /quiet /norestart`);

  const result = spawnSync(
    "msiexec",
    ["/x", productCode, "/quiet", "/norestart"],
    { stdio: "inherit" }
  );

  const exitCode = result.status !== null ? result.status : 1;

  if (exitCode === 0) {
    log("Uninstallation completed successfully.");
  } else if (exitCode === 3010) {
    log("Uninstallation completed. Reboot required.");
  } else {
    log(`msiexec exited with code ${exitCode}.`);
  }

  return exitCode;
}

// -- Verify password with backend ----------------------------------------------
async function verifyPassword(backendUrl, password) {
  const response = await axios.post(
    `${backendUrl}/verify-uninstall`,
    { password },
    { timeout: 10000 }
  );
  return response.data;
}

// -- Interactive password prompt -----------------------------------------------
function promptPassword(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl._writeToOutput = function (str) {
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

// -- Copy self to %TEMP% and relaunch ------------------------------------------
function relaunchFromTemp() {
  const self = process.execPath;
  log("Copying uninstaller to temp location...");
  fs.copyFileSync(self, TEMP_UNINSTALLER);

  log("Relaunching from temp...");
  const child = spawn(TEMP_UNINSTALLER, ["--do-uninstall"], {
    detached: true,
    stdio:    "ignore",
  });
  child.unref();

  log("Uninstall process launched. This window will close.");
  process.exit(0);
}

// == PHASE 2: running from %TEMP% — do the actual uninstall ===================
async function phaseDoUninstall() {
  log("Mock Agent Uninstaller — executing uninstall phase");
  log("Locating installation record in registry...");

  const productCode = findProductCode();
  if (!productCode) {
    die(
      `Could not find "${PRODUCT_NAME}" in registry. ` +
      `It may already be uninstalled or run as Administrator.`
    );
  }

  log(`ProductCode: ${productCode}`);
  const exitCode = runMsiExec(productCode);

  // Clean up temp copy
  setTimeout(() => {
    try { fs.unlinkSync(TEMP_UNINSTALLER); } catch (_) {}
    process.exit(exitCode);
  }, 2000);
}

// == PHASE 1 SILENT: SCCM silent uninstall ====================================
async function phaseSilent() {
  log("Mock Agent Uninstaller — silent mode (SCCM)");

  if (!CLI_PASSWORD) {
    die("--password argument is required in silent mode. Usage: uninstall.exe --silent --password <password>");
  }

  const backendUrl = readBackendUrl();
  log(`Backend: ${backendUrl}`);

  let result;
  try {
    result = await verifyPassword(backendUrl, CLI_PASSWORD);
  } catch (err) {
    if (err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT") {
      die(`Cannot reach backend at ${backendUrl}. Ensure the server is reachable from this machine.`);
    }
    die(`Verification error: ${err.message}`);
  }

  if (!result.success) {
    die(`Password verification failed: ${result.message}`);
  }

  log("Password verified. Locating installation record...");

  const productCode = findProductCode();
  if (!productCode) {
    die(`Could not find "${PRODUCT_NAME}" in registry.`);
  }

  log(`ProductCode: ${productCode}`);
  const exitCode = runMsiExec(productCode);
  process.exit(exitCode);
}

// == PHASE 1 INTERACTIVE: launched from Add/Remove Programs ===================
async function phaseInteractive() {
  console.clear();
  console.log("================================================");
  console.log("  Mock Agent - Uninstall Verification");
  console.log("================================================");
  console.log("Administrator password is required to uninstall.");
  console.log("");

  const backendUrl = readBackendUrl();
  let attemptsUsed = 0;

  while (attemptsUsed < MAX_ATTEMPTS) {
    const remaining = MAX_ATTEMPTS - attemptsUsed;
    const password  = await promptPassword(
      `Password (${remaining} attempt${remaining > 1 ? "s" : ""} remaining): `
    );

    if (!password.trim()) {
      console.log("Password cannot be empty.\n");
      continue;
    }

    try {
      const result = await verifyPassword(backendUrl, password);

      if (result.success) {
        log("Password verified. Preparing uninstall...");
        relaunchFromTemp();
        return;
      }

      attemptsUsed++;
      console.log(`\n${result.message}\n`);

      if (result.attemptsRemaining === 0) {
        die("Maximum attempts exceeded. Contact your administrator.");
      }

    } catch (err) {
      if (err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT") {
        die(`Cannot reach backend at ${backendUrl}. Ensure the server is running.`);
      }
      die(`Verification error: ${err.message}`);
    }
  }

  die("Maximum attempts exceeded. Uninstall aborted.");
}

// == Entry Point ===============================================================
async function main() {
  if (IS_RELAUNCH)     return phaseDoUninstall();
  if (IS_SILENT)       return phaseSilent();
  return phaseInteractive();
}

main();