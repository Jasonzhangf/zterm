import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { resolve } from 'path';

const projectRoot = resolve(import.meta.dirname, '..');
const releaseDist = resolve(projectRoot, 'release-dist');
const manifestPath = resolve(releaseDist, 'latest.json');
const packageJsonPath = resolve(projectRoot, 'package.json');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256(path) {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

function requireFile(path) {
  if (!existsSync(path)) {
    throw new Error(`missing release asset: ${path}`);
  }
  return path;
}

function readShaFile(path) {
  return readFileSync(path, 'utf8').trim().split(/\s+/)[0];
}

function listTarballEntries(path) {
  return execFileSync('tar', ['-tzf', path], { encoding: 'utf8' })
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readTarballText(path, entry) {
  return execFileSync('tar', ['-xOf', path, entry], { encoding: 'utf8' });
}

function hasTarballEntry(entries, expected) {
  return entries.includes(expected) || entries.some((entry) => entry.startsWith(`${expected}/`));
}

const manifest = readJson(requireFile(manifestPath));
const packageJson = readJson(requireFile(packageJsonPath));
const daemonVersion = String(packageJson.version);
for (const key of ['versionName', 'versionCode', 'apkUrl', 'sha256', 'size']) {
  if (manifest[key] === undefined || manifest[key] === null || manifest[key] === '') {
    throw new Error(`latest.json missing ${key}`);
  }
}

const apkPath = requireFile(resolve(releaseDist, manifest.apkUrl));
const daemonArchive = requireFile(resolve(releaseDist, `zterm-daemon-${daemonVersion}-darwin-arm64.tar.gz`));
const daemonArchiveSha = requireFile(`${daemonArchive}.sha256`);
const daemonNpmTgz = requireFile(resolve(releaseDist, `jsonstudio-zterm-daemon-${daemonVersion}.tgz`));
const daemonNpmSha = requireFile(`${daemonNpmTgz}.sha256`);
const daemonNpmEntries = listTarballEntries(daemonNpmTgz);
const daemonNpmSupportScript = readTarballText(daemonNpmTgz, 'package/support/zterm-daemon.sh');

const checks = {
  apkShaMatches: sha256(apkPath) === manifest.sha256,
  apkSizeMatches: statSync(apkPath).size === manifest.size,
  daemonArchiveShaMatches: sha256(daemonArchive) === readShaFile(daemonArchiveSha),
  daemonNpmShaMatches: sha256(daemonNpmTgz) === readShaFile(daemonNpmSha),
  daemonNpmHasConfigureRelay: daemonNpmSupportScript.includes('configure-relay'),
  daemonNpmHasNodePtyRuntime: hasTarballEntry(daemonNpmEntries, 'package/runtime/node_modules/node-pty'),
  daemonNpmHasWrtcRuntime: hasTarballEntry(daemonNpmEntries, 'package/runtime/node_modules/@roamhq/wrtc'),
  daemonNpmHasWrtcNative: hasTarballEntry(daemonNpmEntries, 'package/runtime/node_modules/@roamhq/wrtc-darwin-arm64/wrtc.node'),
  daemonNpmHasSupportScript: hasTarballEntry(daemonNpmEntries, 'package/support/zterm-daemon.sh'),
};

const ok = Object.values(checks).every(Boolean);
const result = {
  ok,
  versionName: manifest.versionName,
  versionCode: manifest.versionCode,
  daemonVersion,
  apkPath,
  apkSha256: manifest.sha256,
  daemonArchive,
  daemonArchiveSha256: readShaFile(daemonArchiveSha),
  daemonNpmTgz,
  daemonNpmSha256: readShaFile(daemonNpmSha),
  checks,
};
console.log(JSON.stringify(result, null, 2));
if (!ok) {
  process.exit(1);
}
