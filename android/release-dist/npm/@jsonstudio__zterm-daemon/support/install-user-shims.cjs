#!/usr/bin/env node
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
  writeShim('zterm-daemon.cmd', `@echo off
node "${packageRoot}\\bin\\zterm-daemon.cjs" %*
`);
  writeShim('wterm.cmd', `@echo off
node "${packageRoot}\\bin\\wterm.cjs" %*
`);
} else {
  writeShim('zterm-daemon', `#!/usr/bin/env bash
set -euo pipefail
exec node "${packageRoot}/bin/zterm-daemon.cjs" "$@"
`);

  writeShim('wterm', `#!/usr/bin/env bash
set -euo pipefail
exec node "${packageRoot}/bin/wterm.cjs" "$@"
`);
}

console.log('[zterm-daemon] installed user shims');
console.log(`- ${resolve(localBin, isWindows ? 'zterm-daemon.cmd' : 'zterm-daemon')}`);
console.log(`- ${resolve(localBin, isWindows ? 'wterm.cmd' : 'wterm')}`);
