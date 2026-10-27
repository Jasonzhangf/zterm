import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MAC_ROOT = resolve(__dirname, '../..');
const REPO_ROOT = resolve(MAC_ROOT, '..');
const ELECTRON_DIR = resolve(MAC_ROOT, 'electron');

/** Every TypeScript file compiled into the Electron main process bundle. */
function readElectronSources() {
  return readdirSync(ELECTRON_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ name, source: readFileSync(join(ELECTRON_DIR, name), 'utf8') }));
}

/**
 * Static import, re-export, dynamic import() and type-only import forms, with
 * either quote style. Type-only imports still need a resolvable `types`
 * condition, so they are held to the same contract.
 */
function collectSharedSpecifiers(source: string) {
  const patterns = [
    /from\s+['"](@zterm\/shared(?:\/[^'"]*)?)['"]/gu,
    /import\s*\(\s*['"](@zterm\/shared(?:\/[^'"]*)?)['"]\s*\)/gu,
    /require\s*\(\s*['"](@zterm\/shared(?:\/[^'"]*)?)['"]\s*\)/gu,
  ];
  const found: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      found.push(match[1]);
    }
  }
  return found;
}

describe('mac main process shared package consumption contract', () => {
  it('only imports shared subpaths that resolve to built dist for Node ESM', () => {
    const sharedPackage = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'packages/shared/package.json'), 'utf8'),
    );
    const imported = new Set<string>();
    for (const { source } of readElectronSources()) {
      for (const specifier of collectSharedSpecifiers(source)) {
        imported.add(specifier);
      }
    }
    expect(imported.size).toBeGreaterThan(0);
    for (const specifier of imported) {
      const condition = sharedPackage.exports[specifier.replace('@zterm/shared', '.')];
      expect(condition, `missing exports entry for ${specifier}`).toBeTruthy();
      const importTarget = typeof condition === 'string' ? condition : condition.import;
      expect(
        importTarget,
        `${specifier} must declare an "import" condition resolving to dist JS for the Electron main process`,
      ).toMatch(/\.js$/u);
    }
  });
});
