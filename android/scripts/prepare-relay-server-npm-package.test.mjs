import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { resolveNpmInvocation } from '../../packages/cli/scripts/process-entry.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));

test('formal Relay preparation executes Node package entries without shell or npm shims on PATH', {
  timeout: 180_000,
}, () => {
  const emptyPath = mkdtempSync(join(tmpdir(), 'zterm-relay-pack-path-'));
  const npm = resolveNpmInvocation([]);
  try {
    const result = spawnSync(process.execPath, [join(scriptDir, 'prepare-relay-server-npm-package.mjs')], {
      cwd: resolve(scriptDir, '..'),
      env: { ...process.env, PATH: emptyPath, npm_execpath: npm.args[0] },
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /\[prepare-relay-server-npm-package\] ready/u);
    assert.match(result.stdout, /jsonstudio-zterm-relay-server-[^\s]+\.tgz/u);
  } finally {
    rmSync(emptyPath, { recursive: true });
  }
});
