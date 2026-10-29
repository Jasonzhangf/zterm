import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  chmodSync,
  copyFileSync,
  existsSync,
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
import { appVersionContract, buildDisplayVersion } from './app-version.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const sourceScript = join(scriptDir, 'prepare-update-bundle.mjs');
const sourceAppVersion = join(scriptDir, 'app-version.mjs');
const sourceVersionContract = join(scriptDir, '..', 'contracts', 'app-version.json');
const packageVersion = '0.1.3';
const fixtureBuildNumber = 3232;
const fixtureNormalVersionName = buildDisplayVersion(packageVersion, fixtureBuildNumber);
const fixtureNormalVersionCode = appVersionContract.version_code_epoch
  + (fixtureBuildNumber * appVersionContract.normal_slot_stride);
const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function writeFixtureFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function createFixture(previousManifest) {
  const root = mkdtempSync(join(tmpdir(), 'zterm-prepare-update-bundle-'));
  const home = join(root, 'home');
  const directories = [
    join(root, 'update-dist'),
    join(root, 'release-dist'),
    join(home, '.zterm', 'updates'),
    join(home, '.wterm', 'updates'),
  ];
  const inputDir = join(root, 'native', 'android', 'app', 'build', 'outputs', 'apk', 'debug');
  const analyzer = join(root, 'bin', 'apkanalyzer');

  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'contracts'), { recursive: true });
  mkdirSync(inputDir, { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  for (const directory of directories) mkdirSync(directory, { recursive: true });

  copyFileSync(sourceScript, join(root, 'scripts', 'prepare-update-bundle.mjs'));
  copyFileSync(sourceAppVersion, join(root, 'scripts', 'app-version.mjs'));
  copyFileSync(sourceVersionContract, join(root, 'contracts', 'app-version.json'));
  writeFixtureFile(join(root, 'package.json'), `{"name":"fixture","version":"${packageVersion}"}\n`);
  writeFixtureFile(join(root, '.build-meta.json'), `{"buildNumber":${fixtureBuildNumber}}\n`);
  writeFixtureFile(join(inputDir, 'app-debug.apk'), 'normal apk fixture\n');
  writeFixtureFile(join(inputDir, 'app-rollback-debug.apk'), 'rollback apk fixture\n');
  writeFixtureFile(analyzer, `#!/usr/bin/env node
const field = process.argv[3];
const apkPath = process.argv[4];
const rollback = apkPath.includes('rollback');
if (field === 'version-name') {
  console.log(rollback ? process.env.FIXTURE_ROLLBACK_NAME : process.env.FIXTURE_NORMAL_NAME);
} else if (field === 'version-code') {
  console.log(rollback ? process.env.FIXTURE_ROLLBACK_CODE : process.env.FIXTURE_NORMAL_CODE);
} else {
  process.exit(2);
}
`);
  chmodSync(analyzer, 0o755);

  for (const directory of directories) {
    for (const name of [
      'zterm-0.1.3.3231.apk',
      'zterm-0.1.3.3231.1.apk',
      'zterm-0.1.3.3230.apk',
      'zterm-0.1.3.3230.1.apk',
      'zterm-0.1.3.3229.apk',
      'zterm-0.1.3.3229.1.apk',
      'zterm-0.1.3.3228.apk',
      'zterm-0.1.3.3228.1.apk',
    ]) {
      writeFixtureFile(join(directory, name), `${name}\n`);
    }
    writeFixtureFile(join(directory, 'latest.json'), `${JSON.stringify(previousManifest, null, 2)}\n`);
  }
  writeFixtureFile(join(root, 'update-dist', 'notes.txt'), 'keep me\n');
  writeFixtureFile(join(root, 'update-dist', 'zterm-0.1.3.3229.1.zip'), 'other extension\n');
  writeFixtureFile(join(root, 'update-dist', 'zterm-0.1.3.not-a-build.apk'), 'unparseable name\n');

  const fixture = { root, home, directories, analyzer };
  fixtures.push(fixture);
  return fixture;
}

function runFixture(fixture, retentionBuilds) {
  const env = {
    ...process.env,
    HOME: fixture.home,
    APKANALYZER: fixture.analyzer,
    FIXTURE_NORMAL_NAME: fixtureNormalVersionName,
    FIXTURE_NORMAL_CODE: String(fixtureNormalVersionCode),
    FIXTURE_ROLLBACK_NAME: `${fixtureNormalVersionName}.1`,
    FIXTURE_ROLLBACK_CODE: String(fixtureNormalVersionCode + appVersionContract.rollback_offset),
    ZTERM_UPDATE_RETENTION_BUILDS: retentionBuilds,
  };
  delete env.WTERM_UPDATES_DIR;
  return spawnSync(
    process.execPath,
    [join(fixture.root, 'scripts', 'prepare-update-bundle.mjs')],
    { cwd: fixture.root, encoding: 'utf8', env },
  );
}

function previousManifest(buildNumber) {
  const normalVersion = buildDisplayVersion(packageVersion, buildNumber);
  const rollbackVersion = `${normalVersion}.1`;
  const normalVersionCode = appVersionContract.version_code_epoch
    + (buildNumber * appVersionContract.normal_slot_stride);
  return {
    versionName: normalVersion,
    versionCode: normalVersionCode,
    buildNumber,
    apkUrl: `zterm-${normalVersion}.apk`,
    preparedRollback: {
      versionCode: normalVersionCode + 1,
      versionName: rollbackVersion,
      apkUrl: `zterm-${rollbackVersion}.apk`,
      sha256: 'fixture',
      size: 1,
      sourceVersionCode: normalVersionCode,
      sourceVersionName: normalVersion,
    },
  };
}

function assertManifestVersion(directory, versionName) {
  const manifest = JSON.parse(readFileSync(join(directory, 'latest.json'), 'utf8'));
  assert.equal(manifest.versionName, versionName);
}

test('retains current, rollback, alias, previous rollback and newest N builds in every artifact directory', () => {
  const fixture = createFixture(previousManifest(3231));
  const result = runFixture(fixture, '3');

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  for (const directory of fixture.directories) {
    for (const name of [
      'zterm-0.1.3.3232.apk',
      'zterm-0.1.3.3232.1.apk',
      'zterm-latest-debug.apk',
      'zterm-0.1.3.3231.apk',
      'zterm-0.1.3.3231.1.apk',
      'zterm-0.1.3.3230.apk',
      'zterm-0.1.3.3230.1.apk',
      'latest.json',
    ]) {
      assert.equal(existsSync(join(directory, name)), true, `${directory}:${name}`);
    }
    for (const name of [
      'zterm-0.1.3.3229.apk',
      'zterm-0.1.3.3229.1.apk',
      'zterm-0.1.3.3228.apk',
      'zterm-0.1.3.3228.1.apk',
    ]) {
      assert.equal(existsSync(join(directory, name)), false, `${directory}:${name}`);
    }
    assertManifestVersion(directory, fixtureNormalVersionName);
  }

  assert.equal(readFileSync(join(fixture.root, 'update-dist', 'notes.txt'), 'utf8'), 'keep me\n');
  assert.equal(
    readFileSync(join(fixture.root, 'update-dist', 'zterm-0.1.3.3229.1.zip'), 'utf8'),
    'other extension\n',
  );
  assert.equal(
    existsSync(join(fixture.root, 'update-dist', 'zterm-0.1.3.not-a-build.apk')),
    true,
  );
  assert.equal((result.stdout.match(/retention \/.*kept /g) ?? []).length, 4);
  assert.equal((result.stdout.match(/retention delete /g) ?? []).length, 16);
});

test('honors the configured count, protects manifest references, and leaves written manifests intact on retention failure', () => {
  const fixture = createFixture(previousManifest(3229));
  const configured = runFixture(fixture, '2');

  assert.equal(configured.status, 0, `${configured.stdout}\n${configured.stderr}`);
  for (const directory of fixture.directories) {
    for (const name of [
      'zterm-0.1.3.3232.apk',
      'zterm-0.1.3.3232.1.apk',
      'zterm-latest-debug.apk',
      'zterm-0.1.3.3231.apk',
      'zterm-0.1.3.3231.1.apk',
      'zterm-0.1.3.3229.1.apk',
    ]) {
      assert.equal(existsSync(join(directory, name)), true, `${directory}:${name}`);
    }
    for (const name of [
      'zterm-0.1.3.3229.apk',
      'zterm-0.1.3.3230.apk',
      'zterm-0.1.3.3230.1.apk',
      'zterm-0.1.3.3228.apk',
      'zterm-0.1.3.3228.1.apk',
    ]) {
      assert.equal(existsSync(join(directory, name)), false, `${directory}:${name}`);
    }
    assertManifestVersion(directory, fixtureNormalVersionName);
  }

  const failed = runFixture(fixture, '0');
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /retention failed/);
  for (const directory of fixture.directories) {
    assertManifestVersion(directory, fixtureNormalVersionName);
    assert.equal(existsSync(join(directory, 'zterm-0.1.3.3232.apk')), true);
  }
});
