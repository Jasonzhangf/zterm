import fs from 'node:fs';
import path from 'node:path';
import type { IpcMain, OpenDialogOptions, OpenDialogReturnValue } from 'electron';

export const WINDOWS_FILE_SYSTEM_CHANNELS = {
  readdir: 'zterm:windows:fs:readdir',
  readFile: 'zterm:windows:fs:read-file',
  selectDirectory: 'zterm:windows:fs:select-directory',
} as const;

export interface WindowsLocalFileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  modified: number;
  modifiedMs: number;
  path: string;
}

export interface WindowsLocalDirectoryReadResult {
  ok: boolean;
  path: string;
  entries: WindowsLocalFileEntry[];
  error?: string;
}

export interface WindowsLocalFileReadResult {
  ok: boolean;
  dataBase64: string;
  size: number;
  error?: string;
}

export interface WindowsLocalFileSystemService {
  readdir: (dirPath: string) => Promise<WindowsLocalDirectoryReadResult>;
  readFile: (filePath: string) => Promise<WindowsLocalFileReadResult>;
}

type ShowOpenDialog = (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function resolveRequiredPath(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return path.resolve(trimmed);
}

export function createWindowsLocalFileSystemService(): WindowsLocalFileSystemService {
  return {
    async readdir(dirPath) {
      try {
        const resolvedPath = resolveRequiredPath(dirPath, 'Directory path');
        const entries = await fs.promises.readdir(resolvedPath, { withFileTypes: true });
        const projected: WindowsLocalFileEntry[] = [];
        for (const entry of entries) {
          const entryPath = path.join(resolvedPath, entry.name);
          const stat = await fs.promises.stat(entryPath);
          projected.push({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
            size: stat.size,
            modified: Math.floor(stat.mtimeMs / 1000),
            modifiedMs: stat.mtimeMs,
            path: entryPath,
          });
        }
        return { ok: true, path: resolvedPath, entries: projected };
      } catch (error) {
        return { ok: false, path: dirPath, entries: [], error: errorMessage(error) };
      }
    },
    async readFile(filePath) {
      try {
        const resolvedPath = resolveRequiredPath(filePath, 'File path');
        const data = await fs.promises.readFile(resolvedPath);
        return { ok: true, dataBase64: data.toString('base64'), size: data.length };
      } catch (error) {
        return { ok: false, dataBase64: '', size: 0, error: errorMessage(error) };
      }
    },
  };
}

export function registerWindowsFileSystemIpcHandlers(
  ipcMain: Pick<IpcMain, 'handle'>,
  options: { service?: WindowsLocalFileSystemService; showOpenDialog?: ShowOpenDialog } = {},
) {
  const service = options.service ?? createWindowsLocalFileSystemService();
  ipcMain.handle(WINDOWS_FILE_SYSTEM_CHANNELS.readdir, (_event, payload: { dirPath: string }) =>
    service.readdir(payload.dirPath));
  ipcMain.handle(WINDOWS_FILE_SYSTEM_CHANNELS.readFile, (_event, payload: { filePath: string }) =>
    service.readFile(payload.filePath));
  ipcMain.handle(WINDOWS_FILE_SYSTEM_CHANNELS.selectDirectory, async () => {
    if (!options.showOpenDialog) return { ok: false, error: 'Directory selection is unavailable' };
    const result = await options.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) {
      return { ok: false, canceled: true, error: 'Directory selection canceled' };
    }
    return { ok: true, path: path.resolve(result.filePaths[0]) };
  });
}
