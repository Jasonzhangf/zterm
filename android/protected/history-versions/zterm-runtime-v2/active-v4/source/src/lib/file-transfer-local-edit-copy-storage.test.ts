// @vitest-environment jsdom

/**
 * Submodule tests: file-transfer-local-edit-copy-storage (client.file_browser).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildBoundedLocalCopyIdentity,
  buildLocalEditCopyStateKey,
  readLocalEditCopyState,
  writeLocalEditCopyState,
} from './file-transfer-local-edit-copy-storage';

describe('file-transfer-local-edit-copy-storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('builds bounded identity hashes that are stable and collision-resistant', () => {
    expect(buildBoundedLocalCopyIdentity('/a/b')).toBe(buildBoundedLocalCopyIdentity('/a/b'));
    expect(buildBoundedLocalCopyIdentity('/a/b')).not.toBe(buildBoundedLocalCopyIdentity('/a/c'));
    expect(buildBoundedLocalCopyIdentity('')).toBe(buildBoundedLocalCopyIdentity('cwd'));
  });

  it('round-trips edit copy state per kind/source', () => {
    const key = buildLocalEditCopyStateKey('remote', 'src-id');
    expect(key).toContain('remote');
    writeLocalEditCopyState('remote', 'src-id', { state: 'unsynced', path: '/p', fileName: 'f.txt', size: 10, modified: 1 });
    expect(readLocalEditCopyState('remote', 'src-id', '/p')?.fileName).toBe('f.txt');
    expect(readLocalEditCopyState('remote', 'other', '/p')).toBeNull();
  });

  it('rejects stale or mismatched stored state', () => {
    writeLocalEditCopyState('remote', 'src-id', { state: 'unsynced', path: '/p', fileName: 'f.txt', size: 10, modified: 1 });
    expect(readLocalEditCopyState('remote', 'src-id', '/other')).toBeNull();
    window.localStorage.setItem(buildLocalEditCopyStateKey('remote', 'src-id'), '{"state":"bogus"}');
    expect(readLocalEditCopyState('remote', 'src-id', '/p')).toBeNull();
    window.localStorage.setItem(buildLocalEditCopyStateKey('remote', 'src-id'), '{corrupt');
    expect(readLocalEditCopyState('remote', 'src-id', '/p')).toBeNull();
  });
});
