import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppUpdateRuntime } from './app-update-runtime';
import type { BrowserStorageLike } from './browser-storage';

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

describe('app-update-runtime', () => {
  const fetchFn = vi.fn();
  const canRequestPackageInstalls = vi.fn();
  const openInstallPermissionSettings = vi.fn();
  const downloadAndInstall = vi.fn();
  const backupCurrentApk = vi.fn();
  const rollbackToBackup = vi.fn();
  const getRollbackBackupInfo = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createRuntime(storage: BrowserStorageLike | null = createStorage()) {
    return createAppUpdateRuntime({
      storage,
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => 123456789,
      runtimeVersionCode: 1011491,
      packageName: 'com.zterm.android',
      isNativeSupported: () => true,
      canRequestPackageInstalls,
      openInstallPermissionSettings,
      downloadAndInstall,
      backupCurrentApk,
      rollbackToBackup,
      getRollbackBackupInfo,
    });
  }

  it('restores preferences from storage via the runtime owner', () => {
    const runtime = createRuntime(createStorage({
      'zterm:app-update-settings': JSON.stringify({
        manifestUrl: 'https://example.com/updates/latest.json',
        autoCheckOnLaunch: false,
      }),
    }));

    runtime.restorePreferences();

    expect(runtime.getSnapshot().preferences.manifestUrl).toBe('https://example.com/updates/latest.json');
    expect(runtime.getSnapshot().preferences.autoCheckOnLaunch).toBe(false);
  });

  it('checks manifest and computes available manifest inside the runtime block', async () => {
    const runtime = createRuntime(createStorage({
      'zterm:app-update-settings': JSON.stringify({
        manifestUrl: 'https://example.com/updates/latest.json',
        autoCheckOnLaunch: false,
      }),
    }));
    runtime.restorePreferences();

    fetchFn.mockResolvedValue({
      ok: true,
      json: async () => ({
        versionName: '0.1.1.1493',
        versionCode: 1011493,
        buildNumber: 1493,
        apkUrl: 'zterm-0.1.1.1493.apk',
        sha256: 'abc123',
        notes: [],
      }),
    });

    const result = await runtime.checkForUpdates();

    expect(result.updateAvailable).toBe(true);
    expect(result.suppressedReason).toBe('none');
    expect(runtime.getSnapshot().latestManifest?.versionCode).toBe(1011493);
    expect(runtime.getSnapshot().availableManifest?.versionCode).toBe(1011493);
    expect(runtime.getSnapshot().preferences.lastCheckedAt).toBe(123456789);
  });

  it('tracks explicit install stage transitions and completes inside the runtime block', async () => {
    const runtime = createRuntime();

    canRequestPackageInstalls.mockResolvedValue({ allowed: true });
    backupCurrentApk.mockResolvedValue({ versionCode: 1011491, versionName: '0.1.1.1491', filePath: '/tmp/rollback.apk', sha256: 'rollbacksha', backedUpAt: 123456789 });
    downloadAndInstall.mockResolvedValue({
      filePath: '/tmp/zterm.apk',
      sha256: 'abc123',
      packageName: 'com.zterm.android',
    });

    const installed = await runtime.startUpdate({
      versionName: '0.1.1.1493',
      versionCode: 1011493,
      buildNumber: 1493,
      apkUrl: 'https://example.com/zterm-0.1.1.1493.apk',
      sha256: 'abc123',
      notes: [],
    });

    expect(installed).toBe(true);
    expect(runtime.getSnapshot().updateStage).toBe('completed');
    expect(runtime.getSnapshot().installing).toBe(false);
    expect(canRequestPackageInstalls).toHaveBeenCalledTimes(1);
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
  });

  it('backs up current apk before download/install and stores rollback backup', async () => {
    const runtime = createRuntime();

    canRequestPackageInstalls.mockResolvedValue({ allowed: true });
    backupCurrentApk.mockResolvedValue({
      versionCode: 1011491,
      versionName: '0.1.1.1491',
      filePath: '/tmp/rollback.apk',
      sha256: 'rollbacksha',
      backedUpAt: 123456789,
    });
    downloadAndInstall.mockResolvedValue({
      filePath: '/tmp/zterm.apk',
      sha256: 'abc123',
      packageName: 'com.zterm.android',
    });

    const installed = await runtime.startUpdate({
      versionName: '0.1.1.1493',
      versionCode: 1011493,
      buildNumber: 1493,
      apkUrl: 'https://example.com/zterm-0.1.1.1493.apk',
      sha256: 'abc123',
      notes: [],
    });

    expect(installed).toBe(true);
    expect(backupCurrentApk).toHaveBeenCalledTimes(1);
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().rollbackBackup?.filePath).toBe('/tmp/rollback.apk');
  });

  it('aborts update when backup current apk fails', async () => {
    const runtime = createRuntime();

    backupCurrentApk.mockRejectedValue(new Error('backup failed'));

    const installed = await runtime.startUpdate({
      versionName: '0.1.1.1493',
      versionCode: 1011493,
      buildNumber: 1493,
      apkUrl: 'https://example.com/zterm-0.1.1.1493.apk',
      sha256: 'abc123',
      notes: [],
    });

    expect(installed).toBe(false);
    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().lastError).toContain('backup failed');
  });

  it('rolls back to previous version and clears rollback backup', async () => {
    const runtime = createRuntime(createStorage({
      'zterm:app-update-settings': JSON.stringify({
        manifestUrl: 'https://example.com/updates/latest.json',
        autoCheckOnLaunch: false,
        rollbackBackup: {
          versionCode: 1011491,
          versionName: '0.1.1.1491',
          filePath: '/tmp/rollback.apk',
          sha256: 'rollbacksha',
          backedUpAt: 123456789,
        },
      }),
    }));
    runtime.restorePreferences();
    rollbackToBackup.mockResolvedValue(undefined);

    const rolledBack = await runtime.rollbackToPreviousVersion();

    expect(rolledBack).toBe(true);
    expect(rollbackToBackup).toHaveBeenCalledWith({
      filePath: '/tmp/rollback.apk',
      sha256: 'rollbacksha',
    });
    expect(runtime.getSnapshot().rollbackBackup).toBeNull();
  });

});