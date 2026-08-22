// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { STORAGE_KEYS } from '../lib/types';
import { APP_UPDATE_STORAGE_KEY } from '../lib/app-update';
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

  it('exports local configuration keys without session/runtime state', async () => {
    vi.mocked(Filesystem.mkdir).mockResolvedValue(undefined as never);
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'file:///storage/zterm-config-export/zterm-config.json' } as never);
    window.localStorage.setItem(STORAGE_KEYS.HOSTS, '[{"id":"host-1"}]');
    window.localStorage.setItem(STORAGE_KEYS.BRIDGE_SETTINGS, '{"servers":[{"id":"server-1"}]}');
    window.localStorage.setItem(STORAGE_KEYS.QUICK_ACTIONS, '[{"label":"ls"}]');
    window.localStorage.setItem(STORAGE_KEYS.SHORTCUT_ACTIONS, '[{"label":"copy"}]');
    window.localStorage.setItem(STORAGE_KEYS.WEBDAV_CONFIG, '{"enabled":false}');
    window.localStorage.setItem(APP_UPDATE_STORAGE_KEY, '{"manifestUrl":"http://daemon/updates/latest.json"}');
    window.localStorage.setItem(STORAGE_KEYS.SESSION_GROUPS, '[{"sessionNames":["server"]}]');
    window.localStorage.setItem(STORAGE_KEYS.OPEN_TABS, '[{"sessionId":"runtime-tab"}]');
    window.localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, 'runtime-tab');
    window.localStorage.setItem(STORAGE_KEYS.SESSION_DRAFTS, '{"runtime-tab":"draft"}');
    const { result } = renderHook(() => useConfigExport());

    await act(async () => {
      await result.current.exportConfig();
    });

    const writeArg = vi.mocked(Filesystem.writeFile).mock.calls[0]?.[0] as { data: string };
    const payload = JSON.parse(writeArg.data) as { storage: Record<string, string> };
    expect(Object.keys(payload.storage).sort()).toEqual([
      APP_UPDATE_STORAGE_KEY,
      STORAGE_KEYS.BRIDGE_SETTINGS,
      STORAGE_KEYS.HOSTS,
      STORAGE_KEYS.QUICK_ACTIONS,
      STORAGE_KEYS.SHORTCUT_ACTIONS,
      STORAGE_KEYS.WEBDAV_CONFIG,
    ].sort());
    expect(payload.storage[STORAGE_KEYS.SESSION_GROUPS]).toBeUndefined();
    expect(payload.storage[STORAGE_KEYS.OPEN_TABS]).toBeUndefined();
    expect(payload.storage[STORAGE_KEYS.ACTIVE_SESSION]).toBeUndefined();
    expect(payload.storage[STORAGE_KEYS.SESSION_DRAFTS]).toBeUndefined();
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
