import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const workspaceRoot = resolve(projectRoot, '..');
const releaseDistDir = resolve(projectRoot, 'release-dist');
const packageJson = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'));
const version = packageJson.version;
const npmPackageName = process.env.ZTERM_RELAY_SERVER_NPM_NAME || '@jsonstudio/zterm-relay-server';
const npmRoot = resolve(releaseDistDir, 'relay-server-npm');
const npmPackageDir = resolve(npmRoot, npmPackageName.replace('/', '__'));
const runtimeDir = resolve(npmPackageDir, 'runtime');

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

function resolveEsbuildBin() {
  const candidates = execFileSync(
    'bash',
    [
      '-lc',
      `{
        ls "${projectRoot}"/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild 2>/dev/null || true
        ls "${workspaceRoot}"/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild 2>/dev/null || true
      } | sort -V | tail -n 1`,
    ],
    { encoding: 'utf8' },
  ).trim();
  if (!candidates) {
    throw new Error(`missing esbuild under ${projectRoot}/node_modules/.pnpm or ${workspaceRoot}/node_modules/.pnpm`);
  }
  return candidates;
}

const esbuildBin = resolveEsbuildBin();

rmSync(npmPackageDir, { recursive: true, force: true });
mkdirSync(resolve(npmPackageDir, 'bin'), { recursive: true });
mkdirSync(runtimeDir, { recursive: true });

execFileSync(esbuildBin, [
  resolve(projectRoot, 'src/traversal-relay/server.ts'),
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--target=node20',
  '--outfile=' + resolve(runtimeDir, 'server.cjs'),
  '--external:bufferutil',
  '--external:utf-8-validate',
], { stdio: 'inherit' });

writeFileSync(resolve(runtimeDir, 'smoke.cjs'), `#!/usr/bin/env node
'use strict';

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return '';
  return process.argv[index + 1] || '';
}

function buildUrl(base, path) {
  return new URL(path.replace(/^\\//, ''), base).toString();
}

async function readJson(response) {
  const text = await response.text();
  return text.trim() ? JSON.parse(text) : {};
}

async function main() {
  const baseUrl = readArg('--base-url') || process.env.RELAY_BASE_URL || process.env.ZTERM_RELAY_BASE_URL;
  if (!baseUrl) {
    throw new Error('zterm-relay-server smoke requires --base-url or RELAY_BASE_URL');
  }
  const username = readArg('--username') || process.env.RELAY_USERNAME;
  const password = readArg('--password') || process.env.RELAY_PASSWORD;
  const health = await fetch(buildUrl(baseUrl, '/health')).then(readJson);
  if (!health.ok) {
    throw new Error('relay health did not return ok=true');
  }
  const result = { ok: true, baseUrl, health: { ok: health.ok, basePath: health.basePath, turn: Boolean(health.turn), relay: health.relay || null } };
  if (username || password) {
    if (!username || !password) {
      throw new Error('both --username/RELAY_USERNAME and --password/RELAY_PASSWORD are required for login smoke');
    }
    const loginResponse = await fetch(buildUrl(baseUrl, '/api/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const login = await readJson(loginResponse);
    if (!loginResponse.ok || !login.accessToken || !login.ws?.host || !login.ws?.client || !login.ws?.devices) {
      throw new Error('relay login smoke failed or ws endpoints are missing');
    }
    result.login = {
      ok: true,
      accessToken: '***',
      ws: login.ws,
      turn: login.turn ? { url: login.turn.url, username: login.turn.username, credential: '***' } : null,
    };
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
`);
chmodSync(resolve(runtimeDir, 'smoke.cjs'), 0o755);

writeExecutable(resolve(npmPackageDir, 'bin/zterm-relay-server'), `#!/usr/bin/env bash
set -euo pipefail
SOURCE="\${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
PACKAGE_ROOT="$(cd -P "$(dirname "$SOURCE")/.." >/dev/null 2>&1 && pwd)"
if [[ "\${1:-}" == "smoke" ]]; then
  shift
  exec node "$PACKAGE_ROOT/runtime/smoke.cjs" "$@"
fi
exec node "$PACKAGE_ROOT/runtime/server.cjs" "$@"
`);

