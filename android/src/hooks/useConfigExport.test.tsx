// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { STORAGE_KEYS } from '../lib/types';
import { APP_UPDATE_STORAGE_KEY } from '../lib/app-update';
import { useConfigExport } from './useConfigExport';

vi.mock('@capacitor/filesystem', () => ({
  Directory: {
    Data: 'DATA',
    ExternalStorage: 'EXTERNAL',
  },
  Encoding: {
    UTF8: 'utf8',
  },
  Filesystem: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
  },
}));

function createCapacitorFilesystemStore() {
  const files = new Map<string, Buffer>();
  const fileKey = (path: string, directory: string) => `${directory}:${path}`;
  return {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async (options: {
      path: string;
      data: string;
      directory: string;
      encoding?: string;
    }) => {
      const bytes = options.encoding === Encoding.UTF8
        ? Buffer.from(options.data, 'utf8')
        : Buffer.from(options.data, 'base64');
      files.set(fileKey(options.path, options.directory), bytes);
      return { uri: `file:///data/user/0/com.zterm.android/files/${options.path}` };
    }),
    readFile: vi.fn(async (options: {
      path: string;
      directory: string;
      encoding?: string;
    }) => {
      const bytes = files.get(fileKey(options.path, options.directory));
      if (!bytes) {
        throw new Error('missing config file');
      }
      return {
        data: options.encoding === Encoding.UTF8
          ? bytes.toString('utf8')
          : bytes.toString('base64'),
      };
    }),
    bytesFor(path: string, directory: string) {
      return files.get(fileKey(path, directory));
    },
  };
}

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
    expect(Filesystem.mkdir).toHaveBeenCalledWith(expect.objectContaining({
      path: 'zterm-config-export',
      directory: Directory.Data,
      recursive: true,
    }));
    expect(Filesystem.writeFile).toHaveBeenCalledWith(expect.objectContaining({
      path: 'zterm-config-export/zterm-config.json',
      directory: Directory.Data,
      encoding: Encoding.UTF8,
      data: expect.stringContaining(STORAGE_KEYS.HOSTS),
    }));
    expect(Filesystem.writeFile).not.toHaveBeenCalledWith(expect.objectContaining({
      directory: Directory.ExternalStorage,
    }));
  });

  it.each([
    ['does-not-exist', 'Directory does not exist'],
    ['unrelated', 'Unable to create directory, unknown reason'],
  ])('returns an explicit export error for app-scoped mkdir %s failures', async (_caseName, errorMessage) => {
    vi.mocked(Filesystem.mkdir).mockRejectedValue(new Error(errorMessage));
    window.localStorage.setItem(STORAGE_KEYS.HOSTS, JSON.stringify([{ id: 'host-1' }]));
    const { result } = renderHook(() => useConfigExport());

    let exportResult: Awaited<ReturnType<typeof result.current.exportConfig>> | undefined;
    await act(async () => {
      exportResult = await result.current.exportConfig();
    });

    expect(exportResult).toEqual({
      ok: false,
      error: errorMessage,
    });
    expect(result.current.lastError).toBe(errorMessage);
    expect(Filesystem.writeFile).not.toHaveBeenCalled();
  });

  it('still writes UTF8 JSON when the app-scoped export directory already exists', async () => {
    vi.mocked(Filesystem.mkdir).mockRejectedValue(new Error('Directory exists'));
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
      encoding: Encoding.UTF8,
      directory: Directory.Data,
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
    expect(Filesystem.readFile).toHaveBeenCalledWith(expect.objectContaining({
      path: 'zterm-config-export/zterm-config.json',
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    }));
    expect(Filesystem.readFile).not.toHaveBeenCalledWith(expect.objectContaining({
      directory: Directory.ExternalStorage,
    }));
  });

  it('writes UTF8 JSON bytes and import roundtrips through the Capacitor encoding contract', async () => {
    const store = createCapacitorFilesystemStore();
    vi.mocked(Filesystem.mkdir).mockImplementation(store.mkdir);
    vi.mocked(Filesystem.writeFile).mockImplementation(store.writeFile as typeof Filesystem.writeFile);
    vi.mocked(Filesystem.readFile).mockImplementation(store.readFile as typeof Filesystem.readFile);

    const hosts = JSON.stringify([{ id: 'host-1' }]);
    window.localStorage.setItem(STORAGE_KEYS.HOSTS, hosts);
    const { result } = renderHook(() => useConfigExport());

    let exportResult: Awaited<ReturnType<typeof result.current.exportConfig>> | undefined;
    await act(async () => {
      exportResult = await result.current.exportConfig();
    });
    expect(exportResult?.ok).toBe(true);

    const writeArg = vi.mocked(Filesystem.writeFile).mock.calls[0]?.[0] as {
      data: string;
      encoding?: string;
      directory: string;
      path: string;
    };
    expect(writeArg.encoding).toBe(Encoding.UTF8);
    const onDisk = store.bytesFor(writeArg.path, writeArg.directory);
    expect(onDisk).toBeDefined();
    expect(onDisk!.length).toBeGreaterThan(17);
    const parsed = JSON.parse(onDisk!.toString('utf8')) as {
      schemaVersion: number;
      storage: Record<string, string>;
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.storage[STORAGE_KEYS.HOSTS]).toBe(hosts);

    const omittedEncodingBytes = Buffer.from(writeArg.data, 'base64');
    expect(() => JSON.parse(omittedEncodingBytes.toString('utf8'))).toThrow();

    window.localStorage.removeItem(STORAGE_KEYS.HOSTS);
    let importResult: Awaited<ReturnType<typeof result.current.importConfig>> | undefined;
    await act(async () => {
      importResult = await result.current.importConfig();
    });
    expect(importResult).toEqual({
      ok: true,
      path: 'zterm-config-export/zterm-config.json',
    });
    expect(window.localStorage.getItem(STORAGE_KEYS.HOSTS)).toBe(hosts);
    expect(Filesystem.readFile).toHaveBeenCalledWith(expect.objectContaining({
      encoding: Encoding.UTF8,
      directory: Directory.Data,
    }));
  });
});
