import { describe, expect, it, vi } from 'vitest';
import {
  requestScheduleListRuntime,
  runScheduleJobNowRuntime,
  sendMessageRuntime,
} from './session-context-public-runtime';
import type { Session, SessionScheduleState } from '../lib/types';

function makeSession(overrides?: Partial<Session>): Session {
  return {
    id: 'session-1',
    hostId: 'host-1',
    connectionName: 'Conn',
    bridgeHost: '100.127.23.27',
    bridgePort: 3333,
    sessionName: 'tmux-1',
    title: 'tmux-1',
    ws: null,
    state: 'connected',
    hasUnread: false,
    createdAt: 1,
    ...overrides,
  };
}

function reduceScheduleCall(
  setScheduleStateForSession: ReturnType<typeof vi.fn>,
  current: SessionScheduleState = { sessionName: 'tmux-1', jobs: [], loading: true },
) {
  const lastCall = setScheduleStateForSession.mock.calls[setScheduleStateForSession.mock.calls.length - 1];
  const reducer = lastCall?.[1] as
    | SessionScheduleState
    | ((state: SessionScheduleState) => SessionScheduleState);
  return typeof reducer === 'function' ? reducer(current) : reducer;
}

describe('session-context-public-runtime schedule send lifecycle', () => {
  it('sendMessageRuntime delegates to client.daemon_connection', () => {
    const daemonConnection = {
      sendSessionMessage: vi.fn(() => true),
    } as any;

    expect(sendMessageRuntime({
      sessionId: 'session-1',
      msg: { type: 'ping' },
      daemonConnection,
    })).toBe(true);

    expect(daemonConnection.sendSessionMessage).toHaveBeenCalledWith(
      'session-1',
      { type: 'ping' },
    );
  });

  it('requestScheduleListRuntime writes a visible transport error when send fails', () => {
    const setScheduleStateForSession = vi.fn();

    requestScheduleListRuntime({
      sessionId: 'session-1',
      sessions: [makeSession()],
      setScheduleStateForSession,
      sendMessage: vi.fn(() => false),
    });

    expect(reduceScheduleCall(setScheduleStateForSession)).toMatchObject({
      sessionName: 'tmux-1',
      loading: false,
      error: 'schedule transport not connected',
    });
  });

  it('runScheduleJobNowRuntime writes session-not-found instead of silently returning', () => {
    const setScheduleStateForSession = vi.fn();
    const sendMessage = vi.fn();

    runScheduleJobNowRuntime({
      sessionId: 'missing-session',
      jobId: 'job-1',
      sessions: [makeSession()],
      setScheduleStateForSession,
      sendMessage,
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(reduceScheduleCall(setScheduleStateForSession)).toMatchObject({
      loading: false,
      error: 'schedule session not found',
    });
  });
});
