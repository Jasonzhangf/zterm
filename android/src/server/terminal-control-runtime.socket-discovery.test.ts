import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverTmuxSocketPaths } from './terminal-control-runtime';
import { resolveStandardTmuxSocketDir } from '@zterm/shared/terminal/tmux-socket-path';

const previousTmuxTmpdir = process.env.TMUX_TMPDIR;
const previousTmpdirDescriptor = Object.getOwnPropertyDescriptor(process.env, 'TMPDIR');
let roots: string[] = [];

function makeRoot(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function setTmpdir(value: string) {
  Object.defineProperty(process.env, 'TMPDIR', { value, configurable: true, enumerable: true, writable: true });
}

function listenAt(socketPath: string) {
  const server = createServer();
  return new Promise<{ close: () => Promise<void> }>((resolve) => {
    server.listen(socketPath, () => {
      resolve({
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

beforeEach(() => {
  roots = [];
});

afterEach(() => {
  if (previousTmuxTmpdir === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = previousTmuxTmpdir;
  if (previousTmpdirDescriptor) Object.defineProperty(process.env, 'TMPDIR', previousTmpdirDescriptor);
  else delete process.env.TMPDIR;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('terminal control runtime tmux socket discovery', () => {
  it('discovers the tmux CLI default socket when process TMPDIR differs and TMUX_TMPDIR is unset', async () => {
    const root = makeRoot('zterm-tmux-cli-default-root-');
    const cliDefaultDir = join(root, 'tmp', 'tmux-501');
    const processTmpDir = join(root, 'process-tmp');
    mkdirSync(cliDefaultDir, { recursive: true });
    mkdirSync(processTmpDir, { recursive: true });
    delete process.env.TMUX_TMPDIR;
    setTmpdir(processTmpDir);
    const cliDefaultServer = await listenAt(join(cliDefaultDir, 'default'));
    try {
      expect(discoverTmuxSocketPaths({
        cliDefaultRoot: join(root, 'tmp'),
        standardRunRoot: join(root, 'no-standard-root'),
        uid: 501,
      })).toEqual([join(cliDefaultDir, 'default')]);
    } finally {
      await cliDefaultServer.close();
    }
  });

  it('discovers the standard tmux run root socket when TMUX_TMPDIR points elsewhere', async () => {
    // Host fact: ~/.zshenv exports TMUX_TMPDIR=$HOME/.tmux/run, so the live
    // server socket lives at ~/.tmux/run/tmux-<uid>/default while the daemon
    // process env and the CLI /tmp root hold no server. Discovery must still
    // reach the standard root instead of falling back to the daemon-owned dir.
    const root = makeRoot('zts-');
    const standardRunRoot = join(root, 'r');
    const standardSocketDir = join(standardRunRoot, 'tmux-501');
    expect(resolveStandardTmuxSocketDir(join(root, 'h'), 501)).toBe(join(root, 'h', '.tmux', 'run', 'tmux-501'));
    mkdirSync(standardSocketDir, { recursive: true });
    delete process.env.TMUX_TMPDIR;
    setTmpdir(join(root, 'p'));
    const standardServer = await listenAt(join(standardSocketDir, 'default'));
    try {
      expect(discoverTmuxSocketPaths({
        cliDefaultRoot: join(root, 'tmp'),
        standardRunRoot,
        uid: 501,
      })).toEqual([join(standardSocketDir, 'default')]);
    } finally {
      await standardServer.close();
    }
  });

  it('discovers the default socket and sockets in the configured stable directory only', async () => {
    const root = makeRoot('zterm-tmux-socket-discovery-');
    const defaultDir = join(root, 'tmux-501');
    const stableDir = join(root, 'stable', 'tmux-501');
    const unrelatedDir = join(root, 'unrelated', 'tmux-501');
    mkdirSync(defaultDir, { recursive: true });
    mkdirSync(stableDir, { recursive: true });
    mkdirSync(unrelatedDir, { recursive: true });
    process.env.TMUX_TMPDIR = root;
    const [defaultServer, stableServer, unrelatedServer] = await Promise.all([
      listenAt(join(defaultDir, 'default')),
      listenAt(join(stableDir, 's')),
      listenAt(join(unrelatedDir, 'default')),
    ]);
    try {
      expect(discoverTmuxSocketPaths({
        stableSocketDir: join(root, 'stable'),
        cliDefaultRoot: join(root, 'cli-default'),
        standardRunRoot: join(root, 'no-standard-root'),
        uid: 501,
      })).toEqual([
        join(stableDir, 's'),
        join(defaultDir, 'default'),
      ]);
    } finally {
      await Promise.all([defaultServer.close(), stableServer.close(), unrelatedServer.close()]);
    }
  });
});
