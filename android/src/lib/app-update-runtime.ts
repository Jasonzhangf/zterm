import type { BrowserStorageLike } from './browser-storage';
import {
  APP_UPDATE_STORAGE_KEY,
  DEFAULT_APP_UPDATE_PREFERENCES,
  DEFAULT_APP_UPDATE_INSTALL_CONTEXT,
  normalizeAppUpdateManifest,
  normalizeAppUpdatePreferences,
  shouldSuppressUpdatePrompt,
  type AppUpdateCheckResult,
  type AppUpdateManifestCandidate,
  type AppUpdateInstallContext,
  type AppUpdateManifest,
  type AppUpdatePreferences,
  type AppUpdateRouteSnapshot,
  type AppUpdateRollbackBackup,
  type AppUpdateRollbackEntry,
} from './app-update';
import { buildRelayInjectedAppUpdatePreferences, isTailscaleManifestCandidate } from './app-update-relay-manifest';
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
  rollbackToPreviousEntry: AppUpdateRollbackEntry | null;
  isBackingUp: boolean;
  isRollingBack: boolean;
  lastInstallContext: AppUpdateInstallContext | null;
  activeManifestUrl: string;
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
  downloadRollbackApk: (options: DownloadAndInstallOptions) => Promise<{
    filePath: string;
    sha256: string;
    versionCode: number;
    versionName: string;
    packageName?: string;
  }>;
  getRollbackApkBaseInfo: () => Promise<{ baseVersionCode: number; baseVersionName: string } | null>;
  onError?: (phase: 'restore-preferences' | 'persist-preferences', error: unknown) => void;
}

