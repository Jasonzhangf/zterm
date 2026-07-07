import { describe, expect, it, vi } from 'vitest';
import { createSessionBufferState } from '../lib/terminal-buffer';
import type { Session } from '../lib/types';
import { initialSessionManagerState, reduceSessionAction, type SessionAction, type SessionManagerState } from './session-context-core';
import { applySessionActionRuntime, isSessionTransportActiveRuntime } from './session-context-infra-runtime';

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

describe('applySessionActionRuntime', () => {
  it('does not dispatch when reducer returns the same state object', () => {
    const state = buildState();
    const stateRef = { current: state };
    const dispatch = vi.fn();
    const action: SessionAction = {
      type: 'UPDATE_SESSION',
      id: 's1',
      updates: {
        state: 'connected',
        title: 's1',
      },
    };

    const changed = applySessionActionRuntime({
      stateRef,
      action,
      reduceSessionAction,
      dispatch,
    });

    expect(changed).toBe(false);
    expect(stateRef.current).toBe(state);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatches when reducer produces a new state object', () => {
    const state = buildState();
    const stateRef = { current: state };
    const dispatch = vi.fn();
    const action: SessionAction = {
      type: 'UPDATE_SESSION',
      id: 's1',
      updates: {
        title: 'renamed',
      },
    };

    const changed = applySessionActionRuntime({
      stateRef,
      action,
      reduceSessionAction,
      dispatch,
    });

    expect(changed).toBe(true);
    expect(stateRef.current).not.toBe(state);
    expect(stateRef.current.sessions[0]?.title).toBe('renamed');
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(action);
  });

  it('treats the active session as transport-active even before live pane ids catch up', () => {
    const state: SessionManagerState = {
      ...initialSessionManagerState,
      sessions: [buildSession('s1'), buildSession('s2')],
      activeSessionId: 's2',
      liveSessionIds: ['s1'],
      liveSessionIdsExplicit: true,
    };
    const stateRef = { current: state };

    expect(isSessionTransportActiveRuntime({ sessionId: 's2', stateRef })).toBe(true);
    expect(isSessionTransportActiveRuntime({ sessionId: 's1', stateRef })).toBe(true);
    expect(isSessionTransportActiveRuntime({ sessionId: 'missing', stateRef })).toBe(false);
  });
});
