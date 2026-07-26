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
  readFileChunk(options: { path: string; offset: number; length: number }): Promise<{ data: string; bytesRead: number; eof: boolean }>;
  writeFile(options: { path: string; data: string }): Promise<void>;
  writeFileChunk(options: { path: string; data: string; append?: boolean }): Promise<{ bytesWritten: number }>;
  mkdir(options: { path: string; recursive?: boolean }): Promise<void>;
}

export const StoragePermissionPlugin = registerPlugin<StoragePermissionPluginApi>('StoragePermission');
