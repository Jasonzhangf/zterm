// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../lib/types';
import { useShortcutActionStorage } from './useShortcutActionStorage';

describe('useShortcutActionStorage', () => {
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
    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('does not seed built-in shortcut presets into persisted shortcut truth', () => {
    const { result } = renderHook(() => useShortcutActionStorage());

    expect(result.current.shortcutActions).toEqual([]);
  });

  it('normalizes stored custom shortcuts without re-adding built-in presets', async () => {
    localStorage.setItem(STORAGE_KEYS.SHORTCUT_ACTIONS, JSON.stringify([
      { id: 'custom-paste', label: 'Paste', sequence: '\\x16', order: 9, row: 'bottom-scroll' },
    ]));

    const { result } = renderHook(() => useShortcutActionStorage());

    await act(async () => undefined);

    expect(result.current.shortcutActions).toEqual([
      { id: 'custom-paste', label: 'Paste', sequence: '\\x16', order: 0, row: 'bottom-scroll' },
    ]);
  });
});
