import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTerminalControlRuntime } from './terminal-control-runtime';
import type { TerminalSourceAdapter } from './terminal-source-adapter';

const spawnMock = vi.fn();
const spawnSyncMock = vi.fn();

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

function createRuntime() {
  const runtime = createTerminalControlRuntime({
    tmuxBinary: 'tmux',
    defaultSessionName: 'demo',
    hiddenTmuxSessions: new Set(),
    sanitizeSessionName: (input) => input?.trim() || 'demo',
  });
  return { runtime };
}

function createWezTermRuntime() {
  const wezTermBackend: TerminalSourceAdapter = {
    listSessions: vi.fn(() => [{ sessionName: 'demo', paneId: 9, workspace: 'zterm-demo', title: 'cmd.exe', cwd: 'D:/work', cols: 100, rows: 30 }]),
    createSession: vi.fn(({ sessionName, cwd } = {}) => ({
      sessionName: sessionName || 'demo',
      paneId: 10,
      workspace: `zterm-${sessionName || 'demo'}`,
      title: 'cmd.exe',
      cwd: cwd || 'D:/work',
      cols: 100,
      rows: 30,
    })),
    readSnapshot: vi.fn(),
    writeInput: vi.fn(),
    closeSession: vi.fn(),
    readCurrentPath: vi.fn(() => 'D:/work'),
  };
  const runtime = createTerminalControlRuntime({
    tmuxBinary: 'tmux',
    defaultSessionName: 'demo',
    hiddenTmuxSessions: new Set(),
    sanitizeSessionName: (input) => input?.trim() || 'demo',
    wezTermBackend,
    defaultBackend: 'wezterm',
  });
  return { runtime, wezTermBackend };
}

function createHerdrOnlyRuntime() {
  const herdrBackend: TerminalSourceAdapter = {
    listSessions: vi.fn(() => [{ sessionName: 'herdr-demo', paneId: 1, workspace: 'herdr-single-session', title: 'herdr', cwd: '/tmp', cols: 80, rows: 24 }]),
    createSession: vi.fn(({ sessionName } = {}) => ({
      sessionName: sessionName || 'herdr-demo',
      paneId: 2,
      workspace: 'herdr-single-session',
      title: 'herdr',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    })),
    readSnapshot: vi.fn(),
    writeInput: vi.fn(),
    closeSession: vi.fn(),
    readCurrentPath: vi.fn(() => '/tmp'),
  };
  const runtime = createTerminalControlRuntime({
    tmuxBinary: 'tmux',
    defaultSessionName: 'demo',
    defaultBackend: 'herdr',
    hiddenTmuxSessions: new Set(),
    sanitizeSessionName: (input) => input?.trim() || 'demo',
    backendRuntimes: { herdr: herdrBackend },
  });
  return { runtime, herdrBackend };
}

