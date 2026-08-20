import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'fs';
import { createHash } from 'crypto';
import { basename, dirname, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import {
  appVersionContract,
  buildDisplayVersion,
  computeNormalVersionCode,
  computeRollbackVersionCode,
} from './app-version.mjs';

function exec(command, options = {}) {
  const result = spawnSync(
    command.shift(), command,
    { encoding: 'utf-8', stdio: 'pipe', ...options }
  );
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command.join(' ')}\n${result.stderr}`);
  }
  return result.stdout;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const packageJson = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf-8'));
const buildMetaPath = resolve(projectRoot, '.build-meta.json');
const buildMeta = existsSync(buildMetaPath)
  ? JSON.parse(readFileSync(buildMetaPath, 'utf-8'))
  : { buildNumber: 1000 };

const DEFAULT_APK_PATH = resolve(projectRoot, 'native/android/app/build/outputs/apk/debug/app-debug.apk');
const DEFAULT_ROLLBACK_APK_PATH = resolve(projectRoot, 'native/android/app/build/outputs/apk/debug/app-rollback-debug.apk');
const apkPath = process.argv[2] ? resolve(projectRoot, process.argv[2]) : DEFAULT_APK_PATH;
const rollbackApkPath = process.argv[3] ? resolve(projectRoot, process.argv[3]) : DEFAULT_ROLLBACK_APK_PATH;
const outputDir = resolve(projectRoot, 'update-dist');
const releaseDistDir = resolve(projectRoot, 'release-dist');
const daemonUpdatesDir = process.env.WTERM_UPDATES_DIR
  ? resolve(process.env.WTERM_UPDATES_DIR)
  : resolve(homedir(), '.zterm/updates');
const latestAliasName = 'zterm-latest-debug.apk';

function hashFile(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

if (!existsSync(apkPath)) {
  console.error(`[prepare-update-bundle] APK not found: ${apkPath}`);
  process.exit(1);
}
if (!existsSync(rollbackApkPath)) {
  console.error(`[prepare-update-bundle] Rollback APK not found: ${rollbackApkPath}`);
  process.exit(1);
}

const previousManifestPath = resolve(outputDir, 'latest.json');
const previousManifest = existsSync(previousManifestPath)
  ? JSON.parse(readFileSync(previousManifestPath, 'utf8'))
  : null;

mkdirSync(outputDir, { recursive: true });
mkdirSync(releaseDistDir, { recursive: true });
rmSync(resolve(outputDir, latestAliasName), { force: true });
rmSync(resolve(releaseDistDir, latestAliasName), { force: true });
rmSync(resolve(daemonUpdatesDir, latestAliasName), { force: true });

const buildNumber = Math.max(1000, Number.parseInt(String(buildMeta.buildNumber || 1000), 10));
const versionName = buildDisplayVersion(packageJson.version, buildNumber);
const versionCode = computeNormalVersionCode(buildNumber);
const targetApkName = `zterm-${versionName}.apk`;
const targetApkPath = resolve(outputDir, targetApkName);
const latestAliasPath = resolve(outputDir, latestAliasName);
const releaseVersionedApkPath = resolve(releaseDistDir, targetApkName);
const releaseLatestAliasPath = resolve(releaseDistDir, latestAliasName);
const rollbackVersionName = buildDisplayVersion(packageJson.version, buildNumber, true);
const rollbackVersionCode = computeRollbackVersionCode(versionCode);
const rollbackApkName = `zterm-${rollbackVersionName}.apk`;
const publishedRollbackApkPath = resolve(outputDir, rollbackApkName);
const releaseRollbackApkPath = resolve(releaseDistDir, rollbackApkName);

const apkAnalyzer = process.env.APKANALYZER
  || resolve(homedir(), 'Library/Android/sdk/cmdline-tools/latest/bin/apkanalyzer');

function readApkVersion(path) {
  return {
    versionName: exec([apkAnalyzer, 'manifest', 'version-name', path]).trim(),
    versionCode: Number.parseInt(exec([apkAnalyzer, 'manifest', 'version-code', path]).trim(), 10),
  };
}

const normalApkVersion = readApkVersion(apkPath);
const rollbackApkVersion = readApkVersion(rollbackApkPath);
if (normalApkVersion.versionName !== versionName || normalApkVersion.versionCode !== versionCode) {
  throw new Error(
    `normal APK metadata mismatch: expected ${versionName}/${versionCode}, `
      + `actual ${normalApkVersion.versionName}/${normalApkVersion.versionCode}`,
  );
}
if (rollbackApkVersion.versionName !== rollbackVersionName || rollbackApkVersion.versionCode !== rollbackVersionCode) {
  throw new Error(
    `rollback APK metadata mismatch: expected ${rollbackVersionName}/${rollbackVersionCode}, `
      + `actual ${rollbackApkVersion.versionName}/${rollbackApkVersion.versionCode}`,
  );
}

copyFileSync(apkPath, targetApkPath);
copyFileSync(apkPath, latestAliasPath);
copyFileSync(apkPath, releaseVersionedApkPath);
copyFileSync(apkPath, releaseLatestAliasPath);
copyFileSync(rollbackApkPath, publishedRollbackApkPath);
copyFileSync(rollbackApkPath, releaseRollbackApkPath);

const preparedRollback = {
  versionCode: rollbackVersionCode,
  versionName: rollbackVersionName,
  apkUrl: rollbackApkName,
  sha256: hashFile(publishedRollbackApkPath),
  size: statSync(publishedRollbackApkPath).size,
  sourceVersionCode: versionCode,
  sourceVersionName: versionName,
};
const rollbackToPrevious = resolvePreviousRollback(previousManifest);

const manifest = {
  versionName,
  versionCode,
  buildNumber,
  apkUrl: targetApkName,
  sha256: hashFile(targetApkPath),
  size: statSync(targetApkPath).size,
  notes: [],
  publishedAt: new Date().toISOString(),
  channel: 'stable',
  sourceApk: basename(apkPath),
  preparedRollback,
  rollbackToPrevious,
};

const nextNormalVersionCode = computeNormalVersionCode(buildNumber + 1);
if (!(versionCode < rollbackVersionCode && rollbackVersionCode < nextNormalVersionCode)) {
  throw new Error(
    `invalid app version ordering: normal=${versionCode}, rollback=${rollbackVersionCode}, nextNormal=${nextNormalVersionCode}`,
  );
}
if (
  (nextNormalVersionCode - versionCode) !== appVersionContract.normal_slot_stride
  || (rollbackVersionCode - versionCode) !== appVersionContract.rollback_offset
) {
  throw new Error('app version contract stride/rollback offset mismatch');
}

writeFileSync(resolve(outputDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(resolve(releaseDistDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

mkdirSync(daemonUpdatesDir, { recursive: true });
copyFileSync(targetApkPath, resolve(daemonUpdatesDir, targetApkName));
copyFileSync(targetApkPath, resolve(daemonUpdatesDir, latestAliasName));
copyFileSync(publishedRollbackApkPath, resolve(daemonUpdatesDir, rollbackApkName));
if (rollbackToPrevious) {
  copyFileSync(resolve(outputDir, rollbackToPrevious.apkUrl), resolve(daemonUpdatesDir, rollbackToPrevious.apkUrl));
  copyFileSync(resolve(outputDir, rollbackToPrevious.apkUrl), resolve(releaseDistDir, rollbackToPrevious.apkUrl));
}
writeFileSync(resolve(daemonUpdatesDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// 兼容旧 launchd（.wterm wrapper 运行 npm 包 daemon，其 updates 目录是 ~/.wterm/updates）：
// 双写一份，避免升级检查 404
const legacyDaemonUpdatesDir = resolve(homedir(), '.wterm/updates');
if (existsSync(resolve(homedir(), '.wterm')) || existsSync(resolve(homedir(), '.wterm/bin/zterm-daemon-launchd-run'))) {
  mkdirSync(legacyDaemonUpdatesDir, { recursive: true });
  copyFileSync(targetApkPath, resolve(legacyDaemonUpdatesDir, targetApkName));
  copyFileSync(targetApkPath, resolve(legacyDaemonUpdatesDir, latestAliasName));
  copyFileSync(publishedRollbackApkPath, resolve(legacyDaemonUpdatesDir, rollbackApkName));
  if (rollbackToPrevious) {
    copyFileSync(resolve(outputDir, rollbackToPrevious.apkUrl), resolve(legacyDaemonUpdatesDir, rollbackToPrevious.apkUrl));
  }
  writeFileSync(resolve(legacyDaemonUpdatesDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`- legacy daemon updates dir (mirrored): ${legacyDaemonUpdatesDir}`);
}

console.log('[prepare-update-bundle] ready');
console.log(`- apk: ${targetApkPath}`);
console.log(`- update latest alias: ${latestAliasPath}`);
console.log(`- release latest alias: ${releaseLatestAliasPath}`);
console.log(`- manifest: ${resolve(outputDir, 'latest.json')}`);
console.log(`- daemon updates dir: ${daemonUpdatesDir}`);
console.log(`- versionName: ${versionName}`);
console.log(`- versionCode: ${versionCode}`);

function resolvePreviousRollback(candidate) {
  if (!candidate || candidate.versionName === versionName) {
    return null;
  }
  const prepared = candidate.preparedRollback;
  if (prepared && existsSync(resolve(outputDir, basename(prepared.apkUrl)))) {
    return prepared;
  }
  const previousBuildNumber = Number.parseInt(String(candidate.buildNumber || ''), 10);
  if (!Number.isFinite(previousBuildNumber)) {
    throw new Error('previous update manifest has no prepared rollback or build number');
  }
  const previousNormalApk = resolve(outputDir, basename(candidate.apkUrl));
  if (!existsSync(previousNormalApk)) {
    throw new Error(`previous normal APK is missing: ${previousNormalApk}`);
  }
  const previousRollbackVersionName = buildDisplayVersion(packageJson.version, previousBuildNumber, true);
  const previousRollbackVersionCode = computeRollbackVersionCode(
    computeNormalVersionCode(previousBuildNumber),
  );
  const previousRollbackApkName = `zterm-${previousRollbackVersionName}.apk`;
  const previousRollbackApk = resolve(outputDir, previousRollbackApkName);
  const patchScript = resolve(scriptDir, 'tools', 'patch-apk-version.py');
  exec([
    'python3', patchScript, previousNormalApk, previousRollbackApk,
    String(previousRollbackVersionCode), previousRollbackVersionName,
  ]);
  return {
    versionCode: previousRollbackVersionCode,
    versionName: previousRollbackVersionName,
    apkUrl: previousRollbackApkName,
    sha256: hashFile(previousRollbackApk),
    size: statSync(previousRollbackApk).size,
    sourceVersionCode: candidate.versionCode,
    sourceVersionName: candidate.versionName,
  };
}
