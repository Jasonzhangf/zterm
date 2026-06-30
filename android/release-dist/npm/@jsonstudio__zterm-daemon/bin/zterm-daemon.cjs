#!/usr/bin/env node
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
