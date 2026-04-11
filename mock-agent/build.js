/**
 * build.js - Mock Agent Build Orchestrator
 *
 * Usage:
 *   node build.js          - full build (agent + uninstaller + MSI)
 *   node build.js --agent  - agent EXE only (skip uninstaller + WiX steps)
 *
 * Prerequisites:
 *   - pkg installed globally: npm install -g pkg
 *   - WiX Toolset v3.14 installed at default path
 *   - nssm.exe placed manually in build/ before running full build
 */

"use strict";

const fs            = require("fs");
const path          = require("path");
const { execSync }  = require("child_process");

// -- Paths ---------------------------------------------------------------------
const ROOT              = __dirname;
const AGENT_DIR         = path.join(ROOT, "agent");
const UNINSTALLER_DIR   = path.join(ROOT, "uninstaller");
const BUILD_DIR         = path.join(ROOT, "build");
const WIX_DIR           = path.join(ROOT, "installer", "wix");

const AGENT_PACKAGE_JSON = path.join(AGENT_DIR, "package.json");
const AGENT_INDEX        = path.join(AGENT_DIR, "index.js");
const AGENT_ENV          = path.join(AGENT_DIR, ".env");
const PRODUCT_WXS        = path.join(WIX_DIR, "Product.wxs");

const WIX_BIN = "C:\\Program Files (x86)\\WiX Toolset v3.14\\bin";
const CANDLE  = `"${path.join(WIX_BIN, "candle.exe")}"`;
const LIGHT   = `"${path.join(WIX_BIN, "light.exe")}"`;

// -- Flags ---------------------------------------------------------------------
const AGENT_ONLY = process.argv.includes("--agent");

// -- Helpers -------------------------------------------------------------------
function log(step, message) {
  console.log(`\n[${step}] ${message}`);
}

function run(command, cwd = ROOT) {
  console.log(`  > ${command}`);
  execSync(command, { cwd, stdio: "inherit" });
}

function die(message) {
  console.error(`\n[ERROR] ${message}`);
  process.exit(1);
}

// -- Step 1: Read version ------------------------------------------------------
log("1/8", "Reading version from agent/package.json...");

if (!fs.existsSync(AGENT_PACKAGE_JSON)) {
  die(`package.json not found at ${AGENT_PACKAGE_JSON}`);
}

const agentPkg = JSON.parse(fs.readFileSync(AGENT_PACKAGE_JSON, "utf-8"));
const VERSION  = agentPkg.version;

if (!VERSION || !/^\d+\.\d+\.\d+$/.test(VERSION)) {
  die(`Invalid or missing version: "${VERSION}". Must be semver (e.g. 1.0.0).`);
}

console.log(`  Version: ${VERSION}`);

// -- Step 2: Stamp version into agent/index.js ---------------------------------
log("2/8", "Stamping version into agent/index.js...");

const AGENT_VERSION_PATTERN  = /^const AGENT_VERSION = ".*?";$/m;
const AGENT_VERSION_ORIGINAL = `const AGENT_VERSION = "1.0.0";`;
const AGENT_VERSION_STAMPED  = `const AGENT_VERSION = "${VERSION}";`;

const indexContent = fs.readFileSync(AGENT_INDEX, "utf-8");

if (!AGENT_VERSION_PATTERN.test(indexContent)) {
  die('Could not find AGENT_VERSION line in agent/index.js.');
}

fs.writeFileSync(AGENT_INDEX, indexContent.replace(AGENT_VERSION_PATTERN, AGENT_VERSION_STAMPED), "utf-8");
console.log(`  Stamped AGENT_VERSION = "${VERSION}"`);

// -- Step 3: Stamp version into Product.wxs ------------------------------------
log("3/8", "Stamping version into installer/wix/Product.wxs...");

