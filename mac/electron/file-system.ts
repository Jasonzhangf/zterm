import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IpcMain, OpenDialogOptions, OpenDialogReturnValue } from 'electron';

export const MAC_FILE_SYSTEM_CHANNELS = {
  readdir: 'zterm:fs:readdir',
  saveFile: 'zterm:fs:save-file',
  readFile: 'zterm:fs:read-file',
  mkdir: 'zterm:fs:mkdir',
  getDownloadDir: 'zterm:fs:get-download-dir',
  selectDirectory: 'zterm:fs:select-directory',
} as const;

export interface MacLocalFileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  modified: number;
  modifiedMs: number;
  path: string;
}

export interface MacLocalDirectoryReadResult {
  ok: boolean;
  path: string;
  entries: MacLocalFileEntry[];
  error?: string;
}

export interface MacLocalFileReadResult {
  ok: boolean;
  dataBase64: string;
  size: number;
  error?: string;
}

export interface MacLocalFileSaveResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export interface MacLocalDirectorySelectResult {
  ok: boolean;
  path?: string;
  canceled?: boolean;
  error?: string;
}

export interface MacLocalFileSystemService {
  readdir: (dirPath: string) => Promise<MacLocalDirectoryReadResult>;
  saveFile: (dirPath: string, fileName: string, dataBase64: string) => Promise<MacLocalFileSaveResult>;
  readFile: (filePath: string) => Promise<MacLocalFileReadResult>;
  mkdir: (dirPath: string) => Promise<{ ok: boolean; error?: string }>;
  getDownloadDir: () => string;
}

interface MacFileSystemServiceOptions {
  defaultDownloadDir?: string;
}

type ShowOpenDialog = (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>;

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validatePathInput(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return path.resolve(trimmed);
}

function validateFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error(`Invalid file name: ${fileName}`);
  }
  return trimmed;
}

export function resolveDefaultMacDownloadDir() {
  return path.join(os.homedir(), 'Downloads', 'zterm');
}

export function createMacLocalFileSystemService(
  options: MacFileSystemServiceOptions = {},
): MacLocalFileSystemService {
  const defaultDownloadDir = options.defaultDownloadDir ?? resolveDefaultMacDownloadDir();

  return {
    async readdir(dirPath: string): Promise<MacLocalDirectoryReadResult> {
      try {
        const resolvedPath = validatePathInput(dirPath, 'Directory path');
        const entries = await fs.promises.readdir(resolvedPath, { withFileTypes: true });
        const result: MacLocalFileEntry[] = [];
        for (const entry of entries) {
          const fullPath = path.join(resolvedPath, entry.name);
          const stat = await fs.promises.stat(fullPath);
          result.push({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
            size: stat.size,
            modified: Math.floor(stat.mtimeMs / 1000),
            modifiedMs: stat.mtimeMs,
            path: fullPath,
          });
        }
        return { ok: true, path: resolvedPath, entries: result };
      } catch (error) {
        return { ok: false, path: dirPath, error: errorToMessage(error), entries: [] };
      }
    },

    async saveFile(dirPath: string, fileName: string, dataBase64: string): Promise<MacLocalFileSaveResult> {
      try {
        const resolvedDir = validatePathInput(dirPath, 'Directory path');
        const safeFileName = validateFileName(fileName);
        await fs.promises.mkdir(resolvedDir, { recursive: true });
        const filePath = path.join(resolvedDir, safeFileName);
        const buffer = Buffer.from(dataBase64, 'base64');
        await fs.promises.writeFile(filePath, buffer);
        return { ok: true, path: filePath };
      } catch (error) {
        return { ok: false, error: errorToMessage(error) };
      }
    },

    async readFile(filePath: string): Promise<MacLocalFileReadResult> {
      try {
        const resolvedPath = validatePathInput(filePath, 'File path');
        const buffer = await fs.promises.readFile(resolvedPath);
        return { ok: true, dataBase64: buffer.toString('base64'), size: buffer.length };
      } catch (error) {
        return { ok: false, error: errorToMessage(error), dataBase64: '', size: 0 };
      }
    },

    async mkdir(dirPath: string): Promise<{ ok: boolean; error?: string }> {
      try {
        const resolvedPath = validatePathInput(dirPath, 'Directory path');
        await fs.promises.mkdir(resolvedPath, { recursive: true });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorToMessage(error) };
      }
    },

    getDownloadDir() {
      return defaultDownloadDir;
    },
  };
}

export function registerMacFileSystemIpcHandlers(
  ipcMain: Pick<IpcMain, 'handle'>,
  options: {
    service?: MacLocalFileSystemService;
    showOpenDialog?: ShowOpenDialog;
  } = {},
) {
  const service = options.service ?? createMacLocalFileSystemService();

  ipcMain.handle(MAC_FILE_SYSTEM_CHANNELS.readdir, (_event, payload: { dirPath: string }) =>
    service.readdir(payload.dirPath));
  ipcMain.handle(MAC_FILE_SYSTEM_CHANNELS.saveFile, (_event, payload: { dirPath: string; fileName: string; dataBase64: string }) =>
    service.saveFile(payload.dirPath, payload.fileName, payload.dataBase64));
  ipcMain.handle(MAC_FILE_SYSTEM_CHANNELS.readFile, (_event, payload: { filePath: string }) =>
    service.readFile(payload.filePath));
  ipcMain.handle(MAC_FILE_SYSTEM_CHANNELS.mkdir, (_event, payload: { dirPath: string }) =>
    service.mkdir(payload.dirPath));
  ipcMain.handle(MAC_FILE_SYSTEM_CHANNELS.getDownloadDir, () => service.getDownloadDir());
  ipcMain.handle(MAC_FILE_SYSTEM_CHANNELS.selectDirectory, async () => {
    if (!options.showOpenDialog) {
      return {
        ok: false,
        error: 'Directory selection is unavailable',
      } satisfies MacLocalDirectorySelectResult;
    }
    const result = await options.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) {
      return {
        ok: false,
        canceled: true,
        error: 'Directory selection canceled',
      } satisfies MacLocalDirectorySelectResult;
    }
    return {
      ok: true,
      path: path.resolve(result.filePaths[0]),
    } satisfies MacLocalDirectorySelectResult;
  });
}

