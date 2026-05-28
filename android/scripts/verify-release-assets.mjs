import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { resolve } from 'path';

const projectRoot = resolve(import.meta.dirname, '..');
const releaseDist = resolve(projectRoot, 'release-dist');
const manifestPath = resolve(releaseDist, 'latest.json');

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

const manifest = readJson(requireFile(manifestPath));
for (const key of ['versionName', 'versionCode', 'apkUrl', 'sha256', 'size']) {
  if (manifest[key] === undefined || manifest[key] === null || manifest[key] === '') {
    throw new Error(`latest.json missing ${key}`);
  }
}

const apkPath = requireFile(resolve(releaseDist, manifest.apkUrl));
const daemonArchive = requireFile(resolve(releaseDist, `zterm-daemon-${String(manifest.versionName).split('.').slice(0, 3).join('.')}-darwin-arm64.tar.gz`));
const daemonArchiveSha = requireFile(`${daemonArchive}.sha256`);
const daemonNpmTgz = requireFile(resolve(releaseDist, `jsonstudio-zterm-daemon-${String(manifest.versionName).split('.').slice(0, 3).join('.')}.tgz`));
const daemonNpmSha = requireFile(`${daemonNpmTgz}.sha256`);

const checks = {
  apkShaMatches: sha256(apkPath) === manifest.sha256,
  apkSizeMatches: statSync(apkPath).size === manifest.size,
  daemonArchiveShaMatches: sha256(daemonArchive) === readShaFile(daemonArchiveSha),
  daemonNpmShaMatches: sha256(daemonNpmTgz) === readShaFile(daemonNpmSha),
};

const ok = Object.values(checks).every(Boolean);
const result = {
  ok,
  versionName: manifest.versionName,
  versionCode: manifest.versionCode,
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
