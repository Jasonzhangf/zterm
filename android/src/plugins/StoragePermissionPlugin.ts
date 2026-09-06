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
  writeFileChunks(options: { path: string; chunks: string[]; append: boolean }): Promise<{ bytesWritten: number }>;
  publishFile(options: {
    sourcePath: string;
    targetPath: string;
    expectedBytes: number;
  }): Promise<{ bytesPublished: number }>;
  copyFile(options: { sourcePath: string; targetPath: string }): Promise<{ bytesWritten: number }>;
  createStableFileSnapshot(options: { sourcePath: string; snapshotPath: string }): Promise<{ path: string; size: number; modified: number }>;
  deleteFile(options: { path: string }): Promise<void>;
  openFile(options: { path: string; mimeType?: string }): Promise<void>;
  mkdir(options: { path: string; recursive?: boolean }): Promise<void>;
  saveToDownloads(options: { dataBase64: string; fileName: string; mimeType?: string }): Promise<{ path: string }>;
}

export const StoragePermissionPlugin = registerPlugin<StoragePermissionPluginApi>('StoragePermission');
