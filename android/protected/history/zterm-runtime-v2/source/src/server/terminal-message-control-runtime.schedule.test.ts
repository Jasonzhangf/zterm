import { describe, expect, it, vi } from 'vitest';
import {
  handleScheduleMessageRuntime,
  handleTmuxControlMessageRuntime,
  type TerminalMessageControlRuntimeDeps,
} from './terminal-message-control-runtime';
import type { TerminalSession, TerminalTransportConnection } from './terminal-runtime-types';

function makeSession(backend: 'tmux' | 'herdr' = 'tmux'): TerminalSession {
  return {
    id: 'server-session-1',
    sessionName: 'tmux-1',
    mirrorKey: 'tmux-1',
    transport: null,
    backend,
  } as TerminalSession;
}

function makeDeps(overrides?: Partial<TerminalMessageControlRuntimeDeps>): TerminalMessageControlRuntimeDeps {
  return {
    sessions: new Map(),
    mirrors: new Map(),
    issueSessionTransportToken: vi.fn(() => 'token-1'),
    consumeSessionTransportToken: vi.fn(() => true),
    scheduleEngine: {
      listBySession: vi.fn(() => []),
      upsert: vi.fn(),
      delete: vi.fn(() => null),
      toggle: vi.fn(() => null),
      runNow: vi.fn(async () => null),
      renameSession: vi.fn(),
      markSessionMissing: vi.fn(),
    },
    sendTransportMessage: vi.fn(),
    sendMessage: vi.fn(),
    sendScheduleStateToSession: vi.fn(),
    listTmuxSessions: vi.fn(() => []),
    createDetachedTmuxSession: vi.fn(() => 'tmux-1'),
    closeDetachedTerminalSession: vi.fn(),
    renameTmuxSession: vi.fn(() => 'tmux-2'),
    runTmux: vi.fn(() => ({ ok: true, stdout: '' })),
    sanitizeSessionName: (input?: string) => (input || '').trim(),
    resolveTerminalSessionBackend: vi.fn(() => 'tmux'),
    createTransportSubscriber: vi.fn(() => makeSession()),
    bindConnectionToSubscriber: vi.fn((_connection, session) => session),
    getMirrorKey: (sessionName: string) => sessionName,
    attachTmux: vi.fn(),
    destroyMirror: vi.fn(),
    ...overrides,
  };
}

describe('terminal-message-control-runtime schedule errors', () => {
  it('emits schedule-error when deleting a stale job', () => {
    const session = makeSession();
    const deps = makeDeps();

    handleScheduleMessageRuntime(deps, session, {
      type: 'schedule-delete',
      payload: { jobId: 'missing-job' },
    }, null);

    expect(deps.sendMessage).toHaveBeenCalledWith(session, {
      type: 'schedule-error',
      payload: {
        sessionName: 'tmux-1',
        operation: 'delete',
        jobId: 'missing-job',
        code: 'schedule_job_not_found',
        message: 'Schedule job no longer exists',
      },
    });
  });

  it('emits schedule-error when run-now resolves to a missing job', async () => {
    const session = makeSession();
    const deps = makeDeps();

    handleScheduleMessageRuntime(deps, session, {
      type: 'schedule-run-now',
      payload: { jobId: 'missing-job' },
    }, null);

    await vi.waitFor(() => {
      expect(deps.sendMessage).toHaveBeenCalledWith(session, {
        type: 'schedule-error',
        payload: {
          sessionName: 'tmux-1',
          operation: 'run-now',
          jobId: 'missing-job',
          code: 'schedule_job_not_found',
          message: 'Schedule job no longer exists',
        },
      });
    });
  });

  it('rejects every schedule operation explicitly for the Herdr single-session backend', () => {
    const session = makeSession('herdr');
    const deps = makeDeps();

    handleScheduleMessageRuntime(deps, session, {
      type: 'schedule-upsert',
      payload: { job: { targetSessionName: 'herdr-1', payload: { text: 'echo no', appendEnter: true }, rule: { kind: 'interval', intervalMs: 1000, startAt: new Date().toISOString() } } },
    }, null);

    expect(deps.scheduleEngine.upsert).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(session, expect.objectContaining({
      type: 'schedule-error',
      payload: expect.objectContaining({ code: 'herdr_schedule_unsupported', operation: 'upsert' }),
    }));
  });
});

