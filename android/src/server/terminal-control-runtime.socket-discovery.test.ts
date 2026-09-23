import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { discoverTmuxSocketPaths } from './terminal-control-runtime';

describe('terminal control runtime tmux socket discovery', () => {
  it('discovers the tmux CLI default socket when process TMPDIR differs and TMUX_TMPDIR is unset', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zterm-tmux-cli-default-root-'));
    const cliDefaultDir = join(root, 'tmp', 'tmux-501');
    const processTmpDir = join(root, 'process-tmp');
    mkdirSync(cliDefaultDir, { recursive: true });
    mkdirSync(processTmpDir, { recursive: true });
    const cliDefaultServer = createServer();
    const previousTmuxTmpdir = process.env.TMUX_TMPDIR;
    delete process.env.TMUX_TMPDIR;
    const previousTmpdirDescriptor = Object.getOwnPropertyDescriptor(process.env, 'TMPDIR');
    Object.defineProperty(process.env, 'TMPDIR', { value: processTmpDir, configurable: true, enumerable: true, writable: true });
    try {
      await new Promise<void>((resolve) => cliDefaultServer.listen(join(cliDefaultDir, 'default'), resolve));
      expect(discoverTmuxSocketPaths({ cliDefaultRoot: join(root, 'tmp'), uid: 501 })).toEqual([
        join(cliDefaultDir, 'default'),
      ]);
    } finally {
      await new Promise<void>((resolve) => cliDefaultServer.close(() => resolve()));
      if (previousTmuxTmpdir === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = previousTmuxTmpdir;
      if (previousTmpdirDescriptor) Object.defineProperty(process.env, 'TMPDIR', previousTmpdirDescriptor);
      else delete process.env.TMPDIR;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('discovers the default socket and sockets in the configured stable directory only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zterm-tmux-socket-discovery-'));
    const defaultDir = join(root, 'tmux-501');
    const stableDir = join(root, 'stable', 'tmux-501');
    const unrelatedDir = join(root, 'unrelated', 'tmux-501');
    mkdirSync(defaultDir, { recursive: true });
    mkdirSync(stableDir, { recursive: true });
    mkdirSync(unrelatedDir, { recursive: true });
    const defaultServer = createServer();
    const stableServer = createServer();
    const unrelatedServer = createServer();
    const previousTmuxTmpdir = process.env.TMUX_TMPDIR;
    process.env.TMUX_TMPDIR = root;
    try {
      await Promise.all([
        new Promise<void>((resolve) => defaultServer.listen(join(defaultDir, 'default'), resolve)),
        new Promise<void>((resolve) => stableServer.listen(join(stableDir, 's'), resolve)),
        new Promise<void>((resolve) => unrelatedServer.listen(join(unrelatedDir, 'default'), resolve)),
      ]);

      expect(discoverTmuxSocketPaths({
        stableSocketDir: join(root, 'stable'),
        cliDefaultRoot: join(root, 'cli-default'),
        uid: 501,
      })).toEqual([
        join(stableDir, 's'),
        join(defaultDir, 'default'),
      ]);
    } finally {
      if (previousTmuxTmpdir === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = previousTmuxTmpdir;
      await Promise.all([
        new Promise<void>((resolve) => defaultServer.close(() => resolve())),
        new Promise<void>((resolve) => stableServer.close(() => resolve())),
        new Promise<void>((resolve) => unrelatedServer.close(() => resolve())),
      ]);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
