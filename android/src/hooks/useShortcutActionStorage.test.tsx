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

  it('seeds built-in shortcut presets into the ordered shortcut truth', () => {
    const { result } = renderHook(() => useShortcutActionStorage());

    expect(result.current.shortcutActions.map(({ id, label, row, order }) => ({
      id,
      label,
      row,
      order,
    }))).toEqual([
      { id: 'preset-top-scroll-esc', label: 'Esc', row: 'top-scroll', order: 0 },
      { id: 'preset-top-scroll-bksp', label: 'Bksp', row: 'top-scroll', order: 1 },
      { id: 'preset-top-scroll-tab', label: 'Tab', row: 'top-scroll', order: 2 },
      { id: 'preset-top-scroll-enter', label: 'Enter', row: 'top-scroll', order: 3 },
      { id: 'preset-top-scroll-space', label: 'Space', row: 'top-scroll', order: 4 },
      { id: 'preset-bottom-scroll-continue', label: '继续', row: 'bottom-scroll', order: 0 },
      { id: 'preset-bottom-scroll-paste', label: 'Paste', row: 'bottom-scroll', order: 1 },
      { id: 'preset-bottom-scroll-shift-tab', label: 'S-Tab', row: 'bottom-scroll', order: 2 },
      { id: 'preset-bottom-scroll-shift-enter', label: 'S-Enter', row: 'bottom-scroll', order: 3 },
    ]);
  });

  it('merges missing built-ins into legacy custom-only storage without dropping custom actions', async () => {
    localStorage.setItem(STORAGE_KEYS.SHORTCUT_ACTIONS, JSON.stringify([
      { id: 'custom-copy', label: 'Ctrl+C', sequence: '\x03', order: 9, row: 'bottom-scroll' },
    ]));

    const { result } = renderHook(() => useShortcutActionStorage());

    await act(async () => undefined);

    expect(result.current.shortcutActions.filter((action) => action.row === 'bottom-scroll').map((action) => action.label)).toEqual([
      'Ctrl+C',
      '继续',
      'Paste',
      'S-Tab',
      'S-Enter',
    ]);
  });

  it('preserves persisted built-in order across storage reload', async () => {
    localStorage.setItem(STORAGE_KEYS.SHORTCUT_ACTIONS, JSON.stringify([
      { id: 'preset-top-scroll-enter', label: 'Enter', sequence: '\r', order: 0, row: 'top-scroll' },
      { id: 'preset-top-scroll-esc', label: 'Esc', sequence: '\x1b', order: 1, row: 'top-scroll' },
    ]));

    const { result } = renderHook(() => useShortcutActionStorage());

    await act(async () => undefined);

    expect(result.current.shortcutActions.filter((action) => action.row === 'top-scroll').map((action) => action.label)).toEqual([
      'Enter',
      'Esc',
      'Bksp',
      'Tab',
      'Space',
    ]);
  });
});
