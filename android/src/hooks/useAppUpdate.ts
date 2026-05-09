import { useCallback, useEffect, useRef, useState } from 'react';
import { APP_PACKAGE_NAME, APP_VERSION_CODE } from '../lib/app-version';
import {
  APP_UPDATE_STORAGE_KEY,
  DEFAULT_APP_UPDATE_PREFERENCES,
  normalizeAppUpdateManifest,
  normalizeAppUpdatePreferences,
  shouldSuppressUpdatePrompt,
  type AppUpdateCheckResult,
  type AppUpdateManifest,
  type AppUpdatePreferences,
} from '../lib/app-update';
import { AppUpdatePlugin, isNativeAppUpdateSupported } from '../plugins/AppUpdatePlugin';

export type AppUpdateStage =
  | 'idle'
  | 'checking-manifest'
  | 'awaiting-install-target'
  | 'validating-native-support'
  | 'checking-install-permission'
  | 'awaiting-install-permission'
  | 'downloading-and-installing'
  | 'completed'
  | 'failed';

export function useAppUpdate() {
  const [preferences, setPreferencesState] = useState<AppUpdatePreferences>(DEFAULT_APP_UPDATE_PREFERENCES);
  const [latestManifest, setLatestManifest] = useState<AppUpdateManifest | null>(null);
  const [availableManifest, setAvailableManifest] = useState<AppUpdateManifest | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [updateStage, setUpdateStage] = useState<AppUpdateStage>('idle');
  const runtimeVersionCode = APP_VERSION_CODE;
  const didAutoCheckRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const raw = localStorage.getItem(APP_UPDATE_STORAGE_KEY);
      if (!raw) {
        return;
      }
      setPreferencesState(normalizeAppUpdatePreferences(JSON.parse(raw)));
    } catch (error) {
      console.error('[useAppUpdate] Failed to restore preferences:', error);
    }
  }, []);

  const setPreferences = useCallback(
    (next: AppUpdatePreferences | ((current: AppUpdatePreferences) => AppUpdatePreferences)) => {
      setPreferencesState((current) => {
        const resolved = normalizeAppUpdatePreferences(typeof next === 'function' ? next(current) : next);
        if (typeof window !== 'undefined') {
          localStorage.setItem(APP_UPDATE_STORAGE_KEY, JSON.stringify(resolved));
        }
        return resolved;
      });
    },
    [],
  );

  const checkForUpdates = useCallback(async (options?: { manual?: boolean; manifestUrlOverride?: string }): Promise<AppUpdateCheckResult> => {
    const manifestUrl = (options?.manifestUrlOverride || preferences.manifestUrl).trim();
    if (!manifestUrl) {
      const message = '未配置升级 manifest URL';
      setLastError(message);
      setUpdateStage('failed');
      setAvailableManifest(null);
      return {
        manifest: null,
        updateAvailable: false,
        suppressedReason: 'none',
      };
    }

    setChecking(true);
    setLastError(null);
    setUpdateStage('checking-manifest');

    try {
      const response = await fetch(manifestUrl, {
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`升级清单请求失败：HTTP ${response.status}`);
      }

      const payload = normalizeAppUpdateManifest(await response.json());
      if (!payload) {
        throw new Error('升级清单格式无效');
      }
      const resolvedManifest: AppUpdateManifest = {
        ...payload,
        apkUrl: new URL(payload.apkUrl, manifestUrl).toString(),
      };

      setLatestManifest(resolvedManifest);
      const updateAvailable = resolvedManifest.versionCode > runtimeVersionCode;
      const suppressedReason = updateAvailable ? shouldSuppressUpdatePrompt(resolvedManifest, preferences, options) : 'none';

      setPreferences((current) => ({
        ...current,
        lastCheckedAt: Date.now(),
        lastSeenVersionCode: resolvedManifest.versionCode,
      }));

      if (updateAvailable && suppressedReason === 'none') {
        setAvailableManifest(resolvedManifest);
      } else if (!updateAvailable || options?.manual) {
        setAvailableManifest(null);
      }

      setUpdateStage('idle');
      return {
        manifest: resolvedManifest,
        updateAvailable,
        suppressedReason,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '检查更新失败';
      setLastError(message);
      setUpdateStage('failed');
      setAvailableManifest(null);
      return {
        manifest: null,
        updateAvailable: false,
        suppressedReason: 'none',
      };
    } finally {
      setChecking(false);
    }
  }, [preferences, runtimeVersionCode, setPreferences]);

  const dismissAvailableManifest = useCallback(() => {
    setAvailableManifest(null);
  }, []);

  const skipCurrentVersion = useCallback((manifest: AppUpdateManifest | null) => {
    if (!manifest) {
      return;
    }
    setPreferences((current) => ({
      ...current,
      skippedVersionCode: manifest.versionCode,
      ignoreUntilManualCheck: false,
    }));
    setAvailableManifest(null);
  }, [setPreferences]);

  const ignoreUntilManualCheck = useCallback(() => {
    setPreferences((current) => ({
      ...current,
      ignoreUntilManualCheck: true,
    }));
    setAvailableManifest(null);
  }, [setPreferences]);

  const resetIgnorePolicy = useCallback(() => {
    setPreferences((current) => ({
      ...current,
      skippedVersionCode: undefined,
      ignoreUntilManualCheck: false,
    }));
  }, [setPreferences]);

  const startUpdate = useCallback(async (manifest?: AppUpdateManifest | null) => {
    setUpdateStage('awaiting-install-target');
    const target = manifest || availableManifest || latestManifest;
    if (!target) {
      setLastError('没有可安装的升级包');
      setUpdateStage('failed');
      return false;
    }

    setUpdateStage('validating-native-support');
    if (!isNativeAppUpdateSupported()) {
      setLastError('当前环境不支持应用内安装');
      setUpdateStage('failed');
      return false;
    }

    setInstalling(true);
    setLastError(null);

    try {
      setUpdateStage('checking-install-permission');
      const permission = await AppUpdatePlugin.canRequestPackageInstalls();
      if (!permission.allowed) {
        setUpdateStage('awaiting-install-permission');
        await AppUpdatePlugin.openInstallPermissionSettings();
        throw new Error('需要先允许本应用安装未知来源应用');
      }

      setUpdateStage('downloading-and-installing');
      await AppUpdatePlugin.downloadAndInstall({
        url: target.apkUrl,
        sha256: target.sha256,
        expectedPackageName: APP_PACKAGE_NAME,
      });

      setPreferences((current) => ({
        ...current,
        skippedVersionCode: target.versionCode,
        ignoreUntilManualCheck: false,
      }));
      setAvailableManifest(null);
      setUpdateStage('completed');
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : '下载或安装升级包失败';
      setLastError(message);
      setUpdateStage('failed');
      return false;
    } finally {
      setInstalling(false);
    }
  }, [availableManifest, latestManifest, setPreferences]);

  useEffect(() => {
    if (didAutoCheckRef.current) {
      return;
    }
    if (!preferences.autoCheckOnLaunch || !preferences.manifestUrl.trim()) {
      return;
    }

    didAutoCheckRef.current = true;
    void checkForUpdates();
  }, [checkForUpdates, preferences.autoCheckOnLaunch, preferences.manifestUrl]);

  return {
    preferences,
    runtimeVersionCode,
    latestManifest,
    availableManifest,
    checking,
    installing,
    lastError,
    updateStage,
    setPreferences,
    checkForUpdates,
    dismissAvailableManifest,
    skipCurrentVersion,
    ignoreUntilManualCheck,
    resetIgnorePolicy,
    startUpdate,
  };
}
