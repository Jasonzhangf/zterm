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
});
