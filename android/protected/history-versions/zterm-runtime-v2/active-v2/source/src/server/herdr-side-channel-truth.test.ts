import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Herdr side-channel boundary', () => {
  it('keeps agent/control vocabulary out of the Herdr terminal source and canonical payload owners', () => {
    const source = readFileSync(new URL('./herdr-backend.ts', import.meta.url), 'utf8');
    const canonicalizer = readFileSync(new URL('./herdr-frame-canonicalizer.ts', import.meta.url), 'utf8');
    const runtime = readFileSync(new URL('./herdr-backend-runtime.ts', import.meta.url), 'utf8');
    for (const forbidden of ['codex', 'opencode', 'reasonix', 'provider', 'retry', 'routing', 'debug']) {
      expect(source.toLowerCase()).not.toContain(forbidden);
      expect(canonicalizer.toLowerCase()).not.toContain(forbidden);
      expect(runtime.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('does not define control or agent metadata on terminal.frame business bytes', () => {
    const source = readFileSync(new URL('./herdr-frame-canonicalizer.ts', import.meta.url), 'utf8');
    expect(source).toContain('bytes: string');
    expect(source).toContain('seq: number');
    expect(source).toContain('full: boolean');
    expect(source).not.toMatch(/metadata\??\s*:/u);
    expect(source).not.toMatch(/provider\??\s*:/u);
    expect(source).not.toMatch(/control\??\s*:/u);
  });
});
