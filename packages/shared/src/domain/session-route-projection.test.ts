import { describe, expect, it } from 'vitest';
import type { Host } from '../connection/types';
import type { BridgeTarget } from '../connection/tmux-sessions';
import {
  DomainContractError,
  createSessionId,
  createSessionTargetIdentity,
  reduceSessionState,
  type SessionAction,
  type SessionDomainState,
} from './session-domain';
import {
  buildRoutePlanFromBridgeTarget,
  buildRoutePlanFromHost,
  projectSessionConnection,
  projectSessionEvent,
  replaySessionConnection,
  replaySessionEvents,
  selectBestRoute,
  toBridgeTarget,
} from './session-route-projection';

const host: Host = {
  id: 'host-1',
  createdAt: 1,
  name: 'work',
  bridgeHost: '192.168.1.20',
  bridgePort: 3333,
  daemonHostId: 'daemon-1',
  sessionName: 'work',
  terminalBackend: 'tmux',
  tailscaleHost: 'mac.tailnet.ts.net',
  ipv4Host: '203.0.113.10',
  ipv6Host: '2001:db8::10',
  authType: 'password',
  password: '',
  privateKey: '',
  tags: [],
  pinned: false,
  autoCommand: '',
  relayEndpointCandidates: [
    {
      id: 'relay-1',
      kind: 'rtc-direct',
      host: 'relay.example.com',
      port: 443,
      wsUrl: 'wss://relay.example.com/ws/client',
      authRequired: true,
      lastSeenAt: '2026-08-26T00:00:00.000Z',
    },
  ],
};

const bridgeTarget: BridgeTarget = {
  bridgeHost: 'bridge.local',
  bridgePort: 4444,
  authToken: 'token-1',
};

function initialSessionState(overrides: Partial<SessionDomainState> = {}): SessionDomainState {
  return {
    sessionId: createSessionId('session-1'),
    target: createSessionTargetIdentity({
      backend: 'tmux',
      daemonId: 'daemon-1',
      sessionName: 'work',
    }),
    status: 'idle',
    selectedRoute: null,
    reconnectAttempt: 0,
    lastError: null,
    ...overrides,
  };
}

function selectedState() {
  return reduceWith(
    initialSessionState(),
    { type: 'select-route', sessionId: createSessionId('session-1'), candidate: { kind: 'direct', endpoint: '192.168.1.20:3333', priority: 0 } },
  );
}

function reduceWith(state: SessionDomainState, action: SessionAction) {
  return reduceSessionState(state, action);
}

