import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

export const DAEMON_PACKAGE_NAMES = [
  '@jsonstudio/zterm-daemon',
  '@jsonstudio/zterm-daemon-darwin-arm64',
  '@jsonstudio/zterm-daemon-linux-x64',
  '@jsonstudio/zterm-daemon-win32-x64',
];

const PAYLOAD_PACKAGES = DAEMON_PACKAGE_NAMES.slice(1);
const REQUIRED_ARGUMENTS = new Set([
  '--packages-dir',
  '--cli-tarball',
  '--evidence-dir',
]);

export function parseDaemonInstallBlackboxArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!REQUIRED_ARGUMENTS.has(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    if (argument in values) {
      throw new Error(`${argument} must appear once`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`);
    }
    values[argument] = resolve(value);
    index += 1;
  }
  for (const argument of REQUIRED_ARGUMENTS) {
    if (!(argument in values)) {
      throw new Error(`${argument} is required`);
    }
  }
  return {
    packagesDir: values['--packages-dir'],
    cliTarball: values['--cli-tarball'],
    evidenceDir: values['--evidence-dir'],
  };
}

function assertPackageMetadata(metadata, path) {
  if (
    !metadata
    || typeof metadata !== 'object'
    || typeof metadata.name !== 'string'
    || typeof metadata.version !== 'string'
  ) {
    throw new Error(`invalid package metadata in ${basename(path)}`);
  }
  return metadata;
}

export function readTarballPackageJson(path) {
  const result = spawnSync(
    'tar',
    ['-xOf', path, 'package/package.json'],
    {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `cannot read package metadata from ${basename(path)}: ${
        result.error?.message || result.stderr.trim() || `tar exited ${String(result.status)}`
      }`,
    );
  }
  try {
    return assertPackageMetadata(JSON.parse(result.stdout), path);
  } catch (error) {
    throw new Error(
      `invalid package/package.json in ${basename(path)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function targetDaemonPayloadName(
  platform = process.platform,
  arch = process.arch,
) {
  const tuple = `${platform}-${arch}`;
  const payload = PAYLOAD_PACKAGES.find((name) => name.endsWith(`-${tuple}`));
  if (!payload) {
    throw new Error(`unsupported daemon blackbox tuple: ${tuple}`);
  }
  return payload;
}

export function validateDaemonPackageSet(metadataRecords) {
  if (metadataRecords.length !== DAEMON_PACKAGE_NAMES.length) {
    throw new Error(
      `exactly four daemon tarballs are required; found ${metadataRecords.length}`,
    );
  }
  const expected = new Set(DAEMON_PACKAGE_NAMES);
  const names = new Set();
  const versions = new Set();
  for (const metadata of metadataRecords) {
    if (!expected.has(metadata.name)) {
      throw new Error(`unexpected daemon package: ${metadata.name}`);
    }
    if (names.has(metadata.name)) {
      throw new Error(`duplicate daemon package: ${metadata.name}`);
    }
    names.add(metadata.name);
    versions.add(metadata.version);
  }
  if (versions.size !== 1) {
    throw new Error(
      `daemon tarballs use different versions: ${[...versions].sort().join(', ')}`,
    );
  }
  for (const name of DAEMON_PACKAGE_NAMES) {
    if (!names.has(name)) {
      throw new Error(`required daemon package is missing: ${name}`);
    }
  }
  return [...versions][0];
}

export function discoverDaemonPackages(
  packagesDir,
  metadataReader = readTarballPackageJson,
) {
  if (!existsSync(packagesDir) || !statSync(packagesDir).isDirectory()) {
    throw new Error(`packages directory does not exist: ${packagesDir}`);
  }
  const tarballs = readdirSync(packagesDir)
    .filter((entry) => entry.endsWith('.tgz'))
    .sort();
  if (tarballs.length !== DAEMON_PACKAGE_NAMES.length) {
    throw new Error(
      `exactly four daemon tarballs are required in ${packagesDir}; found ${tarballs.length}`,
    );
  }
  const packages = tarballs.map((filename) => {
    const path = join(packagesDir, filename);
    if (!statSync(path).isFile()) {
      throw new Error(`daemon tarball is not a regular file: ${path}`);
    }
    const metadata = assertPackageMetadata(metadataReader(path), path);
    return {
      path,
      name: metadata.name,
      version: metadata.version,
      metadata,
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
  const version = validateDaemonPackageSet(packages.map((record) => record.metadata));
  const publicPackage = packages.find(
    (record) => record.name === DAEMON_PACKAGE_NAMES[0],
  );
  const targetPayload = packages.find(
    (record) => record.name === targetDaemonPayloadName(),
  );
  return {
    version,
    packages,
    publicPackage,
    targetPayload,
  };
}

export function readPackageManifest(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function redactText(value, secrets = []) {
  let redacted = String(value);
  for (const secret of [...new Set(secrets)].filter(Boolean)) {
    redacted = redacted.replace(new RegExp(escapeRegExp(secret), 'gu'), '[REDACTED]');
  }
  return redacted
    .replace(
      /((?:authToken|accessToken|refreshToken|password|secret|token)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/giu,
      '$1[REDACTED]',
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, '$1[REDACTED]');
}

const SENSITIVE_KEY = /(?:auth|password|secret|token|cookie)/iu;

export function sanitizeEvidence(value, secrets = []) {
  if (typeof value === 'string') {
    return redactText(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeEvidence(item, secrets));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const sanitized = {};
  for (const [key, item] of Object.entries(value)) {
    sanitized[key] = SENSITIVE_KEY.test(key)
      ? '[REDACTED]'
      : sanitizeEvidence(item, secrets);
  }
  return sanitized;
}
