#!/usr/bin/env node
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
