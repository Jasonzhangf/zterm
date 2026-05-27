import { Capacitor, registerPlugin } from '@capacitor/core';

export interface DownloadAndInstallOptions {
  url: string;
  sha256?: string;
  expectedPackageName?: string;
}

export interface RollbackBackupInfo {
  versionCode: number;
  versionName: string;
  filePath: string;
  sha256: string;
  backedUpAt: number;
}

export interface AppUpdatePlugin {
  canRequestPackageInstalls(): Promise<{ allowed: boolean }>;
  openInstallPermissionSettings(): Promise<void>;
  downloadAndInstall(options: DownloadAndInstallOptions): Promise<{
    filePath: string;
    sha256: string;
    packageName?: string;
  }>;
  backupCurrentApk(): Promise<RollbackBackupInfo>;
  rollbackToBackup(options: { filePath: string; sha256?: string }): Promise<void>;
  getRollbackBackupInfo(): Promise<RollbackBackupInfo | null>;
}

const AppUpdateNative = registerPlugin<AppUpdatePlugin>('AppUpdate');

export function isNativeAppUpdateSupported() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export const AppUpdatePlugin = AppUpdateNative;

