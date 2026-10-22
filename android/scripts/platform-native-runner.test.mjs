import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ANDROID_ROOT = resolve(SCRIPT_DIR, '..');
const BUILD_SCRIPT = join(SCRIPT_DIR, 'build-dagpipe-native.sh');
const WINDOWS_RUNNER = join(SCRIPT_DIR, 'windows', 'zterm-daemon.ps1');
const cleanupRoots = [];

function makeBuildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'zterm-dagpipe-native-build-'));
  cleanupRoots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'native', 'dagpipe'), { recursive: true });
  mkdirSync(join(root, 'test-bin'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'build-dagpipe-native.sh'), readFileSync(BUILD_SCRIPT));
  writeFileSync(
    join(root, 'scripts', 'ensure-dagpipe-sdk.sh'),
    '#!/usr/bin/env bash\nset -euo pipefail\n',
  );
  const cargo = join(root, 'test-bin', 'cargo');
  writeFileSync(
    cargo,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'case " $* " in',
      '  *" --release "*) output_dir="target/release" ;;',
      '  *) output_dir="target/debug" ;;',
      'esac',
      'mkdir -p "${output_dir}"',
      'if [[ -n "${FIXTURE_NATIVE_ARTIFACT:-}" ]]; then',
      '  printf "fixture-native\\n" > "${output_dir}/${FIXTURE_NATIVE_ARTIFACT}"',
      'fi',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return root;
}

function runBuildFixture(root, artifact) {
  return spawnSync('bash', [join(root, 'scripts', 'build-dagpipe-native.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      DAGPIPE_PROFILE: 'release',
      FIXTURE_NATIVE_ARTIFACT: artifact,
      PATH: `${join(root, 'test-bin')}:${process.env.PATH ?? ''}`,
    },
  });
}

afterEach(() => {
  while (cleanupRoots.length > 0) {
    rmSync(cleanupRoots.pop(), { recursive: true, force: true });
  }
});

test('build script copies the Windows DLL artifact into the Node addon slot', () => {
  const root = makeBuildFixture();
  const result = runBuildFixture(root, 'zterm_dagpipe.dll');

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(join(root, 'native', 'dagpipe', 'index.node'), 'utf8'),
    'fixture-native\n',
  );
});

test('build script keeps the native copy failure visible when no artifact exists', () => {
  const root = makeBuildFixture();
  const result = runBuildFixture(root, '');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /libzterm_dagpipe\.so/);
  assert.equal(existsSync(join(root, 'native', 'dagpipe', 'index.node')), false);
});

test('Windows runner rejects a missing explicit payload root', () => {
  const source = readFileSync(WINDOWS_RUNNER, 'utf8');
  const body = source.slice(
    source.indexOf('function Resolve-PackageRoot {'),
    source.indexOf('$PackageRoot = Resolve-PackageRoot'),
  );

  assert.match(body, /if \(\$env:ZTERM_PACKAGE_ROOT\)/);
  assert.match(body, /Test-Path -LiteralPath \$env:ZTERM_PACKAGE_ROOT/);
  assert.match(body, /throw "missing daemon package root: \$env:ZTERM_PACKAGE_ROOT"/);
});

test('Windows runner derives native path and native directory from the resolved payload root', () => {
  const source = readFileSync(WINDOWS_RUNNER, 'utf8');

  assert.match(source, /\$NativeDir = Join-Path \$PackageRoot "runtime"/);
  assert.match(source, /\$DagpipeNative = Join-Path \$NativeDir "dagpipe\.node"/);
  assert.match(source, /\$env:ZTERM_DAGPIPE_NATIVE = \$DagpipeNative/);
  assert.match(source, /\$env:PATH = "\$NativeDir;\$env:PATH"/);
  assert.match(source, /missing daemon DAGPIPE native: \$DagpipeNative/);
});
