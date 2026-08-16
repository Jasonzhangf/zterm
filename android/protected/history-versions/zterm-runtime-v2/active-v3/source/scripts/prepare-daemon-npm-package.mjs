import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { arch, platform } from 'os';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const workspaceRoot = resolve(projectRoot, '..');
const releaseDistDir = resolve(projectRoot, 'release-dist');
const packageJson = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'));
const version = packageJson.version;
const targetOs = platform();
const targetArch = arch();
const releaseName = `zterm-daemon-${version}-${targetOs}-${targetArch}`;
const releaseDir = resolve(releaseDistDir, releaseName);
const npmPackageName = process.env.ZTERM_DAEMON_NPM_NAME || '@jsonstudio/zterm-daemon';
const npmRoot = resolve(releaseDistDir, 'npm');
const npmPackageDir = resolve(npmRoot, npmPackageName.replace('/', '__'));

function sha256(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

function writeExecutable(filePath, content) {
  writeFileSync(filePath, content);
  chmodSync(filePath, 0o755);
}

function requirePath(path, message) {
  if (!existsSync(path)) {
    throw new Error(message);
  }
}

requirePath(
  releaseDir,
  `daemon release directory not found: ${releaseDir}\nRun: pnpm --dir android run daemon:prepare-release`,
);
requirePath(resolve(releaseDir, 'runtime/server.cjs'), `missing staged daemon runtime under ${releaseDir}`);
requirePath(resolve(releaseDir, 'runtime/node_modules/node-pty'), `missing staged node-pty runtime under ${releaseDir}`);
requirePath(resolve(releaseDir, 'runtime/node_modules/@roamhq/wrtc'), `missing staged @roamhq/wrtc runtime under ${releaseDir}`);
requirePath(
  resolve(releaseDir, `runtime/node_modules/@roamhq/wrtc-${targetOs}-${targetArch}/wrtc.node`),
  `missing staged @roamhq/wrtc-${targetOs}-${targetArch}/wrtc.node under ${releaseDir}`,
);
requirePath(resolve(releaseDir, 'support/zterm-daemon.sh'), `missing daemon support script under ${releaseDir}`);
requirePath(resolve(releaseDir, 'support/zterm-daemon'), `missing native zterm-daemon binary under ${releaseDir}`);

rmSync(npmPackageDir, { recursive: true, force: true });
mkdirSync(resolve(npmPackageDir, 'bin'), { recursive: true });
mkdirSync(resolve(npmPackageDir, 'support'), { recursive: true });
mkdirSync(resolve(npmPackageDir, 'support/windows'), { recursive: true });

cpSync(resolve(releaseDir, 'runtime'), resolve(npmPackageDir, 'runtime'), { recursive: true });
cpSync(resolve(releaseDir, 'support'), resolve(npmPackageDir, 'support'), { recursive: true });
copyFileSync(resolve(releaseDir, 'VERSION'), resolve(npmPackageDir, 'VERSION'));
copyFileSync(resolve(workspaceRoot, 'LICENSE'), resolve(npmPackageDir, 'LICENSE'));
copyFileSync(resolve(projectRoot, 'scripts/windows/zterm-daemon.ps1'), resolve(npmPackageDir, 'support/windows/zterm-daemon.ps1'));

writeExecutable(resolve(npmPackageDir, 'bin/zterm-daemon.cjs'), `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');

const packageRoot = resolve(__dirname, '..');
const args = process.argv.slice(2);

function run(command, commandArgs, extraEnv) {
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
    windowsHide: true,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status === null ? 1 : result.status);
}

if (process.platform === 'win32') {
  const script = resolve(packageRoot, 'support/windows/zterm-daemon.ps1');
  if (!existsSync(script)) {
    console.error('missing Windows daemon runner: ' + script);
    process.exit(1);
  }
  run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
    ZTERM_PACKAGE_ROOT: packageRoot,
  });
}

const script = resolve(packageRoot, 'support/zterm-daemon.sh');
if (!existsSync(script)) {
  console.error('missing daemon runner: ' + script);
  process.exit(1);
}
run(script, args, {});
`);

writeExecutable(resolve(npmPackageDir, 'bin/wterm.cjs'), `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

const args = process.argv.slice(2);
if (args[0] === 'daemon') {
  args.shift();
}
const target = resolve(__dirname, 'zterm-daemon.cjs');
const result = spawnSync(process.execPath, [target, ...args], {
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
`);

writeFileSync(resolve(npmPackageDir, 'support/install-user-shims.cjs'), `#!/usr/bin/env node
const { chmodSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { resolve } = require('node:path');

const packageRoot = resolve(__dirname, '..');
const localBin = resolve(homedir(), '.local/bin');
const isWindows = process.platform === 'win32';

function writeShim(name, body) {
  mkdirSync(localBin, { recursive: true });
  const target = resolve(localBin, name);
  rmSync(target, { force: true });
  writeFileSync(target, body);
  chmodSync(target, 0o755);
}

if (isWindows) {
  writeShim('zterm-daemon.cmd', \`@echo off
node "\${packageRoot}\\\\bin\\\\zterm-daemon.cjs" %*
\`);
  writeShim('wterm.cmd', \`@echo off
node "\${packageRoot}\\\\bin\\\\wterm.cjs" %*
\`);
} else {
  writeShim('zterm-daemon', \`#!/usr/bin/env bash
set -euo pipefail
exec node "\${packageRoot}/bin/zterm-daemon.cjs" "$@"
\`);

  writeShim('wterm', \`#!/usr/bin/env bash
set -euo pipefail
exec node "\${packageRoot}/bin/wterm.cjs" "$@"
\`);
}

console.log('[zterm-daemon] installed user shims');
console.log(\`- \${resolve(localBin, isWindows ? 'zterm-daemon.cmd' : 'zterm-daemon')}\`);
console.log(\`- \${resolve(localBin, isWindows ? 'wterm.cmd' : 'wterm')}\`);
`);
chmodSync(resolve(npmPackageDir, 'support/install-user-shims.cjs'), 0o755);

writeFileSync(resolve(npmPackageDir, 'README.md'), `# zterm-daemon

ZTerm daemon for macOS and Windows. It runs the local WebSocket bridge used by the ZTerm Android app to connect to local terminal sessions. macOS uses tmux; Windows uses WezTerm mux through the ZTerm WezTerm backend adapter.

## Requirements

- ${targetOs} ${targetArch}
- Node.js 20+
- macOS: tmux available on PATH
- Windows: WezTerm available on PATH, or set \`ZTERM_WEZTERM_EXE\` to the portable \`wezterm.exe\`
- macOS remote screenshot: grant Screen Recording permission to the installed \`zterm-daemon\` native binary when macOS prompts

## Install

\`\`\`bash
npm install -g ${npmPackageName}
printf '%s\n' "$RELAY_PASSWORD" | zterm-daemon configure-relay \\
  --relay-url "$RELAY_BASE_URL" \\
  --username "$RELAY_USERNAME" \\
  --password-stdin \\
  --host-id "$(hostname -s)" \\
  --device-id "$(hostname -s)" \\
  --device-name "$(hostname)"
zterm-daemon install-service
zterm-daemon service-status
\`\`\`

The relay password must come from a local secret manager, shell secret, or CI secret. The configure command only prints \`passwordSet=true\`; it must not echo the password.

The installer uses these locations:

- runtime/config/logs: \`~/.zterm\`
- CLI: npm global bin \`zterm-daemon\`
- legacy alias: npm global bin \`wterm\`
- macOS launch agent: \`~/Library/LaunchAgents/com.zterm.android.zterm-daemon.plist\`
- Windows scheduled task: \`ZTermDaemon\`

## Commands

\`\`\`bash
zterm-daemon run               # run in foreground
zterm-daemon start             # start launchd service on macOS, scheduled task/direct process on Windows
zterm-daemon status            # direct runtime status
zterm-daemon stop              # stop service or direct process
zterm-daemon restart           # restart service or direct process
zterm-daemon configure-relay   # write ~/.zterm/config.json mobile.relay from secret input
zterm-daemon install-service   # install and start launchd service or Windows scheduled task
zterm-daemon uninstall-service # stop and remove service
zterm-daemon service-status    # service status
\`\`\`

\`wterm daemon <command>\` is kept as a compatibility alias.

## Configuration

Optional config file: \`~/.zterm/config.json\`.

\`\`\`json
{
  "zterm": {
    "android": {
      "daemon": {
        "host": "0.0.0.0",
        "port": 3333,
        "authToken": "change-me"
      }
    }
  }
}
\`\`\`

Relay account configuration should be written through the global CLI, not by hand-editing scattered daemon files. The command shape is \`zterm-daemon configure-relay --relay-url ... --username ... --password-stdin --host-id ...\`:

\`\`\`bash
printf '%s\n' "$RELAY_PASSWORD" | zterm-daemon configure-relay \\
  --relay-url "$RELAY_BASE_URL" \\
  --username "$RELAY_USERNAME" \\
  --password-stdin \\
  --host-id "mac-studio" \\
  --device-id "mac-studio" \\
  --device-name "Mac Studio"
\`\`\`

Successful output contains \`passwordSet=true\` and never prints the relay password.

Environment variables override config:

- \`ZTERM_HOST\`
- \`ZTERM_PORT\`
- \`ZTERM_AUTH_TOKEN\`
- \`ZTERM_DAEMON_SESSION\`
- \`ZTERM_WEZTERM_EXE\` on Windows

## Android connection

In the ZTerm Android app, create a connection pointing at your Mac host/IP and daemon port, usually \`3333\`. If your Mac and phone are connected by Tailscale, use the Mac Tailscale IP.

## Remote screenshot permission

Remote screenshot permission belongs to the installed native \`zterm-daemon\` binary, not Node.js and not a separate GUI helper. Install the service once, trigger a screenshot from Android, and approve the macOS Screen Recording prompt for \`zterm-daemon\`.
`);

writeFileSync(resolve(npmPackageDir, 'package.json'), `${JSON.stringify({
  name: npmPackageName,
  version,
  description: 'ZTerm daemon for Android terminal bridge, file transfer, relay, and remote screenshot support.',
  license: 'Apache-2.0',
  homepage: 'https://github.com/Jasonzhangf/zterm#readme',
  repository: {
    type: 'git',
    url: 'git+https://github.com/Jasonzhangf/zterm.git',
  },
  bugs: {
    url: 'https://github.com/Jasonzhangf/zterm/issues',
  },
  os: ['darwin', 'win32'],
  cpu: ['arm64', 'x64'],
  type: 'commonjs',
  scripts: {
    postinstall: 'node support/install-user-shims.cjs',
  },
  bin: {
    'zterm-daemon': 'bin/zterm-daemon.cjs',
    wterm: 'bin/wterm.cjs',
  },
  files: [
    'bin',
    'runtime',
    'support',
    'VERSION',
    'README.md',
    'LICENSE',
  ],
  bundledDependencies: [],
  publishConfig: {
    access: 'public',
    registry: 'https://registry.npmjs.org/',
  },
  engines: {
    node: '>=20',
  },
  keywords: ['zterm', 'tmux', 'terminal', 'daemon', 'android'],
}, null, 2)}\n`);

const packOutput = execFileSync('npm', ['pack', npmPackageDir, '--pack-destination', releaseDistDir], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
}).trim();
const tgzName = packOutput.split('\n').filter(Boolean).at(-1);
const tgzPath = resolve(releaseDistDir, tgzName);
const shaPath = `${tgzPath}.sha256`;
const digest = sha256(tgzPath);
writeFileSync(shaPath, `${digest}  ${tgzPath}\n`);

console.log('[prepare-daemon-npm-package] ready');
console.log(`- packageDir: ${npmPackageDir}`);
console.log(`- packageName: ${npmPackageName}`);
console.log(`- version: ${version}`);
console.log(`- tarball: ${tgzPath}`);
console.log(`- sha256: ${digest}`);
console.log(`- size: ${statSync(tgzPath).size}`);
