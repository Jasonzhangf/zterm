import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAC_FILE_SYSTEM_CHANNELS,
  createMacLocalFileSystemService,
  registerMacFileSystemIpcHandlers,
} from '../../electron/file-system.js';

let tmpDir = '';

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zterm-mac-fs-'));
});

afterEach(async () => {
  if (tmpDir) {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

describe('Mac local file-system adapter', () => {
  it('lists local filesystem facts without hiding provider errors as empty directories', async () => {
    await fs.promises.mkdir(path.join(tmpDir, 'src'));
    await fs.promises.writeFile(path.join(tmpDir, 'README.md'), 'hello');

    const service = createMacLocalFileSystemService({ defaultDownloadDir: path.join(tmpDir, 'downloads') });
    const listed = await service.readdir(tmpDir);
    const missing = await service.readdir(path.join(tmpDir, 'missing'));

    expect(listed.ok).toBe(true);
    expect(listed.entries.map((entry) => ({
      name: entry.name,
      type: entry.type,
      hasPath: entry.path.startsWith(tmpDir),
    }))).toEqual(expect.arrayContaining([
      { name: 'src', type: 'directory', hasPath: true },
      { name: 'README.md', type: 'file', hasPath: true },
    ]));
    expect(listed.entries.find((entry) => entry.name === 'README.md')?.size).toBe(5);
    expect(missing.ok).toBe(false);
    expect(missing.entries).toEqual([]);
    expect(missing.error).toContain('ENOENT');
  });

  it('reads, writes, and creates directories as IO-only operations', async () => {
    const service = createMacLocalFileSystemService({ defaultDownloadDir: path.join(tmpDir, 'downloads') });
    const created = await service.mkdir(path.join(tmpDir, 'out'));
    const saved = await service.saveFile(path.join(tmpDir, 'out'), 'note.txt', Buffer.from('saved text').toString('base64'));
    const read = await service.readFile(path.join(tmpDir, 'out', 'note.txt'));

    expect(created).toEqual({ ok: true });
    expect(saved.ok).toBe(true);
    expect(saved.path).toBe(path.join(tmpDir, 'out', 'note.txt'));
    expect(Buffer.from(read.dataBase64, 'base64').toString('utf8')).toBe('saved text');
  });

  it('rejects path traversal file names on save', async () => {
    const service = createMacLocalFileSystemService({ defaultDownloadDir: path.join(tmpDir, 'downloads') });
    const result = await service.saveFile(tmpDir, '../escape.txt', Buffer.from('bad').toString('base64'));

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid file name');
  });

  it('registers IPC handlers including explicit directory selection', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
        handlers.set(channel, handler);
      }),
    };
    const showOpenDialog = vi.fn().mockResolvedValue({ canceled: false, filePaths: [tmpDir] });

    registerMacFileSystemIpcHandlers(ipcMain as any, {
      service: createMacLocalFileSystemService({ defaultDownloadDir: path.join(tmpDir, 'downloads') }),
      showOpenDialog,
    });

    expect(ipcMain.handle).toHaveBeenCalledWith(MAC_FILE_SYSTEM_CHANNELS.readdir, expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith(MAC_FILE_SYSTEM_CHANNELS.selectDirectory, expect.any(Function));

    const selected = await handlers.get(MAC_FILE_SYSTEM_CHANNELS.selectDirectory)?.({});
    const downloadDir = await handlers.get(MAC_FILE_SYSTEM_CHANNELS.getDownloadDir)?.({});

    expect(selected).toEqual({ ok: true, path: tmpDir });
    expect(downloadDir).toBe(path.join(tmpDir, 'downloads'));
  });
});