describe('terminal control runtime input queue', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
  });

  it('treats tmux 3.6 missing default socket as an empty session list', () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'error connecting to /private/tmp/tmux-501/default (No such file or directory)',
    });
    const { runtime } = createRuntime();

    expect(runtime.listTmuxSessions()).toEqual([]);
    expect(spawnSyncMock.mock.calls[0]?.[1]).toEqual(['list-sessions', '-F', '#S']);
  });

  it('does not hide non-list tmux socket errors as empty sessions', () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'error connecting to /private/tmp/tmux-501/default (No such file or directory)',
    });
    const { runtime } = createRuntime();

    expect(() => runtime.runTmux(['send-keys', '-t', '=demo:.{top-left}', '-l', '--', 'x']))
      .toThrow(/error connecting to/);
  });

  it('writes one backend input group with an explicit Enter boundary', async () => {
    const { runtime } = createRuntime();
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
        stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
      };
      child.stdout = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
      child.stderr = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
      child.stdout.setEncoding = vi.fn();
      child.stderr.setEncoding = vi.fn();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });

    await runtime.writeBackendInputGroup('demo', 'echo OK', true);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      'send-keys', '-t', '=demo:.{top-left}', '-l', '--', 'echo OK',
    ]);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      'send-keys', '-t', '=demo:.{top-left}', 'Enter',
    ]);
  });

  it('routes list/create/write/close through wezterm backend without invoking tmux', async () => {
    const { runtime, wezTermBackend } = createWezTermRuntime();

    expect(runtime.listTmuxSessions()).toEqual(['demo']);
    expect(runtime.listTerminalSessions()).toEqual(['demo']);
    expect(runtime.createDetachedTmuxSession('new-demo', 'D:/src')).toBe('new-demo');
    await runtime.writeBackendInputGroup('demo', 'echo OK', true);
    runtime.closeDetachedTerminalSession('demo');

    expect(wezTermBackend.listSessions).toHaveBeenCalled();
    expect(wezTermBackend.createSession).toHaveBeenCalledWith({ sessionName: 'new-demo', cwd: 'D:/src' });
    expect(wezTermBackend.writeInput).toHaveBeenNthCalledWith(1, 'demo', 'echo OK');
    expect(wezTermBackend.writeInput).toHaveBeenNthCalledWith(2, 'demo', '\r');
    expect(wezTermBackend.closeSession).toHaveBeenCalledWith('demo');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('creates detached tmux sessions with the 80x80 manual initialization geometry', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const { runtime } = createRuntime();

    expect(runtime.createDetachedTmuxSession('new-demo', '/tmp')).toBe('new-demo');
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'tmux',
      ['new-session', '-d', '-s', 'new-demo', '-x', '80', '-y', '80', '-c', '/tmp'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
  });

  it('returns a unified catalog while keeping backend-specific calls available', () => {
    const { runtime } = createHerdrOnlyRuntime();

    expect(runtime.listTerminalSessions()).toEqual(['herdr-demo']);
    expect(runtime.listTmuxSessions('herdr')).toEqual(['herdr-demo']);
    expect(runtime.listTerminalSessionCatalog()).toEqual([
      { name: 'herdr-demo', backend: 'herdr', cwd: '/tmp' },
    ]);
  });

  it('publishes tmux pane cwd in the daemon-owned session catalog', () => {
    spawnSyncMock.mockImplementation((_binary: string, args: string[]) => ({
      status: 0,
      stdout: args[0] === 'list-panes'
        ? 'demo\t/Users/jason/project\nother\t/Users/jason/project'
        : 'demo\nother\n',
      stderr: '',
    }));
    const { runtime } = createRuntime();

    expect(runtime.listTerminalSessionCatalog()).toEqual([
      { name: 'demo', backend: 'tmux', cwd: '/Users/jason/project' },
      { name: 'other', backend: 'tmux', cwd: '/Users/jason/project' },
    ]);
  });

  it('lists and resolves Herdr sessions without probing tmux on a Herdr-only daemon', () => {
    const { runtime, herdrBackend } = createHerdrOnlyRuntime();

    expect(runtime.listTerminalSessions()).toEqual(['herdr-demo']);
    expect(runtime.resolveTerminalSessionBackend('herdr-demo')).toBe('herdr');
    expect(herdrBackend.listSessions).toHaveBeenCalledTimes(3);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('keeps a Herdr-only catalog isolated from tmux even when a tmux probe would have returned names', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: 'tmux-demo\nshared\n', stderr: '' });
    const { runtime, herdrBackend } = createHerdrOnlyRuntime();
    herdrBackend.listSessions = vi.fn(() => [
      { sessionName: 'herdr-demo', paneId: 1, workspace: 'herdr-single-session', title: 'herdr', cwd: '/tmp', cols: 80, rows: 24 },
      { sessionName: 'shared', paneId: 2, workspace: 'herdr-single-session', title: 'herdr', cwd: '/tmp', cols: 80, rows: 24 },
    ]);
    expect(runtime.listTmuxSessions('herdr')).toContain('herdr-demo');
    expect(runtime.listTerminalSessions()).toEqual(['herdr-demo', 'shared']);
    expect(runtime.listTerminalSessionCatalog()).toEqual([
      { name: 'herdr-demo', backend: 'herdr', cwd: '/tmp' },
      { name: 'shared', backend: 'herdr', cwd: '/tmp' },
    ]);
    expect(runtime.resolveTerminalSessionBackend('shared')).toBe('herdr');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('routes close through tmux only when tmux is the selected backend', () => {
    const { runtime } = createRuntime();

    runtime.closeDetachedTerminalSession('demo');

    expect(spawnSyncMock.mock.calls[0]?.slice(0, 2)).toEqual([
      'tmux',
      ['kill-session', '-t', '=demo'],
    ]);
  });

  it('keeps tmux control available while explicit external backend operations stay typed', async () => {
    const { runtime } = createWezTermRuntime();

    expect(() => runtime.runTmux(['list-sessions'])).not.toThrow();
    expect(() => runtime.renameTmuxSession('a', 'b', 'wezterm')).toThrow('wezterm backend does not support session rename');
  });
});
