import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

const PLUGIN_IMPORT_MARKERS = [
  'plugin-host-runtime',
  'terminal/plugin-contract',
  'terminal/plugin-capability-registry',
];

const HOST_FORBIDDEN_MARKERS = [
  'src/contexts/SessionContext',
  'src/lib/traversal/',
  'src/server/',
];

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(root, dir))) {
    const relative = `${dir}/${entry}`;
    const stat = statSync(join(root, relative));
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(relative));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) {
      files.push(relative);
    }
  }
  return files;
}

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const pattern =
    /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec) specs.push(spec);
  }
  return specs;
}

function normalizeSpecifier(fromFile: string, spec: string): string {
  if (spec.startsWith('.')) {
    return normalize(join(dirname(join(root, fromFile)), spec)).replace(/\\/g, '/');
  }
  if (spec.startsWith('@/')) {
    return normalize(join(root, 'src', spec.slice(2))).replace(/\\/g, '/');
  }
  return spec;
}

function isPluginImport(spec: string): boolean {
  return PLUGIN_IMPORT_MARKERS.some((marker) => spec.includes(marker));
}

function isForbiddenHostImport(fromFile: string, spec: string): boolean {
  const normalized = normalizeSpecifier(fromFile, spec);
  return (
    HOST_FORBIDDEN_MARKERS.some((marker) => normalized.includes(marker)) ||
    /session-[a-z-]*store\.ts/.test(normalized)
  );
}

describe('plugin host ownership gate', () => {
  it('keeps plugin host imports inside the declared capability contract surface', () => {
    const violations: string[] = [];
    for (const file of listSourceFiles('src/lib/plugin-host')) {
      const source = readFileSync(join(root, file), 'utf8');
      for (const spec of importSpecifiers(source)) {
        if (isForbiddenHostImport(file, spec)) {
          violations.push(`${file} imports ${spec}`);
        }
      }
    }
    expect(
      violations,
      `plugin host must not import SessionContext, traversal, session stores, or server truth:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('allows only App composition and the plugin host directory to consume plugin contracts', () => {
    const violations: string[] = [];
    for (const file of listSourceFiles('src')) {
      if (file.startsWith('src/lib/plugin-host/')) continue;
      if (file === 'src/App.tsx') continue;
      const source = readFileSync(join(root, file), 'utf8');
      for (const spec of importSpecifiers(source)) {
        if (isPluginImport(spec)) {
          violations.push(`${file} imports ${spec}`);
        }
      }
    }
    expect(
      violations,
      `UI, page, hook, and plugin layers must not hold plugin host or capability registry access directly:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps App composition as the only production host consumer', () => {
    const appSource = readFileSync(join(root, 'src/App.tsx'), 'utf8');
    expect(appSource).toContain('createPluginHost');
    expect(appSource).toContain('NetworkIdentityCapabilityPlugin');
    expect(appSource).toContain("provideCapability('network:native-snapshot'");
  });
});
