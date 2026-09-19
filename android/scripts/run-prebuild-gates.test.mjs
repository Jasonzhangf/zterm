import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { PREBUILD_GATES, runPrebuildGates } from './run-prebuild-gates.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const runner = join(scriptDirectory, 'run-prebuild-gates.mjs');

test('continues after an early failure and returns a concise failure summary', () => {
  const invoked = [];
  const output = [];
  const exitCode = runPrebuildGates({
    gates: ['early-gate', 'later-sentinel'],
    runGate(name) {
      invoked.push(name);
      return { status: name === 'early-gate' ? 17 : 0 };
    },
    write(line) {
      output.push(line);
    },
  });

  assert.deepEqual(invoked, ['early-gate', 'later-sentinel']);
  assert.equal(exitCode, 1);
  assert.deepEqual(output, [
    'Prebuild gate failures (1/2):',
    '- early-gate: exit 17',
  ]);
});

test('runs each declared gate once and preserves a nonzero process exit', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'zterm-prebuild-gates-'));
  try {
    const bin = join(fixture, 'bin');
    const log = join(fixture, 'invocations.log');
    const fakePnpm = join(bin, 'pnpm');
    mkdirSync(bin);
    writeFileSync(
      fakePnpm,
      '#!/usr/bin/env node\n'
        + "import { appendFileSync } from 'node:fs';\n"
        + "const gate = process.argv[3];\n"
        + "appendFileSync(process.env.ZTERM_PREBUILD_GATE_LOG, `${gate}\\n`);\n"
        + "process.exit(gate === 'test:build-version' ? 17 : 0);\n",
    );
    chmodSync(fakePnpm, 0o755);

    const result = spawnSync(process.execPath, [runner], {
      cwd: join(scriptDirectory, '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        ZTERM_PREBUILD_GATE_LOG: log,
      },
    });

    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(readFileSync(log, 'utf8').trimEnd().split('\n'), PREBUILD_GATES);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
