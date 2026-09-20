import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  CI_ONLY_GATE_SCRIPTS,
  LOCAL_ONLY_GATE_SCRIPTS,
  PREBUILD_GATE_SCRIPTS,
  collectGatePlan,
  runPrebuildGates,
} from './run-prebuild-gates.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const androidRoot = dirname(scriptDirectory);
const packageJson = JSON.parse(readFileSync(join(androidRoot, 'package.json'), 'utf8'));

function plannedFileOwners(plan) {
  const owners = new Map();
  for (const item of plan) {
    for (const file of item.files ?? []) {
      const key = `${item.workingDirectory ?? '.'}:${file}`;
      const previous = owners.get(key);
      assert.equal(previous, undefined, `gate file ${key} owned by ${previous} and ${item.owner}`);
      owners.set(key, item.owner);
    }
  }
  return owners;
}

test('documents and removes current duplicate Android gate file references', () => {
  const gateNames = [...PREBUILD_GATE_SCRIPTS, ...CI_ONLY_GATE_SCRIPTS];
  const result = collectGatePlan({ scripts: packageJson.scripts, gateNames, androidRoot });
  const owners = plannedFileOwners(result.plan);

  assert.ok(result.duplicates.length >= 13);
  assert.ok(owners.size > 100);

  const duplicateFiles = new Set(result.duplicates.map(({ file }) => file));
  for (const file of [
    '.:src/App.dynamic-refresh.test.tsx',
    '.:src/lib/plugin-host/plugin-host-runtime.test.ts',
    '.:src/server/terminal-message-runtime.test.ts',
    '.:src/components/terminal/FileTransferSheet.test.tsx',
    '../packages/shared:src/connection/protocol.test.ts',
  ]) {
    assert.ok(duplicateFiles.has(file), `missing duplicate inventory entry: ${file}`);
  }
});

test('assigns each test file to one owner while retaining later gate coverage', () => {
  const result = collectGatePlan({
    scripts: {
      first: 'pnpm exec vitest run src/first.test.ts src/shared.test.ts',
      second: 'pnpm exec vitest run src/shared.test.ts src/second.test.ts',
      third: 'pnpm exec vitest run src/first.test.ts src/third.test.ts',
    },
    gateNames: ['first', 'second', 'third'],
    androidRoot,
  });

  const commands = result.plan.map((item) => [
    'pnpm exec vitest run',
    ...item.files,
    ...item.options,
  ].join(' '));
  assert.deepEqual(commands, [
    'pnpm exec vitest run src/first.test.ts src/shared.test.ts',
    'pnpm exec vitest run src/second.test.ts',
    'pnpm exec vitest run src/third.test.ts',
  ]);
  assert.deepEqual(result.duplicates, [
    { file: '.:src/first.test.ts', owners: ['first', 'third'] },
    { file: '.:src/shared.test.ts', owners: ['first', 'second'] },
  ]);
});

test('continues after a gate failure and returns nonzero after all unique commands finish', () => {
  const invoked = [];
  const output = [];
  const exitCode = runPrebuildGates({
    profile: 'test',
    packageJson: {
      scripts: {
        first: 'pnpm exec vitest run src/first.test.ts',
        second: 'pnpm exec vitest run src/second.test.ts',
      },
    },
    gateNames: ['first', 'second'],
    androidRoot,
    run(command) {
      invoked.push(command);
      return { status: command.includes('first.test.ts') ? 17 : 0 };
    },
    write(line) {
      output.push(line);
    },
  });

  assert.deepEqual(invoked, [
    'pnpm exec vitest run src/first.test.ts',
    'pnpm exec vitest run src/second.test.ts',
  ]);
  assert.equal(exitCode, 1);
  assert.ok(output.includes('Android test gate failures (1/2):'));
  assert.ok(output.includes('- first: exit 17'));
});

test('keeps CI Android test-gate ownership in the grouped verifier', () => {
  const workflow = readFileSync(
    join(androidRoot, '..', '.github', 'workflows', 'ci.yml'),
    'utf8',
  );
  const androidTestCommands = [...workflow.matchAll(/run: pnpm --dir android run (test:[^\s]+)/gu)]
    .map((match) => match[1]);
  assert.deepEqual(androidTestCommands, ['test:ci-gates']);
});

test('keeps developer-machine-only gates out of the CI profile', () => {
  const invoked = [];
  const runPrebuildProfile = (profile) => {
    invoked.length = 0;
    runPrebuildGates({
      profile,
      packageJson,
      androidRoot,
      run(command) {
        invoked.push(command);
        return { status: 0 };
      },
      write() {},
    });
    return [...invoked];
  };

  const ciCommands = runPrebuildProfile('ci');
  const prebuildCommands = runPrebuildProfile('prebuild');

  assert.ok(LOCAL_ONLY_GATE_SCRIPTS.includes('test:terminal:regression:core'));

  // The relay smoke needs a live relay and real tmux; it must stay local.
  assert.ok(
    !ciCommands.some((invokedCommand) => invokedCommand.includes('traversal-relay-local-smoke.ts')),
    'CI profile must not run the relay smoke',
  );
  assert.ok(
    prebuildCommands.some((invokedCommand) => invokedCommand.includes('traversal-relay-local-smoke.ts')),
    'local prebuild profile must still run the relay smoke',
  );

  // The contracts gate expands into its own vitest command, so assert on the
  // expanded command rather than the script filename.
  const contractsCommand = prebuildCommands.find((invokedCommand) =>
    invokedCommand.includes('src/server/terminal-mirror-runtime.backpressure.test.ts'));
  assert.ok(contractsCommand, 'local prebuild profile must still run the terminal contracts suite');
  assert.ok(
    !ciCommands.includes(contractsCommand),
    'CI profile must not run the terminal contracts suite',
  );
});
