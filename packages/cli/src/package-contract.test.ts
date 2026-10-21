import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

describe('zterm CLI package contract', () => {
  it('exposes a thin external zterm bin and Node 22 runtime contract', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const binSource = readFileSync(new URL('../bin/zterm.mjs', import.meta.url), 'utf8');

    expect(manifest.name).toBe('@jsonstudio/zterm-cli');
    expect(manifest.private).not.toBe(true);
    expect(manifest.engines.node).toBe('>=22');
    expect(manifest.bin).toEqual({ zterm: './bin/zterm.mjs' });
    expect(manifest.files).toEqual(expect.arrayContaining(['bin', 'dist', 'README.md']));
    expect(manifest.dependencies ?? {}).not.toHaveProperty('@zterm/shared');
    expect(manifest.dependencies ?? {}).not.toHaveProperty('@jsonstudio/wtermmod-core');
    expect(binSource.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(binSource).toContain("new URL('../dist/main.mjs', import.meta.url)");
    expect(packageRoot).not.toMatch(/[\\/]android[\\/]src[\\/]/);
  });
});
