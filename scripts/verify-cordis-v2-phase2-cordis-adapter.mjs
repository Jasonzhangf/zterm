#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const commands = [
  ['node', ['scripts/check-zterm-v2-map-registries.mjs']],
  ['pnpm', ['--dir', 'packages/kernel', 'run', 'type-check']],
  ['pnpm', ['--dir', 'packages/kernel', 'run', 'test']],
];

for (const [command, args] of commands) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit', shell: false });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log('zterm-cordis-v2 phase2 adapter: PASS');
