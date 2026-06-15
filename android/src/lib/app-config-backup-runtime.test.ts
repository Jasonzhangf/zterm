import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_UPDATE_STORAGE_KEY } from './app-update';
import { createAppConfigBackupRuntime } from './app-config-backup-runtime';
import type { BrowserStorageLike } from './browser-storage';
import { STORAGE_KEYS } from './types';

function createStorage(initial?: Record<string, string>): BrowserStorageLike {
  const map = new Map<string, string>(Object.entries(initial || {}));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

describe('app-config-backup-runtime', () => {
  const ensureStoragePermission = vi.fn();
  const writeBackupFile = vi.fn();
  const readBackupFile = vi.fn();
  const reloadApp = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    ensureStoragePermission.mockResolvedValue(undefined);
  });

  function createRuntime(storage: BrowserStorageLike | null = createStorage()) {
    return createAppConfigBackupRuntime({
      storage,
      now: () => 123456789,
      appVersion: '0.1.3.1795',
      appVersionCode: 1031795,
      ensureStoragePermission,
      writeBackupFile,
      readBackupFile,
      reloadApp,
    });
  }

  it('exports the allowlisted config snapshot into the fixed backup file payload', async () => {
    const runtime = createRuntime(createStorage({
      [STORAGE_KEYS.HOSTS]: '[{"id":"host-1"}]',
      [APP_UPDATE_STORAGE_KEY]: '{"manifestUrl":"https://example.com"}',
      'zterm:unknown': 'ignore-me',
    }));
    writeBackupFile.mockResolvedValue(undefined);

    const backupInfo = await runtime.exportConfig();

    expect(ensureStoragePermission).toHaveBeenCalledTimes(1);
    expect(writeBackupFile).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(writeBackupFile.mock.calls[0][0]) as Record<string, unknown>;
    expect(payload.storage).toMatchObject({
      [STORAGE_KEYS.HOSTS]: '[{"id":"host-1"}]',
      [APP_UPDATE_STORAGE_KEY]: '{"manifestUrl":"https://example.com"}',
    });
    expect((payload.storage as Record<string, unknown>)['zterm:unknown']).toBeUndefined();
    expect(backupInfo?.storedKeys).toBe(2);
    expect(runtime.getSnapshot().lastError).toBeNull();
  });

  it('fails export explicitly when storage permission is denied', async () => {
    const runtime = createRuntime();
    ensureStoragePermission.mockRejectedValue(new Error('需要先授予外部存储权限'));

    const backupInfo = await runtime.exportConfig();

    expect(backupInfo).toBeNull();
    expect(writeBackupFile).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().lastError).toContain('需要先授予外部存储权限');
    expect(runtime.getSnapshot().stage).toBe('failed');
  });

  it('restores allowlisted config keys, clears absent ones, and reloads the app', async () => {
    const storage = createStorage({
      [STORAGE_KEYS.HOSTS]: '[{"id":"old"}]',
      [STORAGE_KEYS.OPEN_TABS]: '[{"sessionId":"old"}]',
      'zterm:unknown': 'keep-me',
    });
    const runtime = createRuntime(storage);
    readBackupFile.mockResolvedValue(JSON.stringify({
      schemaVersion: 1,
      exportedAt: 123456789,
      platform: 'android',
      appVersion: '0.1.3.1795',
      appVersionCode: 1031795,
      storage: {
        [STORAGE_KEYS.HOSTS]: '[{"id":"new"}]',
        [APP_UPDATE_STORAGE_KEY]: '{"manifestUrl":"https://example.com"}',
      },
    }));

    const backupInfo = await runtime.restoreConfig();

    expect(backupInfo?.storedKeys).toBe(2);
    expect(storage.getItem(STORAGE_KEYS.HOSTS)).toBe('[{"id":"new"}]');
    expect(storage.getItem(APP_UPDATE_STORAGE_KEY)).toBe('{"manifestUrl":"https://example.com"}');
    expect(storage.getItem(STORAGE_KEYS.OPEN_TABS)).toBeNull();
    expect(storage.getItem('zterm:unknown')).toBe('keep-me');
    expect(reloadApp).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid backup payloads without mutating storage or reloading', async () => {
    const storage = createStorage({
      [STORAGE_KEYS.HOSTS]: '[{"id":"keep"}]',
    });
    const runtime = createRuntime(storage);
    readBackupFile.mockResolvedValue(JSON.stringify({
      schemaVersion: 999,
      storage: {},
    }));

    const backupInfo = await runtime.restoreConfig();

    expect(backupInfo).toBeNull();
    expect(storage.getItem(STORAGE_KEYS.HOSTS)).toBe('[{"id":"keep"}]');
    expect(reloadApp).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().lastError).toContain('配置备份文件格式无效');
  });
});
