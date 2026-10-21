import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const stageScript = join(scriptDir, 'prepare-daemon-platform-release.mjs');
const projectRoot = resolve(scriptDir, '..');
const fixtures = [];

after(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function createFixture() {
  const fixture = mkdtempSync(join(tmpdir(), 'zterm-platform-stage-'));
  fixtures.push(fixture);
  mkdirSync(join(fixture, 'src', 'server'), { recursive: true });
  mkdirSync(join(fixture, 'scripts', 'windows'), { recursive: true });
  writeFileSync(join(fixture, 'package.json'), `${JSON.stringify({ version: '0.0.0' })}\n`);
  writeFileSync(
    join(fixture, 'src', 'server', 'server.ts'),
    'export const serverFixture = true;\n',
  );
  writeFileSync(
    join(fixture, 'src', 'server', 'terminal-config-command.ts'),
    'console.log("fixture-config");\n',
  );
  writeFileSync(join(fixture, 'scripts', 'windows', 'zterm-daemon.ps1'), '# fixture runner\n');
  return fixture;
}

function runStage(fixture, args) {
  return spawnSync(process.execPath, [stageScript, ...args], {
    cwd: fixture,
    encoding: 'utf8',
  });
}

async function loadStageModule() {
  return import(stageScript);
}

test('fails before staging when a required component is missing', () => {
  const fixture = createFixture();
  const result = runStage(fixture, [
    '--output-dir',
    join(fixture, 'dist'),
    '--version',
    '0.0.0',
    '--dagpipe-native',
    join(fixture, 'missing.node'),
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing DAGpipe native input/);
  assert.equal(existsSync(join(fixture, 'dist')), false);
});

test('stages Darwin payload and delegates the formal Darwin runner adapter', () => {
  return (async () => {
    const fixture = createFixture();
    const adapter = join(fixture, 'adapter.sh');
    writeFileSync(
      adapter,
      `#!/usr/bin/env bash\nset -euo pipefail\n[[ "$1" == "--stage-platform-support" ]]\nmkdir -p "$2/support"\nprintf '%s\\n' formal-runner > "$2/support/zterm-daemon.sh"\nprintf '%s\\n' formal-helper > "$2/support/zterm-daemon"\nprintf '%s\\n' formal-config > "$2/support/terminal-config-command.cjs"\n`,
      { mode: 0o755 },
    );
    const { stagePlatformSupport } = await loadStageModule();
    const outputDir = join(fixture, 'dist');
    stagePlatformSupport({
      outputDir,
      packageRoot: fixture,
      targetOs: 'darwin',
      targetArch: 'arm64',
      darwinReleaseAdapter: adapter,
    });
    assert.ok(existsSync(join(outputDir, 'support', 'zterm-daemon.sh')));
    assert.ok(existsSync(join(outputDir, 'support', 'zterm-daemon')));
    assert.match(
      readFileSync(join(outputDir, 'support', 'zterm-daemon.sh'), 'utf8'),
      /formal-runner/,
    );
  })();
});

test('stages Linux without Darwin helper and uses absolute native path', () => {
  return (async () => {
    const fixture = createFixture();
    const { stagePlatformSupport } = await loadStageModule();
    const outputDir = join(fixture, 'dist');
    stagePlatformSupport({
      outputDir,
      packageRoot: fixture,
      targetOs: 'linux',
      targetArch: 'x64',
    });
    assert.ok(existsSync(join(outputDir, 'support', 'zterm-daemon.sh')));
    assert.equal(existsSync(join(outputDir, 'support', 'zterm-daemon')), false);
    mkdirSync(join(outputDir, 'runtime'), { recursive: true });
    writeFileSync(
      join(outputDir, 'runtime', 'server.cjs'),
      'console.log(process.env.ZTERM_DAGPIPE_NATIVE);\n',
    );
    writeFileSync(join(outputDir, 'runtime', 'dagpipe.node'), 'fixture native\n');
    const result = spawnSync('bash', [join(outputDir, 'support', 'zterm-daemon.sh'), 'run'], {
      cwd: fixture,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout.trim(),
      realpathSync(join(outputDir, 'runtime', 'dagpipe.node')),
    );
  })();
});

test('includes the fixed Windows runner fixture in the platform payload', () => {
  return (async () => {
    const fixture = createFixture();
    const { stagePlatformSupport, createPlatformManifest } = await loadStageModule();
    const outputDir = join(fixture, 'dist');
    stagePlatformSupport({
      outputDir,
      packageRoot: fixture,
      targetOs: 'win32',
      targetArch: 'x64',
    });
    assert.equal(existsSync(join(outputDir, 'support', 'zterm-daemon.sh')), false);
    assert.ok(existsSync(join(outputDir, 'support', 'windows', 'zterm-daemon.ps1')));
    const manifest = createPlatformManifest({
      version: '1.2.3',
      targetOs: 'win32',
      targetArch: 'x64',
      nodeAbi: 127,
    });
    assert.equal(manifest.package.name, '@jsonstudio/zterm-daemon-win32-x64');
    assert.ok(manifest.runtimeComponents.includes('support/windows/zterm-daemon.ps1'));
    assert.ok(!manifest.runtimeComponents.includes('support/zterm-daemon'));
  })();
});

test('declares the correct runner and native helper components for all three targets', () => {
  return (async () => {
    const { createPlatformManifest } = await loadStageModule();
    const manifests = new Map(
      [
        ['darwin', 'arm64'],
        ['linux', 'x64'],
        ['win32', 'x64'],
      ].map(([targetOs, targetArch]) => [
        `${targetOs}-${targetArch}`,
        createPlatformManifest({
          version: '1.2.3',
          targetOs,
          targetArch,
          nodeAbi: 127,
        }),
      ]),
    );

    assert.ok(manifests.get('darwin-arm64').runtimeComponents.includes('support/zterm-daemon'));
    assert.ok(!manifests.get('linux-x64').runtimeComponents.includes('support/zterm-daemon'));
    assert.ok(
      manifests.get('linux-x64').runtimeComponents.includes('support/zterm-daemon.sh'),
    );
    assert.ok(
      manifests.get('win32-x64').runtimeComponents.includes(
        'support/windows/zterm-daemon.ps1',
      ),
    );
    assert.ok(
      !manifests.get('win32-x64').runtimeComponents.includes('support/zterm-daemon.sh'),
    );
  })();
});

test('rejects a fixture native input that is not a loadable DAGpipe module', () => {
  const fixture = createFixture();
  const badOutput = join(fixture, 'bad-node.node');
  writeFileSync(badOutput, 'not a node module');
  const result = runStage(fixture, [
    '--output-dir',
    join(fixture, 'dist'),
    '--version',
    '0.0.0',
    '--dagpipe-native',
    badOutput,
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DAGpipe native input .* could not be loaded/);
  assert.equal(existsSync(join(fixture, 'dist', 'runtime', 'server.cjs')), false);
});
