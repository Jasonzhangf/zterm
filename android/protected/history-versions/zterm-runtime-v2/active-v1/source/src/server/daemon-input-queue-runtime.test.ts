import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TERMINAL_INPUT_TMUX_WRITE_CHUNK_BYTES,
  TERMINAL_INPUT_TMUX_WRITE_SETTLE_MS,
  getTerminalInputUtf8ByteLength,
} from '@zterm/shared/terminal/input-chunking';
import type { SessionMirror } from './terminal-runtime-types';
import { createDaemonInputQueueRuntime } from './daemon-input-queue-runtime';
import { createTerminalControlRuntime } from './terminal-control-runtime';
import type { TerminalSourceAdapter } from './terminal-source-adapter';

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
    quietFlushStreak: 0,
    lastFlushHadContentChanges: false,
    scratchBridge: null,
  };
}

function createRuntime() {
  const mirrors = new Map<string, SessionMirror>([
    ['demo', createReadyMirror()],
  ]);
  const controlRuntime = createTerminalControlRuntime({
    tmuxBinary: 'tmux',
    defaultSessionName: 'demo',
    hiddenTmuxSessions: new Set(),
    mirrors,
    getMirrorKey: (sessionName) => sessionName,
    sanitizeSessionName: (input) => input?.trim() || 'demo',
  });
  const queue = createDaemonInputQueueRuntime({
    sessions: new Map(),
    mirrors,
    getMirrorKey: (sessionName) => sessionName,
    sendTransportMessage: vi.fn(),
    sendMessage: vi.fn(),
    handleInput: vi.fn(async () => true),
    writeBackendInputGroup: controlRuntime.writeBackendInputGroup,
    resolveBackendInputMaxChunkBytes: controlRuntime.resolveBackendInputMaxChunkBytes,
  });
  return { controlRuntime, queue, mirrors };
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

async function waitForTmuxWriteSettle() {
  await new Promise((resolve) => setTimeout(resolve, TERMINAL_INPUT_TMUX_WRITE_SETTLE_MS + 1));
}

describe('daemon input queue runtime', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
  });

  it('coalesces burst literal input for the same mirror into one tmux write', async () => {
    await runSpawnMockImmediately();
    const { queue } = createRuntime();

    const writes = await Promise.all([
      queue.enqueueLiveMirrorInput('demo', 'a', false, () => true),
      queue.enqueueLiveMirrorInput('demo', 'b', false, () => true),
      queue.enqueueLiveMirrorInput('demo', 'c', false, () => true),
    ]);

    expect(writes).toEqual([true, true, true]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      'send-keys',
      '-t',
      '=demo:.{top-left}',
      '-l',
      '--',
      'abc',
    ]);
  });

  it('does not include stale queued input in a coalesced tmux write', async () => {
    await runSpawnMockImmediately();
    const { queue } = createRuntime();

    const writes = await Promise.all([
      queue.enqueueLiveMirrorInput('demo', 'old', false, () => false),
      queue.enqueueLiveMirrorInput('demo', 'new', false, () => true),
    ]);

    expect(writes).toEqual([false, true]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      'send-keys',
      '-t',
      '=demo:.{top-left}',
      '-l',
      '--',
      'new',
    ]);
  });

  it('preserves append-enter boundaries while batching surrounding literal input', async () => {
    await runSpawnMockImmediately();
    const { queue } = createRuntime();

    const writes = await Promise.all([
      queue.enqueueLiveMirrorInput('demo', 'echo ok', true, () => true),
      queue.enqueueLiveMirrorInput('demo', 'next', false, () => true),
    ]);

    expect(writes).toEqual([true, true]);
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      'send-keys',
      '-t',
      '=demo:.{top-left}',
      '-l',
      '--',
      'echo ok',
    ]);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual(['send-keys', '-t', '=demo:.{top-left}', 'Enter']);
    expect(spawnMock.mock.calls[2]?.[1]).toEqual([
      'send-keys',
      '-t',
      '=demo:.{top-left}',
      '-l',
      '--',
      'next',
    ]);
  });

  it('splits coalesced burst input before tmux write groups exceed the safe byte budget', async () => {
    await runSpawnMockImmediately();
    const { queue } = createRuntime();
    const first = 'a'.repeat(TERMINAL_INPUT_TMUX_WRITE_CHUNK_BYTES - 16);
    const second = `${'b'.repeat(24)}中文😀tail`;

    const writes = await Promise.all([
      queue.enqueueLiveMirrorInput('demo', first, false, () => true),
      queue.enqueueLiveMirrorInput('demo', second, false, () => true),
    ]);

    expect(writes).toEqual([true, true]);
    const payloadWrites = spawnMock.mock.calls
      .map((call) => call[1] as string[])
      .filter((args) => args.includes('-l'))
      .map((args) => args[args.length - 1] || '');
    expect(payloadWrites.length).toBeGreaterThan(1);
    expect(payloadWrites.join('')).toBe(`${first}${second}`);
    for (const payload of payloadWrites) {
      expect(getTerminalInputUtf8ByteLength(payload)).toBeLessThanOrEqual(
        TERMINAL_INPUT_TMUX_WRITE_CHUNK_BYTES,
      );
    }
  });

  it('does not resolve an oversized single input item until all of its tmux chunks finish', async () => {
    const children: Array<ReturnType<typeof createFakeChild>> = [];
    spawnMock.mockImplementation(() => {
      const child = createFakeChild();
      children.push(child);
      return child;
    });
    const { queue } = createRuntime();
    const source = `${'x'.repeat(TERMINAL_INPUT_TMUX_WRITE_CHUNK_BYTES)}${'y'.repeat(64)}`;

    let resolved = false;
    const write = queue.enqueueLiveMirrorInput('demo', source, false, () => true).then((value) => {
      resolved = true;
      return value;
    });

    await Promise.resolve();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    children[0]?.emit('close', 0);
    await Promise.resolve();
    expect(resolved).toBe(false);
    await waitForTmuxWriteSettle();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    children[1]?.emit('close', 0);
    await expect(write).resolves.toBe(true);
    expect(resolved).toBe(true);
  });

  it('drains input queued while a previous tmux write is still in flight', async () => {
    const children: Array<ReturnType<typeof createFakeChild>> = [];
    spawnMock.mockImplementation(() => {
      const child = createFakeChild();
      children.push(child);
      return child;
    });
    const { queue } = createRuntime();

    const firstWrite = queue.enqueueLiveMirrorInput('demo', 'first', false, () => true);
    await Promise.resolve();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const secondWrite = queue.enqueueLiveMirrorInput('demo', 'second', false, () => true);
    children[0]?.emit('close', 0);
    await expect(firstWrite).resolves.toBe(true);
    await Promise.resolve();
    await waitForTmuxWriteSettle();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      'send-keys',
      '-t',
      '=demo:.{top-left}',
      '-l',
      '--',
      'second',
    ]);

    children[1]?.emit('close', 0);
    await expect(secondWrite).resolves.toBe(true);
  });

  it('disposeLiveMirrorInputBatch evicts queued items and reports evicted count', async () => {
    spawnMock.mockImplementation(() => createFakeChild());
    const { queue } = createRuntime();

    const promiseA = queue.enqueueLiveMirrorInput('demo', 'a', false, () => true);
    const promiseB = queue.enqueueLiveMirrorInput('demo', 'b', false, () => true);
    const evicted = queue.disposeLiveMirrorInputBatch('demo', 'unit-test');
    expect(evicted).toBe(2);
    expect(await Promise.all([promiseA, promiseB])).toEqual([false, false]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('disposeLiveMirrorInputBatch is a no-op when nothing is queued', () => {
    const { queue } = createRuntime();
    expect(queue.disposeLiveMirrorInputBatch('demo', 'unit-test')).toBe(0);
  });

  it('re-enqueueing after dispose creates a fresh batch with no leftover items', async () => {
    let calls = 0;
    spawnMock.mockImplementation(() => {
      calls += 1;
      const child = createFakeChild();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    const { queue } = createRuntime();

    const stale = queue.enqueueLiveMirrorInput('demo', 'stale', false, () => true);
    queue.disposeLiveMirrorInputBatch('demo', 'unit-test');
    expect(await stale).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();

    const fresh = queue.enqueueLiveMirrorInput('demo', 'fresh', false, () => true);
    expect(await fresh).toBe(true);
    expect(calls).toBe(1);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      'send-keys',
      '-t',
      '=demo:.{top-left}',
      '-l',
      '--',
      'fresh',
    ]);
  });

  it('routes queued input through the selected external backend', async () => {
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
    const controlRuntime = createTerminalControlRuntime({
      tmuxBinary: 'tmux',
      defaultSessionName: 'demo',
      hiddenTmuxSessions: new Set(),
      mirrors,
      getMirrorKey: (sessionName) => sessionName,
      sanitizeSessionName: (input) => input?.trim() || 'demo',
      wezTermBackend,
      defaultBackend: 'wezterm',
    });
    const queue = createDaemonInputQueueRuntime({
      sessions: new Map(),
      mirrors,
      getMirrorKey: (sessionName) => sessionName,
      sendTransportMessage: vi.fn(),
      sendMessage: vi.fn(),
      handleInput: vi.fn(async () => true),
      writeBackendInputGroup: controlRuntime.writeBackendInputGroup,
      resolveBackendInputMaxChunkBytes: controlRuntime.resolveBackendInputMaxChunkBytes,
    });

    expect(await queue.enqueueLiveMirrorInput('demo', 'abc', false, () => true)).toBe(true);
    expect(wezTermBackend.writeInput).toHaveBeenCalledWith('demo', 'abc');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
