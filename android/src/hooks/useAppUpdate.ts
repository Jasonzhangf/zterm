import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { APP_PACKAGE_NAME, APP_VERSION_CODE } from '../lib/app-version';
import { getBrowserStorage } from '../lib/browser-storage';
import {
  type AppUpdateCheckResult,
  type AppUpdateManifest,
  type AppUpdatePreferences,
} from '../lib/app-update';
import {
  createAppUpdateRuntime,
  type AppUpdateRuntimeSnapshot,
  type AppUpdateStage,
} from '../lib/app-update-runtime';
import { deriveAppUpdateProjection } from '@zterm/shared';
import { AppUpdatePlugin, isNativeAppUpdateSupported } from '../plugins/AppUpdatePlugin';

function useAppUpdateSnapshot(
  runtimeRef: MutableRefObject<ReturnType<typeof createAppUpdateRuntime>>,
) {
  const [snapshot, setSnapshot] = useState<AppUpdateRuntimeSnapshot>(() => runtimeRef.current.getSnapshot());

  const syncSnapshot = useCallback(() => {
    setSnapshot(runtimeRef.current.getSnapshot());
  }, [runtimeRef]);

  return { snapshot, syncSnapshot };
}

export { type AppUpdateStage };

export function useAppUpdate() {
  const runtimeRef = useRef(createAppUpdateRuntime({
    storage: getBrowserStorage(),
    fetchFn: (...args) => globalThis.fetch(...args),
    now: () => Date.now(),
    runtimeVersionCode: APP_VERSION_CODE,
    packageName: APP_PACKAGE_NAME,
    isNativeSupported: isNativeAppUpdateSupported,
    canRequestPackageInstalls: () => AppUpdatePlugin.canRequestPackageInstalls(),
    openInstallPermissionSettings: () => AppUpdatePlugin.openInstallPermissionSettings(),
    downloadAndInstall: (options) => AppUpdatePlugin.downloadAndInstall(options),
    onError: (phase, error) => {
      const prefix = phase === 'restore-preferences'
        ? '[useAppUpdate] Failed to restore preferences:'
        : '[useAppUpdate] Failed to persist preferences:';
      console.error(prefix, error);
    },
  }));
  const { snapshot, syncSnapshot } = useAppUpdateSnapshot(runtimeRef);
  const didAutoCheckRef = useRef(false);

  useEffect(() => {
    runtimeRef.current.restorePreferences();
    syncSnapshot();
  }, [syncSnapshot]);

  const setPreferences = useCallback(
    (next: AppUpdatePreferences | ((current: AppUpdatePreferences) => AppUpdatePreferences)) => {
      runtimeRef.current.setPreferences(next);
      syncSnapshot();
    },
    [syncSnapshot],
  );

  const checkForUpdates = useCallback(async (options?: { manual?: boolean; manifestUrlOverride?: string }): Promise<AppUpdateCheckResult> => {
    const result = await runtimeRef.current.checkForUpdates(options);
    syncSnapshot();
    return result;
  }, [syncSnapshot]);

  const dismissAvailableManifest = useCallback(() => {
    runtimeRef.current.dismissAvailableManifest();
    syncSnapshot();
  }, [syncSnapshot]);

  const skipCurrentVersion = useCallback((manifest: AppUpdateManifest | null) => {
    runtimeRef.current.skipCurrentVersion(manifest);
    syncSnapshot();
  }, [syncSnapshot]);

  const ignoreUntilManualCheck = useCallback(() => {
    runtimeRef.current.ignoreUntilManualCheck();
    syncSnapshot();
  }, [syncSnapshot]);

  const resetIgnorePolicy = useCallback(() => {
    runtimeRef.current.resetIgnorePolicy();
    syncSnapshot();
  }, [syncSnapshot]);

  const startUpdate = useCallback(async (manifest?: AppUpdateManifest | null) => {
    const result = await runtimeRef.current.startUpdate(manifest);
    syncSnapshot();
    return result;
  }, [syncSnapshot]);

  const projection = deriveAppUpdateProjection({
    preferences: snapshot.preferences,
    latestManifest: snapshot.latestManifest,
    availableManifest: snapshot.availableManifest,
    checking: snapshot.checking,
    installing: snapshot.installing,
    lastError: snapshot.lastError,
    updateStage: snapshot.updateStage,
    runtimeVersionCode: snapshot.runtimeVersionCode,
  });

  useEffect(() => {
    if (didAutoCheckRef.current) {
      return;
    }
    if (!snapshot.preferences.autoCheckOnLaunch || !snapshot.preferences.manifestUrl.trim()) {
      return;
    }

    didAutoCheckRef.current = true;
    void checkForUpdates();
  }, [checkForUpdates, snapshot.preferences.autoCheckOnLaunch, snapshot.preferences.manifestUrl]);

  return useMemo(() => ({
    preferences: projection.preferences,
    runtimeVersionCode: projection.runtimeVersionCode,
    latestManifest: projection.latestManifest,
    availableManifest: projection.availableManifest,
    checking: projection.checking,
    installing: projection.installing,
    lastError: projection.lastError,
    updateStage: projection.updateStage,
    hasNewVersion: projection.hasNewVersion,
    hasUpdateIgnorePolicy: projection.hasUpdateIgnorePolicy,
    updateManifestUrlConfigured: projection.updateManifestUrlConfigured,
    setPreferences,
    checkForUpdates,
    dismissAvailableManifest,
    skipCurrentVersion,
    ignoreUntilManualCheck,
    resetIgnorePolicy,
    startUpdate,
  }), [
    projection.preferences,
    projection.runtimeVersionCode,
    projection.latestManifest,
    projection.availableManifest,
    projection.checking,
    projection.installing,
    projection.lastError,
    projection.updateStage,
    projection.hasNewVersion,
    projection.hasUpdateIgnorePolicy,
    projection.updateManifestUrlConfigured,
    setPreferences,
    checkForUpdates,
    dismissAvailableManifest,
    skipCurrentVersion,
    ignoreUntilManualCheck,
    resetIgnorePolicy,
    startUpdate,
  ]);
}
