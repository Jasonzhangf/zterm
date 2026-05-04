import { describe, expect, it } from 'vitest';
import { createSessionBufferState } from '../lib/terminal-buffer';
import type { Session } from '../lib/types';
import { initialSessionManagerState, reduceSessionAction, type SessionManagerState } from './session-context-core';

function buildSession(id: string): Session {
  return {
    id,
    hostId: 'host-1',
    connectionName: 'local',
    bridgeHost: '127.0.0.1',
    bridgePort: 3333,
    sessionName: id,
    title: id,
    ws: null,
    state: 'connected',
    hasUnread: false,
    buffer: createSessionBufferState({
      cols: 80,
      rows: 24,
      cacheLines: 1000,
    }),
    createdAt: 1,
  };
}

function buildState(): SessionManagerState {
  return {
    ...initialSessionManagerState,
    sessions: [buildSession('s1')],
    activeSessionId: 's1',
    liveSessionIds: ['s1'],
  };
}

describe('reduceSessionAction no-op short circuit', () => {
  it('returns the same state for UPDATE_SESSION when every field is unchanged', () => {
    const state = buildState();
    const next = reduceSessionAction(state, {
      type: 'UPDATE_SESSION',
      id: 's1',
      updates: {
        title: 's1',
        state: 'connected',
        lastError: undefined,
      },
    });
    expect(next).toBe(state);
    expect(next.sessions[0]).toBe(state.sessions[0]);
  });

  it('returns the same state for SET_SESSION_STATE when state is unchanged', () => {
    const state = buildState();
    const next = reduceSessionAction(state, {
      type: 'SET_SESSION_STATE',
      id: 's1',
      state: 'connected',
    });
    expect(next).toBe(state);
    expect(next.sessions[0]).toBe(state.sessions[0]);
  });

  it('returns the same state for SET_SESSION_TITLE when title is unchanged', () => {
    const state = buildState();
    const next = reduceSessionAction(state, {
      type: 'SET_SESSION_TITLE',
      id: 's1',
      title: 's1',
    });
    expect(next).toBe(state);
    expect(next.sessions[0]).toBe(state.sessions[0]);
  });
});
