// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_CONFIG_BACKUP_DIR_PATH, APP_CONFIG_BACKUP_FILE_PATH } from '../lib/app-config-backup';
import { STORAGE_KEYS } from '../lib/types';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
  },
}));

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

vi.mock('../plugins/StoragePermissionPlugin', () => ({
  StoragePermissionPlugin: {
    check: vi.fn(),
    request: vi.fn(),
  },
}));

vi.stubGlobal('__APP_VERSION__', '0.1.3.1795');
vi.stubGlobal('__APP_BASE_VERSION__', '0.1.3');
vi.stubGlobal('__APP_BUILD_NUMBER__', '1795');
vi.stubGlobal('__APP_VERSION_CODE__', '1031795');
vi.stubGlobal('__APP_PACKAGE_NAME__', 'com.zterm.android');

describe('useAppConfigBackup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    const storageState = new Map<string, string>();
    const storage = {
      getItem: (key: string) => storageState.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storageState.set(key, value);
      },
      removeItem: (key: string) => {
        storageState.delete(key);
      },
      clear: () => {
        storageState.clear();
      },
    };
    storage.setItem(STORAGE_KEYS.HOSTS, '[{"id":"host-1"}]');
    vi.stubGlobal('localStorage', storage);
  });

  it('requests storage permission and writes the fixed config backup file on export', async () => {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { StoragePermissionPlugin } = await import('../plugins/StoragePermissionPlugin');
    vi.mocked(StoragePermissionPlugin.check).mockResolvedValue({ granted: false, mode: 'manage-external-storage' } as any);
    vi.mocked(StoragePermissionPlugin.request).mockResolvedValue({ granted: true, mode: 'manage-external-storage' } as any);
    vi.mocked(Filesystem.mkdir).mockResolvedValue(undefined as any);
    vi.mocked(Filesystem.writeFile).mockResolvedValue(undefined as any);

    const { useAppConfigBackup } = await import('./useAppConfigBackup');
    const { result } = renderHook(() => useAppConfigBackup());

    await act(async () => {
      await result.current.exportConfig();
    });

    expect(StoragePermissionPlugin.check).toHaveBeenCalledTimes(1);
    expect(StoragePermissionPlugin.request).toHaveBeenCalledTimes(1);
    expect(Filesystem.mkdir).toHaveBeenCalledWith({
      path: APP_CONFIG_BACKUP_DIR_PATH,
      directory: Directory.ExternalStorage,
      recursive: true,
    });
    expect(Filesystem.writeFile).toHaveBeenCalledWith(expect.objectContaining({
      path: APP_CONFIG_BACKUP_FILE_PATH,
      directory: Directory.ExternalStorage,
    }));
    expect(result.current.backupInfo?.filePath).toBe(APP_CONFIG_BACKUP_FILE_PATH);
  });

  it('surfaces restore errors when the backup file cannot be read', async () => {
    const { Filesystem } = await import('@capacitor/filesystem');
    const { StoragePermissionPlugin } = await import('../plugins/StoragePermissionPlugin');
    vi.mocked(StoragePermissionPlugin.check).mockResolvedValue({ granted: true, mode: 'manage-external-storage' } as any);
    vi.mocked(Filesystem.readFile).mockRejectedValue(new Error('backup missing'));

    const { useAppConfigBackup } = await import('./useAppConfigBackup');
    const { result } = renderHook(() => useAppConfigBackup());

    await act(async () => {
      await result.current.restoreConfig();
    });

    await waitFor(() => expect(result.current.lastError).toContain('backup missing'));
  });
});
