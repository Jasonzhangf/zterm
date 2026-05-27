// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppUpdateCheckResult } from '../lib/app-update';

vi.mock('../plugins/AppUpdatePlugin', () => ({
  AppUpdatePlugin: {
    canRequestPackageInstalls: vi.fn(),
    openInstallPermissionSettings: vi.fn(),
    downloadAndInstall: vi.fn(),
    backupCurrentApk: vi.fn(),
    rollbackToBackup: vi.fn(),
    getRollbackBackupInfo: vi.fn(),
  },
  isNativeAppUpdateSupported: () => true,
}));

vi.stubGlobal('__APP_VERSION__', '0.1.1.1491');
vi.stubGlobal('__APP_BASE_VERSION__', '0.1.1');
vi.stubGlobal('__APP_BUILD_NUMBER__', '1491');
vi.stubGlobal('__APP_VERSION_CODE__', '1011491');
vi.stubGlobal('__APP_PACKAGE_NAME__', 'com.zterm.android');

describe('useAppUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.stubGlobal('__APP_VERSION__', '0.1.1.1491');
    vi.stubGlobal('__APP_BASE_VERSION__', '0.1.1');
    vi.stubGlobal('__APP_BUILD_NUMBER__', '1491');
    vi.stubGlobal('__APP_VERSION_CODE__', '1011491');
    vi.stubGlobal('__APP_PACKAGE_NAME__', 'com.zterm.android');
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
    vi.stubGlobal('localStorage', storage);
  });

  it('does not prompt when manifest versionCode equals installed Android versionCode', async () => {
    globalThis.localStorage.setItem('zterm:app-update-settings', JSON.stringify({
      manifestUrl: 'https://example.com/updates/latest.json',
      autoCheckOnLaunch: false,
      ignoreUntilManualCheck: false,
    }));

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        versionName: '0.1.1.1491',
        versionCode: 1011491,
        buildNumber: 1491,
        apkUrl: 'zterm-0.1.1.1491.apk',
        sha256: 'abc123',
        notes: [],
      }),
    }) as typeof fetch);

    const { useAppUpdate } = await import('./useAppUpdate');
    const { result } = renderHook(() => useAppUpdate());

    await waitFor(() => expect(result.current.runtimeVersionCode).toBe(1011491));

    let checkResultPromiseValue: AppUpdateCheckResult | undefined;
    await act(async () => {
      checkResultPromiseValue = await result.current.checkForUpdates({ manual: true });
    });

    if (!checkResultPromiseValue) {
      throw new Error('expected check result');
    }
    expect(checkResultPromiseValue.updateAvailable).toBe(false);
    expect(result.current.availableManifest).toBeNull();
    expect(result.current.latestManifest?.versionCode).toBe(1011491);
  });

  it('does not re-prompt after relaunch when manifest matches installed Android versionCode even if buildNumber is shorter', async () => {
    globalThis.localStorage.setItem('zterm:app-update-settings', JSON.stringify({
      manifestUrl: 'https://example.com/updates/latest.json',
      autoCheckOnLaunch: false,
      ignoreUntilManualCheck: false,
    }));

    vi.stubGlobal('__APP_VERSION__', '0.1.1.1551');
    vi.stubGlobal('__APP_BASE_VERSION__', '0.1.1');
    vi.stubGlobal('__APP_BUILD_NUMBER__', '1551');
    vi.stubGlobal('__APP_VERSION_CODE__', '1011551');
    vi.resetModules();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        versionName: '0.1.1.1551',
        versionCode: 1011551,
        buildNumber: 1551,
        apkUrl: 'zterm-0.1.1.1551.apk',
        sha256: 'abc123',
        notes: [],
      }),
    }) as typeof fetch);

    const { useAppUpdate } = await import('./useAppUpdate');
    const { result } = renderHook(() => useAppUpdate());

    await waitFor(() => expect(result.current.runtimeVersionCode).toBe(1011551));

    let checkResultPromiseValue: AppUpdateCheckResult | undefined;
    await act(async () => {
      checkResultPromiseValue = await result.current.checkForUpdates({ manual: true });
    });

    if (!checkResultPromiseValue) {
      throw new Error('expected check result');
    }
    expect(checkResultPromiseValue.updateAvailable).toBe(false);
    expect(result.current.availableManifest).toBeNull();
  });

  it('tracks explicit update stage truth across install completion', async () => {
    globalThis.localStorage.setItem('zterm:app-update-settings', JSON.stringify({
      manifestUrl: 'https://example.com/updates/latest.json',
      autoCheckOnLaunch: false,
      ignoreUntilManualCheck: false,
    }));

    const { AppUpdatePlugin } = await import('../plugins/AppUpdatePlugin');
    vi.mocked(AppUpdatePlugin.canRequestPackageInstalls).mockResolvedValue({ allowed: true } as any);
    vi.mocked(AppUpdatePlugin.downloadAndInstall).mockResolvedValue({
      filePath: '/tmp/zterm.apk',
      sha256: 'abc123',
      packageName: 'com.zterm.android',
    } as any);

    const { useAppUpdate } = await import('./useAppUpdate');
    const { result } = renderHook(() => useAppUpdate());

    await waitFor(() => expect(result.current.runtimeVersionCode).toBe(1011491));

    let installed = false;
    await act(async () => {
      installed = await result.current.startUpdate({
        versionName: '0.1.1.1493',
        versionCode: 1011493,
        buildNumber: 1493,
        apkUrl: 'https://example.com/zterm-0.1.1.1493.apk',
        sha256: 'abc123',
        notes: [],
      });
    });

    expect(installed).toBe(true);
    expect(AppUpdatePlugin.canRequestPackageInstalls).toHaveBeenCalledTimes(1);
    expect(AppUpdatePlugin.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(result.current.updateStage).toBe('completed');
  });

  it('binds fetch to the global owner so WebView-style fetch implementations do not throw illegal invocation', async () => {
    globalThis.localStorage.setItem('zterm:app-update-settings', JSON.stringify({
      manifestUrl: 'https://example.com/updates/latest.json',
      autoCheckOnLaunch: false,
      ignoreUntilManualCheck: false,
    }));

    const ownerSensitiveFetch = vi.fn(function (this: typeof globalThis, _input: RequestInfo | URL, _init?: RequestInit) {
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          versionName: '0.1.1.1569',
          versionCode: 1011569,
          buildNumber: 1569,
          apkUrl: 'zterm-0.1.1.1569.apk',
          sha256: 'abc123',
          notes: [],
        }),
      } as Response);
    });
    vi.stubGlobal('fetch', ownerSensitiveFetch as typeof fetch);

    const { useAppUpdate } = await import('./useAppUpdate');
    const { result } = renderHook(() => useAppUpdate());

    await waitFor(() => expect(result.current.runtimeVersionCode).toBe(1011491));

    let checkResultPromiseValue: AppUpdateCheckResult | undefined;
    await act(async () => {
      checkResultPromiseValue = await result.current.checkForUpdates({ manual: true });
    });

    if (!checkResultPromiseValue) {
      throw new Error('expected check result');
    }
    expect(ownerSensitiveFetch).toHaveBeenCalledTimes(1);
    expect(result.current.lastError).toBeNull();
    expect(checkResultPromiseValue.updateAvailable).toBe(true);
    expect(result.current.latestManifest?.versionCode).toBe(1011569);
  });

});
