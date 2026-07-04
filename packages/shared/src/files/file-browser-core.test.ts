import { describe, expect, it } from 'vitest';
import {
  decideFileBrowserPreview,
  joinFileBrowserPath,
  normalizeFileBrowserPath,
  projectFileBrowserDirectoryResult,
  resolveFileBrowserParentPath,
  sortFileBrowserEntries,
  type FileBrowserEntry,
} from './file-browser-core';

function entry(name: string, type: 'file' | 'directory', sizeBytes = 0, modifiedMs = 0): FileBrowserEntry {
  return { name, type, sizeBytes, modifiedMs };
}

describe('FileBrowserCore', () => {
  it('normalizes local paths and resolves adjacent child/parent paths', () => {
    expect(normalizeFileBrowserPath(' /Users/jason/../jason/project//./src ')).toBe('/Users/jason/project/src');
    expect(normalizeFileBrowserPath('relative/./folder/../file.txt')).toBe('relative/file.txt');
    expect(joinFileBrowserPath('/Users/jason/project', 'README.md')).toBe('/Users/jason/project/README.md');
    expect(resolveFileBrowserParentPath('/Users/jason/project')).toBe('/Users/jason');
    expect(resolveFileBrowserParentPath('/')).toBeNull();
  });

  it('rejects non-adjacent child joins', () => {
    expect(() => joinFileBrowserPath('/Users/jason/project', '../secret')).toThrow('Invalid file browser child name');
    expect(() => joinFileBrowserPath('/Users/jason/project', 'nested/file.txt')).toThrow('Invalid file browser child name');
  });

  it('sorts directory-first by name or modified time', () => {
    const entries = [
      entry('zeta.txt', 'file', 1, 20),
      entry('beta', 'directory', 0, 30),
      entry('alpha.txt', 'file', 1, 10),
      entry('alpha', 'directory', 0, 40),
    ];

    expect(sortFileBrowserEntries(entries).map((item) => item.name)).toEqual(['alpha', 'beta', 'alpha.txt', 'zeta.txt']);
    expect(sortFileBrowserEntries(entries, { key: 'modifiedMs', direction: 'desc' }).map((item) => item.name)).toEqual([
      'alpha',
      'beta',
      'zeta.txt',
      'alpha.txt',
    ]);
  });

  it('projects provider errors as errors, not empty directories', () => {
    const projection = projectFileBrowserDirectoryResult({
      ok: false,
      path: '/missing',
      error: 'ENOENT: no such file or directory',
    });

    expect(projection).toEqual({
      kind: 'error',
      path: '/missing',
      error: 'ENOENT: no such file or directory',
    });
  });

  it('projects successful directory reads with normalized path and sorted entries', () => {
    const projection = projectFileBrowserDirectoryResult({
      ok: true,
      path: '/Users/jason/project/../project',
      entries: [entry('b.txt', 'file'), entry('src', 'directory'), entry('a.txt', 'file')],
    });

    expect(projection.kind).toBe('directory');
    if (projection.kind !== 'directory') return;
    expect(projection.path).toBe('/Users/jason/project');
    expect(projection.entries.map((item) => item.name)).toEqual(['src', 'a.txt', 'b.txt']);
  });

  it('allows text preview candidates', () => {
    expect(decideFileBrowserPreview(entry('README.md', 'file', 1024))).toMatchObject({ kind: 'text' });
    expect(decideFileBrowserPreview(entry('Makefile', 'file', 1024))).toMatchObject({ kind: 'text' });
  });

  it('disables binary preview', () => {
    expect(decideFileBrowserPreview(entry('image.png', 'file', 1024))).toMatchObject({
      kind: 'binary-disabled',
    });
    expect(decideFileBrowserPreview(entry('unknown.blob', 'file', 1024))).toMatchObject({
      kind: 'binary-disabled',
    });
  });

  it('requires explicit confirmation for large text preview', () => {
    const largeText = entry('large.log', 'file', 900 * 1024);

    expect(decideFileBrowserPreview(largeText)).toMatchObject({
      kind: 'confirm-large-text',
      sizeBytes: 900 * 1024,
    });
    expect(decideFileBrowserPreview(largeText, { confirmedLargeText: true })).toMatchObject({ kind: 'text' });
  });
});

