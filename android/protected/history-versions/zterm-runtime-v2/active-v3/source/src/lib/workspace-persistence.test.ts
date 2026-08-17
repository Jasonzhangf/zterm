// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { persistWorkspace, readPersistedWorkspace } from './workspace-persistence';
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
    if (typeof localStorage?.clear === 'function') {
      localStorage.clear();
    }
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

  it('preserves a well-formed empty pane without manufacturing pane identity', () => {
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify({
      panes: [
        { id: 'pane-1', size: 0.5, activeTabId: 'tab-s1', tabs: [{ id: 'tab-s1', sessionId: 's1' }] },
        { id: 'pane-empty-explicit', size: 0.5, activeTabId: '', tabs: [] },
      ],
      activePaneId: 'pane-empty-explicit',
    }));

    const workspace = readPersistedWorkspace(['s1'], 's1');

    expect(workspace.activePaneId).toBe('pane-empty-explicit');
    expect(workspace.panes.map((pane) => pane.id)).toEqual(['pane-1', 'pane-empty-explicit']);
    expect(workspace.panes[1]).toEqual({
      id: 'pane-empty-explicit',
      size: 0.5,
      activeTabId: '',
      tabs: [],
    });
  });

  it('rejects malformed empty panes instead of inventing an id, size, or active tab', () => {
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify({
      panes: [
        { id: 'pane-1', size: 0.5, activeTabId: 'tab-s1', tabs: [{ id: 'tab-s1', sessionId: 's1' }] },
        { tabs: [] },
        { id: 'pane-empty-bad-active', size: 0.5, tabs: [] },
      ],
      activePaneId: 'pane-empty-bad-active',
    }));

    expect(() => readPersistedWorkspace(['s1'], 's1')).toThrow(
      /workspace pane 1 must declare explicit id and positive size/,
    );
  });

  it('rejects persisted panes whose activeTabId does not point at a declared tab', () => {
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify({
      panes: [
        { id: 'pane-1', size: 1, activeTabId: 'tab-missing', tabs: [{ id: 'tab-s1', sessionId: 's1' }] },
      ],
      activePaneId: 'pane-1',
    }));

    expect(() => readPersistedWorkspace(['s1'], 's1')).toThrow(
      /workspace pane 0 activeTabId must reference a declared tab/,
    );
  });

  it('rejects persisted workspace states with no panes instead of manufacturing a default pane', () => {
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify({
      panes: [],
      activePaneId: '',
    }));

    expect(() => readPersistedWorkspace(['s1'], 's1')).toThrow(
      /workspace state must declare at least one pane/,
    );
  });

  it('rejects persisted panes with any malformed tab instead of truncating to the valid tabs', () => {
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify({
      panes: [
        {
          id: 'pane-1',
          size: 1,
          activeTabId: 'tab-s1',
          tabs: [
            { id: 'tab-s1', sessionId: 's1' },
            { id: 'tab-bad' },
          ],
        },
      ],
      activePaneId: 'pane-1',
    }));

    expect(() => readPersistedWorkspace(['s1'], 's1')).toThrow(
      /workspace pane 0 tab 1 must declare explicit id and sessionId/,
    );
  });

  it('rejects invalid workspace JSON instead of replacing persisted truth with a generated workspace', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, '{bad-json');

    expect(() => readPersistedWorkspace(['s1'], 's1')).toThrow(SyntaxError);
    expect(errorSpy).toHaveBeenCalledWith(
      '[workspace-persistence] Failed to parse workspace:',
      expect.any(SyntaxError),
    );
    errorSpy.mockRestore();
  });

  it('rejects unknown persisted workspace schema instead of replacing it with a generated workspace', () => {
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify({ unexpected: true }));

    expect(() => readPersistedWorkspace(['s1'], 's1')).toThrow(
      /persisted workspace must match the workspace or legacy terminal layout schema/,
    );
  });

  it('does not log or throw when browser storage is unavailable in local harness mode', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('localStorage', {} as Storage);

    const workspace = readPersistedWorkspace(['s1', 's2'], 's2');

    expect(workspace.panes).toHaveLength(1);
    expect(workspace.panes[0]?.tabs.map((tab) => tab.sessionId)).toEqual(['s1', 's2']);
    expect(errorSpy).not.toHaveBeenCalled();

    persistWorkspace(workspace);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
