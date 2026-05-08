// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPersistedWorkspace } from './workspace-persistence';
import { STORAGE_KEYS } from './types';

describe('workspace-persistence', () => {
  beforeEach(() => {
    const storageBacking = new Map<string, string>();
    const storageShim = {
      get length() {
        return storageBacking.size;
      },
      clear() {
        storageBacking.clear();
      },
      getItem(key: string) {
        return storageBacking.has(key) ? storageBacking.get(key)! : null;
      },
      key(index: number) {
        return Array.from(storageBacking.keys())[index] ?? null;
      },
      removeItem(key: string) {
        storageBacking.delete(key);
      },
      setItem(key: string, value: string) {
        storageBacking.set(key, String(value));
      },
    } as Storage;
    vi.stubGlobal('localStorage', storageShim);
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('treats pane count as the only split width truth and redistributes persisted pane sizes evenly', () => {
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify({
      panes: [
        { id: 'pane-1', size: 0.62, activeTabId: 'tab-s1', tabs: [{ id: 'tab-s1', sessionId: 's1' }] },
        { id: 'pane-2', size: 0.23, activeTabId: 'tab-s2', tabs: [{ id: 'tab-s2', sessionId: 's2' }] },
        { id: 'pane-3', size: 0.15, activeTabId: 'tab-s3', tabs: [{ id: 'tab-s3', sessionId: 's3' }] },
      ],
      activePaneId: 'pane-2',
    }));

    const workspace = readPersistedWorkspace(['s1', 's2', 's3'], 's2');

    expect(workspace.activePaneId).toBe('pane-2');
    expect(workspace.panes).toHaveLength(3);
    expect(workspace.panes.map((pane) => pane.size)).toEqual([
      1 / 3,
      1 / 3,
      1 / 3,
    ]);
  });
});
