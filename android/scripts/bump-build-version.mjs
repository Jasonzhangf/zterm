import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const BUILD_META_PATH = resolve(process.cwd(), '.build-meta.json');
const DEFAULT_BUILD_NUMBER = 1000;

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

const current = readBuildMeta();
const next = {
  buildNumber: current.buildNumber + 1,
};

writeFileSync(BUILD_META_PATH, `${JSON.stringify(next, null, 2)}\n`);
console.log(`[build-version] ${String(next.buildNumber).padStart(4, '0')}`);
