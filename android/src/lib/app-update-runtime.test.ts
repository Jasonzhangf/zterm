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
  const downloadRollbackApk = vi.fn();
  const getRollbackApkBaseInfo = vi.fn();

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
      downloadRollbackApk,
      getRollbackApkBaseInfo,
    });
  }

  function withManifestUrl(runtime: ReturnType<typeof createAppUpdateRuntime>) {
    runtime.restorePreferences();
    runtime.setPreferences((current) => ({
      ...current,
      manifestUrl: 'https://example.com/updates/latest.json',
    }));
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

  it('returns a persistence failure without projecting unsaved preferences', () => {
    const storage = createStorage();
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('update storage failed');
    });
    const runtime = createRuntime(storage);
    const before = runtime.getSnapshot().preferences;

    const result = runtime.setPreferences((current) => ({
      ...current,
      manifestUrl: 'https://updates.example.test/latest.json',
    }));

    expect(result).toMatchObject({ ok: false });
    expect(runtime.getSnapshot().preferences).toEqual(before);
    expect(runtime.getSnapshot().preferences.manifestUrl).toBe('');
  });

  it('treats missing update storage as an explicit persistence failure', () => {
    const runtime = createRuntime(null);
    const result = runtime.setPreferences((current) => ({
      ...current,
      manifestUrl: 'https://updates.example.test/latest.json',
    }));

    expect(result).toMatchObject({ ok: false, persistedKeys: [] });
    expect(runtime.getSnapshot().preferences.manifestUrl).toBe('');
  });

  it('applies relay-derived manifest through the app-update runtime owner', () => {
    const storage = createStorage({
      'zterm:app-update-settings': JSON.stringify({
        manifestUrl: 'http://100.66.1.82:3333/updates/latest.json',
        manifestSource: 'server-connected',
        autoCheckOnLaunch: false,
      }),
    });
    const runtime = createRuntime(storage);
    runtime.restorePreferences();

    runtime.applyRelayManifestSource('wss://relay.codewhisper.cc:18443/relay/ws/host?token=abc');

    expect(runtime.getSnapshot().preferences).toMatchObject({
      manifestUrl: 'https://relay.codewhisper.cc:18443/relay/updates/latest.json',
      manifestSource: 'relay-injected',
      autoCheckOnLaunch: false,
    });
    expect(JSON.parse(storage.getItem('zterm:app-update-settings') || '{}')).toMatchObject({
      manifestUrl: 'https://relay.codewhisper.cc:18443/relay/updates/latest.json',
      manifestSource: 'relay-injected',
    });
  });

  it('keeps explicit user-saved update manifest when relay settings change', () => {
    const runtime = createRuntime(createStorage({
      'zterm:app-update-settings': JSON.stringify({
        manifestUrl: 'https://updates.example.com/latest.json',
        manifestSource: 'user-saved',
        autoCheckOnLaunch: false,
      }),
    }));
    runtime.restorePreferences();

    runtime.applyRelayManifestSource('wss://relay.codewhisper.cc:18443/relay/ws/host');

    expect(runtime.getSnapshot().preferences).toMatchObject({
      manifestUrl: 'https://updates.example.com/latest.json',
      manifestSource: 'user-saved',
    });
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

  it('uses the confirmed Relay route instead of a persisted LAN manifest', async () => {
    const runtime = createRuntime(createStorage({
      'zterm:app-update-settings': JSON.stringify({
        manifestUrl: 'http://192.168.0.3:3333/updates/latest.json',
        manifestSource: 'server-connected',
        autoCheckOnLaunch: false,
      }),
    }));
    runtime.restorePreferences();

    fetchFn.mockResolvedValue({
      ok: true,
      json: async () => ({
        versionName: '0.1.1.1493',
        versionCode: 1011493,
        apkUrl: 'zterm-0.1.1.1493.apk',
        sha256: 'relay-sha',
        notes: [],
      }),
    });

    await runtime.checkForUpdates({
      activeSessionRoute: {
        resolvedPath: 'rtc-relay',
        resolvedRelayTransport: 'turn',
        resolvedEndpoint: 'relay:daemon-a',
      },
      manifestCandidates: [
        {
          id: 'relay-public',
          label: 'Relay 公网',
          manifestUrl: 'https://relay.codewhisper.cc:18443/relay/updates/latest.json',
          manifestSource: 'relay-injected',
        },
        {
          id: 'daemon-lan',
          label: 'LAN',
          manifestUrl: 'http://192.168.0.3:3333/updates/latest.json',
          manifestSource: 'server-connected',
        },
      ],
    });

    expect(fetchFn).toHaveBeenCalledWith(
      'https://relay.codewhisper.cc:18443/relay/updates/latest.json',
      expect.any(Object),
    );
  });

  it('honors an explicit manual candidate selection over the active route', async () => {
    const runtime = createRuntime(createStorage({
      'zterm:app-update-settings': JSON.stringify({
        manifestUrl: 'http://192.168.0.3:3333/updates/latest.json',
        manifestSource: 'server-connected',
        autoCheckOnLaunch: false,
      }),
    }));
    runtime.restorePreferences();

    fetchFn.mockResolvedValue({
      ok: true,
      json: async () => ({
        versionName: '0.1.1.1493',
        versionCode: 1011493,
        apkUrl: 'zterm-0.1.1.1493.apk',
        sha256: 'lan-sha',
        notes: [],
      }),
    });

    await runtime.checkForUpdates({
      manual: true,
      manifestUrlOverride: 'http://192.168.0.3:3333/updates/latest.json',
      activeSessionRoute: {
        resolvedPath: 'rtc-relay',
        resolvedRelayTransport: 'turn',
        resolvedEndpoint: 'relay:daemon-a',
      },
      manifestCandidates: [
        {
          id: 'relay-public',
          label: 'Relay 公网',
          manifestUrl: 'https://relay.codewhisper.cc:18443/relay/updates/latest.json',
          manifestSource: 'relay-injected',
        },
        {
          id: 'daemon-lan',
          label: 'LAN',
          manifestUrl: 'http://192.168.0.3:3333/updates/latest.json',
          manifestSource: 'server-connected',
        },
      ],
    });

    expect(fetchFn).toHaveBeenCalledWith(
      'http://192.168.0.3:3333/updates/latest.json',
      expect.any(Object),
    );
  });

  it('does not auto-select LAN for a remote confirmed route', async () => {
    const runtime = createRuntime(createStorage({
      'zterm:app-update-settings': JSON.stringify({
        manifestUrl: 'http://192.168.0.3:3333/updates/latest.json',
        manifestSource: 'server-connected',
        autoCheckOnLaunch: false,
      }),
    }));
    runtime.restorePreferences();

    await runtime.checkForUpdates({
      activeSessionRoute: {
        resolvedPath: 'tailscale',
        resolvedEndpoint: '100.66.1.82:3333',
      },
      manifestCandidates: [
        {
          id: 'daemon-lan',
          label: 'LAN',
          manifestUrl: 'http://192.168.0.3:3333/updates/latest.json',
          manifestSource: 'server-connected',
        },
        {
          id: 'daemon-tailscale',
          label: 'Tailscale',
          manifestUrl: 'http://100.66.1.82:3333/updates/latest.json',
          manifestSource: 'server-connected',
        },
      ],
    });

    expect(fetchFn).not.toHaveBeenCalledWith(
      'http://192.168.0.3:3333/updates/latest.json',
      expect.any(Object),
    );
  });

  it('replaces a persisted LAN manifest with the available Tailscale route when no route snapshot exists', async () => {
    const runtime = createRuntime(createStorage({
      'zterm:app-update-settings': JSON.stringify({
        manifestUrl: 'http://192.168.0.3:3333/updates/latest.json',
        manifestSource: 'server-connected',
        autoCheckOnLaunch: false,
      }),
    }));
    runtime.restorePreferences();
    fetchFn.mockResolvedValue({
      ok: true,
      json: async () => ({
        versionName: '0.1.1.1493',
        versionCode: 1011493,
        apkUrl: 'zterm-0.1.1.1493.apk',
        sha256: 'tailscale-sha',
        notes: [],
      }),
    });

    await runtime.checkForUpdates({
      manifestCandidates: [
        {
          id: 'daemon-tailscale',
          label: 'Tailscale',
          manifestUrl: 'http://100.66.1.82:3333/updates/latest.json',
          manifestSource: 'server-connected',
        },
        {
          id: 'daemon-lan',
          label: 'LAN',
          manifestUrl: 'http://192.168.0.3:3333/updates/latest.json',
          manifestSource: 'server-connected',
        },
      ],
    });

    expect(fetchFn).toHaveBeenCalledWith(
      'http://192.168.0.3:3333/updates/latest.json',
      expect.any(Object),
    );
  });

  it('selects the LAN manifest for a confirmed same-network ipv4 route', async () => {
    const runtime = createRuntime(createStorage({
      'zterm:app-update-settings': JSON.stringify({
        manifestUrl: 'https://relay.codewhisper.cc:18443/relay/updates/latest.json',
        manifestSource: 'relay-injected',
        autoCheckOnLaunch: false,
      }),
    }));
    runtime.restorePreferences();

    fetchFn.mockResolvedValue({
      ok: true,
      json: async () => ({
        versionName: '0.1.1.1493',
        versionCode: 1011493,
        apkUrl: 'zterm-0.1.1.1493.apk',
        sha256: 'lan-sha',
        notes: [],
      }),
    });

    await runtime.checkForUpdates({
      activeSessionRoute: {
        resolvedPath: 'ipv4',
        resolvedEndpoint: '192.168.0.3:3333',
      },
      manifestCandidates: [
        {
          id: 'relay-public',
          label: 'Relay 公网',
          manifestUrl: 'https://relay.codewhisper.cc:18443/relay/updates/latest.json',
          manifestSource: 'relay-injected',
        },
        {
          id: 'daemon-lan',
          label: 'LAN',
          manifestUrl: 'http://192.168.0.3:3333/updates/latest.json',
          manifestSource: 'server-connected',
        },
      ],
    });

    expect(fetchFn).toHaveBeenCalledWith(
      'http://192.168.0.3:3333/updates/latest.json',
      expect.any(Object),
    );
  });

  it('fails explicitly when a confirmed route has no matching manifest candidate', async () => {
    const runtime = createRuntime(createStorage({
      'zterm:app-update-settings': JSON.stringify({
        manifestUrl: 'http://192.168.0.3:3333/updates/latest.json',
        manifestSource: 'server-connected',
        autoCheckOnLaunch: false,
      }),
    }));
    runtime.restorePreferences();

    const result = await runtime.checkForUpdates({
      activeSessionRoute: {
        resolvedPath: 'rtc-relay',
        resolvedRelayTransport: 'turn',
        resolvedEndpoint: 'relay:daemon-a',
      },
      manifestCandidates: [],
    });

    expect(result.manifest).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().lastError).toBe('未配置升级 manifest URL');
  });

  it('tracks explicit install stage transitions and completes inside the runtime block', async () => {
    const runtime = createRuntime();
    withManifestUrl(runtime);

    canRequestPackageInstalls.mockResolvedValue({ allowed: true });
    backupCurrentApk.mockResolvedValue({ versionCode: 1011491, versionName: '0.1.1.1491', filePath: '/tmp/rollback.apk', sha256: 'rollbacksha', backedUpAt: 123456789 });
    downloadAndInstall.mockResolvedValue({
      filePath: '/tmp/zterm.apk',
      sha256: 'abc123',
      packageName: 'com.zterm.android',
    });
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

  it('records last install context when cached manifest revalidation fails before install', async () => {
    const runtime = createRuntime();
    withManifestUrl(runtime);

    fetchFn.mockResolvedValueOnce({
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
    await runtime.checkForUpdates();

    fetchFn.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({}),
    });

    const installed = await runtime.startUpdate();

    expect(installed).toBe(false);
    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().lastInstallContext).toEqual(expect.objectContaining({
      manifestUrl: 'https://example.com/updates/latest.json',
      apkUrl: 'https://example.com/updates/zterm-0.1.1.1493.apk',
      versionCode: 1011493,
      sha256Expected: 'abc123',
    }));
    expect(runtime.getSnapshot().lastError).toContain('HTTP 404');
  });

  it('backs up current apk before download/install and stores rollback backup', async () => {
    const runtime = createRuntime();
    withManifestUrl(runtime);

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
    withManifestUrl(runtime);

    backupCurrentApk.mockRejectedValue(new Error('backup failed'));
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

  it('installs the explicit manifest target without revalidating a potentially changed manifest', async () => {
    const runtime = createRuntime();
    withManifestUrl(runtime);

    fetchFn.mockResolvedValue({
      ok: true,
      json: async () => ({
        versionName: '0.1.1.1494',
        versionCode: 1011494,
        buildNumber: 1494,
        apkUrl: 'zterm-0.1.1.1494.apk',
        sha256: 'newsha',
        notes: [],
      }),
    });
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
      apkUrl: 'https://stale.example.com/zterm-0.1.1.1493.apk',
      sha256: 'abc123',
      notes: [],
    });

    expect(installed).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(downloadAndInstall).toHaveBeenCalledWith({
      url: 'https://stale.example.com/zterm-0.1.1.1493.apk',
      sha256: 'abc123',
      expectedPackageName: 'com.zterm.android',
      expectedVersionCode: 1011493,
      expectedVersionName: '0.1.1.1493',
    });
  });

  it('revalidates the cached manifest when install is requested without an explicit target', async () => {
    const runtime = createRuntime();
    withManifestUrl(runtime);

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
    fetchFn.mockResolvedValueOnce({
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

    await runtime.checkForUpdates();

    fetchFn.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        versionName: '0.1.1.1494',
        versionCode: 1011494,
        buildNumber: 1494,
        apkUrl: 'zterm-0.1.1.1494.apk',
        sha256: 'newsha',
        notes: [],
      }),
    });

    const installed = await runtime.startUpdate();

    expect(installed).toBe(false);
    expect(backupCurrentApk).not.toHaveBeenCalled();
    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().lastError).toBe('升级清单已变更，请重新检查更新');
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

    const rolledBack = await runtime.rollbackToLocalBackup();

    expect(rolledBack).toBe(true);
    expect(rollbackToBackup).toHaveBeenCalledWith({
      filePath: '/tmp/rollback.apk',
      sha256: 'rollbacksha',
    });
    expect(runtime.getSnapshot().rollbackBackup).toBeNull();
  });

});
