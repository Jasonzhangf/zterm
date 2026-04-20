import { chmodSync, existsSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { createRequire } from 'module';

export interface NodePtyRuntimeRepairResult {
  packageRoot: string | null;
  checkedHelpers: string[];
  repairedHelpers: string[];
}

function resolveNodePtyPackageRoot() {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve('node-pty/package.json');
  return dirname(packageJsonPath);
}

export function ensureNodePtySpawnHelpersExecutable(): NodePtyRuntimeRepairResult {
  let packageRoot: string | null = null;
  try {
    packageRoot = resolveNodePtyPackageRoot();
  } catch {
    return {
      packageRoot: null,
      checkedHelpers: [],
      repairedHelpers: [],
    };
  }

  const prebuildsDir = join(packageRoot, 'prebuilds');
  if (!existsSync(prebuildsDir)) {
    return {
      packageRoot,
      checkedHelpers: [],
      repairedHelpers: [],
    };
  }

  const checkedHelpers: string[] = [];
  const repairedHelpers: string[] = [];

  for (const entry of readdirSync(prebuildsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const helperPath = join(prebuildsDir, entry.name, 'spawn-helper');
    if (!existsSync(helperPath)) {
      continue;
    }

    checkedHelpers.push(helperPath);
    const currentMode = statSync(helperPath).mode & 0o777;
    const executableMode = currentMode | 0o111;
    if (currentMode !== executableMode) {
      chmodSync(helperPath, executableMode);
      repairedHelpers.push(helperPath);
    }
  }

  return {
    packageRoot,
    checkedHelpers,
    repairedHelpers,
  };
}
