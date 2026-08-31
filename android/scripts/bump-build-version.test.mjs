import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const sourceScript = join(dirname(fileURLToPath(import.meta.url)), 'bump-build-version.mjs');
const buildScript = join(dirname(fileURLToPath(import.meta.url)), 'build-android-debug.sh');
const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function createFixture(buildNumber) {
  const fixture = mkdtempSync(join(tmpdir(), 'zterm-build-version-'));
  fixtures.push(fixture);
  mkdirSync(join(fixture, 'scripts'));
  cpSync(sourceScript, join(fixture, 'scripts', 'bump-build-version.mjs'));
  writeFileSync(
    join(fixture, '.build-meta.json'),
    `${JSON.stringify({ buildNumber }, null, 2)}\n`,
  );
  return fixture;
}

function runFixture(fixture, args = []) {
  return spawnSync(
    process.execPath,
    [join(fixture, 'scripts', 'bump-build-version.mjs'), ...args],
    { cwd: fixture, encoding: 'utf8' },
  );
}

test('allocates the next build number by default', () => {
  const fixture = createFixture(2788);
  const result = runFixture(fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(readFileSync(join(fixture, '.build-meta.json'), 'utf8')),
    { buildNumber: 2789 },
  );
});

test('resumes the exact allocated build without rewriting metadata', () => {
  const fixture = createFixture(2789);
  const metadataPath = join(fixture, '.build-meta.json');
  const before = readFileSync(metadataPath, 'utf8');
  const result = runFixture(fixture, ['--resume', '2789']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /resume 2789/);
  assert.equal(readFileSync(metadataPath, 'utf8'), before);
});

test('rejects a mismatched resume without rewriting metadata', () => {
  const fixture = createFixture(2789);
  const metadataPath = join(fixture, '.build-meta.json');
  const before = readFileSync(metadataPath, 'utf8');
  const result = runFixture(fixture, ['--resume', '2788']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected build 2788.*current build 2789/i);
  assert.equal(readFileSync(metadataPath, 'utf8'), before);
});

test('rejects malformed resume arguments without rewriting metadata', () => {
  const fixture = createFixture(2789);
  const metadataPath = join(fixture, '.build-meta.json');
  const before = readFileSync(metadataPath, 'utf8');
  const result = runFixture(fixture, ['--resume', 'latest']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /usage:/i);
  assert.equal(readFileSync(metadataPath, 'utf8'), before);
});

test('prepares the daemon release before package prebuild contracts consume it', () => {
  const source = readFileSync(buildScript, 'utf8');
  const prepareIndex = source.indexOf('pnpm run daemon:prepare-release');
  const packageBuildIndex = source.indexOf('pnpm build');

  assert.notEqual(prepareIndex, -1);
  assert.notEqual(packageBuildIndex, -1);
  assert.ok(prepareIndex < packageBuildIndex);
  assert.equal(source.match(/pnpm run daemon:prepare-release/g)?.length, 1);
});
