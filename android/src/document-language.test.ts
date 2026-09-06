import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('HTML document language', () => {
  it('declares the Chinese product language at the app entry', () => {
    const entryHtml = readFileSync(resolve(__dirname, '../index.html'), 'utf8');

    expect(entryHtml).toMatch(/<html\s+lang="zh-CN">/);
  });
});
