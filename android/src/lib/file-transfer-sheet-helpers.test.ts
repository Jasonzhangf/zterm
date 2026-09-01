/**
 * Submodule tests: file-transfer-sheet-helpers (client.file_browser).
 */
import { describe, expect, it } from 'vitest';
import {
  compareFileEntries,
  encodeBytesToBase64,
  formatBytes,
  getParentLocalDisplayPath,
  isMarkdownFileName,
  isTextPreviewFileName,
  joinLocalDisplayPath,
  normalizeLocalDisplayPath,
  resolveTextMimeType,
  shortenDisplayPath,
  truncateName,
} from './file-transfer-sheet-helpers';

describe('file-transfer-sheet-helpers', () => {
  it('formats byte counts', () => {
    expect(formatBytes(0)).toContain('B');
    expect(formatBytes(1536)).toContain('KB');
  });

  it('truncates names at the boundary', () => {
    expect(truncateName('abcdef', 3)).toBe('a…');
    expect(truncateName('ab', 3)).toBe('ab');
  });

  it('shows only the final directory for display paths', () => {
    expect(shortenDisplayPath('/storage/emulated/0/Download/zterm')).toBe('zterm');
    expect(shortenDisplayPath('/remote/home/')).toBe('home');
    expect(shortenDisplayPath('/')).toBe('/');
    expect(shortenDisplayPath('~/')).toBe('~');
  });

  it('detects markdown and text preview files', () => {
    expect(isMarkdownFileName('README.md')).toBe(true);
    expect(isTextPreviewFileName('note.txt')).toBe(true);
    expect(isTextPreviewFileName('a.png')).toBe(false);
  });

  it('resolves text mime types', () => {
    expect(resolveTextMimeType('x.ts')).toBe('text/plain');
    expect(resolveTextMimeType('x.bin')).toBe('text/plain');
  });

  it('encodes bytes to base64', () => {
    expect(encodeBytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=');
  });

  it('joins and normalizes display paths', () => {
    expect(joinLocalDisplayPath('/a', 'b')).toContain('/a/b');
    expect(normalizeLocalDisplayPath('/a/b/')).toContain('/a/b');
    expect(getParentLocalDisplayPath('/storage/emulated/0/a/b')).toContain('/a');
  });

  it('sorts file entries by field and direction', () => {
    const a = { name: 'a', type: 'file', modified: 1 } as never;
    const b = { name: 'b', type: 'file', modified: 2 } as never;
    expect(compareFileEntries(a, b, 'name', 'asc')).toBeLessThan(0);
    expect(compareFileEntries(a, b, 'modified', 'desc')).toBeGreaterThan(0);
  });
});
