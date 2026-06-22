import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { basename, resolve } from 'path';
import { homedir } from 'os';

const projectRoot = resolve(import.meta.dirname, '..');
const updateDistDir = resolve(projectRoot, 'update-dist');
const daemonUpdatesDir = process.env.WTERM_UPDATES_DIR
  ? resolve(process.env.WTERM_UPDATES_DIR)
  : resolve(homedir(), '.wterm/updates');

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
    throw new Error(`missing update asset: ${path}`);
  }
  return path;
}

const updateManifestPath = requireFile(resolve(updateDistDir, 'latest.json'));
const daemonManifestPath = requireFile(resolve(daemonUpdatesDir, 'latest.json'));
const updateManifest = readJson(updateManifestPath);
const daemonManifest = readJson(daemonManifestPath);

for (const key of ['versionName', 'versionCode', 'apkUrl', 'sha256', 'size']) {
  if (!updateManifest[key]) {
    throw new Error(`update-dist/latest.json missing ${key}`);
  }
  if (!daemonManifest[key]) {
    throw new Error(`daemon updates latest.json missing ${key}`);
  }
}

const updateApkPath = requireFile(resolve(updateDistDir, basename(updateManifest.apkUrl)));
const daemonApkPath = requireFile(resolve(daemonUpdatesDir, basename(daemonManifest.apkUrl)));
const updateLatestAliasPath = requireFile(resolve(updateDistDir, 'zterm-latest-debug.apk'));
const daemonLatestAliasPath = requireFile(resolve(daemonUpdatesDir, 'zterm-latest-debug.apk'));

const checks = {
  manifestVersionAligned:
    updateManifest.versionName === daemonManifest.versionName
    && updateManifest.versionCode === daemonManifest.versionCode
    && basename(updateManifest.apkUrl) === basename(daemonManifest.apkUrl),
  updateApkShaMatchesManifest: sha256(updateApkPath) === updateManifest.sha256,
  daemonApkShaMatchesManifest: sha256(daemonApkPath) === daemonManifest.sha256,
  updateAndDaemonApkShaMatch: sha256(updateApkPath) === sha256(daemonApkPath),
  updateApkSizeMatchesManifest: statSync(updateApkPath).size === updateManifest.size,
  daemonApkSizeMatchesManifest: statSync(daemonApkPath).size === daemonManifest.size,
  updateLatestAliasMatchesVersioned: sha256(updateLatestAliasPath) === sha256(updateApkPath),
  daemonLatestAliasMatchesVersioned: sha256(daemonLatestAliasPath) === sha256(daemonApkPath),
};

const ok = Object.values(checks).every(Boolean);
const result = {
  ok,
  updateManifestPath,
  daemonManifestPath,
  updateApkPath,
  daemonApkPath,
  checks,
};

console.log(JSON.stringify(result, null, 2));
if (!ok) {
  process.exit(1);
}
