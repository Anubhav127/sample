# Mock Agent — Implementation Guide

This document explains exactly how the mock-agent achieves two things:

1. **Password-protected uninstall** — only a user with the correct backend password can uninstall the agent from Settings > Apps
2. **Silent SCCM-compatible upgrades** — a new version can be pushed silently over a running installation with no errors

Everything documented here is battle-tested and working. Use this as the blueprint to replicate the same behaviour in your real agent.

---

## Table of Contents

1. [Project Structure](#1-project-structure)
2. [How Password-Protected Uninstall Works](#2-how-password-protected-uninstall-works)
   - [The Core Problem It Solves](#the-core-problem-it-solves)
   - [The Registry Trick](#the-registry-trick)
   - [The Two-Phase Uninstall Flow](#the-two-phase-uninstall-flow)
   - [Uninstaller Code Walkthrough](#uninstaller-code-walkthrough)
3. [How Silent Upgrades Work](#3-how-silent-upgrades-work)
   - [The Core Problem It Solves](#the-core-problem-it-solves-1)
   - [WiX Upgrade Sequence Explained](#wix-upgrade-sequence-explained)
   - [The Critical Conditions](#the-critical-conditions)
4. [The WiX Installer (Product.wxs) — Full Explanation](#4-the-wix-installer-productwxs--full-explanation)
   - [MajorUpgrade Element](#majorupgrade-element)
   - [ARPSYSTEMCOMPONENT Property](#arpsystemcomponent-property)
   - [Component GUIDs](#component-guids)
   - [Custom Actions Explained](#custom-actions-explained)
   - [InstallExecuteSequence — The Full Sequence](#installexecutesequence--the-full-sequence)
5. [The Build Pipeline (build.js)](#5-the-build-pipeline-buildjs)
6. [The Agent (agent/index.js)](#6-the-agent-agentindexjs)
7. [Things You Must Get Right in Your Real Agent](#7-things-you-must-get-right-in-your-real-agent)
8. [Common Errors and What Causes Them](#8-common-errors-and-what-causes-them)
9. [SCCM Deployment Command](#9-sccm-deployment-command)

---

## 1. Project Structure

```
mock-agent/
├── agent/
│   ├── index.js          ← Agent source code (heartbeat sender)
│   ├── package.json      ← Version lives here (single source of truth)
│   ├── pkg.config.json   ← pkg compilation config
│   └── .env              ← BACKEND_URL config
│
├── uninstaller/
│   ├── index.js          ← Uninstaller source (password verification + msiexec)
│   └── package.json
│
├── installer/
│   └── wix/
│       └── Product.wxs   ← Windows Installer definition (MSI blueprint)
│
├── build/                ← All compiled outputs land here
│   ├── mock-agent.exe
│   ├── mock-agent.msi
│   ├── uninstall.exe
│   ├── nssm.exe          ← Placed manually (not compiled, downloaded separately)
│   └── .env
│
└── build.js              ← Build orchestrator (8-step pipeline)
```

**Key rule:** The version number lives in exactly one place — `agent/package.json`. The build script stamps it everywhere else (into `index.js` at compile time, into `Product.wxs` for the MSI). Never manually edit the version anywhere else.

---

## 2. How Password-Protected Uninstall Works

### The Core Problem It Solves

When you install a standard MSI, Windows automatically creates an entry in Settings > Apps that lets anyone uninstall it by clicking a button — no password, no check, no server call. For an enterprise agent this is a problem: any local administrator could remove the agent without your knowledge.

The solution has two parts:
1. **Hide** the MSI's native uninstall entry from the UI
2. **Replace** it with a custom entry that runs your own `uninstall.exe` which calls your backend to verify a password before proceeding

### The Registry Trick

When an MSI is installed, Windows registers two things in the registry:

**Entry A — MSI's own registration (ProductCode key):**
```
HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\{ProductCode-GUID}
  UninstallString = MsiExec.exe /I{ProductCode-GUID}
```
This is what Settings > Apps shows by default. Anyone can trigger it.

**Entry B — Your custom entry (written by the installer):**
```
HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\MockAgent
  UninstallString = C:\Program Files (x86)\MockAgent\uninstall.exe
```
This runs your password-protected uninstaller.

Without any intervention, **both entries are visible** in Settings > Apps. The user sees two "Mock Agent" entries and the one without a password works fine, defeating your protection.

**The fix — `ARPSYSTEMCOMPONENT=1`:**

In `Product.wxs`:
```xml
<Property Id="ARPSYSTEMCOMPONENT" Value="1" />
```

This single line tells Windows Installer to stamp `SystemComponent=dword:1` onto the `{ProductCode}` registry key. Settings > Apps checks for this value and **hides that entry from the list**. The key still exists in the registry (the uninstaller needs it to find the ProductCode), but it is invisible in the UI.

Result: Only your custom `MockAgent` entry is visible. The only way to uninstall from the UI is through `uninstall.exe`, which requires a password.

**Custom registry entry written by the installer:**
```xml
<Component Id="UninstallRegistryEntry" Guid="F5A6B7C8-D9E0-1234-F012-456789012345">
  <RegistryValue Root="HKLM"
    Key="SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\MockAgent"
    Name="DisplayName"    Value="Mock Agent"           Type="string" KeyPath="yes" />
  <RegistryValue Root="HKLM"
    Key="SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\MockAgent"
    Name="DisplayVersion" Value="$(var.Version)"       Type="string" />
  <RegistryValue Root="HKLM"
    Key="SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\MockAgent"
    Name="UninstallString" Value="[INSTALLFOLDER]uninstall.exe" Type="string" />
  <RegistryValue Root="HKLM"
    Key="SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\MockAgent"
    Name="NoModify"       Value="1"                    Type="integer" />
  <RegistryValue Root="HKLM"
    Key="SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\MockAgent"
    Name="NoRepair"       Value="1"                    Type="integer" />
</Component>
```

- `DisplayName` + `DisplayVersion` — what Settings > Apps shows
- `UninstallString` — what runs when the user clicks Uninstall; points to your `uninstall.exe`
- `NoModify` + `NoRepair` — hides the "Change" button so users can only uninstall, not repair
- Note: `HKLM\SOFTWARE\...` on a 32-bit MSI gets redirected by Windows to `WOW6432Node\...` automatically

### The Two-Phase Uninstall Flow

The uninstaller uses a two-phase approach because of a Windows limitation: a process cannot delete its own directory or the files within it while it is running from that directory. The agent is installed to `Program Files\MockAgent` and `uninstall.exe` lives there — it cannot call `msiexec /x` from that location because msiexec would try to delete the folder that contains the running process.

**Phase 1 — Interactive (runs from `Program Files\MockAgent\uninstall.exe`):**

```
User clicks Uninstall in Settings > Apps
         |
         v
uninstall.exe launches (from C:\Program Files (x86)\MockAgent\)
         |
         v
Reads BACKEND_URL from .env in the same directory
         |
         v
Prompts for password (hidden input, shows * for each character)
         |
         v
POST /verify-uninstall  { password: "..." }  →  Backend server
         |
    success?
    /       \
  NO         YES
   |           |
  Ask again   Copy uninstall.exe → %TEMP%\mock-agent-uninstall.exe
  (max 3)     Spawn %TEMP%\mock-agent-uninstall.exe --do-uninstall (detached)
               Exit Phase 1 process
```

**Phase 2 — Unattended (runs from `%TEMP%\mock-agent-uninstall.exe --do-uninstall`):**

```
Launched from %TEMP% with --do-uninstall flag
         |
         v
Scan registry for {ProductCode} GUID
  (checks both HKLM\...\Uninstall and HKLM\...\WOW6432Node\...\Uninstall)
  Finds entry where DisplayName = "Mock Agent" and key starts with "{"
         |
         v
msiexec /x {ProductCode} /quiet /norestart
         |
         v
MSI runs its uninstall sequence:
  - CA_StopService  (nssm stop MockAgentService)
  - CA_RemoveService (nssm remove MockAgentService)
  - Files deleted from C:\Program Files (x86)\MockAgent\
  - Registry entries removed
         |
         v
Delete %TEMP%\mock-agent-uninstall.exe (self-cleanup)
Exit
```

Why copy to `%TEMP%` first? Because Phase 1 is running from `Program Files\MockAgent\`. When msiexec tries to delete that directory, it cannot if a process is running from it. By relaunching from `%TEMP%`, Phase 1 exits and frees the directory, then Phase 2 (running from a completely different location) can call msiexec to delete everything including the original `uninstall.exe`.

### Uninstaller Code Walkthrough

**`uninstaller/index.js`:**

```javascript
const INSTALL_DIR      = "C:\\Program Files\\MockAgent";   // Hardcoded install path
const TEMP_UNINSTALLER = path.join(os.tmpdir(), "mock-agent-uninstall.exe");
const MAX_ATTEMPTS     = 3;
const PRODUCT_NAME     = "Mock Agent";   // Must match DisplayName in Product.wxs exactly

// Registry paths to scan for the ProductCode
const UNINSTALL_KEYS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];
```

**Finding the ProductCode** — scans both registry hive paths, queries each subkey for `DisplayName`, matches against `PRODUCT_NAME`, extracts the GUID:

```javascript
function findProductCode() {
  for (const baseKey of UNINSTALL_KEYS) {
    const output = execSync(`reg query "${baseKey}" /f "" /k`, ...);
    const subkeys = output.split(/\r?\n/).filter(l => l.startsWith("HKEY_"));

    for (const subkey of subkeys) {
      const values = execSync(`reg query "${subkey}" /v DisplayName`, ...);
      if (values.includes(PRODUCT_NAME)) {
        const guid = subkey.split("\\").pop();
        if (guid.startsWith("{") && guid.endsWith("}")) return guid;
      }
    }
  }
  return null;
}
```

This works even though `ARPSYSTEMCOMPONENT=1` hides the entry from the UI — the registry key still exists, the scan still finds it.

**Password prompt with hidden input** — overrides readline's `_writeToOutput` to print `*` instead of the typed character:

```javascript
rl._writeToOutput = function (str) {
  if (str === prompt)              rl.output.write(str);   // show the prompt text
  else if (str === "\r\n" || str === "\n") rl.output.write("\n"); // show newline
  else                             rl.output.write("*");   // mask every character
};
```

**Backend verification call:**

```javascript
const response = await axios.post(
  `${backendUrl}/verify-uninstall`,
  { password },
  { timeout: 10000 }
);
// expects: { success: true/false, message: "...", attemptsRemaining: N }
```

Your backend must implement `POST /verify-uninstall`. It receives `{ password }` and returns `{ success, message, attemptsRemaining }`.

**Relaunching from temp:**

```javascript
fs.copyFileSync(process.execPath, TEMP_UNINSTALLER);  // copy self
const child = spawn(TEMP_UNINSTALLER, ["--do-uninstall"], {
  detached: true,   // runs independently of parent
  stdio: "ignore",
});
child.unref();      // parent doesn't wait for child
process.exit(0);    // Phase 1 exits, frees the install directory
```

---

## 3. How Silent Upgrades Work

### The Core Problem It Solves

When you run `msiexec /i new-agent.msi /quiet` over an existing installation, Windows Installer performs a **major upgrade**:
1. It detects the old product via `UpgradeCode` (a fixed GUID shared across all versions)
2. It removes the old product
3. It installs the new product

The problem: the agent runs as a Windows service. The old product's removal sequence tries to delete files while the service is still running, and the new product's install tries to register a service that already exists. Both fail unless the service is explicitly stopped and deregistered between the two operations.

### WiX Upgrade Sequence Explained

With `Schedule="afterInstallInitialize"` (the setting used here), the upgrade order inside a single msiexec call is:

```
msiexec starts new product install
         |
         v
InstallInitialize
         |
         v
RemoveExistingProducts  ← old product's entire removal sequence runs here
  ├─ Old product: CA_StopService   (stops MockAgentService)
  ├─ Old product: CA_RemoveService (removes MockAgentService)
  └─ Old product: RemoveFiles      (deletes old EXE, nssm.exe, etc.)
         |
         v
InstallFiles  ← new product's files are copied (new EXE, nssm.exe, etc.)
         |
         v
CA_StopExistingService   ← NEW: stop any service that slipped through
CA_RemoveExistingService ← NEW: remove any service registration that slipped through
CA_InstallService        ← register MockAgentService fresh with new EXE path
CA_SetServiceDescription
CA_SetServiceAutoStart
CA_HardenEnvAcl_*        ← lock down .env permissions
CA_StartService          ← service is now running the new version
         |
         v
InstallFinalize
```

### The Critical Conditions

Every custom action in `InstallExecuteSequence` has a condition that controls whether it runs. Getting these wrong is the #1 source of upgrade errors.

**Condition for install/upgrade actions:**
```xml
<Custom Action="CA_InstallService" After="CA_RemoveExistingService">NOT REMOVE</Custom>
```
`NOT REMOVE` means: run this action unless we are doing an uninstall. This fires on both fresh install and upgrade (incoming product), and is skipped on uninstall.

**Condition for uninstall actions:**
```xml
<Custom Action="CA_StopService" Before="RemoveFiles">REMOVE="ALL"</Custom>
```
`REMOVE="ALL"` means: run this only when the product is being removed. This fires during both full uninstall and during the old product's removal in an upgrade (inside `RemoveExistingProducts`).

**What went wrong before (and why `NOT UPGRADINGPRODUCTCODE` is dangerous):**

The original code had:
```xml
<!-- WRONG — do not use this -->
<Custom Action="CA_StopService" Before="RemoveFiles">REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE</Custom>
```

`UPGRADINGPRODUCTCODE` is a property that Windows Installer sets on the **old product** when it is being removed as part of an upgrade. The `AND NOT UPGRADINGPRODUCTCODE` condition therefore means "skip this during upgrade". The intention was to avoid a brief service outage, but the consequence was that the service was never stopped during upgrades, so the new product's `CA_InstallService` would fail because the service was already registered.

**Why two sets of stop/remove actions?**

There are two separate stop/remove custom action pairs:

| Action pair | When it runs | Purpose |
|---|---|---|
| `CA_StopExistingService` + `CA_RemoveExistingService` | `NOT REMOVE` (install/upgrade, on the NEW product) | Cleans up any service left behind by the old product's removal, regardless of what version of the installer the old product used |
| `CA_StopService` + `CA_RemoveService` | `REMOVE="ALL"` (uninstall, on THIS product when being removed later) | Properly stops and deregisters the service before files are deleted during a future upgrade or manual uninstall |

The first pair (`CA_StopExistingService`) is the key defensive measure. Even if the previously installed MSI had a buggy stop/remove condition, the new MSI's pre-install cleanup ensures the service is gone before attempting to register it again. This makes upgrades self-healing — the new MSI doesn't trust the old MSI to have done its job correctly.

---

## 4. The WiX Installer (Product.wxs) — Full Explanation

### MajorUpgrade Element

```xml
<MajorUpgrade
  DowngradeErrorMessage="A newer version of Mock Agent is already installed."
  Schedule="afterInstallInitialize" />
```

- `Id="*"` on the `<Product>` element means WiX auto-generates a new ProductCode GUID on every build. This is required for major upgrades to work. If ProductCode stays the same, Windows Installer treats the new install as a repair, not an upgrade.
- `UpgradeCode="A1B2C3D4-..."` is the **fixed** GUID that ties all versions together. It must never change across versions. Windows Installer uses this to detect that the new MSI is an upgrade of the same product family.
- `Schedule="afterInstallInitialize"` places `RemoveExistingProducts` early in the sequence, after `InstallInitialize`. This is the recommended setting — it means old files are removed before new files are written, preventing conflicts.
- `DowngradeErrorMessage` prevents installing an older version over a newer one.

### ARPSYSTEMCOMPONENT Property

```xml
<Property Id="ARPSYSTEMCOMPONENT" Value="1" />
```

Causes Windows Installer to write `SystemComponent=dword:1` to the `{ProductCode}` registry key under `Uninstall`. Settings > Apps and the legacy Add/Remove Programs control panel both check for this value and hide the entry if it is set. The entry still exists in the registry and `msiexec /x {ProductCode}` still works — it is hidden from the UI only.

### Component GUIDs

Every `<Component>` has a fixed `Guid` attribute:

```xml
<Component Id="AgentExe"    Guid="B1C2D3E4-F5A6-7890-BCDE-F12345678901">
<Component Id="AgentEnv"    Guid="C2D3E4F5-A6B7-8901-CDEF-123456789012">
<Component Id="NssmExe"     Guid="D3E4F5A6-B7C8-9012-DEF0-234567890123">
<Component Id="UninstallExe" Guid="E4F5A6B7-C8D9-0123-EF01-345678901234">
<Component Id="UninstallRegistryEntry" Guid="F5A6B7C8-D9E0-1234-F012-456789012345">
```

**These GUIDs must never change between versions.** Component GUIDs are the identity of each installed file in the Windows Installer component database. If you change a GUID, Windows Installer treats the new component as a brand new file and the old component as an orphan, which causes upgrade conflicts and potential file leaks.

**Each file must have its own unique Component GUID.** Never share a Component GUID between two different files.

### Custom Actions Explained

All custom actions use the same pattern:
```xml
<CustomAction
  Id="CA_Name"
  Directory="INSTALLFOLDER"
  ExeCommand='"[INSTALLFOLDER]tool.exe" arguments'
  Execute="deferred"
  Impersonate="no"
  Return="check|ignore" />
```

- `Directory="INSTALLFOLDER"` — sets the working directory for the executable
- `ExeCommand` — the command to run; `[INSTALLFOLDER]` is resolved to the actual install path at scheduling time
- `Execute="deferred"` — runs in the deferred (elevated) execution phase, not the immediate phase. Required for anything that modifies system state (services, files, registry). All actions that need admin access must be deferred.
- `Impersonate="no"` — runs as SYSTEM, not as the calling user. Required for service management.
- `Return="check"` — failure aborts the install (use for critical actions like `CA_InstallService`)
- `Return="ignore"` — failure is silently ignored (use for cleanup actions like stop/remove that may not have anything to clean up on fresh install)

**The 9 custom actions:**

| Action | Command | Return | Purpose |
|---|---|---|---|
| `CA_StopExistingService` | `nssm stop MockAgentService confirm` | ignore | Pre-install: stop any running service |
| `CA_RemoveExistingService` | `nssm remove MockAgentService confirm` | ignore | Pre-install: deregister any existing service |
| `CA_InstallService` | `nssm install MockAgentService "[INSTALLFOLDER]mock-agent.exe"` | **check** | Register the service with nssm |
| `CA_SetServiceDescription` | `nssm set MockAgentService Description "..."` | ignore | Set human-readable description |
| `CA_SetServiceAutoStart` | `nssm set MockAgentService Start SERVICE_AUTO_START` | ignore | Ensure service starts on boot |
| `CA_HardenEnvAcl_Inherit` | `icacls "[INSTALLFOLDER].env" /inheritance:r` | check | Remove inherited ACL entries from .env |
| `CA_HardenEnvAcl_System` | `icacls "[INSTALLFOLDER].env" /grant SYSTEM:(F)` | check | Give SYSTEM full control of .env |
| `CA_HardenEnvAcl_Admins` | `icacls "[INSTALLFOLDER].env" /grant Administrators:(R)` | check | Give Admins read-only access to .env |
| `CA_StartService` | `nssm start MockAgentService` | ignore | Start the service immediately after install |
| `CA_StopService` | `nssm stop MockAgentService confirm` | ignore | Uninstall: stop the service |
| `CA_RemoveService` | `nssm remove MockAgentService confirm` | ignore | Uninstall: deregister the service |

### InstallExecuteSequence — The Full Sequence

```xml
<InstallExecuteSequence>

  <!-- INSTALL / UPGRADE path — condition: NOT REMOVE (not an uninstall) -->
  <Custom Action="CA_StopExistingService"   After="InstallFiles">NOT REMOVE</Custom>
  <Custom Action="CA_RemoveExistingService"  After="CA_StopExistingService">NOT REMOVE</Custom>
  <Custom Action="CA_InstallService"         After="CA_RemoveExistingService">NOT REMOVE</Custom>
  <Custom Action="CA_SetServiceDescription"  After="CA_InstallService">NOT REMOVE</Custom>
  <Custom Action="CA_SetServiceAutoStart"    After="CA_SetServiceDescription">NOT REMOVE</Custom>
  <Custom Action="CA_HardenEnvAcl_Inherit"   After="CA_SetServiceAutoStart">NOT REMOVE</Custom>
  <Custom Action="CA_HardenEnvAcl_System"    After="CA_HardenEnvAcl_Inherit">NOT REMOVE</Custom>
  <Custom Action="CA_HardenEnvAcl_Admins"    After="CA_HardenEnvAcl_System">NOT REMOVE</Custom>
  <Custom Action="CA_StartService"           After="CA_HardenEnvAcl_Admins">NOT REMOVE</Custom>

  <!-- UNINSTALL path — condition: REMOVE="ALL" -->
  <Custom Action="CA_StopService"   Before="RemoveFiles">REMOVE="ALL"</Custom>
  <Custom Action="CA_RemoveService" After="CA_StopService">REMOVE="ALL"</Custom>

</InstallExecuteSequence>
```

The ordering matters:
- `CA_StopExistingService` and `CA_RemoveExistingService` go **After="InstallFiles"** — by this point the new `nssm.exe` is guaranteed to be on disk
- `CA_InstallService` goes after both cleanup actions — the service slot is empty before it runs
- `CA_StopService` goes **Before="RemoveFiles"** — must stop the service before nssm.exe gets deleted

---

## 5. The Build Pipeline (build.js)

The build script is an 8-step pipeline. Run it with `node build.js` from the project root.

```
Step 1: Read version from agent/package.json
Step 2: Stamp version into agent/index.js   (const AGENT_VERSION = "X.Y.Z")
Step 3: Stamp version into Product.wxs      (Product Version="X.Y.Z")
Step 4: Compile agent → build/mock-agent.exe   (via pkg)
Step 5: Restore agent/index.js              (revert version stamp)
Step 6: Copy agent/.env → build/.env
Step 7: Compile uninstaller → build/uninstall.exe  (via pkg)
Step 8: Compile Product.wxs → build/mock-agent.msi (via WiX candle + light)
```

**Version stamping:**

The agent source file has this line:
```javascript
const AGENT_VERSION = "1.0.0";  // build.js temporarily replaces this
```

Build step 2 replaces `"1.0.0"` with the actual version from `package.json`, compiles the binary (so the version is baked into the EXE), then step 5 restores the file to `"1.0.0"`. This keeps the source file in a clean state for git — only compiled binaries carry the real version.

**WiX compilation (step 8):**

Two tools are used, both from WiX Toolset v3.14:

```bash
# candle.exe — compiles .wxs XML to an intermediate .wixobj
candle.exe Product.wxs -out Product.wixobj -dBuildDir="..." -dVersion="X.Y.Z"

# light.exe — links .wixobj into the final .msi
light.exe Product.wixobj -out mock-agent.msi -ext WixUtilExtension -sice:ICE80
```

- `-dBuildDir` and `-dVersion` inject variables into the WiX file (referenced as `$(var.BuildDir)` and `$(var.Version)`)
- `-ext WixUtilExtension` loads the WiX utility extension
- `-sice:ICE80` suppresses the ICE80 validation warning (triggered because 32-bit WiX component declarations reference a 64-bit directory path; the actual install location is correct)

**Pre-delete of existing MSI:**

```javascript
if (fs.existsSync(MSI_OUT)) {
  try {
    fs.unlinkSync(MSI_OUT);
  } catch {
    // Windows Installer locks the .msi file after installation.
    // Use elevated PowerShell to force-delete it.
    execSync(`powershell -Command "Start-Process cmd -Verb RunAs -ArgumentList '/c del /f /q \\"${MSI_OUT}\\"' -Wait"`);
  }
}
```

After installing the MSI, Windows Installer caches and locks the original `.msi` file. If you try to overwrite it by building again, `light.exe` throws `UnauthorizedAccessException`. The build script handles this by deleting the file first, using an elevated process if needed.

---

## 6. The Agent (agent/index.js)

The agent is a Node.js process compiled to a single self-contained Windows EXE via `pkg`. It runs as a Windows service managed by NSSM.

**Config loading from .env:**

When running as a compiled binary (`pkg`), `__dirname` points inside the package snapshot — not to the directory on disk where the EXE lives. Use `process.execPath` to find the actual disk location:

```javascript
const envPath = path.join(path.dirname(process.execPath), ".env");
```

This is critical. If you use `__dirname` to find `.env` in a pkg-compiled binary, it will not find the file.

**Heartbeat payload:**

```javascript
{
  version: AGENT_VERSION,        // baked in at compile time
  timestamp: new Date().toISOString(),
  hostname: os.hostname(),
  platform: os.platform(),       // "win32"
  osRelease: os.release(),
  arch: os.arch(),               // "x64"
  cpu: cpus[0].model,
  cpuCount: cpus.length,
  totalRamMB: Math.round(os.totalmem() / (1024 * 1024)),
  freeRamMB:  Math.round(os.freemem()  / (1024 * 1024)),
  uptimeSeconds: Math.round(os.uptime()),
}
```

**Graceful shutdown (important for NSSM):**

NSSM sends `SIGTERM` when stopping the service. Listen for it:
```javascript
process.on("SIGTERM", () => {
  clearInterval(intervalId);
  process.exit(0);
});
```

Without this, NSSM will wait for the timeout and then force-kill the process.

---

## 7. Things You Must Get Right in Your Real Agent

These are the exact points that caused failures during development of the mock-agent. Every item here was a real bug that had to be debugged and fixed.

### 7.1 — UpgradeCode must be fixed across all versions

```xml
<Product
  Id="*"                                              ← auto-generates new GUID each build
  UpgradeCode="A1B2C3D4-E5F6-7890-ABCD-EF1234567890" ← NEVER change this
  Version="1.1.0">
```

`Id="*"` must be a wildcard so every build gets a new ProductCode. If ProductCode stays the same, upgrading the same version doesn't work — Windows sees it as a repair.

`UpgradeCode` must be the same across all versions of your product. Windows uses it to detect that the new MSI belongs to the same product family and triggers `RemoveExistingProducts`. If you change it, the old version is never removed — you end up with two products installed simultaneously.

Generate one UpgradeCode GUID, write it down, and never change it.

### 7.2 — Component GUIDs must never change

Once an MSI version is deployed, the Component GUIDs for each file are written to the Windows Installer component database on every machine. If a future build changes a Component GUID, the old component becomes an orphan and the new component is treated as a new file — they will both be on disk simultaneously and the old one will never be cleaned up.

Generate one GUID per file, write them down, and never change them across builds.

### 7.3 — Never use `AND NOT UPGRADINGPRODUCTCODE` on stop/remove actions

```xml
<!-- DO NOT DO THIS -->
<Custom Action="CA_StopService" Before="RemoveFiles">REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE</Custom>

<!-- CORRECT -->
<Custom Action="CA_StopService" Before="RemoveFiles">REMOVE="ALL"</Custom>
```

`AND NOT UPGRADINGPRODUCTCODE` blocks the stop/remove action during upgrade, which leaves the service registered. Then the new product tries to install the same service name and fails.

### 7.4 — Always add pre-install cleanup actions on the new product

Do not rely on the old product's MSI to have correctly stopped the service. Always add:

```xml
<CustomAction Id="CA_StopExistingService"  ... Return="ignore" />
<CustomAction Id="CA_RemoveExistingService" ... Return="ignore" />

<Custom Action="CA_StopExistingService"  After="InstallFiles">NOT REMOVE</Custom>
<Custom Action="CA_RemoveExistingService" After="CA_StopExistingService">NOT REMOVE</Custom>
<Custom Action="CA_InstallService"        After="CA_RemoveExistingService">NOT REMOVE</Custom>
```

These run on the new product after its files are written. If the old product left the service running (because of a bug in an earlier MSI), these clean it up before `CA_InstallService` tries to register it fresh. `Return="ignore"` means they silently succeed on fresh install when there is nothing to stop or remove.

### 7.5 — Use `ARPSYSTEMCOMPONENT=1` to hide the MSI's native entry

```xml
<Property Id="ARPSYSTEMCOMPONENT" Value="1" />
```

Without this, two entries appear in Settings > Apps. The native MSI entry has no password protection. Add this to every version of your installer.

### 7.6 — PRODUCT_NAME in uninstaller must exactly match DisplayName in Product.wxs

In `uninstaller/index.js`:
```javascript
const PRODUCT_NAME = "Mock Agent";
```

In `Product.wxs`:
```xml
<RegistryValue Name="DisplayName" Value="Mock Agent" ... />
```

These strings must be identical. The uninstaller finds the ProductCode by scanning the registry for a key whose `DisplayName` value matches `PRODUCT_NAME`. If they differ, `findProductCode()` returns `null` and the uninstall fails.

### 7.7 — INSTALL_DIR in uninstaller must match the actual install path

In `uninstaller/index.js`:
```javascript
const INSTALL_DIR = "C:\\Program Files\\MockAgent";
const ENV_PATH    = path.join(INSTALL_DIR, ".env");
```

The uninstaller reads `BACKEND_URL` from this path. If your installer deploys to a different directory, update this constant. Note: because this MSI is compiled as a 32-bit MSI with `ProgramFiles64Folder`, Windows actually installs to `C:\Program Files (x86)\MockAgent` on 64-bit systems. If you compile your real agent as a 64-bit MSI or use `ProgramFilesFolder`, the path will be different.

### 7.8 — Backend must implement `/verify-uninstall`

Your backend needs this endpoint:
```
POST /verify-uninstall
Body: { "password": "..." }
Response 200: { "success": true, "message": "Verified" }
Response 200: { "success": false, "message": "Wrong password", "attemptsRemaining": 2 }
```

The uninstaller calls this endpoint and only proceeds if `success: true`. If the backend is unreachable (`ECONNREFUSED` or `ETIMEDOUT`), the uninstall is aborted — you cannot uninstall while the backend is offline.

### 7.9 — Build order: always bump version in package.json before building

The version flows from `agent/package.json` to `index.js` (at compile time) and to `Product.wxs` (for the MSI). Always bump the version in `package.json` before running `node build.js`. Never manually edit the version in `index.js` or `Product.wxs` — those are overwritten by the build script.

### 7.10 — The pre-existing MSI file gets locked after install

After installing an MSI, Windows Installer caches and locks the source `.msi` file. Your build script must delete it before `light.exe` tries to write a new one. See the pre-delete logic in `build.js` step 8.

### 7.11 — Use `process.execPath` not `__dirname` in a pkg binary

In any code that needs to read files from disk at runtime (`.env`, logs, config), use:
```javascript
path.dirname(process.execPath)  // directory where the .exe lives on disk
```
Not:
```javascript
__dirname  // inside the pkg snapshot — files don't exist here at runtime
```

This applies to both the agent and the uninstaller.

### 7.12 — nssm.exe must be present in build/ before running the full build

`nssm.exe` is not compiled — it is a pre-built tool downloaded separately. It must be placed manually in `build/nssm.exe` before running `node build.js`. The WiX installer packages it from there.

Download from: https://nssm.cc/download — use the 64-bit version (`nssm-2.24.zip` → `win64/nssm.exe`)

---

## 8. Common Errors and What Causes Them

### Error 1603 / `CA_InstallService returned actual error code 5`

**Cause:** The service is already registered when `nssm install MockAgentService` runs. Error code 5 from NSSM means "access denied" — which is what nssm returns when the service name is already taken.

**Fix:** Add `CA_StopExistingService` and `CA_RemoveExistingService` running `After="InstallFiles"` with `Return="ignore"` and condition `NOT REMOVE`. Also ensure `CA_StopService`/`CA_RemoveService` use condition `REMOVE="ALL"` without `AND NOT UPGRADINGPRODUCTCODE`.

### Error 1721 / `CA_InstallService — program required for install could not be run`

**Cause:** `nssm.exe` was deleted before `CA_InstallService` ran. This happens when the old product's `RemoveFiles` deletes `nssm.exe` and then the deferred `CA_InstallService` tries to use it.

**Fix:** Schedule `CA_StopExistingService` and `CA_RemoveExistingService` `After="InstallFiles"` on the new product — by that point the new `nssm.exe` is already on disk regardless of what the old product deleted.

### Two entries in Settings > Apps / one uninstalls without password

**Cause:** `ARPSYSTEMCOMPONENT=1` is missing from `Product.wxs`. The MSI's native `{ProductCode}` entry is visible alongside the custom `MockAgent` entry.

**Fix:** Add `<Property Id="ARPSYSTEMCOMPONENT" Value="1" />` to `Product.wxs`.

If stale ProductCode entries from old installs (before the fix) are still visible, patch them manually:
```powershell
# Run as Administrator
Set-ItemProperty -LiteralPath "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\{YOUR-OLD-PRODUCT-CODE}" -Name "SystemComponent" -Value 1 -Type DWord
```

### `light.exe: Access to the path ... mock-agent.msi is denied`

**Cause:** Windows Installer locked the previous `.msi` file after installation.

**Fix:** Delete the `.msi` before running `light.exe`. The `build.js` already handles this. If you see this error, the pre-delete logic failed — check if an elevated process is needed (the build.js fallback uses PowerShell RunAs).

### `findProductCode()` returns null in uninstaller

**Cause:** `PRODUCT_NAME` in `uninstaller/index.js` does not match the `DisplayName` written by the installer.

**Fix:** Make sure both strings are identical. Also ensure the registry scan covers both `HKLM\SOFTWARE\...\Uninstall` and `HKLM\SOFTWARE\WOW6432Node\...\Uninstall`.

### Build fails: `Could not find AGENT_VERSION line in agent/index.js`

**Cause:** The version line in `agent/index.js` does not match the pattern `const AGENT_VERSION = "...";`.

**Fix:** The line must be exactly `const AGENT_VERSION = "1.0.0";` (with the placeholder value `"1.0.0"`). The build script matches against this regex: `/^const AGENT_VERSION = ".*?";$/m`.

---

## 9. SCCM Deployment Command

For SCCM (or any patch management system), the deployment command is:

```
msiexec /i mock-agent.msi /quiet /norestart
```

- `/quiet` — fully silent, no UI
- `/norestart` — suppresses any automatic reboot

This command works for both fresh installs and upgrades over a running installation. The installer handles stopping the service, replacing the files, and restarting the service entirely on its own.

For logging (useful for SCCM troubleshooting):
```
msiexec /i mock-agent.msi /quiet /norestart /l*v C:\Windows\Temp\mock-agent-install.log
```

---

## Quick Checklist for Real Agent Implementation

Copy and use this checklist when porting to your real agent:

- [ ] Set `Id="*"` on `<Product>` (auto-generate ProductCode per build)
- [ ] Set a fixed `UpgradeCode` GUID — write it down, never change it
- [ ] Assign a unique fixed GUID to every `<Component>` — never change these
- [ ] Add `<Property Id="ARPSYSTEMCOMPONENT" Value="1" />`
- [ ] Add `<MajorUpgrade Schedule="afterInstallInitialize" />`
- [ ] Write a custom `Uninstall\YourProduct` registry key with `UninstallString` pointing to your `uninstall.exe`
- [ ] Add `CA_StopExistingService` + `CA_RemoveExistingService` on the new product (`After="InstallFiles"`, `Return="ignore"`, `NOT REMOVE`)
- [ ] Add `CA_InstallService` after the cleanup pair (`NOT REMOVE`)
- [ ] Add `CA_StopService` + `CA_RemoveService` for uninstall (`Before="RemoveFiles"`, `REMOVE="ALL"`, no `AND NOT UPGRADINGPRODUCTCODE`)
- [ ] All service management CAs: `Execute="deferred"`, `Impersonate="no"`
- [ ] `PRODUCT_NAME` in uninstaller matches `DisplayName` in installer exactly
- [ ] `INSTALL_DIR` in uninstaller matches the actual install path
- [ ] Backend implements `POST /verify-uninstall`
- [ ] Agent uses `path.dirname(process.execPath)` (not `__dirname`) to find `.env`
- [ ] Version lives only in `package.json`; build script stamps it everywhere else
- [ ] Build script pre-deletes the existing `.msi` before compiling
- [ ] `nssm.exe` is present in `build/` before running the full build
