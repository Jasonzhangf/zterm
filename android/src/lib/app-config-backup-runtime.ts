import type { BrowserStorageLike } from './browser-storage';
import {
  applyAppConfigBackupPayload,
  buildAppConfigBackupPayload,
  normalizeAppConfigBackupPayload,
  toAppConfigBackupInfo,
  type AppConfigBackupInfo,
} from './app-config-backup';

export type AppConfigBackupStage = 'idle' | 'exporting' | 'restoring' | 'failed';

export interface AppConfigBackupRuntimeSnapshot {
  backupInfo: AppConfigBackupInfo | null;
  exporting: boolean;
  restoring: boolean;
  lastError: string | null;
  stage: AppConfigBackupStage;
}

export interface AppConfigBackupRuntimeDeps {
  storage: BrowserStorageLike | null;
  now: () => number;
  appVersion: string;
  appVersionCode: number;
  ensureStoragePermission: () => Promise<void>;
  writeBackupFile: (contents: string) => Promise<void>;
  readBackupFile: () => Promise<string>;
  reloadApp: () => void;
}

function createDefaultSnapshot(): AppConfigBackupRuntimeSnapshot {
  return {
    backupInfo: null,
    exporting: false,
    restoring: false,
    lastError: null,
    stage: 'idle',
  };
}

function toErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export function createAppConfigBackupRuntime(deps: AppConfigBackupRuntimeDeps) {
  let snapshot = createDefaultSnapshot();

  const setSnapshot = (
    next:
      | AppConfigBackupRuntimeSnapshot
      | ((current: AppConfigBackupRuntimeSnapshot) => AppConfigBackupRuntimeSnapshot),
  ) => {
    snapshot = typeof next === 'function' ? next(snapshot) : next;
    return snapshot;
  };

  return {
    getSnapshot() {
      return snapshot;
    },

    async exportConfig() {
      setSnapshot((current) => ({
        ...current,
        exporting: true,
        lastError: null,
        stage: 'exporting',
      }));

      try {
        if (!deps.storage) {
          throw new Error('当前环境不支持配置备份');
        }
        await deps.ensureStoragePermission();
        const payload = buildAppConfigBackupPayload({
          storage: deps.storage,
          exportedAt: deps.now(),
          appVersion: deps.appVersion,
          appVersionCode: deps.appVersionCode,
        });
        await deps.writeBackupFile(JSON.stringify(payload, null, 2));
        const backupInfo = toAppConfigBackupInfo(payload);
        setSnapshot((current) => ({
          ...current,
          backupInfo,
          exporting: false,
          stage: 'idle',
        }));
        return backupInfo;
      } catch (error) {
        setSnapshot((current) => ({
          ...current,
          exporting: false,
          lastError: toErrorMessage(error, '导出配置失败'),
          stage: 'failed',
        }));
        return null;
      }
    },

    async restoreConfig() {
      setSnapshot((current) => ({
        ...current,
        restoring: true,
        lastError: null,
        stage: 'restoring',
      }));

      try {
        if (!deps.storage) {
          throw new Error('当前环境不支持配置恢复');
        }
        await deps.ensureStoragePermission();
        const raw = await deps.readBackupFile();
        const payload = normalizeAppConfigBackupPayload(JSON.parse(raw));
        if (!payload) {
          throw new Error('配置备份文件格式无效');
        }
        applyAppConfigBackupPayload(deps.storage, payload);
        const backupInfo = toAppConfigBackupInfo(payload);
        setSnapshot((current) => ({
          ...current,
          backupInfo,
          restoring: false,
          stage: 'idle',
        }));
        deps.reloadApp();
        return backupInfo;
      } catch (error) {
        setSnapshot((current) => ({
          ...current,
          restoring: false,
          lastError: toErrorMessage(error, '恢复配置失败'),
          stage: 'failed',
        }));
        return null;
      }
    },
  };
}
