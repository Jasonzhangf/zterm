import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { basename, resolve } from 'path';
import { homedir } from 'os';

const cwd = process.cwd();
const packageJson = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf-8'));
const buildMetaPath = resolve(cwd, '.build-meta.json');
const buildMeta = existsSync(buildMetaPath)
  ? JSON.parse(readFileSync(buildMetaPath, 'utf-8'))
  : { buildNumber: 1000 };

const DEFAULT_APK_PATH = resolve(cwd, 'native/android/app/build/outputs/apk/debug/app-debug.apk');
const apkPath = process.argv[2] ? resolve(cwd, process.argv[2]) : DEFAULT_APK_PATH;
const outputDir = resolve(cwd, 'update-dist');
const daemonUpdatesDir = resolve(homedir(), '.wterm/updates');

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

const buildNumber = Math.max(1000, Number.parseInt(String(buildMeta.buildNumber || 1000), 10));
const versionName = `${packageJson.version}.${String(buildNumber).padStart(4, '0')}`;
const versionCode = computeVersionCode(packageJson.version, buildNumber);
const targetApkName = `zterm-${versionName}.apk`;
const targetApkPath = resolve(outputDir, targetApkName);

copyFileSync(apkPath, targetApkPath);

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

mkdirSync(daemonUpdatesDir, { recursive: true });
copyFileSync(targetApkPath, resolve(daemonUpdatesDir, targetApkName));
writeFileSync(resolve(daemonUpdatesDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log('[prepare-update-bundle] ready');
console.log(`- apk: ${targetApkPath}`);
console.log(`- manifest: ${resolve(outputDir, 'latest.json')}`);
console.log(`- daemon updates dir: ${daemonUpdatesDir}`);
console.log(`- versionName: ${versionName}`);
console.log(`- versionCode: ${versionCode}`);
