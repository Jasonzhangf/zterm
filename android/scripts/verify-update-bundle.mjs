import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { basename, resolve } from 'path';
import { homedir } from 'os';
import { buildDisplayVersion, computeNormalVersionCode } from './app-version.mjs';

const projectRoot = resolve(import.meta.dirname, '..');
const updateDistDir = resolve(projectRoot, 'update-dist');
const releaseDistDir = resolve(projectRoot, 'release-dist');
const daemonUpdatesDir = process.env.WTERM_UPDATES_DIR
  ? resolve(process.env.WTERM_UPDATES_DIR)
  : resolve(homedir(), '.zterm/updates');

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

const apkAnalyzer = process.env.APKANALYZER
  || resolve(homedir(), 'Library/Android/sdk/cmdline-tools/latest/bin/apkanalyzer');

function readApkVersion(path) {
  return {
    versionName: execFileSync(apkAnalyzer, ['manifest', 'version-name', path], { encoding: 'utf8' }).trim(),
    versionCode: Number.parseInt(
      execFileSync(apkAnalyzer, ['manifest', 'version-code', path], { encoding: 'utf8' }).trim(),
      10,
    ),
  };
}

const updateManifestPath = requireFile(resolve(updateDistDir, 'latest.json'));
const daemonManifestPath = requireFile(resolve(daemonUpdatesDir, 'latest.json'));
const releaseManifestPath = requireFile(resolve(releaseDistDir, 'latest.json'));
const buildMetaPath = requireFile(resolve(projectRoot, '.build-meta.json'));
const updateManifest = readJson(updateManifestPath);
const daemonManifest = readJson(daemonManifestPath);
const releaseManifest = readJson(releaseManifestPath);
const buildMeta = readJson(buildMetaPath);
const packageJson = readJson(resolve(projectRoot, 'package.json'));
const expectedBuildNumber = Number(buildMeta.buildNumber);
const expectedVersionName = buildDisplayVersion(packageJson.version, expectedBuildNumber);
const expectedVersionCode = computeNormalVersionCode(expectedBuildNumber);

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
const updateApkVersion = readApkVersion(updateApkPath);
const preparedRollback = updateManifest.preparedRollback;
const preparedRollbackPath = requireFile(resolve(updateDistDir, basename(preparedRollback.apkUrl)));
const preparedRollbackVersion = readApkVersion(preparedRollbackPath);
const previousRollback = updateManifest.rollbackToPrevious || null;
const previousRollbackPath = previousRollback
  ? requireFile(resolve(updateDistDir, basename(previousRollback.apkUrl)))
  : null;
const previousRollbackVersion = previousRollbackPath ? readApkVersion(previousRollbackPath) : null;
let apkWebAssetsError = null;
try {
  execFileSync(
    process.execPath,
    [
      resolve(projectRoot, 'scripts', 'verify-web-assets-version.mjs'),
      updateApkPath,
      String(updateManifest.buildNumber),
    ],
    { encoding: 'utf8', stdio: 'pipe' },
  );
} catch (error) {
  apkWebAssetsError = error instanceof Error ? error.message : String(error);
}

const checks = {
  manifestVersionAligned:
    updateManifest.versionName === daemonManifest.versionName
    && updateManifest.versionCode === daemonManifest.versionCode
    && basename(updateManifest.apkUrl) === basename(daemonManifest.apkUrl),
  buildMetaMatchesManifest:
    Number.isSafeInteger(expectedBuildNumber)
    && updateManifest.buildNumber === expectedBuildNumber,
  manifestMatchesContract:
    updateManifest.versionName === expectedVersionName
    && updateManifest.versionCode === expectedVersionCode,
  releaseManifestMatchesUpdate:
    releaseManifest.versionName === updateManifest.versionName
    && releaseManifest.versionCode === updateManifest.versionCode
    && basename(releaseManifest.apkUrl) === basename(updateManifest.apkUrl)
    && releaseManifest.sha256 === updateManifest.sha256,
  apkWebAssetsMatchManifest: apkWebAssetsError === null,
  updateApkShaMatchesManifest: sha256(updateApkPath) === updateManifest.sha256,
  daemonApkShaMatchesManifest: sha256(daemonApkPath) === daemonManifest.sha256,
  updateAndDaemonApkShaMatch: sha256(updateApkPath) === sha256(daemonApkPath),
  updateApkSizeMatchesManifest: statSync(updateApkPath).size === updateManifest.size,
  daemonApkSizeMatchesManifest: statSync(daemonApkPath).size === daemonManifest.size,
  updateLatestAliasMatchesVersioned: sha256(updateLatestAliasPath) === sha256(updateApkPath),
  daemonLatestAliasMatchesVersioned: sha256(daemonLatestAliasPath) === sha256(daemonApkPath),
  normalManifestMatchesApk:
    updateApkVersion.versionName === updateManifest.versionName
    && updateApkVersion.versionCode === updateManifest.versionCode,
  preparedRollbackManifestMatchesApk:
    preparedRollbackVersion.versionName === preparedRollback.versionName
    && preparedRollbackVersion.versionCode === preparedRollback.versionCode
    && sha256(preparedRollbackPath) === preparedRollback.sha256,
  preparedRollbackOccupiesCurrentSubversion:
    preparedRollback.versionName === `${updateManifest.versionName}.1`
    && preparedRollback.versionCode > updateManifest.versionCode,
  nextNormalCanReplacePreparedRollback:
    computeNormalVersionCode(Number(updateManifest.buildNumber) + 1) > preparedRollback.versionCode,
  previousRollbackManifestMatchesApk: !previousRollback || (
    previousRollbackVersion.versionName === previousRollback.versionName
    && previousRollbackVersion.versionCode === previousRollback.versionCode
    && sha256(previousRollbackPath) === previousRollback.sha256
  ),
  previousRollbackIsOlderPayload: !previousRollback
    || previousRollback.sourceVersionName !== updateManifest.versionName,
};

const ok = Object.values(checks).every(Boolean);
const result = {
  ok,
  updateManifestPath,
  daemonManifestPath,
  updateApkPath,
  daemonApkPath,
  checks,
  apkWebAssetsError,
};

console.log(JSON.stringify(result, null, 2));
if (!ok) {
  process.exit(1);
}