describe('session route projection', () => {
  it('builds a deterministic route plan from host endpoints and relays', () => {
    const plan = buildRoutePlanFromHost(host);

    expect(plan.target).toEqual({
      backend: 'tmux',
      daemonId: 'daemon-1',
      sessionName: 'work',
    });
    expect(plan.candidates.map((candidate) => candidate.endpoint)).toEqual([
      'mac.tailnet.ts.net:3333',
      '203.0.113.10:3333',
      '2001:db8::10:3333',
      '192.168.1.20:3333',
      'wss://relay.example.com/ws/client',
    ]);
    expect(selectBestRoute(plan)?.kind).toBe('tailscale');
  });

  it('round-trips a bridge target through the shared route plan', () => {
    const plan = buildRoutePlanFromBridgeTarget(bridgeTarget, 'shell', 'daemon-2');

    expect(plan.target).toEqual({
      backend: 'tmux',
      daemonId: 'daemon-2',
      sessionName: 'shell',
    });
    expect(toBridgeTarget(plan)).toEqual({
      bridgeHost: 'bridge.local',
      bridgePort: 4444,
    });
  });

  it('projects the full session lifecycle into connection state', () => {
    const plan = buildRoutePlanFromHost(host);
    const route = selectBestRoute(plan)!;
    const state = reduceWith(
      selectedState(),
      { type: 'request-connect', sessionId: createSessionId('session-1') },
    );

    expect(projectSessionConnection(state, plan).state).toMatchObject({
      kind: 'connecting',
      sessionId: 'session-1',
      route: { endpoint: '192.168.1.20:3333' },
    });

    const connected = reduceWith(
      state,
      { type: 'confirm-connected', sessionId: createSessionId('session-1') },
    );
    expect(projectSessionConnection(connected, plan).state.kind).toBe('connected');

    const disconnected = reduceWith(
      connected,
      { type: 'report-disconnected', sessionId: createSessionId('session-1') },
    );
    expect(projectSessionConnection(disconnected, plan).state.kind).toBe('disconnected');

    const reconnecting = reduceWith(
      disconnected,
      { type: 'request-reconnect', sessionId: createSessionId('session-1') },
    );
    expect(projectSessionConnection(reconnecting, plan).state).toMatchObject({
      kind: 'reconnecting',
      attempt: 1,
    });

    const closed = reduceWith(
      reconnecting,
      { type: 'close', sessionId: createSessionId('session-1') },
    );
    expect(projectSessionConnection(closed, plan).state).toEqual({
      kind: 'closed',
      sessionId: 'session-1',
    });
  });

  it('replays connection snapshots exactly from an action sequence', () => {
    const plan = buildRoutePlanFromHost(host);
    const actions: SessionAction[] = [
      { type: 'select-route', sessionId: createSessionId('session-1'), candidate: { kind: 'direct', endpoint: '192.168.1.20:3333', priority: 0 } },
      { type: 'request-connect', sessionId: createSessionId('session-1') },
      { type: 'confirm-connected', sessionId: createSessionId('session-1') },
      { type: 'report-disconnected', sessionId: createSessionId('session-1') },
      { type: 'request-reconnect', sessionId: createSessionId('session-1') },
      { type: 'confirm-connected', sessionId: createSessionId('session-1') },
    ];

    const snapshots = replaySessionConnection(initialSessionState(), actions, plan);

    expect(snapshots.map((snapshot) => snapshot.state.kind)).toEqual([
      'idle',
      'idle',
      'connecting',
      'connected',
      'disconnected',
      'reconnecting',
      'connected',
    ]);
    expect(snapshots[snapshots.length - 1]!.state).toMatchObject({
      kind: 'connected',
      sessionId: 'session-1',
      route: { endpoint: '192.168.1.20:3333' },
    });
  });

  it('projects exact events and can rebuild events from a serializable action log', () => {
    const actions: SessionAction[] = [
      { type: 'select-route', sessionId: createSessionId('session-1'), candidate: { kind: 'tailscale', endpoint: 'mac.tailnet.ts.net:3333', priority: 0 } },
      { type: 'request-connect', sessionId: createSessionId('session-1') },
      { type: 'confirm-connected', sessionId: createSessionId('session-1') },
      { type: 'report-disconnected', sessionId: createSessionId('session-1') },
      { type: 'request-reconnect', sessionId: createSessionId('session-1') },
    ];

    const events = replaySessionEvents(initialSessionState(), actions);

    expect(events).toEqual([
      {
        type: 'route-selected',
        sessionId: 'session-1',
        route: { kind: 'tailscale', endpoint: 'mac.tailnet.ts.net:3333', priority: 0 },
      },
      {
        type: 'connect-requested',
        sessionId: 'session-1',
        route: { kind: 'tailscale', endpoint: 'mac.tailnet.ts.net:3333', priority: 0 },
      },
      {
        type: 'connected',
        sessionId: 'session-1',
        route: { kind: 'tailscale', endpoint: 'mac.tailnet.ts.net:3333', priority: 0 },
      },
      {
        type: 'disconnected',
        sessionId: 'session-1',
        route: { kind: 'tailscale', endpoint: 'mac.tailnet.ts.net:3333', priority: 0 },
      },
      {
        type: 'reconnect-requested',
        sessionId: 'session-1',
        attempt: 1,
        route: { kind: 'tailscale', endpoint: 'mac.tailnet.ts.net:3333', priority: 0 },
      },
    ]);
  });

  it('rejects a projection when the domain target does not match the route plan', () => {
    const plan = buildRoutePlanFromBridgeTarget(bridgeTarget, 'other');
    const state = initialSessionState();

    expect(() => projectSessionConnection(state, plan)).toThrow(DomainContractError);
  });

  it('rejects an active projection when no route is selected', () => {
    const plan = buildRoutePlanFromHost(host);
    const state = {
      ...initialSessionState(),
      status: 'connecting' as const,
      selectedRoute: null,
    };

    expect(() => projectSessionConnection(state, plan)).toThrow(DomainContractError);
  });

  it('rejects invalid lifecycle replay instead of silently advancing state', () => {
    const actions: SessionAction[] = [
      { type: 'select-route', sessionId: createSessionId('session-1'), candidate: { kind: 'direct', endpoint: '192.168.1.20:3333', priority: 0 } },
      { type: 'confirm-connected', sessionId: createSessionId('session-1') },
    ];

    expect(() => replaySessionConnection(initialSessionState(), actions, buildRoutePlanFromHost(host)))
      .toThrow(DomainContractError);
    expect(() => replaySessionEvents(initialSessionState(), actions))
      .toThrow(DomainContractError);
  });

  it('rejects a bridge route plan with an invalid port or empty host', () => {
    expect(() => buildRoutePlanFromBridgeTarget({ bridgeHost: '', bridgePort: 3333 }, 'work'))
      .toThrow(DomainContractError);
    expect(() => buildRoutePlanFromBridgeTarget({ bridgeHost: 'bridge.local', bridgePort: 0 }, 'work'))
      .toThrow(DomainContractError);
    expect(() => buildRoutePlanFromHost({ ...host, bridgeHost: '   ' }))
      .toThrow(DomainContractError);
  });

  it('rejects event projection for a transition that lost its route', () => {
    const state = initialSessionState();
    const next = {
      ...state,
      status: 'connected' as const,
      selectedRoute: null,
      reconnectAttempt: 0,
      lastError: null,
    };

    expect(() => projectSessionEvent(
      { type: 'confirm-connected', sessionId: createSessionId('session-1') },
      next,
    )).toThrow(DomainContractError);
  });
});
