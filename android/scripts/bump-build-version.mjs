import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const BUILD_META_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.build-meta.json');
const DEFAULT_BUILD_NUMBER = 1000;

function readResumeBuildNumber(args) {
  if (args.length === 0) {
    return null;
  }
  if (args.length !== 2 || args[0] !== '--resume' || !/^\d+$/.test(args[1] || '')) {
    throw new Error('usage: bump-build-version.mjs [--resume <expected-build-number>]');
  }
  const buildNumber = Number(args[1]);
  if (!Number.isSafeInteger(buildNumber) || buildNumber < DEFAULT_BUILD_NUMBER) {
    throw new Error('usage: bump-build-version.mjs [--resume <expected-build-number>]');
  }
  return buildNumber;
}

function readAllocatedBuildNumber() {
  if (!existsSync(BUILD_META_PATH)) {
    throw new Error(`build metadata missing: ${BUILD_META_PATH}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(BUILD_META_PATH, 'utf-8'));
  } catch {
    throw new Error(`build metadata is invalid: ${BUILD_META_PATH}`);
  }
  if (!Number.isSafeInteger(parsed.buildNumber) || parsed.buildNumber < DEFAULT_BUILD_NUMBER) {
    throw new Error(`build metadata has invalid buildNumber: ${BUILD_META_PATH}`);
  }
  return parsed.buildNumber;
}

function readBuildMeta() {
  if (!existsSync(BUILD_META_PATH)) {
    return {
      buildNumber: DEFAULT_BUILD_NUMBER,
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(BUILD_META_PATH, 'utf-8'));
    return {
      buildNumber:
        typeof parsed.buildNumber === 'number' && Number.isFinite(parsed.buildNumber)
          ? Math.max(DEFAULT_BUILD_NUMBER, Math.floor(parsed.buildNumber))
          : DEFAULT_BUILD_NUMBER,
    };
  } catch {
    return {
      buildNumber: DEFAULT_BUILD_NUMBER,
    };
  }
}

try {
  const resumeBuildNumber = readResumeBuildNumber(process.argv.slice(2));
  if (resumeBuildNumber !== null) {
    const allocatedBuildNumber = readAllocatedBuildNumber();
    if (allocatedBuildNumber !== resumeBuildNumber) {
      throw new Error(
        `expected build ${resumeBuildNumber}, current build ${allocatedBuildNumber}`,
      );
    }
    console.log(`[build-version] resume ${resumeBuildNumber}`);
  } else {
    const current = readBuildMeta();
    const next = {
      buildNumber: current.buildNumber + 1,
    };

    writeFileSync(BUILD_META_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`[build-version] ${String(next.buildNumber).padStart(4, '0')}`);
  }
} catch (error) {
  console.error(`[build-version] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