export interface AppUpdateCheckOptions {
  manual?: boolean;
  manifestUrlOverride?: string;
  activeSessionRoute?: AppUpdateRouteSnapshot;
  manifestCandidates?: AppUpdateManifestCandidate[];
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
    rollbackToPreviousEntry: null,
    isBackingUp: false,
    isRollingBack: false,
    lastInstallContext: null,
    activeManifestUrl: '',
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

function routeEndpointKey(endpoint: string) {
  const raw = endpoint.trim();
  if (!raw || raw.startsWith('relay:') || raw.startsWith('rtc-')) {
    return '';
  }
  try {
    const parsed = raw.includes('://') ? new URL(raw) : new URL(`ws://${raw}`);
    return `${parsed.hostname.toLowerCase()}:${parsed.port || '3333'}`;
  } catch {
    return raw.toLowerCase();
  }
}

function manifestEndpointKey(manifestUrl: string) {
  try {
    const parsed = new URL(manifestUrl);
    return `${parsed.hostname.toLowerCase()}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    return '';
  }
}

function classifyManifestCandidate(candidate: AppUpdateManifestCandidate) {
  try {
    const hostname = new URL(candidate.manifestUrl).hostname.toLowerCase();
    if (isTailscaleHost(hostname)) {
      return 1;
    }
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.') || hostname.startsWith('10.') || hostname.startsWith('172.')) {
      return 0;
    }
  } catch {
    return 3;
  }
  return candidate.manifestSource === 'relay-injected' ? 2 : 3;
}

function isTailscaleHost(hostname: string) {
  const host = hostname.trim().toLowerCase();
  if (host.endsWith('.ts.net') || host.includes('tailnet')) {
    return true;
  }
  const parts = host.split('.').map((part) => Number.parseInt(part, 10));
  return parts.length === 4
    && parts.every((part) => Number.isFinite(part) && part >= 0 && part <= 255)
    && parts[0] === 100
    && parts[1] >= 64
    && parts[1] <= 127;
}

function resolveRouteAwareManifestUrl(
  preferences: AppUpdatePreferences,
  route: AppUpdateRouteSnapshot | undefined,
  candidates: AppUpdateManifestCandidate[] | undefined,
) {
  const persistedUrl = preferences.manifestUrl.trim();
  if (
    persistedUrl
    && (preferences.manifestSource === 'user-saved' || preferences.manifestSource === 'manual-override')
  ) {
    return persistedUrl;
  }
  const tailscaleCandidate = candidates?.find(isTailscaleManifestCandidate)?.manifestUrl.trim() || '';
  if (!route && preferences.manifestSource === 'server-connected' && tailscaleCandidate) {
    return tailscaleCandidate;
  }
  if (!route || !candidates?.length) {
    return route ? '' : persistedUrl;
  }

  if (route.resolvedPath === 'rtc-relay') {
    return candidates.find((candidate) => candidate.manifestSource === 'relay-injected')?.manifestUrl.trim() || '';
  }

  const endpointKey = routeEndpointKey(route.resolvedEndpoint || '');
  if (endpointKey) {
    const exact = candidates.find((candidate) => manifestEndpointKey(candidate.manifestUrl) === endpointKey);
    if (exact) {
      return exact.manifestUrl.trim();
    }
  }

  if (route.resolvedPath === 'tailscale') {
    return tailscaleCandidate;
  }

  return '';
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

    async checkForUpdates(options?: AppUpdateCheckOptions): Promise<AppUpdateCheckResult> {
      let manifestUrl = (
        options?.manifestUrlOverride?.trim()
        || resolveRouteAwareManifestUrl(
          snapshot.preferences,
          options?.activeSessionRoute,
          options?.manifestCandidates,
        )
      ).trim();
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
        let response: Response | null = null;
        if (!options?.manifestUrlOverride && !options?.activeSessionRoute && options?.manifestCandidates?.length) {
          const candidates = [...options.manifestCandidates].sort((left, right) => (
            classifyManifestCandidate(left) - classifyManifestCandidate(right)
          ));
          for (const candidate of candidates) {
            try {
              const candidateResponse = await deps.fetchFn(candidate.manifestUrl.trim(), {
                cache: 'no-store',
                headers: { Accept: 'application/json' },
              });
              if (candidateResponse.ok) {
                manifestUrl = candidate.manifestUrl.trim();
                response = candidateResponse;
                break;
              }
            } catch {
              // An unavailable route is only a probe failure; the next route is authoritative.
            }
          }
          if (!response) {
            throw new Error('LAN 与 Tailscale 升级路径均不可达');
          }
        } else {
          response = await deps.fetchFn(manifestUrl, {
            cache: 'no-store',
            headers: { Accept: 'application/json' },
          });
        }
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

        const rollbackEntry = resolvedManifest.rollbackToPrevious && resolvedManifest.rollbackToPrevious.sourceVersionCode === snapshot.runtimeVersionCode
          ? resolvedManifest.rollbackToPrevious
          : null;

        const nextPreferences = normalizeAppUpdatePreferences({
          ...snapshot.preferences,
          lastCheckedAt: deps.now(),
          lastSeenVersionCode: resolvedManifest.versionCode,
        });

        persistPreferences(deps.storage, nextPreferences, deps.onError);

        setSnapshot((current) => ({
          ...current,
          preferences: nextPreferences,
          activeManifestUrl: manifestUrl,
          latestManifest: resolvedManifest,
          availableManifest:
            updateAvailable && suppressedReason === 'none'
              ? resolvedManifest
              : (!updateAvailable || options?.manual ? null : current.availableManifest),
          rollbackToPreviousEntry: rollbackEntry,
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
      const entry = snapshot.rollbackToPreviousEntry;
      if (!entry) {
        setSnapshot((current) => ({
          ...current,
          lastError: '当前没有可用的回退版本',
          updateStage: 'failed',
          lastInstallContext: DEFAULT_APP_UPDATE_INSTALL_CONTEXT,
        }));
        return false;
      }

      setSnapshot((current) => ({
        ...current,
        isRollingBack: true,
        lastError: null,
        updateStage: 'downloading-and-installing',
      }));

      try {
        const apkUrl = new URL(entry.apkUrl, snapshot.activeManifestUrl || snapshot.preferences.manifestUrl || entry.apkUrl).toString();
        const result = await deps.downloadRollbackApk({
          url: apkUrl,
          sha256: entry.sha256,
          expectedPackageName: deps.packageName,
          expectedVersionCode: entry.versionCode,
          expectedVersionName: entry.versionName,
        });

        setSnapshot((current) => ({
          ...current,
          isRollingBack: false,
          updateStage: 'completed',
          rollbackToPreviousEntry: null,
        }));
        return Boolean(result);
      } catch (error) {
        setSnapshot((current) => ({
          ...current,
          isRollingBack: false,
          lastError: error instanceof Error ? error.message : '回退到上一版本失败',
          updateStage: 'failed',
          lastInstallContext: {
          manifestUrl: snapshot.activeManifestUrl || snapshot.preferences.manifestUrl,
            apkUrl: entry.apkUrl,
            versionCode: entry.versionCode,
            versionName: entry.versionName,
            sha256Expected: entry.sha256,
            capturedAt: deps.now(),
            reason: error instanceof Error ? error.message : '回退到上一版本失败',
          },
        }));
        return false;
      }
    },

    async rollbackToLocalBackup() {
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
          manifestUrl: snapshot.activeManifestUrl || snapshot.preferences.manifestUrl,
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
      const activeManifestUrl = snapshot.activeManifestUrl || snapshot.preferences.manifestUrl;
      if (manifest) {
        installTarget = {
          ...manifest,
          apkUrl: new URL(manifest.apkUrl, snapshot.activeManifestUrl || snapshot.preferences.manifestUrl || manifest.apkUrl).toString(),
        };
        setSnapshot((current) => ({
          ...current,
          latestManifest: installTarget,
          availableManifest: installTarget,
          lastInstallContext: {
            manifestUrl: snapshot.activeManifestUrl || snapshot.preferences.manifestUrl,
            apkUrl: installTarget.apkUrl,
            versionCode: installTarget.versionCode,
            versionName: installTarget.versionName,
            sha256Expected: installTarget.sha256,
            capturedAt: deps.now(),
          },
        }));
      } else {
        if (!activeManifestUrl.trim()) {
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
          const response = await deps.fetchFn(activeManifestUrl, {
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
            apkUrl: new URL(payload.apkUrl, activeManifestUrl).toString(),
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
              manifestUrl: activeManifestUrl,
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
            manifestUrl: snapshot.activeManifestUrl || snapshot.preferences.manifestUrl,
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
            manifestUrl: activeManifestUrl,
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
          expectedVersionCode: installTarget.versionCode,
          expectedVersionName: installTarget.versionName,
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
            manifestUrl: activeManifestUrl,
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
