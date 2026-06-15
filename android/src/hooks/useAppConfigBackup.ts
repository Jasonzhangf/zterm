import { useCallback, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { getBrowserStorage } from '../lib/browser-storage';
import {
  APP_CONFIG_BACKUP_DIR_PATH,
  APP_CONFIG_BACKUP_FILE_PATH,
} from '../lib/app-config-backup';
import { APP_VERSION, APP_VERSION_CODE } from '../lib/app-version';
import {
  createAppConfigBackupRuntime,
  type AppConfigBackupRuntimeSnapshot,
} from '../lib/app-config-backup-runtime';
import { StoragePermissionPlugin } from '../plugins/StoragePermissionPlugin';

function isAppConfigBackupSupported() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

async function ensureStoragePermission() {
  if (!isAppConfigBackupSupported()) {
    throw new Error('配置备份仅支持 Android 安装包');
  }
  const current = await StoragePermissionPlugin.check();
  if (current.granted) {
    return;
  }
  const requested = await StoragePermissionPlugin.request();
  if (!requested.granted) {
    throw new Error('需要先授予外部存储权限');
  }
}

function useAppConfigBackupSnapshot(
  runtimeRef: MutableRefObject<ReturnType<typeof createAppConfigBackupRuntime>>,
) {
  const [snapshot, setSnapshot] = useState<AppConfigBackupRuntimeSnapshot>(() => runtimeRef.current.getSnapshot());
  const syncSnapshot = useCallback(() => {
    setSnapshot(runtimeRef.current.getSnapshot());
  }, [runtimeRef]);
  return { snapshot, syncSnapshot };
}

export function useAppConfigBackup() {
  const runtimeRef = useRef(createAppConfigBackupRuntime({
    storage: getBrowserStorage(),
    now: () => Date.now(),
    appVersion: APP_VERSION,
    appVersionCode: APP_VERSION_CODE,
    ensureStoragePermission,
    writeBackupFile: async (contents: string) => {
      await Filesystem.mkdir({
        path: APP_CONFIG_BACKUP_DIR_PATH,
        directory: Directory.ExternalStorage,
        recursive: true,
      });
      await Filesystem.writeFile({
        path: APP_CONFIG_BACKUP_FILE_PATH,
        data: contents,
        directory: Directory.ExternalStorage,
      });
    },
    readBackupFile: async () => {
      const result = await Filesystem.readFile({
        path: APP_CONFIG_BACKUP_FILE_PATH,
        directory: Directory.ExternalStorage,
      });
      if (typeof result.data !== 'string') {
        throw new Error('配置备份文件读取结果无效');
      }
      return result.data;
    },
    reloadApp: () => {
      globalThis.location?.reload();
    },
  }));
  const { snapshot, syncSnapshot } = useAppConfigBackupSnapshot(runtimeRef);

  const exportConfig = useCallback(async () => {
    const result = await runtimeRef.current.exportConfig();
    syncSnapshot();
    return result;
  }, [syncSnapshot]);

  const restoreConfig = useCallback(async () => {
    const result = await runtimeRef.current.restoreConfig();
    syncSnapshot();
    return result;
  }, [syncSnapshot]);

  return useMemo(() => ({
    backupPath: APP_CONFIG_BACKUP_FILE_PATH,
    backupInfo: snapshot.backupInfo,
    lastError: snapshot.lastError,
    exporting: snapshot.exporting,
    restoring: snapshot.restoring,
    stage: snapshot.stage,
    exportConfig,
    restoreConfig,
  }), [
    snapshot.backupInfo,
    snapshot.lastError,
    snapshot.exporting,
    snapshot.restoring,
    snapshot.stage,
    exportConfig,
    restoreConfig,
  ]);
}
