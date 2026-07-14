import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WINDOWS_FILE_SYSTEM_CHANNELS,
  createWindowsLocalFileSystemService,
  registerWindowsFileSystemIpcHandlers,
} from '../electron/windows-file-system';

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((target) => fs.promises.rm(target, { recursive: true, force: true })));
});

describe('windows local filesystem provider', () => {
  it('lists and reads a real fixture directory without preview policy', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zterm-win-fs-'));
    tempPaths.push(root);
    await fs.promises.mkdir(path.join(root, 'src'));
    await fs.promises.writeFile(path.join(root, 'README.md'), 'WINDOWS_FILE_PREVIEW_SOURCE\n');
    const service = createWindowsLocalFileSystemService();

    const directory = await service.readdir(root);
    expect(directory.ok).toBe(true);
    expect(directory.entries.map((entry) => [entry.name, entry.type])).toEqual(expect.arrayContaining([
      ['README.md', 'file'],
      ['src', 'directory'],
    ]));
    const file = await service.readFile(path.join(root, 'README.md'));
    expect(Buffer.from(file.dataBase64, 'base64').toString('utf8')).toBe('WINDOWS_FILE_PREVIEW_SOURCE\n');
  });

  it('surfaces missing paths and unavailable selection explicitly', async () => {
    const service = createWindowsLocalFileSystemService();
    await expect(service.readdir('')).resolves.toMatchObject({ ok: false, entries: [], error: 'Directory path is required' });
    await expect(service.readFile('')).resolves.toMatchObject({ ok: false, dataBase64: '', error: 'File path is required' });

    const handlers = new Map<string, (...args: any[]) => any>();
    registerWindowsFileSystemIpcHandlers({ handle: vi.fn((channel, handler) => handlers.set(channel, handler)) } as any, { service });
    await expect(handlers.get(WINDOWS_FILE_SYSTEM_CHANNELS.selectDirectory)?.({})).resolves.toMatchObject({
      ok: false,
      error: 'Directory selection is unavailable',
    });
  });
});
