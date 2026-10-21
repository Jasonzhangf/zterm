import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('./prepare-daemon-npm-package.mjs', import.meta.url));
const workspaceRoot = resolve(dirname(scriptPath), '../..');
const tuples = [
  { tuple: 'darwin-arm64', os: 'darwin', arch: 'arm64' },
  { tuple: 'linux-x64', os: 'linux', arch: 'x64' },
  { tuple: 'win32-x64', os: 'win32', arch: 'x64' },
];

function writeFixtureFile(root, relativePath, content = '') {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function releaseFixture(root, tuple, os, arch, marker) {
  const releaseRoot = join(root, tuple);
  writeFixtureFile(releaseRoot, 'VERSION', `${marker}\n`);
  writeFixtureFile(releaseRoot, 'runtime/server.cjs', marker);
  writeFixtureFile(releaseRoot, 'runtime/dagpipe.node', marker);
  writeFixtureFile(
    releaseRoot,
    'runtime/node_modules/node-pty/package.json',
    JSON.stringify({ name: 'node-pty', version: 'fixture' }),
  );
  writeFixtureFile(
    releaseRoot,
    'runtime/node_modules/@roamhq/wrtc/package.json',
    JSON.stringify({ name: '@roamhq/wrtc', version: 'fixture' }),
  );
  writeFixtureFile(
    releaseRoot,
    `runtime/node_modules/@roamhq/wrtc-${os}-${arch}/wrtc.node`,
    marker,
  );
  writeFixtureFile(releaseRoot, `runtime/node_modules/@roamhq/wrtc-${os}-${arch}/package.json`,
    JSON.stringify({ name: `@roamhq/wrtc-${os}-${arch}`, version: 'fixture', main: 'index.js' }));
  writeFixtureFile(releaseRoot, `runtime/node_modules/@roamhq/wrtc-${os}-${arch}/index.js`,
    'module.exports = require("./wrtc.node");\n');
  writeFixtureFile(releaseRoot, 'support/terminal-config-command.cjs', marker);
  if (os === 'win32') {
    writeFixtureFile(releaseRoot, 'support/windows/zterm-daemon.ps1', marker);
  } else {
    writeFixtureFile(releaseRoot, 'support/zterm-daemon.sh', marker);
  }
  if (os === 'darwin') {
    writeFixtureFile(releaseRoot, 'support/zterm-daemon', marker);
  }
  writeFileSync(
    join(releaseRoot, 'zterm-package.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      package: {
        name: '@jsonstudio/zterm-daemon',
        version: 'input-version-is-not-authoritative',
      },
      platform: {
        os,
        arch,
        node: {
          minimum: '22.0.0',
          abi: '127',
        },
      },
      runtimeComponents: [],
    }, null, 2)}\n`,
  );
  return releaseRoot;
}

function packages(root) {
  return {
    publicPackage: join(root, 'public', '@jsonstudio', 'zterm-daemon'),
    publicRoot: join(root, 'public'),
    payloads: Object.fromEntries(
      tuples.map(({ tuple }) => [
        tuple,
        join(root, 'payloads', `@jsonstudio/zterm-daemon-${tuple}`),
      ]),
    ),
    payloadRoot: join(root, 'payloads'),
  };
}

function packArguments(root, outputDir) {
  return [
    scriptPath,
    '--version',
    '9.8.7',
    '--output-dir',
    outputDir,
    ...tuples.flatMap(({ tuple, os, arch }) => [
      '--release',
      `${tuple}=${releaseFixture(root, tuple, os, arch, `payload-${tuple}`)}`,
    ]),
  ];
}

test('packs one public package and exactly three same-version platform payloads', () => {
  const root = mkdtempSync(join(tmpdir(), 'zterm-daemon-package-'));
  const outputDir = join(root, 'out');
  const result = spawnSync(process.execPath, packArguments(root, outputDir), {
    cwd: workspaceRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const publicPackagePath = join(outputDir, 'packages', '@jsonstudio', 'zterm-daemon');
  const publicManifest = JSON.parse(readFileSync(join(publicPackagePath, 'package.json'), 'utf8'));
  assert.equal(publicManifest.version, '9.8.7');
  assert.deepEqual(publicManifest.optionalDependencies, {
    '@jsonstudio/zterm-daemon-darwin-arm64': '9.8.7',
    '@jsonstudio/zterm-daemon-linux-x64': '9.8.7',
    '@jsonstudio/zterm-daemon-win32-x64': '9.8.7',
  });
  assert.deepEqual(Object.keys(publicManifest.bin).sort(), ['wterm', 'zterm-daemon']);
  assert.equal(existsSync(join(publicPackagePath, 'runtime')), false);
  assert.equal(existsSync(join(publicPackagePath, 'support', 'install-user-shims.cjs')), true);

  for (const { tuple, os, arch } of tuples) {
    const payloadPath = join(
      outputDir,
      'packages',
      '@jsonstudio',
      `zterm-daemon-${tuple}`,
    );
    const payloadManifest = JSON.parse(readFileSync(join(payloadPath, 'package.json'), 'utf8'));
    const distributionManifest = JSON.parse(
      readFileSync(join(payloadPath, 'zterm-package.json'), 'utf8'),
    );
    assert.equal(payloadManifest.name, `@jsonstudio/zterm-daemon-${tuple}`);
    assert.equal(payloadManifest.version, '9.8.7');
    assert.deepEqual(payloadManifest.os, [os]);
    assert.deepEqual(payloadManifest.cpu, [arch]);
    assert.equal(payloadManifest.bin, undefined);
    const rtcModule = join(payloadPath, 'runtime', 'node_modules', '@roamhq', `wrtc-${os}-${arch}`);
    assert.equal(existsSync(join(rtcModule, 'package.json')), true, `${tuple} RTC package manifest`);
    assert.equal(existsSync(join(rtcModule, 'index.js')), true, `${tuple} RTC module entry`);
    assert.equal(distributionManifest.package.name, `@jsonstudio/zterm-daemon-${tuple}`);
    assert.equal(distributionManifest.package.version, '9.8.7');
    assert.equal(
      existsSync(join(payloadPath, 'support', 'zterm-daemon')),
      os === 'darwin',
      'Darwin is the only tuple with the Swift helper',
    );
    assert.equal(
      existsSync(join(payloadPath, 'support', 'windows', 'zterm-daemon.ps1')),
      os === 'win32',
    );
  }

  const tarballs = [
    'jsonstudio-zterm-daemon-9.8.7.tgz',
    'jsonstudio-zterm-daemon-darwin-arm64-9.8.7.tgz',
    'jsonstudio-zterm-daemon-linux-x64-9.8.7.tgz',
    'jsonstudio-zterm-daemon-win32-x64-9.8.7.tgz',
  ];
  for (const tarball of tarballs) {
    assert.equal(existsSync(join(outputDir, tarball)), true, tarball);
  }
});

test('refuses to overwrite an existing package version after payload input changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'zterm-daemon-overwrite-'));
  const outputDir = join(root, 'out');
  const first = spawnSync(process.execPath, packArguments(root, outputDir), {
    cwd: workspaceRoot,
    encoding: 'utf8',
  });
  assert.equal(first.status, 0, first.stderr || first.stdout);

  writeFileSync(join(root, 'darwin-arm64', 'runtime/server.cjs'), 'different-payload');
  const second = spawnSync(process.execPath, packArguments(root, outputDir), {
    cwd: workspaceRoot,
    encoding: 'utf8',
  });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /already exists/i);
  assert.equal(
    readFileSync(
      join(outputDir, 'packages', '@jsonstudio', 'zterm-daemon-darwin-arm64', 'runtime/server.cjs'),
      'utf8',
    ),
    'payload-darwin-arm64',
  );
});

test('fails before creating output when one required tuple is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'zterm-daemon-missing-'));
  const outputDir = join(root, 'out');
  const result = spawnSync(
    process.execPath,
    [
      scriptPath,
      '--version',
      '9.8.7',
      '--output-dir',
      outputDir,
      '--release',
      `darwin-arm64=${releaseFixture(root, 'darwin-arm64', 'darwin', 'arm64', 'darwin')}`,
      '--release',
      `linux-x64=${releaseFixture(root, 'linux-x64', 'linux', 'x64', 'linux')}`,
    ],
    {
      cwd: workspaceRoot,
      encoding: 'utf8',
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /win32-x64/);
  assert.equal(existsSync(outputDir), false);
});
