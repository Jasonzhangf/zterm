import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMirror } from './terminal-runtime-types';
import { createTerminalControlRuntime } from './terminal-control-runtime';
import type { WezTermBackendRuntime } from './wezterm-backend';

const spawnMock = vi.fn();
const spawnSyncMock = vi.fn();

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

function createFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  };
  child.stdout = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  child.stderr = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  child.stdout.setEncoding = vi.fn();
  child.stderr.setEncoding = vi.fn();
  return child;
}

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
  const wezTermBackend: WezTermBackendRuntime = {
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
  });
  return { runtime, mirrors, wezTermBackend };
}

async function runSpawnMockImmediately() {
  spawnMock.mockImplementation(() => {
    const child = createFakeChild();
    queueMicrotask(() => {
      child.emit('close', 0);
    });
    return child;
  });
}

describe('terminal control runtime input queue', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
  });

  it('coalesces burst literal input for the same mirror into one tmux write', async () => {
    await runSpawnMockImmediately();
    const { runtime } = createRuntime();

    const writes = await Promise.all([
      runtime.enqueueLiveMirrorInput('demo', 'a', false, () => true),
      runtime.enqueueLiveMirrorInput('demo', 'b', false, () => true),
      runtime.enqueueLiveMirrorInput('demo', 'c', false, () => true),
    ]);

    expect(writes).toEqual([true, true, true]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      'send-keys',
      '-t',
      'demo',
      '-l',
      '--',
      'abc',
    ]);
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

  it('does not include stale queued input in a coalesced tmux write', async () => {
    await runSpawnMockImmediately();
    const { runtime } = createRuntime();

    const writes = await Promise.all([
      runtime.enqueueLiveMirrorInput('demo', 'old', false, () => false),
      runtime.enqueueLiveMirrorInput('demo', 'new', false, () => true),
    ]);

    expect(writes).toEqual([false, true]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      'send-keys',
      '-t',
      'demo',
      '-l',
      '--',
      'new',
    ]);
  });

  it('preserves append-enter boundaries while batching surrounding literal input', async () => {
    await runSpawnMockImmediately();
    const { runtime } = createRuntime();

    const writes = await Promise.all([
      runtime.enqueueLiveMirrorInput('demo', 'echo ok', true, () => true),
      runtime.enqueueLiveMirrorInput('demo', 'next', false, () => true),
    ]);

    expect(writes).toEqual([true, true]);
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      'send-keys',
      '-t',
      'demo',
      '-l',
      '--',
      'echo ok',
    ]);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual(['send-keys', '-t', 'demo', 'Enter']);
    expect(spawnMock.mock.calls[2]?.[1]).toEqual([
      'send-keys',
      '-t',
      'demo',
      '-l',
      '--',
      'next',
    ]);
  });

  // R3 reverse tests: close/destroy must NOT leak input into a future attach.
  it('disposeLiveMirrorInputBatch evicts queued items and reports evicted count', async () => {
    // intentionally do NOT start spawn; we want to assert items stay queued and
    // get rejected (false) when dispose runs, without ever touching tmux.
    spawnMock.mockImplementation(() => createFakeChild());
    const { runtime } = createRuntime();

    const promiseA = runtime.enqueueLiveMirrorInput('demo', 'a', false, () => true);
    const promiseB = runtime.enqueueLiveMirrorInput('demo', 'b', false, () => true);
    const evicted = runtime.disposeLiveMirrorInputBatch('demo', 'unit-test');
    expect(evicted).toBe(2);
    expect(await Promise.all([promiseA, promiseB])).toEqual([false, false]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('disposeLiveMirrorInputBatch is a no-op when nothing is queued', () => {
    const { runtime } = createRuntime();
    expect(runtime.disposeLiveMirrorInputBatch('demo', 'unit-test')).toBe(0);
  });

  it('re-enqueueing after dispose creates a fresh batch with no leftover items', async () => {
    let calls = 0;
    spawnMock.mockImplementation(() => {
      calls += 1;
      const child = createFakeChild();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    const { runtime } = createRuntime();

    // queue, then dispose
    const stale = runtime.enqueueLiveMirrorInput('demo', 'stale', false, () => true);
    runtime.disposeLiveMirrorInputBatch('demo', 'unit-test');
    expect(await stale).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();

    // fresh attach -> fresh batch, the new write must be the only one sent
    const fresh = runtime.enqueueLiveMirrorInput('demo', 'fresh', false, () => true);
    expect(await fresh).toBe(true);
    expect(calls).toBe(1);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      'send-keys',
      '-t',
      'demo',
      '-l',
      '--',
      'fresh',
    ]);
  });

  it('routes list/create/write through wezterm backend without invoking tmux', async () => {
    const { runtime, wezTermBackend } = createWezTermRuntime();

    expect(runtime.listTmuxSessions()).toEqual(['demo']);
    expect(runtime.createDetachedTmuxSession('new-demo', 'D:/src')).toBe('new-demo');
    runtime.writeToTmuxSession('demo', 'echo OK', true);
    expect(await runtime.enqueueLiveMirrorInput('demo', 'abc', false, () => true)).toBe(true);

    expect(wezTermBackend.listSessions).toHaveBeenCalled();
    expect(wezTermBackend.createSession).toHaveBeenCalledWith({ sessionName: 'new-demo', cwd: 'D:/src' });
    expect(wezTermBackend.writeInput).toHaveBeenCalledWith('demo', 'echo OK\r');
    expect(wezTermBackend.writeInput).toHaveBeenCalledWith('demo', 'abc');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('throws explicit errors for tmux-only operations in wezterm mode', async () => {
    const { runtime } = createWezTermRuntime();

    expect(() => runtime.runTmux(['list-sessions'])).toThrow('wezterm backend does not support tmux command: list-sessions');
    await expect(runtime.runTmuxAsync(['display-message'])).rejects.toThrow(
      'wezterm backend does not support tmux command: display-message',
    );
    expect(() => runtime.renameTmuxSession('a', 'b')).toThrow('wezterm backend does not support tmux rename-session');
  });
});