writeFileSync(resolve(npmPackageDir, 'README.md'), `# zterm-relay-server

ZTerm traversal relay server. This is the public control-plane service for account login, device presence, WebSocket signaling, and TURN credential delivery.

This package is intentionally separate from the Mac daemon package. The daemon runs on user Macs; this relay server runs on a public server such as Claw.

## Install

\`\`\`bash
npm install -g ${npmPackageName}
\`\`\`

## Runtime env

All production configuration must come from environment variables or a secret manager:

\`\`\`bash
export ZTERM_TRAVERSAL_HOST=127.0.0.1
export ZTERM_TRAVERSAL_PORT=19090
export ZTERM_TRAVERSAL_BASE_PATH=/relay
export ZTERM_TRAVERSAL_STORE_PATH=/var/lib/zterm-relay/store.json
export ZTERM_TRAVERSAL_UPDATES_DIR=/var/lib/zterm-relay/updates
export ZTERM_TURN_URL='turn:claw.codewhisper.cc:3479?transport=udp'
export ZTERM_TURN_USERNAME='<secret>'
export ZTERM_TURN_CREDENTIAL='<secret>'
zterm-relay-server
\`\`\`

Do not put test account passwords or TURN credentials in the package or repository.

## Smoke

\`\`\`bash
zterm-relay-server smoke --base-url https://claw.codewhisper.cc:18443/relay/
RELAY_USERNAME=zterm-relay-smoke RELAY_PASSWORD='<secret>' \\
  zterm-relay-server smoke --base-url https://claw.codewhisper.cc:18443/relay/
\`\`\`

The smoke command redacts access tokens and TURN credentials.

## systemd example

\`\`\`ini
[Unit]
Description=ZTerm Relay Server
After=network.target

[Service]
EnvironmentFile=/etc/zterm-relay/server.env
ExecStart=/usr/bin/env zterm-relay-server
Restart=always
RestartSec=5
User=zterm-relay
Group=zterm-relay

[Install]
WantedBy=multi-user.target
\`\`\`

## nginx upstream sketch

Public TLS and path routing should stay in the reverse proxy:

\`\`\`nginx
location /relay/ {
  proxy_pass http://127.0.0.1:19090/relay/;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Host $host;
  proxy_set_header X-Forwarded-Proto https;
}
\`\`\`

The relay server also serves Android update assets from
\`ZTERM_TRAVERSAL_UPDATES_DIR\` at \`/relay/updates/latest.json\` and
\`/relay/updates/<apk>\`. The manifest should keep \`apkUrl\` relative so
clients resolve the APK against the same public relay route.
`);

copyFileSync(resolve(workspaceRoot, 'LICENSE'), resolve(npmPackageDir, 'LICENSE'));

writeFileSync(resolve(npmPackageDir, 'package.json'), `${JSON.stringify({
  name: npmPackageName,
  version,
  description: 'ZTerm public traversal relay server for device presence, signaling, and TURN credential delivery.',
  license: 'Apache-2.0',
  homepage: 'https://github.com/Jasonzhangf/zterm#readme',
  repository: {
    type: 'git',
    url: 'git+https://github.com/Jasonzhangf/zterm.git',
  },
  bugs: {
    url: 'https://github.com/Jasonzhangf/zterm/issues',
  },
  type: 'commonjs',
  bin: {
    'zterm-relay-server': 'bin/zterm-relay-server',
  },
  files: [
    'bin',
    'runtime',
    'README.md',
    'LICENSE',
  ],
  publishConfig: {
    access: 'public',
    registry: 'https://registry.npmjs.org/',
  },
  engines: {
    node: '>=20',
  },
  keywords: ['zterm', 'relay', 'turn', 'webrtc', 'signaling'],
}, null, 2)}\n`);

requirePath(resolve(runtimeDir, 'server.cjs'), 'missing runtime/server.cjs');
requirePath(resolve(runtimeDir, 'smoke.cjs'), 'missing runtime/smoke.cjs');
requirePath(resolve(npmPackageDir, 'bin/zterm-relay-server'), 'missing bin/zterm-relay-server');

const packOutput = execFileSync('npm', ['pack', npmPackageDir, '--pack-destination', releaseDistDir], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
}).trim();
const tgzName = packOutput.split('\n').filter(Boolean).at(-1);
const tgzPath = resolve(releaseDistDir, tgzName);
const shaPath = `${tgzPath}.sha256`;
const digest = sha256(tgzPath);
writeFileSync(shaPath, `${digest}  ${tgzPath}\n`);

console.log('[prepare-relay-server-npm-package] ready');
console.log(`- packageDir: ${npmPackageDir}`);
console.log(`- packageName: ${npmPackageName}`);
console.log(`- version: ${version}`);
console.log(`- tarball: ${tgzPath}`);
console.log(`- sha256: ${digest}`);
console.log(`- size: ${statSync(tgzPath).size}`);
