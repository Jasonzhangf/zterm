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
requirePath(resolve(releaseDir, 'support/zterm-daemon.sh'), `missing daemon support script under ${releaseDir}`);
requirePath(resolve(releaseDir, 'support/zterm-daemon'), `missing native zterm-daemon binary under ${releaseDir}`);

rmSync(npmPackageDir, { recursive: true, force: true });
mkdirSync(resolve(npmPackageDir, 'bin'), { recursive: true });

cpSync(resolve(releaseDir, 'runtime'), resolve(npmPackageDir, 'runtime'), { recursive: true });
rmSync(resolve(npmPackageDir, 'runtime/node_modules'), { recursive: true, force: true });
cpSync(resolve(releaseDir, 'support'), resolve(npmPackageDir, 'support'), { recursive: true });
copyFileSync(resolve(releaseDir, 'VERSION'), resolve(npmPackageDir, 'VERSION'));
copyFileSync(resolve(workspaceRoot, 'LICENSE'), resolve(npmPackageDir, 'LICENSE'));

writeExecutable(resolve(npmPackageDir, 'bin/zterm-daemon'), `#!/usr/bin/env bash
set -euo pipefail
SOURCE="\${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
PACKAGE_ROOT="$(cd -P "$(dirname "$SOURCE")/.." >/dev/null 2>&1 && pwd)"
exec "$PACKAGE_ROOT/support/zterm-daemon.sh" "$@"
`);

writeExecutable(resolve(npmPackageDir, 'bin/wterm'), `#!/usr/bin/env bash
set -euo pipefail
SOURCE="\${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
PACKAGE_ROOT="$(cd -P "$(dirname "$SOURCE")/.." >/dev/null 2>&1 && pwd)"
if [[ "\${1:-}" == "daemon" ]]; then
  shift
fi
exec "$PACKAGE_ROOT/support/zterm-daemon.sh" "$@"
`);

writeFileSync(resolve(npmPackageDir, 'README.md'), `# zterm-daemon

ZTerm daemon for macOS. It runs the local WebSocket bridge used by the ZTerm Android app to connect to local tmux sessions, transfer files, and capture remote screenshots through the installed daemon permission owner.

## Requirements

- macOS ${targetArch}
- Node.js 20+
- tmux available on PATH
- For remote screenshot: grant Screen Recording permission to the installed \`zterm-daemon\` native binary when macOS prompts

## Install

\`\`\`bash
npm install -g ${npmPackageName}
zterm-daemon install-service
zterm-daemon service-status
\`\`\`

The installer uses these locations:

- runtime/config/logs: \`~/.wterm\`
- CLI: npm global bin \`zterm-daemon\`
- legacy alias: npm global bin \`wterm\`
- launch agent: \`~/Library/LaunchAgents/com.zterm.android.zterm-daemon.plist\`

## Commands

\`\`\`bash
zterm-daemon run               # run in foreground
zterm-daemon start             # start launchd service
zterm-daemon status            # direct runtime status
zterm-daemon stop              # stop launchd service
zterm-daemon restart           # restart launchd service
zterm-daemon install-service   # install and start launchd service
zterm-daemon uninstall-service # stop and remove launchd service
zterm-daemon service-status    # launchd service status
\`\`\`

\`wterm daemon <command>\` is kept as a compatibility alias.

## Configuration

Optional config file: \`~/.wterm/config.json\`.

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

Environment variables override config:

- \`ZTERM_HOST\`
- \`ZTERM_PORT\`
- \`ZTERM_AUTH_TOKEN\`
- \`ZTERM_DAEMON_SESSION\`

## Android connection

In the ZTerm Android app, create a connection pointing at your Mac host/IP and daemon port, usually \`3333\`. If your Mac and phone are connected by Tailscale, use the Mac Tailscale IP.

## Remote screenshot permission

Remote screenshot permission belongs to the installed native \`zterm-daemon\` binary, not Node.js and not a separate GUI helper. Install the service once, trigger a screenshot from Android, and approve the macOS Screen Recording prompt for \`zterm-daemon\`.
`);

writeFileSync(resolve(npmPackageDir, 'package.json'), `${JSON.stringify({
  name: npmPackageName,
  version,
  description: 'ZTerm macOS daemon for Android tmux bridge, file transfer, and remote screenshot capture.',
  license: 'Apache-2.0',
  homepage: 'https://github.com/Jasonzhangf/zterm#readme',
  repository: {
    type: 'git',
    url: 'git+https://github.com/Jasonzhangf/zterm.git',
  },
  bugs: {
    url: 'https://github.com/Jasonzhangf/zterm/issues',
  },
  os: [targetOs],
  cpu: [targetArch],
  type: 'commonjs',
  bin: {
    'zterm-daemon': 'bin/zterm-daemon',
    wterm: 'bin/wterm',
  },
  files: [
    'bin',
    'runtime',
    'support',
    'VERSION',
    'README.md',
    'LICENSE',
  ],
  dependencies: {
    'node-pty': '^1.1.0',
  },
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
