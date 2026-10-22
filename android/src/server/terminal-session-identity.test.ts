import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('node:child_process', () => childProcessMocks);

import { createTerminalControlRuntime } from './terminal-control-runtime';
import { buildTmuxSessionStableId } from './terminal-source-adapter';

type IdentityRuntime = ReturnType<typeof createTerminalControlRuntime> & {
  readSessionIdentity: (target: {
    backend: 'tmux' | 'herdr';
    sessionName: string;
  }) => { backend: 'tmux' | 'herdr'; sessionName: string; stableId: string } | null;
  resolveExistingSession: (
    stableId: string,
    backend: 'tmux' | 'herdr',
    sessionName?: string,
  ) =>
    | {
        ok: true;
        session: {
          identity: { backend: 'tmux' | 'herdr'; sessionName: string; stableId: string };
          target: Record<string, unknown>;
        };
      }
    | { ok: false; code: 'session_not_found' | 'session_identity_mismatch'; message: string };
};

const socketA = '/tmp/zterm-identity-a/default';
const socketB = '/tmp/zterm-identity-b/default';

function successful(stdout: string) {
  return { status: 0, stdout, stderr: '', error: undefined };
}

describe('terminal session stable identity', () => {
  let rowsBySocket: Map<string, string>;

  beforeEach(() => {
    childProcessMocks.spawn.mockReset();
    childProcessMocks.spawnSync.mockReset();
    rowsBySocket = new Map([
      [socketA, ['work\t$1\t100\t900', 'other\t$2\t101\t900'].join('\n')],
      [socketB, ['remote\t$3\t102\t901'].join('\n')],
    ]);
    childProcessMocks.spawnSync.mockImplementation((_binary: string, args: string[]) => {
      const socketIndex = args.indexOf('-S');
      const socketPath = socketIndex >= 0 ? args[socketIndex + 1] : undefined;
      if (!socketPath) {
        return { status: 1, stdout: '', stderr: 'no server running', error: undefined };
      }
      const command = socketIndex >= 0 ? args[socketIndex + 2] : args[0];
      if (command === 'list-sessions') {
        const rows = rowsBySocket.get(socketPath);
        if (!rows) {
          return { status: 1, stdout: '', stderr: 'no server running', error: undefined };
        }
        const formatIndex = args.indexOf('-F');
        const format = formatIndex >= 0 ? args[formatIndex + 1] : '';
        const stdout = format === '#S'
          ? rows.split('\n').map((line) => line.split('\t')[0]).join('\n')
          : rows;
        return successful(`${stdout}\n`);
      }
      if (command === 'list-panes') {
        return successful(`${rowsBySocket.get(socketPath) || ''}\n`);
      }
      return successful('');
    });
  });

  function createRuntime() {
    return createTerminalControlRuntime({
      tmuxBinary: 'tmux',
      defaultSessionName: 'demo',
      hiddenTmuxSessions: new Set(),
      tmuxSocketPaths: () => [socketA, socketB],
      sanitizeSessionName: (input?: string) => input?.trim() || 'demo',
      defaultBackend: 'tmux',
    }) as IdentityRuntime;
  }

  it('keeps socket, server generation, session id, and creation in the opaque identity', () => {
    const runtime = createRuntime();

    const identity = runtime.readSessionIdentity({ backend: 'tmux', sessionName: 'work' });

    expect(identity).toMatchObject({ backend: 'tmux', sessionName: 'work' });
    expect(identity?.stableId).toMatch(/^tmux:v1:/u);
    expect(identity?.stableId).not.toContain('work');
    expect(runtime.listTerminalSessionCatalog()).toContainEqual(
      expect.objectContaining({
        name: 'work',
        backend: 'tmux',
        stableId: identity?.stableId,
      }),
    );
  });

  it('rejects an old stable identity when tmux recreates the same display name', () => {
    const runtime = createRuntime();
    const original = runtime.readSessionIdentity({ backend: 'tmux', sessionName: 'work' });

    rowsBySocket.set(socketA, [
      'work\t$9\t200\t900',
      'other\t$2\t101\t900',
    ].join('\n'));

    expect(runtime.resolveExistingSession(original!.stableId, 'tmux', 'work')).toMatchObject({
      ok: false,
      code: 'session_identity_mismatch',
    });

    const recreated = runtime.resolveExistingSession(
      runtime.readSessionIdentity({ backend: 'tmux', sessionName: 'work' })!.stableId,
      'tmux',
      'work',
    );
    expect(recreated).toMatchObject({
      ok: true,
      session: {
        identity: { backend: 'tmux', sessionName: 'work' },
        target: {
          backend: 'tmux',
          sessionName: 'work',
          socketPath: socketA,
          sessionId: '$9',
          createdAt: 200,
        },
      },
    });
  });

  it('does not resolve a tmux identity as the same-name Herdr session', () => {
    const runtime = createRuntime();
    const tmuxIdentity = runtime.readSessionIdentity({ backend: 'tmux', sessionName: 'work' });

    expect(runtime.resolveExistingSession(tmuxIdentity!.stableId, 'herdr', 'work')).toMatchObject({
      ok: false,
      code: 'session_identity_mismatch',
    });
  });

  it('returns session_not_found for a valid identity that is no longer present', () => {
    const runtime = createRuntime();
    const missingIdentity = buildTmuxSessionStableId({
      socketPath: '/tmp/zterm-identity-gone/default',
      serverPid: '777',
      sessionId: '$404',
      createdAt: 1,
    });

    expect(runtime.resolveExistingSession(missingIdentity, 'tmux', 'missing')).toMatchObject({
      ok: false,
      code: 'session_not_found',
    });
  });

  it('keeps bound input and capture targets on the original socket and session id after recreation', async () => {
    const runtime = createRuntime();
    const identity = runtime.readSessionIdentity({ backend: 'tmux', sessionName: 'work' })!;
    const resolved = runtime.resolveExistingSession(identity.stableId, 'tmux', 'work');
    if (!resolved.ok) {
      throw new Error(resolved.message);
    }
    runtime.bindResolvedSession(resolved.session);

    rowsBySocket.set(socketA, [
      'work\t$9\t200\t900',
      'other\t$2\t101\t900',
    ].join('\n'));
    childProcessMocks.spawn.mockImplementation(() => {
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

    await runtime.writeBackendInputGroup('work', 'echo exact', false, 'tmux');
    await runtime.runTmuxAsyncForSession([
      'capture-pane',
      '-p',
      '-t',
      '=work:.{top-left}',
    ], 'work');

    expect(childProcessMocks.spawn.mock.calls.map((call) => call[1])).toEqual([
      ['-S', socketA, 'send-keys', '-t', '$1:.{top-left}', '-l', '--', 'echo exact'],
      ['-S', socketA, 'capture-pane', '-p', '-t', '$1:.{top-left}'],
    ]);
  });

  it('rejects rebinding a live native target to a different stable identity with the same display name', async () => {
    const runtime = createRuntime();
    const identityA = runtime.readSessionIdentity({ backend: 'tmux', sessionName: 'work' })!;
    const resolvedA = runtime.resolveExistingSession(identityA.stableId, 'tmux', 'work');
    if (!resolvedA.ok) {
      throw new Error(resolvedA.message);
    }
    runtime.bindResolvedSession(resolvedA.session);

    rowsBySocket.set(socketB, ['work\t$3\t102\t901'].join('\n'));
    const stableB = buildTmuxSessionStableId({
      socketPath: socketB,
      serverPid: '901',
      sessionId: '$3',
      createdAt: 102,
    });
    const resolvedB = runtime.resolveExistingSession(stableB, 'tmux', 'work');
    if (!resolvedB.ok) {
      throw new Error(resolvedB.message);
    }

    expect(() => runtime.bindResolvedSession(resolvedB.session)).toThrow(/live|different|bound/u);

    childProcessMocks.spawn.mockImplementation(() => {
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
    await runtime.writeBackendInputGroup('work', 'echo exact', false, 'tmux');

    expect(childProcessMocks.spawn.mock.calls.map((call) => call[1])).toEqual([
      ['-S', socketA, 'send-keys', '-t', '$1:.{top-left}', '-l', '--', 'echo exact'],
    ]);
  });

  it('replaces a dead native binding when the same display name is recreated', async () => {
    const runtime = createRuntime();
    const identityA = runtime.readSessionIdentity({ backend: 'tmux', sessionName: 'work' })!;
    const resolvedA = runtime.resolveExistingSession(identityA.stableId, 'tmux', 'work');
    if (!resolvedA.ok) {
      throw new Error(resolvedA.message);
    }
    runtime.bindResolvedSession(resolvedA.session);

    rowsBySocket.set(socketA, ['work\t$9\t200\t900', 'other\t$2\t101\t900'].join('\n'));
    const stableB = buildTmuxSessionStableId({
      socketPath: socketA,
      serverPid: '900',
      sessionId: '$9',
      createdAt: 200,
    });
    const resolvedB = runtime.resolveExistingSession(stableB, 'tmux', 'work');
    if (!resolvedB.ok) {
      throw new Error(resolvedB.message);
    }

    expect(() => runtime.bindResolvedSession(resolvedB.session)).not.toThrow();

    childProcessMocks.spawn.mockImplementation(() => {
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
    await runtime.writeBackendInputGroup('work', 'echo exact', false, 'tmux');

    expect(childProcessMocks.spawn.mock.calls.map((call) => call[1])).toEqual([
      ['-S', socketA, 'send-keys', '-t', '$9:.{top-left}', '-l', '--', 'echo exact'],
    ]);
  });

  function mockSuccessfulSpawn() {
    childProcessMocks.spawn.mockImplementation(() => {
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
  }

  it('routes a bound later-discovered same-name socket after a public catalog refresh', async () => {
    rowsBySocket.set(socketA, ['work\t$1\t100\t900'].join('\n'));
    rowsBySocket.set(socketB, ['work\t$3\t102\t901'].join('\n'));
    const runtime = createRuntime();
    const stableB = buildTmuxSessionStableId({
      socketPath: socketB,
      serverPid: '901',
      sessionId: '$3',
      createdAt: 102,
    });
    const resolvedB = runtime.resolveExistingSession(stableB, 'tmux', 'work');
    if (!resolvedB.ok) {
      throw new Error(resolvedB.message);
    }
    runtime.bindResolvedSession(resolvedB.session);

    // The public catalog refresh rebuilds the discovery cache from the first
    // same-name entry it sees (socket A). It must not steal the pinned route.
    expect(runtime.listTerminalSessionCatalog().filter((entry) => entry.name === 'work')).toHaveLength(2);

    mockSuccessfulSpawn();
    await runtime.writeBackendInputGroup('work', 'echo later-b', false, 'tmux');
    await runtime.runTmuxAsyncForSession([
      'capture-pane',
      '-p',
      '-t',
      '=work:.{top-left}',
    ], 'work');

    expect(childProcessMocks.spawn.mock.calls.map((call) => call[1])).toEqual([
      ['-S', socketB, 'send-keys', '-t', '$3:.{top-left}', '-l', '--', 'echo later-b'],
      ['-S', socketB, 'capture-pane', '-p', '-t', '$3:.{top-left}'],
    ]);
  });

  it('keeps a pinned default-socket binding off a discovered socket after a public catalog refresh', async () => {
    rowsBySocket.set(socketA, ['work\t$1\t100\t900'].join('\n'));
    const runtime = createRuntime();
    const stableId = buildTmuxSessionStableId({
      serverPid: '888',
      sessionId: '$5',
      createdAt: 50,
    });
    runtime.bindResolvedSession({
      identity: { backend: 'tmux', sessionName: 'work', stableId },
      target: {
        backend: 'tmux',
        sessionName: 'work',
        stableId,
        serverPid: '888',
        sessionId: '$5',
        createdAt: 50,
      },
    });

    expect(runtime.listTerminalSessionCatalog().some((entry) => entry.name === 'work')).toBe(true);

    mockSuccessfulSpawn();
    await runtime.writeBackendInputGroup('work', 'echo default-socket', false, 'tmux');
    await runtime.runTmuxAsyncForSession([
      'capture-pane',
      '-p',
      '-t',
      '=work:.{top-left}',
    ], 'work');

    expect(childProcessMocks.spawn.mock.calls.map((call) => call[1])).toEqual([
      ['send-keys', '-t', '$5:.{top-left}', '-l', '--', 'echo default-socket'],
      ['capture-pane', '-p', '-t', '$5:.{top-left}'],
    ]);
  });

  it('publishes each distinct native target for a duplicated display name', () => {
    rowsBySocket.set(socketA, ['work\t$1\t100\t900'].join('\n'));
    rowsBySocket.set(socketB, ['work\t$3\t102\t901'].join('\n'));
    const runtime = createRuntime();

    const catalog = runtime.listTerminalSessionCatalog();
    const workEntries = catalog.filter((entry) => entry.name === 'work');
    const stableA = buildTmuxSessionStableId({
      socketPath: socketA,
      serverPid: '900',
      sessionId: '$1',
      createdAt: 100,
    });
    const stableB = buildTmuxSessionStableId({
      socketPath: socketB,
      serverPid: '901',
      sessionId: '$3',
      createdAt: 102,
    });

    expect(workEntries).toHaveLength(2);
    expect(workEntries.map((entry) => entry.stableId).sort()).toEqual([stableA, stableB].sort());
    expect(workEntries.every((entry) => entry.cwd === undefined)).toBe(true);
    expect(runtime.listTerminalSessions()).toEqual(['work']);

    rowsBySocket.set(socketB, [
      'work\t$3\t102\t901',
      'legacy\t$4\tnot-a-number\t901',
    ].join('\n'));
    const catalogWithLegacyEntry = runtime.listTerminalSessionCatalog();
    const legacyEntry = catalogWithLegacyEntry.find((entry) => entry.name === 'legacy');

    expect(legacyEntry).toMatchObject({ name: 'legacy', backend: 'tmux' });
    expect(legacyEntry).not.toHaveProperty('stableId');
    expect(runtime.listTerminalSessions()).toEqual(['legacy', 'work']);
  });
});
