import { describe, expect, it } from 'vitest';

import {
  DomainContractError,
  canAcceptInput,
  createRoutePlan,
  createSessionId,
  createSessionTargetIdentity,
  reduceSessionState,
  selectPreferredRoute,
} from './session-domain';

const target = createSessionTargetIdentity({
  backend: 'tmux',
  daemonId: 'daemon-1',
  sessionName: 'work',
});

function initialState() {
  return reduceSessionState(
    {
      sessionId: createSessionId('session-1'),
      target,
      status: 'idle',
      selectedRoute: null,
      reconnectAttempt: 0,
      lastError: null,
    },
    { type: 'select-route', sessionId: createSessionId('session-1'), candidate: { kind: 'direct', endpoint: 'ws://a', priority: 2 } },
  );
}

describe('session identity contracts', () => {
  it('creates stable serializable identity', () => {
    const sessionId = createSessionId(' session-1 ');
    expect(sessionId).toBe('session-1');
    expect(target).toEqual({ backend: 'tmux', daemonId: 'daemon-1', sessionName: 'work' });
    expect(JSON.parse(JSON.stringify({ sessionId, target }))).toEqual({
      sessionId: 'session-1',
      target: { backend: 'tmux', daemonId: 'daemon-1', sessionName: 'work' },
    });
  });

  it('rejects blank identity fields', () => {
    expect(() => createSessionId('   ')).toThrow(DomainContractError);
    expect(() => createSessionTargetIdentity({ ...target, sessionName: '' })).toThrow(DomainContractError);
  });
});

describe('route plan contracts', () => {
  it('orders candidates by priority then deterministic identity', () => {
    const plan = createRoutePlan(target, [
      { kind: 'rtc-relay', endpoint: 'relay-2', priority: 3 },
      { kind: 'direct', endpoint: 'direct-1', priority: 1 },
      { kind: 'tailscale', endpoint: 'tailscale-1', priority: 2 },
      { kind: 'rtc-direct', endpoint: 'rtc-1', priority: 2 },
    ]);
    expect(plan.candidates.map((candidate) => candidate.endpoint)).toEqual([
      'direct-1',
      'rtc-1',
      'tailscale-1',
      'relay-2',
    ]);
    expect(selectPreferredRoute(plan)?.endpoint).toBe('direct-1');
  });

  it('rejects empty plans and duplicate candidate endpoints', () => {
    expect(() => createRoutePlan(target, [])).toThrow(DomainContractError);
    expect(() => createRoutePlan(target, [
      { kind: 'direct', endpoint: 'same', priority: 1 },
      { kind: 'tailscale', endpoint: 'same', priority: 2 },
    ])).toThrow(DomainContractError);
  });
});

describe('session state transitions', () => {
  it('accepts the explicit connect lifecycle and resets recovery counters', () => {
    let state = initialState();
    state = reduceSessionState(state, { type: 'request-connect', sessionId: state.sessionId });
    expect(state.status).toBe('connecting');
    state = reduceSessionState(state, { type: 'confirm-connected', sessionId: state.sessionId });
    expect(state.status).toBe('connected');
    state = reduceSessionState(state, { type: 'report-disconnected', sessionId: state.sessionId });
    expect(state.status).toBe('disconnected');
    state = reduceSessionState(state, { type: 'request-reconnect', sessionId: state.sessionId });
    expect(state).toMatchObject({ status: 'reconnecting', reconnectAttempt: 1 });
    state = reduceSessionState(state, { type: 'confirm-connected', sessionId: state.sessionId });
    expect(state).toMatchObject({ status: 'connected', reconnectAttempt: 0, lastError: null });
  });

  it('records terminal errors without erasing route truth', () => {
    const state = reduceSessionState(initialState(), {
      type: 'report-error',
      sessionId: createSessionId('session-1'),
      message: 'transport failed',
    });
    expect(state.status).toBe('error');
    expect(state.lastError).toBe('transport failed');
    expect(state.selectedRoute?.endpoint).toBe('ws://a');
  });

  it('closes from any live state as a terminal transition', () => {
    for (const status of ['idle', 'connected'] as const) {
      const base = { ...initialState(), status };
      const closed = reduceSessionState(base, { type: 'close', sessionId: base.sessionId });
      expect(closed.status).toBe('closed');
      expect(() => reduceSessionState(closed, { type: 'request-connect', sessionId: closed.sessionId }))
        .toThrow(DomainContractError);
    }
  });

  it('rejects invalid transitions and cross-session actions', () => {
    const idle = reduceSessionState(initialState(), {
      type: 'report-error',
      sessionId: createSessionId('session-1'),
      message: 'seed',
    });
    expect(() => reduceSessionState(idle, { type: 'confirm-connected', sessionId: idle.sessionId }))
      .toThrow(DomainContractError);
    expect(() => reduceSessionState(idle, { type: 'close', sessionId: createSessionId('other') }))
      .toThrow(DomainContractError);
  });
});

describe('domain selectors', () => {
  it('permits input only for connected sessions', () => {
    expect(canAcceptInput(initialState())).toBe(false);
    const connected = reduceSessionState(
      reduceSessionState(initialState(), { type: 'request-connect', sessionId: createSessionId('session-1') }),
      { type: 'confirm-connected', sessionId: createSessionId('session-1') },
    );
    expect(canAcceptInput(connected)).toBe(true);
  });
});
