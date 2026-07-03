import { registerPlugin } from '@capacitor/core';

export interface StoragePermissionStatus {
  granted: boolean;
  mode: 'manage-external-storage' | 'legacy-read-write';
}

export interface StorageFileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  modified: number;
  uri: string;
}

interface StoragePermissionPluginApi {
  check(): Promise<StoragePermissionStatus>;
  request(): Promise<StoragePermissionStatus>;
  readdir(options: { path: string }): Promise<{ files: StorageFileEntry[] }>;
  stat(options: { path: string }): Promise<{ size: number; modified: number; uri: string; type: 'file' | 'directory' }>;
  readFile(options: { path: string }): Promise<{ data: string }>;
  writeFile(options: { path: string; data: string }): Promise<void>;
  mkdir(options: { path: string; recursive?: boolean }): Promise<void>;
}

export const StoragePermissionPlugin = registerPlugin<StoragePermissionPluginApi>('StoragePermission');
