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

  it('creates a tmux session and republishes the catalog', () => {
    const deps = makeDeps({
      listTerminalSessionCatalog: vi.fn(() => [
        { name: 'tmux-default', backend: 'tmux' },
        { name: 'tmux-new', backend: 'tmux' },
      ]),
      createDetachedTmuxSession: vi.fn(),
    });

    const result = handleTmuxControlMessageRuntime(deps, connection, {
      type: 'tmux-create-session',
      payload: { sessionName: 'tmux-new' },
    });

    expect(deps.createDetachedTmuxSession).toHaveBeenCalledWith('tmux-new', undefined, 'tmux');
    expect(result).toEqual({ ok: true });
    expect(deps.sendTransportMessage).toHaveBeenCalledWith(null, expect.objectContaining({ type: 'sessions' }));
  });

  it('routes tmux rename through the resolved tmux backend', () => {
    const deps = makeDeps({
      resolveTerminalSessionBackend: vi.fn(() => 'tmux'),
      renameTmuxSession: vi.fn(() => 'renamed'),
      listTerminalSessionCatalog: vi.fn(() => [
        { name: 'renamed', backend: 'tmux' },
      ]),
    });

    const result = handleTmuxControlMessageRuntime(deps, connection, {
      type: 'tmux-rename-session',
      payload: { sessionName: 'original', nextSessionName: 'renamed' },
    });

    expect(result).toEqual({ ok: true });
    expect(deps.renameTmuxSession).toHaveBeenCalledWith('original', 'renamed', 'tmux');
  });

  it('projects tmux-only rename failure with the typed tmux_rename_failed code', () => {
    const deps = makeDeps({
      resolveTerminalSessionBackend: vi.fn(),
      renameTmuxSession: vi.fn(() => {
        throw new Error('tmux rename-session permission denied');
      }),
    });

    const result = handleTmuxControlMessageRuntime(deps, connection, {
      type: 'tmux-rename-session',
      payload: {
        sessionName: 'tmux-original',
        nextSessionName: 'tmux-renamed',
      },
    });

    expect(deps.renameTmuxSession).toHaveBeenCalledWith('tmux-original', 'tmux-renamed', 'tmux');
    expect(result).toEqual({
      ok: false,
      code: 'tmux_rename_failed',
      message: 'Failed to rename tmux session: tmux rename-session permission denied',
    });
    expect(deps.sendTransportMessage).toHaveBeenCalledWith(null, {
      type: 'error',
      payload: {
        code: 'tmux_rename_failed',
        message: 'Failed to rename tmux session: tmux rename-session permission denied',
      },
    });
  });

  it('keeps tmux rename success unchanged when backend is tmux', () => {
    const deps = makeDeps({
      resolveTerminalSessionBackend: vi.fn(() => 'tmux'),
      renameTmuxSession: vi.fn(() => 'tmux-1-renamed'),
      listTerminalSessionCatalog: vi.fn(() => [
        { name: 'tmux-1-renamed', backend: 'tmux' },
      ]),
    });

    const result = handleTmuxControlMessageRuntime(deps, connection, {
      type: 'tmux-rename-session',
      payload: { sessionName: 'tmux-1', nextSessionName: 'tmux-1-renamed' },
    });

    expect(result).toEqual({ ok: true });
    expect(deps.renameTmuxSession).toHaveBeenCalledWith('tmux-1', 'tmux-1-renamed', 'tmux');
  });

  it('keeps tmux rename binary failure on the generic tmux_rename_failed code', () => {
    const deps = makeDeps({
      resolveTerminalSessionBackend: vi.fn(() => 'tmux'),
      renameTmuxSession: vi.fn(() => {
        throw new Error('tmux: rename-session permission denied');
      }),
      listTerminalSessionCatalog: vi.fn(() => []),
    });

    const result = handleTmuxControlMessageRuntime(deps, connection, {
      type: 'tmux-rename-session',
      payload: { sessionName: 'tmux-1', nextSessionName: 'tmux-1-renamed' },
    });

    expect(result).toEqual({
      ok: false,
      code: 'tmux_rename_failed',
      message: 'Failed to rename tmux session: tmux: rename-session permission denied',
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
      resolveTerminalSessionBackend: vi.fn(() => 'tmux'),
      runTmux: vi.fn((args: string[]) => ({
        ok: true as const,
        stdout: args[0] === 'list-panes' ? '99\tcodex' : '',
      })),
      readProcessGroup: vi.fn(() => ({ groupId: 'pg-1', alive: true })),
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
        sessionCatalog: [expect.objectContaining({ name: 'live', backend: 'tmux', observation: expect.objectContaining({ status: 'unknown' }) })],
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

  it('treats an already absent tmux session as idempotently closed and republishes the catalog', () => {
    const deps = makeDeps({
      closeDetachedTerminalSession: vi.fn(() => {
        throw new Error("can't find session: stale");
      }),
      listTerminalSessionCatalog: vi.fn(() => [
        { name: 'tmux-live', backend: 'tmux' },
        { name: 'tmux-stale', backend: 'tmux' },
      ]),
      runTmux: vi.fn((args: string[]) => ({
        ok: true as const,
        stdout: args[0] === 'list-panes' ? '99\tcodex' : '',
      })),
      readProcessGroup: vi.fn(() => ({ groupId: 'pg-1', alive: true })),
    });

    const result = handleTmuxControlMessageRuntime(deps, connection, {
      type: 'tmux-kill-session',
      payload: { sessionName: 'stale' },
    });

    expect(deps.closeDetachedTerminalSession).toHaveBeenCalledWith('stale', 'tmux');
    expect(deps.scheduleEngine.markSessionMissing).toHaveBeenCalledWith('stale', 'session already absent', 'tmux');
    expect(result).toEqual({ ok: true });
    expect(deps.sendTransportMessage).toHaveBeenCalledWith(null, expect.objectContaining({ type: 'sessions' }));
  });
});
