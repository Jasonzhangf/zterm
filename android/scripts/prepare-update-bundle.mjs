import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
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
const explicitDaemonUpdatesDir = process.env.WTERM_UPDATES_DIR
  ? resolve(process.env.WTERM_UPDATES_DIR)
  : null;
const daemonUpdatesDir = explicitDaemonUpdatesDir
  ? explicitDaemonUpdatesDir
  : resolve(homedir(), '.zterm/updates');
const latestAliasName = 'zterm-latest-debug.apk';
const updateApkNamePattern = /^zterm-(.+)\.apk$/u;
const updateApkBuildPattern = /^zterm-(.+?)\.(\d+)(?:\.1)?\.apk$/u;
const retentionBuildsEnvName = 'ZTERM_UPDATE_RETENTION_BUILDS';
const defaultRetentionBuilds = 3;

function parseBuildNumber(apkName) {
  const match = updateApkBuildPattern.exec(apkName);
  if (!match) return null;
  const buildNumber = Number.parseInt(match[2], 10);
  return Number.isSafeInteger(buildNumber) ? buildNumber : null;
}

function resolveRetentionBuildLimit() {
  const raw = process.env[retentionBuildsEnvName];
  if (raw === undefined || raw === '') return defaultRetentionBuilds;
  const normalized = raw.trim();
  const parsed = Number.parseInt(normalized, 10);
  if (!/^\d+$/u.test(normalized)) {
    throw new Error(`${retentionBuildsEnvName} must be a positive integer, received: ${raw}`);
  }
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${retentionBuildsEnvName} must be a positive integer, received: ${raw}`);
  }
  return parsed;
}

function manifestApkNames(manifest) {
  return [
    manifest.apkUrl,
    manifest.preparedRollback?.apkUrl,
    manifest.rollbackToPrevious?.apkUrl,
    manifest.sourceApk,
  ].filter((name) => typeof name === 'string' && name.length > 0);
}

function retainUpdateArtifacts(directory, manifest, {
  aliases = [latestAliasName],
  buildLimit = resolveRetentionBuildLimit(),
  log = console.log,
} = {}) {
  const protectedNames = new Set([
    ...manifestApkNames(manifest).map((name) => basename(name)),
    ...aliases.map((name) => basename(name)),
  ]);
  const apkFiles = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && updateApkNamePattern.test(entry.name))
    .map((entry) => ({ name: entry.name, buildNumber: parseBuildNumber(entry.name) }));
  const newestBuildNumbers = new Set(
    [...new Set(
      apkFiles
        .map((entry) => entry.buildNumber)
        .filter((buildNumber) => buildNumber !== null),
    )]
      .sort((left, right) => right - left)
      .slice(0, buildLimit),
  );
  const deleted = [];
  let kept = 0;

  for (const entry of apkFiles) {
    const filePath = resolve(directory, entry.name);
    const shouldKeep = protectedNames.has(entry.name)
      || entry.buildNumber === null
      || newestBuildNumbers.has(entry.buildNumber);
    if (shouldKeep) {
      kept += 1;
      continue;
    }
    unlinkSync(filePath);
    deleted.push(filePath);
    log(`[prepare-update-bundle] retention delete ${filePath}`);
  }
  log(`[prepare-update-bundle] retention ${directory}: kept ${kept}`);
  return { deleted, kept };
}

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
const retentionDirectories = [outputDir, releaseDistDir, daemonUpdatesDir];
if (!explicitDaemonUpdatesDir
  && (existsSync(resolve(homedir(), '.wterm')) || existsSync(resolve(homedir(), '.wterm/bin/zterm-daemon-launchd-run')))) {
  mkdirSync(legacyDaemonUpdatesDir, { recursive: true });
  copyFileSync(targetApkPath, resolve(legacyDaemonUpdatesDir, targetApkName));
  copyFileSync(targetApkPath, resolve(legacyDaemonUpdatesDir, latestAliasName));
  copyFileSync(publishedRollbackApkPath, resolve(legacyDaemonUpdatesDir, rollbackApkName));
  if (rollbackToPrevious) {
    copyFileSync(resolve(outputDir, rollbackToPrevious.apkUrl), resolve(legacyDaemonUpdatesDir, rollbackToPrevious.apkUrl));
  }
  writeFileSync(resolve(legacyDaemonUpdatesDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`- legacy daemon updates dir (mirrored): ${legacyDaemonUpdatesDir}`);
  retentionDirectories.push(legacyDaemonUpdatesDir);
}

const retentionErrors = [];
for (const directory of retentionDirectories) {
  try {
    retainUpdateArtifacts(directory, manifest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    retentionErrors.push(`${directory}: ${message}`);
    console.error(`[prepare-update-bundle] retention failed ${directory}: ${message}`);
  }
}
if (retentionErrors.length > 0) {
  throw new Error(`update retention failed:\n${retentionErrors.join('\n')}`);
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
