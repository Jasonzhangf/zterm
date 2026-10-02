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
const apkNativeLibrary = 'lib/arm64-v8a/libzterm_dagpipe.so';
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

test('keeps normal and resume allocation safe under macOS Bash nounset mode', () => {
  const source = readFileSync(buildScript, 'utf8');

  assert.doesNotMatch(source, /BUILD_VERSION_ARGS/);
  assert.match(source, /RESUME_BUILD_NUMBER=""/);
  assert.match(
    source,
    /if \[\[ -n "\$RESUME_BUILD_NUMBER" \]\]; then\s+node \.\/scripts\/bump-build-version\.mjs --resume "\$RESUME_BUILD_NUMBER"\s+else\s+node \.\/scripts\/bump-build-version\.mjs\s+fi/,
  );
});

test('does not fail the APK content check on SIGPIPE from grep -q', () => {
  const listing = [
    'Archive:  app-normal-debug.apk',
    `   123456  2026-10-02 00:00   ${apkNativeLibrary}`,
    ...Array.from({ length: 200_000 }, (_, index) => `       0  2026-10-02 00:00   padding/${index}`),
    '---------                     -------',
  ].join('\n');
  const fixture = mkdtempSync(join(tmpdir(), 'zterm-apk-sigpipe-'));
  fixtures.push(fixture);
  const contentsPath = join(fixture, 'app-normal-debug-contents.txt');
  writeFileSync(contentsPath, `${listing}\n`);
  const originalPipeline = spawnSync(
    'bash',
    [
      '-o',
      'pipefail',
      '-c',
      'cat "$1" | grep -q "$2"',
      'bash',
      contentsPath,
      apkNativeLibrary,
    ],
    { encoding: 'utf8' },
  );

  assert.equal(
    originalPipeline.status,
    141,
    'the old listing | grep -q pipeline must fail on truncated consumer output',
  );

  const regularFileCheck = spawnSync('grep', ['-Fq', apkNativeLibrary, contentsPath], {
    encoding: 'utf8',
  });

  assert.equal(regularFileCheck.status, 0, regularFileCheck.stderr);

  const source = readFileSync(buildScript, 'utf8');
  const ownedContentsPath = source.indexOf('APK_CONTENTS_PATH="$APK_WORK_DIR/app-normal-debug-contents.txt"');
  const writeListing = source.indexOf('unzip -l "$NORMAL_APK_PATH" > "$APK_CONTENTS_PATH"');
  const grepListing = source.indexOf('grep -Fq \'lib/arm64-v8a/libzterm_dagpipe.so\' "$APK_CONTENTS_PATH"');

  assert.notEqual(ownedContentsPath, -1);
  assert.notEqual(writeListing, -1);
  assert.notEqual(grepListing, -1);
  assert.ok(ownedContentsPath < writeListing);
  assert.ok(writeListing < grepListing);
  assert.doesNotMatch(source, /unzip -l "\$NORMAL_APK_PATH" \| grep -q/);
});
