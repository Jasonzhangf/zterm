import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TERMINAL_INPUT_TMUX_WRITE_CHUNK_BYTES,
  getTerminalInputUtf8ByteLength,
} from '@zterm/shared/terminal/input-chunking';
import type { SessionMirror } from './terminal-runtime-types';
import { createTerminalControlRuntime } from './terminal-control-runtime';
import type { TerminalSourceAdapter } from './terminal-source-adapter';

const spawnMock = vi.fn();
const spawnSyncMock = vi.fn();

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

function createReadyMirror(): SessionMirror {
  return {
    key: 'demo',
    sessionName: 'demo',
    lifecycle: 'ready',
    cols: 80,
    rows: 24,
    baselineCols: 80,
    baselineRows: 24,
    cursorKeysApp: false,
    revision: 0,
    lastScrollbackCount: -1,
    bufferStartIndex: 0,
    bufferLines: [],
    cursor: null,
    lastFlushStartedAt: 0,
    lastFlushCompletedAt: 0,
    lastLiveActivityAt: 0,
      lastHeadBroadcastAt: 0,
    lastCaptureDurationMs: 0,
    lastCanonicalizeDurationMs: 0,
    flushInFlight: false,
    flushPromise: null,
    pendingStableCaptureSnapshot: null,
    liveSyncTimer: null,
    consecutiveFailures: 0,
    subscribers: new Set(),
      quietFlushStreak: 0,
      lastFlushHadContentChanges: false,
    scratchBridge: null,
  };
}

function createRuntime() {
  const mirrors = new Map<string, SessionMirror>([
    ['demo', createReadyMirror()],
  ]);
  const runtime = createTerminalControlRuntime({
    tmuxBinary: 'tmux',
    defaultSessionName: 'demo',
    hiddenTmuxSessions: new Set(),
    mirrors,
    getMirrorKey: (sessionName) => sessionName,
    sanitizeSessionName: (input) => input?.trim() || 'demo',
  });
  return { runtime, mirrors };
}

function createWezTermRuntime() {
  const mirrors = new Map<string, SessionMirror>([
    ['demo', createReadyMirror()],
  ]);
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
    mirrors,
    getMirrorKey: (sessionName) => sessionName,
    sanitizeSessionName: (input) => input?.trim() || 'demo',
    wezTermBackend,
    defaultBackend: 'wezterm',
  });
  return { runtime, mirrors, wezTermBackend };
}

function createHerdrOnlyRuntime() {
  const mirrors = new Map<string, SessionMirror>([
    ['demo', createReadyMirror()],
  ]);
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
    mirrors,
    getMirrorKey: (sessionName) => sessionName,
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

    expect(() => runtime.writeToTmuxSession('demo', 'x', false)).toThrow(/error connecting to/);
  });

  it('chunks direct tmux writes so fallback paths do not send oversized literal arguments', () => {
    const { runtime } = createRuntime();
    const source = 'z'.repeat(TERMINAL_INPUT_TMUX_WRITE_CHUNK_BYTES + 9);

    runtime.writeToTmuxSession('demo', source, true);

    const sendKeyCalls = spawnSyncMock.mock.calls
      .map((call) => call[1] as string[])
      .filter((args) => args[0] === 'send-keys');
    expect(sendKeyCalls).toHaveLength(3);
    const payloads = sendKeyCalls
      .filter((args) => args.includes('-l'))
      .map((args) => args[args.length - 1] || '');
    expect(payloads.join('')).toBe(source);
    for (const payload of payloads) {
      expect(getTerminalInputUtf8ByteLength(payload)).toBeLessThanOrEqual(
        TERMINAL_INPUT_TMUX_WRITE_CHUNK_BYTES,
      );
    }
    expect(sendKeyCalls[sendKeyCalls.length - 1]).toEqual(['send-keys', '-t', '=demo:.{top-left}', 'Enter']);
  });

  it('routes list/create/write/close through wezterm backend without invoking tmux', async () => {
    const { runtime, wezTermBackend } = createWezTermRuntime();

    expect(runtime.listTmuxSessions()).toEqual(['demo']);
    expect(runtime.listTerminalSessions()).toEqual(['demo']);
    expect(runtime.createDetachedTmuxSession('new-demo', 'D:/src')).toBe('new-demo');
    runtime.writeToTmuxSession('demo', 'echo OK', true);
    runtime.closeDetachedTerminalSession('demo');

    expect(wezTermBackend.listSessions).toHaveBeenCalled();
    expect(wezTermBackend.createSession).toHaveBeenCalledWith({ sessionName: 'new-demo', cwd: 'D:/src' });
    expect(wezTermBackend.writeInput).toHaveBeenCalledWith('demo', 'echo OK\r');
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
      { name: 'herdr-demo', backend: 'herdr' },
    ]);
  });

  it('lists and resolves Herdr sessions without probing tmux on a Herdr-only daemon', () => {
    const { runtime, herdrBackend } = createHerdrOnlyRuntime();

    expect(runtime.listTerminalSessions()).toEqual(['herdr-demo']);
    expect(runtime.resolveTerminalSessionBackend('herdr-demo')).toBe('herdr');
    expect(herdrBackend.listSessions).toHaveBeenCalledTimes(2);
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
      { name: 'herdr-demo', backend: 'herdr' },
      { name: 'shared', backend: 'herdr' },
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
