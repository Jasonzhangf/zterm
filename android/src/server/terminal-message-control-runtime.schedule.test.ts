import { describe, expect, it, vi } from 'vitest';
import {
  handleScheduleMessageRuntime,
  handleTmuxControlMessageRuntime,
  type TerminalMessageControlRuntimeDeps,
} from './terminal-message-control-runtime';
import type { TerminalSession, TerminalTransportConnection } from './terminal-runtime-types';

function makeSession(): TerminalSession {
  return {
    id: 'server-session-1',
    sessionName: 'tmux-1',
    mirrorKey: 'tmux-1',
    transport: null,
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
    createTransportSubscriber: vi.fn(() => makeSession()),
    createMuxChannelSubscriber: vi.fn(() => makeSession()),
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
});

describe('terminal-message-control-runtime tmux kill truth', () => {
  const connection = { transport: null } as unknown as TerminalTransportConnection;

  it('treats an already absent tmux session as idempotently closed and republishes the current list', () => {
    const deps = makeDeps({
      closeDetachedTerminalSession: vi.fn(() => {
        throw new Error("can't find session: stale");
      }),
      listTmuxSessions: vi.fn(() => ['live']),
    });

    handleTmuxControlMessageRuntime(deps, connection, {
      type: 'tmux-kill-session',
      payload: { sessionName: 'stale' },
    });

    expect(deps.scheduleEngine.markSessionMissing).toHaveBeenCalledWith('stale', 'session already absent');
    expect(deps.sendTransportMessage).toHaveBeenCalledWith(null, {
      type: 'sessions',
      payload: { sessions: ['live'] },
    });
    expect(deps.sendTransportMessage).not.toHaveBeenCalledWith(null, expect.objectContaining({ type: 'error' }));
  });

  it('keeps a real tmux kill failure explicit', () => {
    const deps = makeDeps({
      closeDetachedTerminalSession: vi.fn(() => {
        throw new Error('permission denied');
      }),
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
});