if (!fs.existsSync(PRODUCT_WXS)) {
  console.warn(`  WARN: Product.wxs not found. Skipping.`);
} else {
  const wxs     = fs.readFileSync(PRODUCT_WXS, "utf-8");
  const stamped = wxs.replace(/(<Product\b[^>]*\bVersion=")[^"]*(")/,`$1${VERSION}$2`);
  fs.writeFileSync(PRODUCT_WXS, stamped, "utf-8");
  console.log(`  Stamped Product Version="${VERSION}"`);
}

// -- Step 4: Compile agent EXE via pkg -----------------------------------------
log("4/8", "Compiling agent EXE via pkg...");

if (!fs.existsSync(BUILD_DIR)) {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  console.log(`  Created build/ directory.`);
}

try {
  run(
    `pkg index.js --target node18-win-x64 --output "${path.join(BUILD_DIR, "mock-agent.exe")}"`,
    AGENT_DIR
  );
  console.log(`  Output: build/mock-agent.exe`);
} catch (err) {
  fs.writeFileSync(AGENT_INDEX, indexContent, "utf-8");
  die(`pkg compilation failed. agent/index.js restored.\n${err.message}`);
}

// -- Step 5: Restore agent/index.js --------------------------------------------
log("5/8", "Restoring agent/index.js...");
fs.writeFileSync(AGENT_INDEX, indexContent, "utf-8");
console.log(`  Restored AGENT_VERSION = "1.0.0"`);

// -- Step 6: Copy .env into build/ ---------------------------------------------
log("6/8", "Copying agent/.env into build/...");

if (!fs.existsSync(AGENT_ENV)) {
  die(`.env not found at ${AGENT_ENV}. Create it with BACKEND_URL before building.`);
}

fs.copyFileSync(AGENT_ENV, path.join(BUILD_DIR, ".env"));
console.log(`  Copied .env -> build/.env`);

// Stop here if --agent only
if (AGENT_ONLY) {
  log("DONE", `Agent-only build complete. Version: ${VERSION}`);
  console.log(`  build/mock-agent.exe`);
  console.log(`  build/.env`);
  process.exit(0);
}

// -- Step 7: Compile uninstaller EXE via pkg -----------------------------------
log("7/8", "Compiling uninstaller EXE via pkg...");

const UNINSTALLER_INDEX = path.join(UNINSTALLER_DIR, "index.js");
if (!fs.existsSync(UNINSTALLER_INDEX)) {
  die(`uninstaller/index.js not found.`);
}

// Make sure uninstaller dependencies are installed
if (!fs.existsSync(path.join(UNINSTALLER_DIR, "node_modules"))) {
  console.log(`  Installing uninstaller dependencies...`);
  run(`npm install`, UNINSTALLER_DIR);
}

run(
  `pkg index.js --target node18-win-x64 --output "${path.join(BUILD_DIR, "uninstall.exe")}"`,
  UNINSTALLER_DIR
);
console.log(`  Output: build/uninstall.exe`);

// -- Step 8: Compile Product.wxs -> mock-agent.msi -----------------------------
log("8/8", "Compiling WiX MSI...");

if (!fs.existsSync(PRODUCT_WXS)) {
  die(`Product.wxs not found. Cannot build MSI.`);
}

const WIXOBJ_DIR     = path.join(BUILD_DIR, "wixobj");
const PRODUCT_WIXOBJ = path.join(WIXOBJ_DIR, "Product.wixobj");
const MSI_OUT        = path.join(BUILD_DIR, "mock-agent.msi");

if (!fs.existsSync(WIXOBJ_DIR)) {
  fs.mkdirSync(WIXOBJ_DIR, { recursive: true });
}

run(
  `${CANDLE} "${PRODUCT_WXS}" -out "${PRODUCT_WIXOBJ}" -dBuildDir="${BUILD_DIR}" -dVersion="${VERSION}"`,
  ROOT
);

// Remove existing MSI before writing — Windows Installer locks the file
// after installation; deleting first avoids an UnauthorizedAccessException
// in light.exe's SetAttributes call. Use PowerShell with elevation so it
// works even when the file is admin-locked by the Windows Installer cache.
if (fs.existsSync(MSI_OUT)) {
  try {
    fs.unlinkSync(MSI_OUT);
  } catch {
    execSync(
      `powershell -Command "Start-Process cmd -Verb RunAs -ArgumentList '/c del /f /q \\"${MSI_OUT}\\"' -Wait"`,
      { stdio: "inherit" }
    );
  }
}

run(
  `${LIGHT} "${PRODUCT_WIXOBJ}" -out "${MSI_OUT}" -ext WixUtilExtension -sice:ICE80`,
  ROOT
);

console.log(`  Output: build/mock-agent.msi`);

// -- Summary -------------------------------------------------------------------
log("DONE", `Full build complete. Version: ${VERSION}`);
console.log(`  build/mock-agent.exe`);
console.log(`  build/.env`);
console.log(`  build/nssm.exe          <- place manually before building MSI`);
console.log(`  build/uninstall.exe`);
console.log(`  build/mock-agent.msi`);