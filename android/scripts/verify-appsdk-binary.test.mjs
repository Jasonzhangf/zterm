import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const gatePath = fileURLToPath(new URL('./verify-appsdk-binary.mjs', import.meta.url));
const androidRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = join(androidRoot, '..');

async function createFixture({ version = '0.1.3', probeExit = 0, verifyExit = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zterm-appsdk-binary-gate-'));
  const projectRoot = join(root, 'project');
  const binaryDir = join(root, 'bin');
  const markerPath = join(root, 'verify-marker.txt');
  await mkdir(join(projectRoot, '.appsdk'), { recursive: true });
  await mkdir(binaryDir, { recursive: true });
  const binaryPath = join(binaryDir, 'appsdk');
  const source = `#!/bin/sh
if [ "$1" = "version" ]; then
  printf '%s\\n' 'appsdk ${version} (rust)'
  exit ${probeExit}
fi
printf '%s\\n%s\\n' "$1" "$2" > "$APPSDK_TEST_MARKER"
exit ${verifyExit}
`;
  await writeFile(binaryPath, source);
  await chmod(binaryPath, 0o755);
  const digest = 'sha256:test-fixture';
  await writeFile(join(projectRoot, '.appsdk', 'project.json'), JSON.stringify({ sdk: { version: '0.1.3' } }));
  await writeFile(join(projectRoot, '.appsdk', 'sdk.lock'), JSON.stringify({
    version: '0.1.3',
    digest,
    compiler_digest: digest,
  }));
  return { root, projectRoot, binaryDir, binaryPath, markerPath, digest };
}

function runGate(fixture, options = {}) {
  return spawnSync(process.execPath, [gatePath, fixture.projectRoot], {
    cwd: options.cwd ?? fixture.root,
    env: {
      ...process.env,
      PATH: options.path ?? fixture.binaryDir,
      APPSDK_TEST_MARKER: fixture.markerPath,
    },
    encoding: 'utf8',
  });
}

test('executes verify through the exact locked binary', async () => {
  const fixture = await createFixture();
  const result = runGate(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    (await readFile(fixture.markerPath, 'utf8')).trim().split('\n'),
    ['verify', fixture.projectRoot],
  );
  assert.match(result.stdout, /"ok":true/);
});

test('rejects a missing PATH binary', async () => {
  const fixture = await createFixture();
  const emptyPath = join(fixture.root, 'empty');
  await mkdir(emptyPath);
  const result = runGate(fixture, { path: emptyPath });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /APPSDK_BINARY_MISSING/);
});

test('rejects project, lock, binary, digest, and version-probe drift', async (t) => {
  await t.test('lock version mismatch', async () => {
    const fixture = await createFixture();
    const lockPath = join(fixture.projectRoot, '.appsdk', 'sdk.lock');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    lock.version = '0.1.2';
    await writeFile(lockPath, JSON.stringify(lock));
    const result = runGate(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /APPSDK_LOCK_VERSION_MISMATCH/);
  });

  await t.test('version mismatch', async () => {
    const fixture = await createFixture({ version: '0.1.2' });
    const result = runGate(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /APPSDK_BINARY_VERSION_MISMATCH/);
  });


  await t.test('version probe failure', async () => {
    const fixture = await createFixture({ probeExit: 7 });
    const result = runGate(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /APPSDK_VERSION_PROBE_FAILED/);
  });
});

test('surfaces exact-binary verify failure', async () => {
  const fixture = await createFixture({ verifyExit: 9 });
  const result = runGate(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /APPSDK_VERIFY_FAILED/);
});

test('keeps prebuild, CI, and Android release on the canonical package gate', async () => {
  const packageJson = JSON.parse(await readFile(join(androidRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(androidRoot, '.appsdk', 'sdk.lock'), 'utf8'));
  const ci = await readFile(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  const release = await readFile(join(repoRoot, '.github', 'workflows', 'android-release.yml'), 'utf8');
  const compilerDigest = lock.compiler_digest.replace(/^sha256:/, '');

  assert.equal(
    packageJson.scripts['test:appsdk-verify'],
    'pnpm run test:appsdk-binary && node ./scripts/verify-appsdk-binary.mjs .',
  );
  assert.match(packageJson.scripts.prebuild, /pnpm run test:appsdk-verify/);
  assert.match(ci, /uses: pnpm\/action-setup@v4/);
  assert.match(ci, /run: pnpm --dir android run test:appsdk-verify/);
  assert.match(release, /run: pnpm --dir android run test:appsdk-verify/);
  assert.match(ci, new RegExp(`APPSDK_SHA256: ${compilerDigest}`));
  assert.match(release, new RegExp(`APPSDK_SHA256: ${compilerDigest}`));
  assert.doesNotMatch(ci, /verify-appsdk-binary\.mjs android && appsdk verify android/);
  assert.doesNotMatch(release, /verify-appsdk-binary\.mjs android && appsdk verify android/);
});
