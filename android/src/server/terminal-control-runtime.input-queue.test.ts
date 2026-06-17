import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTerminalControlRuntime } from './terminal-control-runtime';

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
  queueMicrotask(() => child.emit('close', 0));
  return child;
}

function createReadyMirror() {
  return {
    key: 'demo',
    sessionName: 'demo',
    lifecycle: 'ready',
  } as any;
}

function createRuntime() {
  const mirrors = new Map<string, any>([['demo', createReadyMirror()]]);
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

describe('terminal control runtime input queue', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnSyncMock.mockReset();
    spawnMock.mockImplementation(() => createFakeChild());
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
  });

  it('coalesces burst literal input for the same mirror into one tmux write', async () => {
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

  it('does not include stale queued input in a coalesced tmux write', async () => {
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
});
