// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppUpdateCheckResult } from '../lib/app-update';

const getInfoMock = vi.fn();

vi.mock('@capacitor/app', () => ({
  App: {
    getInfo: getInfoMock,
  },
}));

vi.mock('../plugins/AppUpdatePlugin', () => ({
  AppUpdatePlugin: {
    canRequestPackageInstalls: vi.fn(),
    openInstallPermissionSettings: vi.fn(),
    downloadAndInstall: vi.fn(),
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
    getInfoMock.mockResolvedValue({
      name: 'ZTerm',
      id: 'com.zterm.android',
      build: '1011492',
      version: '0.1.1.1492',
    });
  });

  it('uses runtime installed version code as the only update comparison truth', async () => {
    globalThis.localStorage.setItem('zterm:app-update-settings', JSON.stringify({
      manifestUrl: 'https://example.com/updates/latest.json',
      autoCheckOnLaunch: false,
      ignoreUntilManualCheck: false,
    }));

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        versionName: '0.1.1.1492',
        versionCode: 1011492,
        buildNumber: 1492,
        apkUrl: 'zterm-0.1.1.1492.apk',
        sha256: 'abc123',
        notes: [],
      }),
    }) as typeof fetch);

    const { useAppUpdate } = await import('./useAppUpdate');
    const { result } = renderHook(() => useAppUpdate());

    await waitFor(() => {
      expect(result.current.runtimeVersionCode).toBe(1011492);
    });

    let checkResultPromiseValue: AppUpdateCheckResult | undefined;
    await act(async () => {
      checkResultPromiseValue = await result.current.checkForUpdates({ manual: true });
    });

    if (!checkResultPromiseValue) {
      throw new Error('expected check result');
    }
    expect(checkResultPromiseValue.updateAvailable).toBe(false);
    expect(result.current.availableManifest).toBeNull();
    expect(result.current.latestManifest?.versionCode).toBe(1011492);
  });
});
