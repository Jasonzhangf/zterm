import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname, normalize } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Module import graph truth gate.
 *
 * This gate verifies that CODE matches the registries, not just that the
 * registries are self-consistent:
 *
 * 1. Full ownership: every non-test source file under src/ belongs to exactly
 *    one module via module-registry `owned_paths`. Unowned or multi-owned
 *    files fail the gate.
 * 2. Import graph lockstep: every cross-module import edge found in the real
 *    source import graph must be declared in edge-registry `import_edges`,
 *    and every declared entry must still exist in code (both directions).
 * 3. pending_removal entries are known violations; they may not grow, and a
 *    fixed violation must be removed from the registry.
 */

type ModuleRegistry = {
  modules: Array<{ module_id: string; owned_paths?: string[] }>;
};

type ImportEdgeEntry = {
  from_module: string;
  to_module: string;
  status: 'active' | 'pending_removal';
  note?: string;
};

type EdgeRegistry = {
  import_edges?: ImportEdgeEntry[];
  import_edges_description?: string;
};

const root = process.cwd();

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function listSourceFiles(): string[] {
  const result: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(join(root, dir))) {
      const rel = `${dir}/${entry}`;
      const stat = statSync(join(root, rel));
      if (stat.isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        visit(rel);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      if (/\.test\.(ts|tsx)$/.test(entry) || entry.endsWith('.d.ts')) continue;
      result.push(rel);
    }
  };
  visit('src');
  const sharedPaneProfile = '../packages/shared/src/react/pane-profile.ts';
  if (existsSync(join(root, sharedPaneProfile))) {
    result.push('packages/shared/src/react/pane-profile.ts');
  }
  return result.sort();
}

function buildOwnerIndex(registry: ModuleRegistry) {
  const dirPatterns: Array<{ prefix: string; moduleId: string }> = [];
  const filePatterns = new Map<string, string[]>();
  for (const module of registry.modules) {
    for (const pattern of module.owned_paths ?? []) {
      if (pattern.endsWith('/')) {
        dirPatterns.push({ prefix: pattern, moduleId: module.module_id });
      } else {
        const owners = filePatterns.get(pattern) ?? [];
        owners.push(module.module_id);
        filePatterns.set(pattern, owners);
      }
    }
  }
  return { dirPatterns, filePatterns };
}

function ownersOf(file: string, index: ReturnType<typeof buildOwnerIndex>): string[] {
  const exact = index.filePatterns.get(file);
  if (exact && exact.length > 0) return exact;
  const dirOwners = index.dirPatterns
    .filter((pattern) => file.startsWith(pattern.prefix))
    .map((pattern) => pattern.moduleId);
  return [...new Set(dirOwners)];
}

const IMPORT_PATTERN =
  /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveImport(fromFile: string, spec: string, owned: Set<string>): string | null {
  let target: string;
  if (spec.startsWith('.')) {
    target = normalize(join(dirname(fromFile), spec)).replace(/\\/g, '/');
  } else if (spec.startsWith('@/')) {
    target = `src/${spec.slice(2)}`;
  } else {
    return null;
  }
  if (target.includes('packages/')) return null;
  for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx', '']) {
    const candidate = `${target}${suffix}`;
    if (owned.has(candidate)) return candidate;
  }
  return null;
}

describe('module import graph truth gate', () => {
  const moduleRegistry = JSON.parse(read('docs/module-registry.json')) as ModuleRegistry;
  const edgeRegistry = JSON.parse(read('docs/edge-registry.json')) as EdgeRegistry;
  const files = listSourceFiles();
  const ownerIndex = buildOwnerIndex(moduleRegistry);

  it('keeps every owned_paths pattern pointing at real files or directories', () => {
    const repoRoot = join(root, '..');
    for (const module of moduleRegistry.modules) {
      for (const pattern of module.owned_paths ?? []) {
        const relative = pattern.replace(/\/$/, '');
        const exists = existsSync(join(root, relative)) || existsSync(join(repoRoot, relative));
        expect(exists, `${module.module_id}:${pattern}`).toBe(true);
      }
    }
  });

  it('keeps every source file owned by exactly one module (no unowned, no multi-owned)', () => {
    const unowned: string[] = [];
    const multiOwned: string[] = [];
    for (const file of files) {
      const owners = ownersOf(file, ownerIndex);
      if (owners.length === 0) unowned.push(file);
      if (owners.length > 1) multiOwned.push(`${file} -> ${owners.join(', ')}`);
    }
    expect(unowned, `unowned files:\n${unowned.join('\n')}`).toEqual([]);
    expect(multiOwned, `multi-owned files:\n${multiOwned.join('\n')}`).toEqual([]);
  });

  it('keeps the terminal shell stylesheet under one module owner', () => {
    expect(ownersOf('src/index.css', ownerIndex)).toEqual(['client.app_shell']);
  });

  it('keeps the real cross-module import graph in lockstep with edge-registry import_edges', () => {
    expect(edgeRegistry.import_edges, 'edge-registry.json missing import_edges').toBeTruthy();
    const declared = new Map<string, ImportEdgeEntry>();
    for (const entry of edgeRegistry.import_edges ?? []) {
      declared.set(`${entry.from_module}->${entry.to_module}`, entry);
    }

    const owner = new Map<string, string>();
    for (const file of files) {
      const owners = ownersOf(file, ownerIndex);
      if (owners.length === 1) owner.set(file, owners[0]);
    }
    const ownedFiles = new Set(owner.keys());

    const actualEdges = new Map<string, string[]>();
    for (const file of files) {
      const fromModule = owner.get(file);
      if (!fromModule) continue;
      const source = file.startsWith('packages/')
        ? readFileSync(join(root, '..', file), 'utf8')
        : read(file);
      for (const match of source.matchAll(IMPORT_PATTERN)) {
        const spec = match[1] ?? match[2] ?? match[3];
        if (!spec) continue;
        const resolved = resolveImport(file, spec, ownedFiles);
        if (!resolved) continue;
        const toModule = owner.get(resolved);
        if (!toModule || toModule === fromModule) continue;
        const key = `${fromModule}->${toModule}`;
        const samples = actualEdges.get(key) ?? [];
        if (samples.length < 5) samples.push(`${file} -> ${resolved}`);
        actualEdges.set(key, samples);
      }
    }

    const undeclared: string[] = [];
    for (const [key, samples] of actualEdges) {
      if (!declared.has(key)) {
        undeclared.push(`${key}\n    ${samples.join('\n    ')}`);
      }
    }
    expect(
      undeclared,
      `cross-module import edges found in code but not declared in edge-registry import_edges ` +
        `(declare the edge, or fix the import):\n${undeclared.join('\n')}`,
    ).toEqual([]);

    const stale: string[] = [];
    for (const key of declared.keys()) {
      if (!actualEdges.has(key)) stale.push(key);
    }
    expect(
      stale,
      `import_edges entries with no matching import left in code (remove them):\n${stale.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps pending_removal import edges bounded and annotated', () => {
    const pending = (edgeRegistry.import_edges ?? []).filter((entry) => entry.status === 'pending_removal');
    // Ratchet: all known violations have been fixed. This number may only go DOWN;
    // adding a new pending_removal entry requires an explicit decision doc.
    expect(pending.length).toBeLessThanOrEqual(0);
    for (const entry of pending) {
      expect(entry.note, `${entry.from_module}->${entry.to_module} needs a removal note`).toBeTruthy();
    }
  });
});
