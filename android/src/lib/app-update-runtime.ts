import type { BrowserStorageLike } from './browser-storage';
import {
  APP_UPDATE_STORAGE_KEY,
  DEFAULT_APP_UPDATE_PREFERENCES,
  normalizeAppUpdateManifest,
  normalizeAppUpdatePreferences,
  shouldSuppressUpdatePrompt,
  type AppUpdateCheckResult,
  type AppUpdateManifest,
  type AppUpdatePreferences,
} from './app-update';
import type { DownloadAndInstallOptions } from '../plugins/AppUpdatePlugin';

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

export interface AppUpdateRuntimeSnapshot {
  preferences: AppUpdatePreferences;
  latestManifest: AppUpdateManifest | null;
  availableManifest: AppUpdateManifest | null;
  checking: boolean;
  installing: boolean;
  lastError: string | null;
  updateStage: AppUpdateStage;
  runtimeVersionCode: number;
}

export interface AppUpdateRuntimeDeps {
  storage: BrowserStorageLike | null;
  fetchFn: typeof fetch;
  now: () => number;
  runtimeVersionCode: number;
  packageName: string;
  isNativeSupported: () => boolean;
  canRequestPackageInstalls: () => Promise<{ allowed: boolean }>;
  openInstallPermissionSettings: () => Promise<void>;
  downloadAndInstall: (options: DownloadAndInstallOptions) => Promise<unknown>;
  onError?: (phase: 'restore-preferences' | 'persist-preferences', error: unknown) => void;
}

function createDefaultSnapshot(runtimeVersionCode: number): AppUpdateRuntimeSnapshot {
  return {
    preferences: DEFAULT_APP_UPDATE_PREFERENCES,
    latestManifest: null,
    availableManifest: null,
    checking: false,
    installing: false,
    lastError: null,
    updateStage: 'idle',
    runtimeVersionCode,
  };
}

function persistPreferences(
  storage: BrowserStorageLike | null,
  preferences: AppUpdatePreferences,
  onError?: (phase: 'restore-preferences' | 'persist-preferences', error: unknown) => void,
) {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(APP_UPDATE_STORAGE_KEY, JSON.stringify(preferences));
  } catch (error) {
    onError?.('persist-preferences', error);
  }
}

