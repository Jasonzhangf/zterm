import { Capacitor, registerPlugin } from '@capacitor/core';

export interface DownloadAndInstallOptions {
  url: string;
  sha256?: string;
  expectedPackageName?: string;
}

export interface AppUpdatePlugin {
  canRequestPackageInstalls(): Promise<{ allowed: boolean }>;
  openInstallPermissionSettings(): Promise<void>;
  downloadAndInstall(options: DownloadAndInstallOptions): Promise<{
    filePath: string;
    sha256: string;
    packageName?: string;
  }>;
}

const AppUpdateNative = registerPlugin<AppUpdatePlugin>('AppUpdate');

export function isNativeAppUpdateSupported() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export const AppUpdatePlugin = AppUpdateNative;

