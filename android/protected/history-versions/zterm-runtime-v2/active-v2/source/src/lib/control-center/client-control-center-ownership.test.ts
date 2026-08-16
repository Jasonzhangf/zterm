import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

const FORBIDDEN_MARKERS = [
  'src/contexts/SessionContext',
  'src/lib/traversal/',
  'src/server/',
  'plugin-host-runtime',
  'session-context-',
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

describe('client control center ownership gate', () => {
  it('keeps control center imports free of session, traversal, plugin host implementation, and server truth', () => {
    const violations: string[] = [];
    for (const file of listSourceFiles('src/lib/control-center')) {
      const source = readFileSync(join(root, file), 'utf8');
      for (const spec of importSpecifiers(source)) {
        const normalized = normalizeSpecifier(file, spec);
        if (FORBIDDEN_MARKERS.some((marker) => normalized.includes(marker))) {
          violations.push(`${file} imports ${spec}`);
        }
      }
    }
    expect(
      violations,
      `control center must not import SessionContext, traversal, session stores, plugin host implementation, or server truth:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('allows only App composition and the control center directory to import ClientControlCenter', () => {
    const violations: string[] = [];
    for (const file of listSourceFiles('src')) {
      if (file.startsWith('src/lib/control-center/')) continue;
      if (file === 'src/App.tsx') continue;
      const source = readFileSync(join(root, file), 'utf8');
      for (const spec of importSpecifiers(source)) {
        if (normalizeSpecifier(file, spec).includes('/control-center/client-control-center')) {
          violations.push(file);
        }
      }
    }
    expect(
      violations,
      `UI, page, hook, context, and plugin layers must not import the client control center:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps App routing plugin-host disposal through the control center', () => {
    const appSource = readFileSync(join(root, 'src/App.tsx'), 'utf8');
    expect(appSource).toContain('controlCenter.register(');
    expect(appSource).toContain("'plugin-host.dispose',");
    expect(appSource).toContain("new PluginHostControlNode(pluginHost)");
    expect(appSource).toContain('createControlCommand(');
    expect(appSource).toContain("'plugin-host.dispose',");
    expect(appSource).toContain("subject: 'app-shell'");
    expect(appSource).toContain("capabilities: ['plugin-host:dispose']");
    expect(appSource).toContain("idempotencyKey: 'plugin-host.dispose:app-unmount'");
    expect(appSource).not.toContain('pluginHost.disposeAll');
    expect(appSource).not.toContain("disposeAll('app-unmount')");
  });
});
