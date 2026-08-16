import { describe, expect, it, vi } from 'vitest';
import { createDaemonControlGateway } from './daemon-control-gateway-runtime';
import type {
  TerminalMessageControlRuntimeDeps,
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
    runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
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

function makeConnection(): TerminalTransportConnection {
  return {
    transportId: 'transport-1',
    transport: {
      kind: 'ws',
      readyState: 1,
      requestOrigin: undefined,
      connectedSent: false,
      sendText: vi.fn(),
      close: vi.fn(),
    },
    closeTransport: vi.fn(),
    requestOrigin: 'http://127.0.0.1:3333',
    role: 'pending',
    boundSubscriberId: null,
  };
}

describe('daemon control gateway outcome truth', () => {
  it('returns handler_failed and audits error when a control handler emits a business error', async () => {
    const deps = makeDeps();
    const gateway = createDaemonControlGateway(deps);

    const outcome = await gateway.handleScheduleControl(null, {
      type: 'schedule-delete',
      payload: { jobId: 'missing-job' },
    }, null, 'subject-1');

    expect(outcome).toEqual({
      ok: false,
      error: {
        code: 'handler_failed',
        commandType: 'schedule-delete',
        message: 'schedule-delete requires an attached session transport',
      },
    });
    expect(gateway.getAuditEntries()).toHaveLength(1);
    expect(gateway.getAuditEntries()[0]?.result).toBe('error');
    expect(deps.sendTransportMessage).toHaveBeenCalledWith(null, {
      type: 'error',
      payload: {
        message: 'schedule-delete requires an attached session transport',
        code: 'session_required',
      },
    });
  });

  it('returns dispatched only when a tmux control handler succeeds', async () => {
    const deps = makeDeps();
    const gateway = createDaemonControlGateway(deps);
    const connection = makeConnection();

    const outcome = await gateway.handleTmuxControl(connection, {
      type: 'tmux-create-session',
      payload: { sessionName: 'new-session' },
    });

    expect(outcome).toEqual({ ok: true, value: { dispatched: true } });
    expect(deps.createDetachedTmuxSession).toHaveBeenCalledWith('new-session', undefined, 'tmux');
    expect(gateway.getAuditEntries()[0]?.result).toBe('ok');
  });
});
