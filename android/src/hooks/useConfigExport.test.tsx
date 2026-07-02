// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { STORAGE_KEYS } from '../lib/types';
import { useConfigExport } from './useConfigExport';

vi.mock('@capacitor/filesystem', () => ({
  Directory: {
    ExternalStorage: 'EXTERNAL',
  },
  Filesystem: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
  },
}));

describe('useConfigExport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, String(value));
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
    });
  });

  it('exports config with a visible path/uri result instead of silent boolean success', async () => {
    vi.mocked(Filesystem.mkdir).mockResolvedValue(undefined as never);
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'file:///storage/zterm-config-export/zterm-config.json' } as never);
    window.localStorage.setItem(STORAGE_KEYS.HOSTS, JSON.stringify([{ id: 'host-1' }]));
    const { result } = renderHook(() => useConfigExport());

    let exportResult: Awaited<ReturnType<typeof result.current.exportConfig>> | undefined;
    await act(async () => {
      exportResult = await result.current.exportConfig();
    });

    expect(exportResult).toEqual({
      ok: true,
      path: 'zterm-config-export/zterm-config.json',
      uri: 'file:///storage/zterm-config-export/zterm-config.json',
    });
    expect(Filesystem.writeFile).toHaveBeenCalledWith(expect.objectContaining({
      path: 'zterm-config-export/zterm-config.json',
      directory: Directory.ExternalStorage,
      data: expect.stringContaining(STORAGE_KEYS.HOSTS),
    }));
  });

  it('returns an explicit import error instead of silently failing', async () => {
    vi.mocked(Filesystem.readFile).mockRejectedValue(new Error('missing config file'));
    const { result } = renderHook(() => useConfigExport());

    let importResult: Awaited<ReturnType<typeof result.current.importConfig>> | undefined;
    await act(async () => {
      importResult = await result.current.importConfig();
    });

    expect(importResult).toEqual({ ok: false, error: 'missing config file' });
    expect(result.current.lastError).toBe('missing config file');
  });
});
