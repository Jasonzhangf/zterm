import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MAC_ROOT = resolve(__dirname, '../..');
const REPO_ROOT = resolve(MAC_ROOT, '..');

function readElectronSources() {
  const electronDir = resolve(MAC_ROOT, 'electron');
  return readFileSync(electronDir + '/main.ts', 'utf8').length > 0
    ? ['main.ts', 'preload.ts', 'local-tmux.ts', 'standard-tmux-socket.ts'].map((name) => ({
        name,
        source: readFileSync(resolve(electronDir, name), 'utf8'),
      }))
    : [];
}

describe('mac main process shared package consumption contract', () => {
  it('only imports shared subpaths that resolve to built dist for Node ESM', () => {
    const sharedPackage = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'packages/shared/package.json'), 'utf8'),
    );
    const imported = new Set<string>();
    for (const { source } of readElectronSources()) {
      for (const match of source.matchAll(/from '(@zterm\/shared\/[^']+)'/g)) {
        imported.add(match[1]);
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