describe('terminal-message-control-runtime tmux kill truth', () => {
  const connection = { transport: null } as unknown as TerminalTransportConnection;

  it('republishes the selected backend catalog after creating a Herdr session', () => {
    const deps = makeDeps({
      listTerminalSessionCatalog: vi.fn(() => [
        { name: 'tmux-default', backend: 'tmux' },
        { name: 'hd-codex', backend: 'herdr' },
      ]),
      createDetachedTmuxSession: vi.fn(),
    });

    handleTmuxControlMessageRuntime(deps, connection, {
      type: 'tmux-create-session',
      payload: { sessionName: 'hd-codex', terminalBackend: 'herdr' },
    });

    expect(deps.createDetachedTmuxSession).toHaveBeenCalledWith('hd-codex', undefined, 'herdr');
    expect(deps.sendTransportMessage).toHaveBeenCalledWith(null, {
      type: 'sessions',
      payload: {
        sessions: ['tmux-default', 'hd-codex'],
        sessionCatalog: [
          { name: 'tmux-default', backend: 'tmux' },
          { name: 'hd-codex', backend: 'herdr' },
        ],
      },
    });
  });

  it('treats an already absent tmux session as idempotently closed and republishes the current list', () => {
    const deps = makeDeps({
      closeDetachedTerminalSession: vi.fn(() => {
        throw new Error("can't find session: stale");
      }),
      listTerminalSessionCatalog: vi.fn(() => [
        { name: 'live', backend: 'tmux' },
      ]),
    });

    handleTmuxControlMessageRuntime(deps, connection, {
      type: 'tmux-kill-session',
      payload: { sessionName: 'stale' },
    });

    expect(deps.scheduleEngine.markSessionMissing).toHaveBeenCalledWith('stale', 'session already absent', 'tmux');
    expect(deps.sendTransportMessage).toHaveBeenCalledWith(null, {
      type: 'sessions',
      payload: {
        sessions: ['live'],
        sessionCatalog: [{ name: 'live', backend: 'tmux' }],
      },
    });
    expect(deps.sendTransportMessage).not.toHaveBeenCalledWith(null, expect.objectContaining({ type: 'error' }));
  });

  it('keeps a real tmux kill failure explicit', () => {
    const deps = makeDeps({
      closeDetachedTerminalSession: vi.fn(() => {
        throw new Error('permission denied');
      }),
      resolveTerminalSessionBackend: vi.fn(() => 'tmux'),
    });

    handleTmuxControlMessageRuntime(deps, connection, {
      type: 'tmux-kill-session',
      payload: { sessionName: 'live' },
    });

    expect(deps.sendTransportMessage).toHaveBeenCalledWith(null, {
      type: 'error',
      payload: {
        message: 'Failed to kill tmux session: permission denied',
        code: 'tmux_kill_failed',
      },
    });
  });

  it('republishes the selected Herdr catalog when an already absent Herdr session is killed', () => {
    const deps = makeDeps({
      closeDetachedTerminalSession: vi.fn(() => {
        throw new Error('herdr session not found: stale');
      }),
      listTerminalSessionCatalog: vi.fn(() => [
        { name: 'tmux-live', backend: 'tmux' },
        { name: 'herdr-live', backend: 'herdr' },
      ]),
    });

    handleTmuxControlMessageRuntime(deps, connection, {
      type: 'tmux-kill-session',
      payload: { sessionName: 'stale', terminalBackend: 'herdr' },
    });

    expect(deps.closeDetachedTerminalSession).toHaveBeenCalledWith('stale', 'herdr');
    expect(deps.sendTransportMessage).toHaveBeenCalledWith(null, {
      type: 'sessions',
      payload: {
        sessions: ['tmux-live', 'herdr-live'],
        sessionCatalog: [
          { name: 'tmux-live', backend: 'tmux' },
          { name: 'herdr-live', backend: 'herdr' },
        ],
      },
    });
  });
});
