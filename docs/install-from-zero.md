# ZTerm From-Zero Clean-Machine Installation Guide & Public Release Audit

This document provides the complete from-zero installation steps for a blank supported OS (`darwin-arm64`, `linux-x64`, `win32-x64`, and Android), the coordinated install order and version compatibility contract with `AppSDK` / `DAGPipe` / `Collab`, and the public release verification matrix for `v0.1.3.3232`.

---

## 1. Published Public Release Artifacts (`v0.1.3.3232`)

- **Source Commit (`origin/main`)**: `492650a074065b96d234167fa77f8d4bd2637d3f`
- **GitHub Public Release**: [`v0.1.3.3232`](https://github.com/Jasonzhangf/zterm/releases/tag/v0.1.3.3232)
- **CI Release Matrix Run**: [`40797381369`](https://github.com/Jasonzhangf/zterm/actions/runs/40797381369)

### 1.1 Public npm Registry Packages (`https://registry.npmjs.org`)

| Package | Version | Dist-Tags (`latest` / `next`) | Tarball SHA-1 (`dist.shasum`) | Target / Role |
|---|---|---|---|---|
| `@jsonstudio/zterm-cli` | `0.1.4` | `0.1.4` / `0.1.4` | `53ae4615c43e54585eb44f6913d34d314acf4b06` | Global user CLI (`zterm`) |
| `@jsonstudio/zterm-daemon` | `0.1.3` | `0.1.3` / `0.1.3` | `bcad7594e4f18cb17925f74659f93af71c0c3aeb` | Public daemon launcher (`zterm-daemon`, `wterm`) |
| `@jsonstudio/zterm-daemon-darwin-arm64` | `0.1.3` | `0.1.3` / `0.1.3` | `c101e50f1c2b78e074e6bf2b413e26626c8cc5bb` | macOS Apple Silicon (`darwin-arm64`) native payload |
| `@jsonstudio/zterm-daemon-linux-x64` | `0.1.3` | `0.1.3` / `0.1.3` | `edc1b1185b36858e11b5e18220a12243c0f31c29` | Linux glibc x86_64 (`linux-x64`) native payload |
| `@jsonstudio/zterm-daemon-win32-x64` | `0.1.3` | `0.1.3` / `0.1.3` | `f9598e400bc1760565be305f7e1587efbc738237` | Windows x64 MSVC (`win32-x64`) native payload |

> **npm-only update (2026-10-31):** `@jsonstudio/zterm-cli@0.1.5` and
> `@jsonstudio/zterm-daemon@0.1.4` (with the matching `0.1.4` platform payloads)
> are published to the public npm registry at `latest`. CLI `0.1.5` adds the
> `zterm app` cross-machine message and file commands; daemon `0.1.4` adds the
> `/app` WebSocket gateway. Install with `npm install -g @jsonstudio/zterm-cli@0.1.5`
> then `zterm daemon install --version 0.1.4`. The GitHub Release assets below
> remain the `v0.1.3.3232` snapshot, which pins daemon `0.1.3`.

### 1.2 GitHub Release `v0.1.3.3232` Assets

| Asset | Size (Bytes) | SHA-256 | Purpose |
|---|---:|---|---|
| `zterm-0.1.3.3232.apk` | `58,277,963` | `ccf4f4d15efd06aec83268eda661059257d7b63a442a236a7a907403dcaa4c84` | Android client installer (`versionCode: 1100032320`) |
| `zterm-0.1.3.3232.1.apk` | `58,277,963` | `d3f3d96facb166cbe13678fcb2499c406fb88be44a78571008851202432fbc98` | Prepared Android rollback installer (`versionCode: 1100032321`) |
| `latest.json` | `815` | `b2a19d1fc435156b2e98dd5d1de976bf029a97797b3e626142a4bc7bf4c7538e` | Android OTA manifest |
| `zterm-daemon-0.1.3-darwin-arm64.tar.gz` | `25,155,691` | `6849da92f487066d8f0155ac262958af61d0e11132af9fa45b110ccfb8399228` | Standalone macOS ARM64 daemon bundle |
| `jsonstudio-zterm-cli-0.1.4.tgz` | `101,579` | `b7650eb07f70b84b449b6c7bf5f78488c1e76db313cb88a02700ff0794388479` | Standalone npm tarball for `@jsonstudio/zterm-cli@0.1.4` |
| `jsonstudio-zterm-daemon-0.1.3.tgz` | `6,518` | `4c9956fe06bb2ab4c4be5a496f49e77153517f0606b6a21be67f8c30f4c43627` | Standalone npm tarball for `@jsonstudio/zterm-daemon@0.1.3` |
| `jsonstudio-zterm-daemon-darwin-arm64-0.1.3.tgz` | `25,594,479` | `cf1c1eb120a2c72242a15f87c5d239a07b2963eb25e04d787be33ff7b1db5e22` | Standalone npm tarball for `@jsonstudio/zterm-daemon-darwin-arm64@0.1.3` |
| `jsonstudio-zterm-daemon-linux-x64-0.1.3.tgz` | `31,014,938` | `5128a5a14746cbff290fd705560be416bc0e8f48c01ca9a54434822460fc3be5` | Standalone npm tarball for `@jsonstudio/zterm-daemon-linux-x64@0.1.3` |
| `jsonstudio-zterm-daemon-win32-x64-0.1.3.tgz` | `24,076,349` | `d186f38953543d708bf63e675d16075f5cbca641e214d72800c7c7fc1d87e240` | Standalone npm tarball for `@jsonstudio/zterm-daemon-win32-x64@0.1.3` |

---

## 2. Version Compatibility & Install Order Contract (`zterm` + `AppSDK` / `Collab`)

1. **Node.js Runtime & Native Addon ABI Constraint (`Node.js 22.x LTS`, `ABI 127`)**:
   - `@jsonstudio/zterm-daemon@0.1.3` platform payloads bundle prebuilt native Node addons (`runtime/dagpipe.node`, `node-pty`, `@roamhq/wrtc-*/wrtc.node`) compiled against **Node.js 22 LTS (`process.versions.modules === "127"`)**.
   - At startup, `zterm-daemon` strictly verifies `manifest.platform.node.abi === process.versions.modules` and fails closed with `daemon_node_abi_mismatch: payload=127 actual=...` if invoked under Node.js 24 (`ABI 137`) or Node.js 20 (`ABI 115`).
   - Although `@jsonstudio/appsdk@0.1.15` declares `"engines": { "node": ">=24.0.0" }` in its npm manifest, its Node wrapper (`bin/appsdk.js`) only spawns the native Rust binary (`bin/appsdk`) and executes without any runtime Node version check under Node.js 22 LTS. Furthermore, `AppSDK`, `DAGPipe`, and `Collab` can be installed as native Rust binaries without any Node.js runtime dependency.
   - **Rule**: On any machine running `zterm-daemon`, **Node.js 22.x LTS (`ABI 127`) MUST be the active `node` binary on `PATH`**.

2. **Standard `tmux` Socket Path (`TMUX_TMPDIR = ~/.tmux/run`)**:
   - Both `zterm-daemon` (`packages/shared/src/terminal/tmux-socket-path.ts`) and `Collab` tmux pane bindings use `~/.tmux/run/tmux-<uid>/default` (`TMUX_TMPDIR="$HOME/.tmux/run"`).
   - **Rule**: Configure `TMUX_TMPDIR="$HOME/.tmux/run"` before starting tmux sessions, `zterm-daemon`, or `collab` so both systems observe the same tmux socket without restarting or terminating any running tmux server.

3. **Coordinated Installation Sequence**:
   - **Step 1**: OS system packages (`curl`, `git`, `tmux` on macOS/Linux, C build toolchain if building Rust/Collab from source).
   - **Step 2**: Node.js 22.x LTS (`v22.x`, verify `node -p "process.versions.modules"` outputs `127`).
   - **Step 3**: Standard `TMUX_TMPDIR` directory and shell profile export (`~/.tmux/run`).
   - **Step 4**: `@jsonstudio/zterm-cli@0.1.4` and `@jsonstudio/zterm-daemon@0.1.3` (`zterm daemon install --version 0.1.3`).
   - **Step 5**: `AppSDK` (`v0.1.0015` / `@jsonstudio/appsdk@0.1.15`), `DAGPipe` (`0.1.0`), and `Collab` (`0.2.x` via `scripts/install-global-collab.sh` from `Jasonzhangf/appsdk` on macOS/Linux).
   - **Step 6**: Configure and start `zterm-daemon` service (`zterm-daemon install-service`) and verify `collab context` in the target project checkout.

---

## 3. Executable From-Zero Installation Steps by OS

### 3.1 macOS Apple Silicon (`darwin-arm64`)

#### Step 1: Install Xcode Command Line Tools, Homebrew, `tmux`, and Node.js 22 LTS

```bash
# 1. Xcode Command Line Tools (if not already installed)
xcode-select -p >/dev/null 2>&1 || xcode-select --install

# 2. Install Homebrew (if not already installed)
if ! command -v brew >/dev/null 2>&1; then
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi

# 3. Install git, tmux, and Node.js 22 LTS (ABI 127)
brew install git tmux node@22
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
grep -q '/opt/homebrew/opt/node@22/bin' ~/.zshrc 2>/dev/null || \
  echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zshrc

# 4. Verify Node 22 and ABI 127
node -v
test "$(node -p 'process.versions.modules')" = "127"
```

#### Step 2: Configure Standard `TMUX_TMPDIR` (`~/.tmux/run`)

```bash
mkdir -p "$HOME/.tmux/run"
chmod 700 "$HOME/.tmux/run"
export TMUX_TMPDIR="$HOME/.tmux/run"
grep -q 'TMUX_TMPDIR="\$HOME/.tmux/run"' ~/.zshenv 2>/dev/null || \
  echo 'export TMUX_TMPDIR="$HOME/.tmux/run"' >> ~/.zshenv
```

#### Step 3: Install `zterm` CLI (`0.1.4`) and `zterm-daemon` (`0.1.3`)

Option A — From the public npm registry:

```bash
npm install --global @jsonstudio/zterm-cli@0.1.4
zterm daemon install --version 0.1.3
export PATH="$HOME/.local/bin:$PATH"
grep -q '\$HOME/.local/bin' ~/.zshrc 2>/dev/null || \
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

Option B — Directly from GitHub Release `v0.1.3.3232` tarballs:

```bash
RELEASE_URL="https://github.com/Jasonzhangf/zterm/releases/download/v0.1.3.3232"
npm install --global "${RELEASE_URL}/jsonstudio-zterm-cli-0.1.4.tgz"
npm install --global \
  "${RELEASE_URL}/jsonstudio-zterm-daemon-darwin-arm64-0.1.3.tgz" \
  "${RELEASE_URL}/jsonstudio-zterm-daemon-0.1.3.tgz"
```

#### Step 4: Verify `zterm` & `zterm-daemon` and Start Daemon Service

```bash
zterm --version
zterm-daemon --help
zterm daemon config

# Start a baseline tmux session under ~/.tmux/run
tmux new-session -d -s main || true

# Install and start the macOS launchd service
zterm-daemon install-service
zterm-daemon service-status
zterm daemon status
```

#### Step 5: Install `AppSDK`, `DAGPipe`, and `Collab` (macOS/Linux Interoperability)

`Collab` (`collab` and `collab-mcp`) is distributed from the `Jasonzhangf/appsdk` source repository (`scripts/install-global-collab.sh`) and requires Rust/Cargo:

```bash
# 1. Install Rust/Cargo if missing
if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  . "$HOME/.cargo/env"
fi

# 2. Clone Jasonzhangf/appsdk and run official installers
WorkDir="$(mktemp -d)"
git clone https://github.com/Jasonzhangf/appsdk.git "$WorkDir/appsdk"
(
  cd "$WorkDir/appsdk"
  ./scripts/install-global-appsdk.sh
  ./scripts/install-global-dagpipe.sh
  ./scripts/install-global-collab.sh
)
rm -rf "$WorkDir"

# 3. Verify installed versions
appsdk version
dagpipe --version
collab --version
```

---

### 3.2 Linux x86_64 (`linux-x64`, glibc)

```bash
# 1. Install system dependencies and tmux
sudo apt-get update
sudo apt-get install -y curl git tmux build-essential pkg-config libssl-dev ca-certificates

# 2. Install Node.js 22.x LTS (ABI 127) via NodeSource or fnm/nvm
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
test "$(node -p 'process.versions.modules')" = "127"

# 3. Configure standard TMUX_TMPDIR
mkdir -p "$HOME/.tmux/run"
chmod 700 "$HOME/.tmux/run"
export TMUX_TMPDIR="$HOME/.tmux/run"
grep -q 'TMUX_TMPDIR="\$HOME/.tmux/run"' ~/.bashrc 2>/dev/null || \
  echo 'export TMUX_TMPDIR="$HOME/.tmux/run"' >> ~/.bashrc

# 4. Install zterm CLI and zterm-daemon
mkdir -p "$HOME/.local"
npm config set prefix "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
npm install --global @jsonstudio/zterm-cli@0.1.4
zterm daemon install --version 0.1.3

# 5. Verify entrypoints and start daemon
zterm --version
zterm-daemon --help
tmux new-session -d -s main || true
zterm-daemon start
zterm daemon status
```

---

### 3.3 Windows x64 (`win32-x64`, PowerShell)

```powershell
# 1. Install Node.js 22 LTS x64 (ABI 127) via winget
winget install --id OpenJS.NodeJS.LTS --version 22.22.2 --silent --accept-package-agreements --accept-source-agreements
node -v
if ((node -p "process.versions.modules") -ne "127") { throw "Node ABI 127 (Node.js 22.x) is required" }

# 2. Install zterm CLI and zterm-daemon from npm
npm install --global @jsonstudio/zterm-cli@0.1.4
zterm daemon install --version 0.1.3

# 3. Verify installed entrypoints and status
$env:Path = "$HOME\.local\bin;$env:Path"
zterm --version
zterm-daemon --help
zterm daemon config
zterm-daemon install-service
zterm-daemon service-status
zterm daemon status
```

---

### 3.4 Android Client (`zterm-0.1.3.3232.apk`)

1. Download `zterm-0.1.3.3232.apk` from [`https://github.com/Jasonzhangf/zterm/releases/download/v0.1.3.3232/zterm-0.1.3.3232.apk`](https://github.com/Jasonzhangf/zterm/releases/download/v0.1.3.3232/zterm-0.1.3.3232.apk) (or install via in-app OTA from `https://relay.codewhisper.cc:18443/relay/updates/latest.json`).
2. Verify SHA-256: `ccf4f4d15efd06aec83268eda661059257d7b63a442a236a7a907403dcaa4c84`.
3. Install on Android device (`adb install -r zterm-0.1.3.3232.apk` or system package installer).

---

## 4. Public Release & Blank-Machine Audit Matrix (2026-10-29)

Per project governance rules (`AGENTS.md`), CI/container/existing-host evidence is strictly separated from genuine blank-machine verification:

| Audit Dimension | Status | Verified Evidence / Concrete Gap |
|---|---|---|
| **GitHub Public Release (`v0.1.3.3232`)** | `VERIFIED` | Published at [`https://github.com/Jasonzhangf/zterm/releases/tag/v0.1.3.3232`](https://github.com/Jasonzhangf/zterm/releases/tag/v0.1.3.3232) on commit `492650a074065b96d234167fa77f8d4bd2637d3f` with 15 installable assets and `verify-release-assets.mjs` (`ok: true`). |
| **npm Public Registry (`@jsonstudio/*`)** | `VERIFIED` | Published and promoted `latest` + `next` dist-tags for `@jsonstudio/zterm-cli@0.1.4`, `@jsonstudio/zterm-daemon@0.1.3`, `@jsonstudio/zterm-daemon-darwin-arm64@0.1.3`, `@jsonstudio/zterm-daemon-linux-x64@0.1.3`, and `@jsonstudio/zterm-daemon-win32-x64@0.1.3`. |
| **Three-Platform Clean CI Runner Build & Install (`darwin-arm64`, `linux-x64`, `win32-x64`)** | `VERIFIED (CI Runner)` | GitHub Actions run [`40797381369`](https://github.com/Jasonzhangf/zterm/actions/runs/40797381369) verified `zterm daemon install`, `zterm daemon status`, `zterm daemon config`, `zterm upgrade` (8/8 isolation suite), `dagpipe.node` (`compileAllDagpipePhases`, `runPhase2DaemonConnection`, `runPhase7Release`), `node-pty`, and `@roamhq/wrtc` across macOS ARM64, Ubuntu x64, and Windows x64 runners. |
| **Android `0.1.3.3232` Device & OTA Gate** | `VERIFIED` | Verified on `emulator-5554` and physical OnePlus 15T (`100.104.163.65:5555`) across all 6 connection routes (`autoSameSubnetLan`, `manualLan`, `manualTailscale`, `autoCrossSubnet`, `manualRtcDirect`, `manualRtcRelay`) + local and public Relay OTA. |
| **Same-Host `AppSDK` / `Collab` Interoperability** | `VERIFIED (Configured Host)` | Verified `appsdk` (`0.1.0015`), `dagpipe` (`0.1.0`), `collab` (`0.2.0381`) `collab context`/`recv`/`sendmessage`, and `zterm-daemon` session drawer Collab role projection (`master`/`CEO`/`peer`). |
| **Genuinely Blank Machine (Physical / Clean OS VM) End-to-End Install & Upgrade/Rollback** | `UNVERIFIED (Blocked on Blank Machine Resource)` | Neither `zterm` nor `appsdk` currently has a provisioned blank physical machine or blank OS VM (`m1793238318673-416`). Pre-configured hosts, containers, and GitHub-hosted CI runners do not substitute for a genuinely blank machine. |
| **`Collab` Public Binary & Blank-Machine Install Sequence Handshake** | `UNVERIFIED (Blocked on AppSDK/Collab Release & Blank Machine)` | Per AppSDK master (`Jenny`, `m1793238318673-416`), `Collab` has no published npm or prebuilt binary release (only source script `collab/scripts/install-global-collab.sh`), has not been verified on a blank machine or Windows/WSL, and daemon binary upgrades require manual `collab down` -> `collab up` maintenance. |
| **Cross-Machine `Collab` <-> `zterm` Transport** | `UNVERIFIED (In Progress: cli-cross-machine-messaging)` | Same-host Collab list/send is verified, but cross-machine routing (`cli-cross-machine-messaging`) is not yet completed or verified across two blank machines. |
