import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'fs';
import { createHash } from 'crypto';
import { basename, dirname, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const packageJson = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf-8'));
const buildMetaPath = resolve(projectRoot, '.build-meta.json');
const buildMeta = existsSync(buildMetaPath)
  ? JSON.parse(readFileSync(buildMetaPath, 'utf-8'))
  : { buildNumber: 1000 };

const DEFAULT_APK_PATH = resolve(projectRoot, 'native/android/app/build/outputs/apk/debug/app-debug.apk');
const apkPath = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : DEFAULT_APK_PATH;
const outputDir = resolve(projectRoot, 'update-dist');
const releaseDistDir = resolve(projectRoot, 'release-dist');
const daemonUpdatesDir = process.env.WTERM_UPDATES_DIR
  ? resolve(process.env.WTERM_UPDATES_DIR)
  : resolve(homedir(), '.wterm/updates');
const latestAliasName = 'zterm-latest-debug.apk';

function computeVersionCode(version, buildNumber) {
  const semver = String(version)
    .split('.')
    .map((part) => {
      const matched = part.match(/^\d+/);
      return matched ? Number.parseInt(matched[0], 10) : 0;
    });
  while (semver.length < 3) {
    semver.push(0);
  }
  return (semver[0] * 100000000) + (semver[1] * 1000000) + (semver[2] * 10000) + buildNumber;
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

mkdirSync(outputDir, { recursive: true });
mkdirSync(releaseDistDir, { recursive: true });
rmSync(resolve(outputDir, latestAliasName), { force: true });
rmSync(resolve(releaseDistDir, latestAliasName), { force: true });
rmSync(resolve(daemonUpdatesDir, latestAliasName), { force: true });

const buildNumber = Math.max(1000, Number.parseInt(String(buildMeta.buildNumber || 1000), 10));
const versionName = `${packageJson.version}.${String(buildNumber).padStart(4, '0')}`;
const versionCode = computeVersionCode(packageJson.version, buildNumber);
const targetApkName = `zterm-${versionName}.apk`;
const targetApkPath = resolve(outputDir, targetApkName);
const latestAliasPath = resolve(outputDir, latestAliasName);
const releaseVersionedApkPath = resolve(releaseDistDir, targetApkName);
const releaseLatestAliasPath = resolve(releaseDistDir, latestAliasName);

copyFileSync(apkPath, targetApkPath);
copyFileSync(apkPath, latestAliasPath);
copyFileSync(apkPath, releaseVersionedApkPath);
copyFileSync(apkPath, releaseLatestAliasPath);

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
};

writeFileSync(resolve(outputDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(resolve(releaseDistDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

mkdirSync(daemonUpdatesDir, { recursive: true });
copyFileSync(targetApkPath, resolve(daemonUpdatesDir, targetApkName));
copyFileSync(targetApkPath, resolve(daemonUpdatesDir, latestAliasName));
writeFileSync(resolve(daemonUpdatesDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log('[prepare-update-bundle] ready');
console.log(`- apk: ${targetApkPath}`);
console.log(`- update latest alias: ${latestAliasPath}`);
console.log(`- release latest alias: ${releaseLatestAliasPath}`);
console.log(`- manifest: ${resolve(outputDir, 'latest.json')}`);
console.log(`- daemon updates dir: ${daemonUpdatesDir}`);
console.log(`- versionName: ${versionName}`);
console.log(`- versionCode: ${versionCode}`);
