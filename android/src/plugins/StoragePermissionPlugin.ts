import { registerPlugin } from '@capacitor/core';

export interface StoragePermissionStatus {
  granted: boolean;
  mode: 'manage-external-storage' | 'legacy-read-write';
}

interface StoragePermissionPluginApi {
  check(): Promise<StoragePermissionStatus>;
  request(): Promise<StoragePermissionStatus>;
}

export const StoragePermissionPlugin = registerPlugin<StoragePermissionPluginApi>('StoragePermission');
