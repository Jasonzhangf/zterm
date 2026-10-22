import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DAEMON_PACKAGE_NAMES,
  discoverDaemonPackages,
  parseDaemonInstallBlackboxArgs,
  sanitizeEvidence,
  validateDaemonPackageSet,
} from './daemon-install-blackbox-helper.mjs';

const VERSION = '9.8.7-blackbox.1';
const [PUBLIC_PACKAGE, ...PAYLOAD_PACKAGES] = DAEMON_PACKAGE_NAMES;

function metadata(name, version = VERSION) {
  return { name, version };
}

test('requires the exact bounded CLI contract', () => {
  assert.deepEqual(
    parseDaemonInstallBlackboxArgs([
      '--packages-dir',
      './packages',
      '--cli-tarball',
      './zterm-cli.tgz',
      '--evidence-dir',
      './evidence',
    ]),
    {
      packagesDir: join(process.cwd(), 'packages'),
      cliTarball: join(process.cwd(), 'zterm-cli.tgz'),
      evidenceDir: join(process.cwd(), 'evidence'),
    },
  );
  assert.throws(
    () => parseDaemonInstallBlackboxArgs(['--packages-dir', './packages']),
    /--cli-tarball is required/u,
  );
  assert.throws(
    () => parseDaemonInstallBlackboxArgs([
      '--packages-dir', './a',
      '--packages-dir', './b',
      '--cli-tarball', './cli.tgz',
      '--evidence-dir', './evidence',
    ]),
    /--packages-dir must appear once/u,
  );
  assert.throws(
    () => parseDaemonInstallBlackboxArgs([
      '--packages-dir', './packages',
      '--cli-tarball', './cli.tgz',
      '--evidence-dir', './evidence',
      '--unknown',
    ]),
    /unknown argument/u,
  );
});

test('accepts exactly the four daemon tarballs at one metadata version', () => {
  const directory = mkdtempSync(join(tmpdir(), 'daemon-install-blackbox-helper-'));
  try {
    const records = DAEMON_PACKAGE_NAMES.map((name, index) => {
      const path = join(directory, `${index}.tgz`);
      writeFileSync(path, '');
      return { path, metadata: metadata(name) };
    });
    const reader = (path) => records.find((record) => record.path === path).metadata;
    const discovered = discoverDaemonPackages(directory, reader);
    assert.equal(discovered.version, VERSION);
    assert.deepEqual(
      discovered.packages.map((record) => record.name),
      [...DAEMON_PACKAGE_NAMES].sort(),
    );
    assert.equal(discovered.publicPackage.name, PUBLIC_PACKAGE);
    assert.equal(discovered.publicPackage.tarballPath, records.find((record) => record.metadata.name === PUBLIC_PACKAGE).path);
    assert.equal(discovered.publicPackage.manifest.name, PUBLIC_PACKAGE);
    assert.equal(
      discovered.targetPayload.name,
      PAYLOAD_PACKAGES.find((name) => name.endsWith(`${process.platform}-${process.arch}`))
        ?? PAYLOAD_PACKAGES[0],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects incomplete, duplicate, foreign, and mixed-version package sets', () => {
  assert.throws(
    () => validateDaemonPackageSet(
      DAEMON_PACKAGE_NAMES.slice(0, 3).map((name) => metadata(name)),
    ),
    /exactly four/u,
  );
  const duplicate = [
    PUBLIC_PACKAGE,
    PAYLOAD_PACKAGES[0],
    PAYLOAD_PACKAGES[1],
    PAYLOAD_PACKAGES[1],
  ].map((name) => metadata(name));
  assert.throws(
    () => validateDaemonPackageSet(duplicate),
    /duplicate daemon package/u,
  );
  const foreign = DAEMON_PACKAGE_NAMES.map((name, index) => (
    metadata(index === 0 ? '@example/not-zterm-daemon' : name)
  ));
  assert.throws(
    () => validateDaemonPackageSet(foreign),
    /unexpected daemon package/u,
  );
  const mixed = DAEMON_PACKAGE_NAMES.map((name, index) => (
    metadata(name, index === 2 ? '9.8.8' : VERSION)
  ));
  assert.throws(
    () => validateDaemonPackageSet(mixed),
    /different versions/u,
  );
});

test('public evidence removes config and process secrets', () => {
  const secrets = {
    authToken: 'auth-token-must-not-leak',
    password: 'password-must-not-leak',
    accessToken: 'access-token-must-not-leak',
  };
  const sanitized = sanitizeEvidence({
    command: `failed ${secrets.authToken}`,
    stderr: `password=${secrets.password}`,
    nested: [{ authorization: `Bearer ${secrets.accessToken}` }],
    version: VERSION,
  }, Object.values(secrets));
  const text = JSON.stringify(sanitized);
  for (const secret of Object.values(secrets)) {
    assert.doesNotMatch(text, new RegExp(secret, 'u'));
  }
  assert.match(text, /\[REDACTED\]/u);
  assert.match(text, new RegExp(VERSION, 'u'));
});

test('missing evidence arguments fail before any package is inspected', () => {
  const directory = mkdtempSync(join(tmpdir(), 'daemon-install-blackbox-evidence-'));
  try {
    mkdirSync(join(directory, 'packages'));
    assert.throws(
      () => discoverDaemonPackages(join(directory, 'packages'), () => {
        throw new Error('metadata reader must not run');
      }),
      /exactly four/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