export function createAppUpdateRuntime(deps: AppUpdateRuntimeDeps) {
  let snapshot = createDefaultSnapshot(deps.runtimeVersionCode);

  const setSnapshot = (
    next:
      | AppUpdateRuntimeSnapshot
      | ((current: AppUpdateRuntimeSnapshot) => AppUpdateRuntimeSnapshot),
  ) => {
    snapshot = typeof next === 'function' ? next(snapshot) : next;
    return snapshot;
  };

  const setPreferences = (
    next: AppUpdatePreferences | ((current: AppUpdatePreferences) => AppUpdatePreferences),
  ) => {
    const resolved = normalizeAppUpdatePreferences(
      typeof next === 'function' ? next(snapshot.preferences) : next,
    );
    setSnapshot((current) => ({
      ...current,
      preferences: resolved,
    }));
    persistPreferences(deps.storage, resolved, deps.onError);
    return snapshot;
  };

  return {
    getSnapshot() {
      return snapshot;
    },

    restorePreferences() {
      if (!deps.storage) {
        return snapshot;
      }
      try {
        const raw = deps.storage.getItem(APP_UPDATE_STORAGE_KEY);
        if (!raw) {
          return snapshot;
        }
        return setSnapshot((current) => ({
          ...current,
          preferences: normalizeAppUpdatePreferences(JSON.parse(raw)),
        }));
      } catch (error) {
        deps.onError?.('restore-preferences', error);
        return snapshot;
      }
    },

    setPreferences,

    async checkForUpdates(options?: { manual?: boolean; manifestUrlOverride?: string }): Promise<AppUpdateCheckResult> {
      const manifestUrl = (options?.manifestUrlOverride || snapshot.preferences.manifestUrl).trim();
      if (!manifestUrl) {
        setSnapshot((current) => ({
          ...current,
          lastError: '未配置升级 manifest URL',
          updateStage: 'failed',
          availableManifest: null,
        }));
        return { manifest: null, updateAvailable: false, suppressedReason: 'none' };
      }

      setSnapshot((current) => ({
        ...current,
        checking: true,
        lastError: null,
        updateStage: 'checking-manifest',
      }));

      try {
        const response = await deps.fetchFn(manifestUrl, {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
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
        const updateAvailable = resolvedManifest.versionCode > snapshot.runtimeVersionCode;
        const suppressedReason = updateAvailable
          ? shouldSuppressUpdatePrompt(resolvedManifest, snapshot.preferences, options)
          : 'none';

        const nextPreferences = normalizeAppUpdatePreferences({
          ...snapshot.preferences,
          lastCheckedAt: deps.now(),
          lastSeenVersionCode: resolvedManifest.versionCode,
        });

        persistPreferences(deps.storage, nextPreferences, deps.onError);

        setSnapshot((current) => ({
          ...current,
          preferences: nextPreferences,
          latestManifest: resolvedManifest,
          availableManifest:
            updateAvailable && suppressedReason === 'none'
              ? resolvedManifest
              : (!updateAvailable || options?.manual ? null : current.availableManifest),
          checking: false,
          updateStage: 'idle',
        }));

        return {
          manifest: resolvedManifest,
          updateAvailable,
          suppressedReason,
        };
      } catch (error) {
        setSnapshot((current) => ({
          ...current,
          checking: false,
          lastError: error instanceof Error ? error.message : '检查更新失败',
          updateStage: 'failed',
          availableManifest: null,
        }));
        return { manifest: null, updateAvailable: false, suppressedReason: 'none' };
      }
    },

    dismissAvailableManifest() {
      return setSnapshot((current) => ({
        ...current,
        availableManifest: null,
      }));
    },

    skipCurrentVersion(manifest: AppUpdateManifest | null) {
      if (!manifest) {
        return snapshot;
      }
      const nextPreferences = normalizeAppUpdatePreferences({
        ...snapshot.preferences,
        skippedVersionCode: manifest.versionCode,
        ignoreUntilManualCheck: false,
      });
      persistPreferences(deps.storage, nextPreferences, deps.onError);
      return setSnapshot((current) => ({
        ...current,
        preferences: nextPreferences,
        availableManifest: null,
      }));
    },

    ignoreUntilManualCheck() {
      const nextPreferences = normalizeAppUpdatePreferences({
        ...snapshot.preferences,
        ignoreUntilManualCheck: true,
      });
      persistPreferences(deps.storage, nextPreferences, deps.onError);
      return setSnapshot((current) => ({
        ...current,
        preferences: nextPreferences,
        availableManifest: null,
      }));
    },

    resetIgnorePolicy() {
      const nextPreferences = normalizeAppUpdatePreferences({
        ...snapshot.preferences,
        skippedVersionCode: undefined,
        ignoreUntilManualCheck: false,
      });
      persistPreferences(deps.storage, nextPreferences, deps.onError);
      return setSnapshot((current) => ({
        ...current,
        preferences: nextPreferences,
      }));
    },

    async startUpdate(manifest?: AppUpdateManifest | null) {
      setSnapshot((current) => ({
        ...current,
        updateStage: 'awaiting-install-target',
      }));

      const target = manifest || snapshot.availableManifest || snapshot.latestManifest;
      if (!target) {
        setSnapshot((current) => ({
          ...current,
          lastError: '没有可安装的升级包',
          updateStage: 'failed',
        }));
        return false;
      }

      setSnapshot((current) => ({
        ...current,
        updateStage: 'validating-native-support',
      }));
      if (!deps.isNativeSupported()) {
        setSnapshot((current) => ({
          ...current,
          lastError: '当前环境不支持应用内安装',
          updateStage: 'failed',
        }));
        return false;
      }

      setSnapshot((current) => ({
        ...current,
        installing: true,
        lastError: null,
      }));

      try {
        setSnapshot((current) => ({
          ...current,
          updateStage: 'checking-install-permission',
        }));
        const permission = await deps.canRequestPackageInstalls();
        if (!permission.allowed) {
          setSnapshot((current) => ({
            ...current,
            updateStage: 'awaiting-install-permission',
          }));
          await deps.openInstallPermissionSettings();
          throw new Error('需要先允许本应用安装未知来源应用');
        }

        setSnapshot((current) => ({
          ...current,
          updateStage: 'downloading-and-installing',
        }));
        await deps.downloadAndInstall({
          url: target.apkUrl,
          sha256: target.sha256,
          expectedPackageName: deps.packageName,
        });

        const nextPreferences = normalizeAppUpdatePreferences({
          ...snapshot.preferences,
          skippedVersionCode: target.versionCode,
          ignoreUntilManualCheck: false,
        });
        persistPreferences(deps.storage, nextPreferences, deps.onError);

        setSnapshot((current) => ({
          ...current,
          preferences: nextPreferences,
          availableManifest: null,
          installing: false,
          updateStage: 'completed',
        }));
        return true;
      } catch (error) {
        setSnapshot((current) => ({
          ...current,
          installing: false,
          lastError: error instanceof Error ? error.message : '下载或安装升级包失败',
          updateStage: 'failed',
        }));
        return false;
      }
    },
  };
}
