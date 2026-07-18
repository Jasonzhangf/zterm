import type { BrowserStorageLike } from './browser-storage';
import {
  APP_UPDATE_STORAGE_KEY,
  DEFAULT_APP_UPDATE_PREFERENCES,
  DEFAULT_APP_UPDATE_INSTALL_CONTEXT,
  normalizeAppUpdateManifest,
  normalizeAppUpdatePreferences,
  shouldSuppressUpdatePrompt,
  type AppUpdateCheckResult,
  type AppUpdateInstallContext,
  type AppUpdateManifest,
  type AppUpdatePreferences,
  type AppUpdateRollbackBackup,
} from './app-update';
import { buildRelayInjectedAppUpdatePreferences } from './app-update-relay-manifest';
import type { DownloadAndInstallOptions } from '../plugins/AppUpdatePlugin';

export type AppUpdateStage =
  | 'idle'
  | 'checking-manifest'
  | 'awaiting-install-target'
  | 'refreshing-manifest'
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
  rollbackBackup: AppUpdateRollbackBackup | null;
  isBackingUp: boolean;
  isRollingBack: boolean;
  lastInstallContext: AppUpdateInstallContext | null;
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
  backupCurrentApk: () => Promise<AppUpdateRollbackBackup>;
  rollbackToBackup: (options: { filePath: string; sha256?: string }) => Promise<void>;
  getRollbackBackupInfo: () => Promise<AppUpdateRollbackBackup | null>;
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
    rollbackBackup: null,
    isBackingUp: false,
    isRollingBack: false,
    lastInstallContext: null,
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
      rollbackBackup: resolved.rollbackBackup || null,
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
          rollbackBackup: normalizeAppUpdatePreferences(JSON.parse(raw)).rollbackBackup || null,
        }));
      } catch (error) {
        deps.onError?.('restore-preferences', error);
        return snapshot;
      }
    },

    setPreferences,

    applyRelayManifestSource(wsHostUrl: string) {
      const nextPreferences = buildRelayInjectedAppUpdatePreferences(snapshot.preferences, wsHostUrl);
      if (
        nextPreferences.manifestUrl === snapshot.preferences.manifestUrl
        && nextPreferences.manifestSource === snapshot.preferences.manifestSource
      ) {
        return snapshot;
      }
      setSnapshot((current) => ({
        ...current,
        preferences: nextPreferences,
      }));
      persistPreferences(deps.storage, nextPreferences, deps.onError);
      return snapshot;
    },

    async checkForUpdates(options?: { manual?: boolean; manifestUrlOverride?: string }): Promise<AppUpdateCheckResult> {
      const manifestUrl = (options?.manifestUrlOverride || snapshot.preferences.manifestUrl).trim();
      if (!manifestUrl) {
        setSnapshot((current) => ({
          ...current,
          lastError: '未配置升级 manifest URL',
          updateStage: 'failed',
          lastInstallContext: DEFAULT_APP_UPDATE_INSTALL_CONTEXT,
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
          lastInstallContext: DEFAULT_APP_UPDATE_INSTALL_CONTEXT,
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

    async rollbackToPreviousVersion() {
      const backup = snapshot.rollbackBackup;
      if (!backup) {
        setSnapshot((current) => ({
          ...current,
          lastError: '没有可回退的旧版本备份',
          updateStage: 'failed',
          lastInstallContext: DEFAULT_APP_UPDATE_INSTALL_CONTEXT,
        }));
        return false;
      }

      setSnapshot((current) => ({
        ...current,
        isRollingBack: true,
        lastError: null,
      }));

      try {
        await deps.rollbackToBackup({
          filePath: backup.filePath,
          sha256: backup.sha256,
        });

        const nextPreferences = normalizeAppUpdatePreferences({
          ...snapshot.preferences,
          rollbackBackup: null,
        });
        persistPreferences(deps.storage, nextPreferences, deps.onError);

        setSnapshot((current) => ({
          ...current,
          preferences: nextPreferences,
          rollbackBackup: null,
          isRollingBack: false,
          updateStage: 'completed',
        }));
        return true;
      } catch (error) {
        setSnapshot((current) => ({
          ...current,
          isRollingBack: false,
          lastError: error instanceof Error ? error.message : '回滚失败',
          updateStage: 'failed',
          lastInstallContext: {
            manifestUrl: snapshot.preferences.manifestUrl,
            apkUrl: backup.filePath,
            capturedAt: deps.now(),
            reason: error instanceof Error ? error.message : '回滚失败',
          },
        }));
        return false;
      }
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
          lastInstallContext: DEFAULT_APP_UPDATE_INSTALL_CONTEXT,
        }));
        return false;
      }

      let installTarget: AppUpdateManifest;
      if (manifest) {
        installTarget = {
          ...manifest,
          apkUrl: new URL(manifest.apkUrl, snapshot.preferences.manifestUrl || manifest.apkUrl).toString(),
        };
        setSnapshot((current) => ({
          ...current,
          latestManifest: installTarget,
          availableManifest: installTarget,
          lastInstallContext: {
            manifestUrl: snapshot.preferences.manifestUrl,
            apkUrl: installTarget.apkUrl,
            versionCode: installTarget.versionCode,
            versionName: installTarget.versionName,
            sha256Expected: installTarget.sha256,
            capturedAt: deps.now(),
          },
        }));
      } else {
        if (!snapshot.preferences.manifestUrl.trim()) {
          setSnapshot((current) => ({
            ...current,
            lastError: '未配置升级 manifest URL',
            updateStage: 'failed',
            lastInstallContext: DEFAULT_APP_UPDATE_INSTALL_CONTEXT,
          }));
          return false;
        }

        setSnapshot((current) => ({
          ...current,
          updateStage: 'refreshing-manifest',
        }));

        try {
          const response = await deps.fetchFn(snapshot.preferences.manifestUrl, {
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

          installTarget = {
            ...payload,
            apkUrl: new URL(payload.apkUrl, snapshot.preferences.manifestUrl).toString(),
          };
          if (
            installTarget.versionCode !== target.versionCode
            || installTarget.sha256 !== target.sha256.toLowerCase()
          ) {
            throw new Error('升级清单已变更，请重新检查更新');
          }

          setSnapshot((current) => ({
            ...current,
            latestManifest: installTarget,
            availableManifest: installTarget,
            lastInstallContext: {
              manifestUrl: snapshot.preferences.manifestUrl,
              apkUrl: installTarget.apkUrl,
              versionCode: installTarget.versionCode,
              versionName: installTarget.versionName,
              sha256Expected: installTarget.sha256,
              capturedAt: deps.now(),
            },
          }));
        } catch (error) {
          setSnapshot((current) => ({
            ...current,
            lastError: error instanceof Error ? error.message : '升级清单复核失败',
            updateStage: 'failed',
            lastInstallContext: {
              manifestUrl: snapshot.preferences.manifestUrl,
              apkUrl: target.apkUrl,
              versionCode: target.versionCode,
              versionName: target.versionName,
              sha256Expected: target.sha256,
              capturedAt: deps.now(),
              reason: error instanceof Error ? error.message : '升级清单复核失败',
            },
          }));
          return false;
        }
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
          lastInstallContext: {
            manifestUrl: snapshot.preferences.manifestUrl,
            apkUrl: target.apkUrl,
            versionCode: target.versionCode,
            versionName: target.versionName,
            sha256Expected: target.sha256,
            capturedAt: deps.now(),
            reason: '当前环境不支持应用内安装',
          },
        }));
        return false;
      }

      setSnapshot((current) => ({
        ...current,
        installing: true,
        isBackingUp: true,
        lastError: null,
      }));

      try {
        const rollbackBackup = await deps.backupCurrentApk();
        const backupPreferences = normalizeAppUpdatePreferences({
          ...snapshot.preferences,
          rollbackBackup,
        });
        persistPreferences(deps.storage, backupPreferences, deps.onError);
        setSnapshot((current) => ({
          ...current,
          preferences: backupPreferences,
          rollbackBackup,
          isBackingUp: false,
        }));
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
          url: installTarget.apkUrl,
          sha256: installTarget.sha256,
          expectedPackageName: deps.packageName,
        });

        const nextPreferences = normalizeAppUpdatePreferences({
          ...snapshot.preferences,
          skippedVersionCode: installTarget.versionCode,
          ignoreUntilManualCheck: false,
        });
        persistPreferences(deps.storage, nextPreferences, deps.onError);

        setSnapshot((current) => ({
          ...current,
          preferences: nextPreferences,
          latestManifest: installTarget,
          availableManifest: null,
          installing: false,
          isBackingUp: false,
          updateStage: 'completed',
        }));
        return true;
      } catch (error) {
        setSnapshot((current) => ({
          ...current,
          installing: false,
          isBackingUp: false,
          lastError: error instanceof Error ? error.message : '下载或安装升级包失败',
          updateStage: 'failed',
          lastInstallContext: {
            manifestUrl: snapshot.preferences.manifestUrl,
            apkUrl: installTarget?.apkUrl || target.apkUrl,
            versionCode: installTarget?.versionCode || target.versionCode,
            versionName: installTarget?.versionName || target.versionName,
            sha256Expected: installTarget?.sha256 || target.sha256,
            capturedAt: deps.now(),
            reason: error instanceof Error ? error.message : '下载或安装升级包失败',
          },
        }));
        return false;
      }
    },
  };
}
