import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BRIDGE_SETTINGS, type BridgeSettings } from '../lib/bridge-settings';
import { createSessionBufferState } from '../lib/terminal-buffer';
import { buildTraversalPlan } from '../lib/traversal/config';
import { TraversalSocket } from '../lib/traversal/socket';
import type { Host, Session } from '../lib/types';
import { initialSessionManagerState, reduceSessionAction, type SessionAction, type SessionManagerState } from './session-context-core';
import {
  applySessionActionRuntime,
  buildTraversalSocketForHostRuntime,
  isSessionTransportActiveRuntime,
  shouldUseLegacyWsOverrideForHostRuntime,
} from './session-context-infra-runtime';

vi.mock('../lib/traversal/socket', () => ({
  TraversalSocket: vi.fn(function MockTraversalSocket() {
    return {
      readyState: 0,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send: vi.fn(),
      close: vi.fn(),
      getDiagnostics: vi.fn(() => ({
        mode: 'auto',
        stage: 'connecting',
        attempts: [],
      })),
    };
  }),
}));

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

function buildHost(overrides: Partial<Host> = {}): Host {
  return {
    id: 'host-1',
    createdAt: 1,
    name: 'Mac Studio',
    bridgeHost: '100.66.1.82',
    bridgePort: 3333,
    sessionName: 'zterm',
    authToken: 'token-a',
    authType: 'password',
    tags: [],
    pinned: false,
    ...overrides,
  };
}

function buildRelayBridgeSettings(): BridgeSettings {
  return {
    ...DEFAULT_BRIDGE_SETTINGS,
    transportMode: 'auto',
    traversalPathPriority: ['rtc-direct', 'tailscale', 'ipv6', 'ipv4', 'rtc-relay'],
    traversalRelay: {
      relayBaseUrl: 'https://relay.codewhisper.cc:18443/relay',
      accessToken: 'access-1',
      userId: 'user-1',
      username: 'jason',
      deviceId: 'android-1',
      deviceName: 'Android',
      platform: 'android',
      wsDevicesUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/devices',
      wsHostUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/host',
      wsClientUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/client',
      turnUrl: 'turn:relay.codewhisper.cc:3479?transport=udp',
      turnUsername: 'turn-user',
      turnCredential: 'turn-secret',
      updatedAt: 1,
    },
  };
}

function readTraversalSocketConstructorCall() {
  const calls = vi.mocked(TraversalSocket).mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0];
}

describe('applySessionActionRuntime', () => {
  beforeEach(() => {
    vi.mocked(TraversalSocket).mockClear();
  });

  it('does not let a legacy wsUrl override bypass WebRTC-first relay candidates', () => {
    const host = buildHost({
      daemonHostId: 'mac-studio',
      relayHostId: 'mac-studio',
      transportMode: 'auto',
      relayEndpointCandidates: [
        {
          id: 'direct:tailscale:mac-studio',
          kind: 'tailscale',
          host: '100.66.1.82',
          port: 3333,
          authRequired: true,
          lastSeenAt: '2026-07-18T00:00:00.000Z',
        },
        {
          id: 'relay-rtc:mac-studio',
          kind: 'relay-rtc',
          relayHostId: 'mac-studio',
          authRequired: true,
          lastSeenAt: '2026-07-18T00:00:00.000Z',
        },
      ],
    });

    buildTraversalSocketForHostRuntime({
      host,
      bridgeSettings: buildRelayBridgeSettings(),
      wsUrl: 'ws://100.66.1.82:3333/?token=legacy',
      transportRole: 'session',
    });

    const [target, settings, options] = readTraversalSocketConstructorCall();
    expect(options).toMatchObject({
      overrideUrl: undefined,
      autoReconnect: false,
    });
    const plan = buildTraversalPlan(target, settings, options?.overrideUrl);
    expect(plan.candidates.map((candidate) => candidate.path)).toEqual([
      'rtc-direct',
      'tailscale',
      'rtc-relay',
    ]);
    expect(plan.candidates[0]).toMatchObject({
      kind: 'rtc',
      path: 'rtc-direct',
      endpoint: 'rtc-direct:mac-studio',
      iceTransportPolicy: 'all',
      iceServers: [{ urls: 'stun:relay.codewhisper.cc:3479' }],
    });
  });

  it('keeps wsUrl override only for legacy non-relay hosts', () => {
    buildTraversalSocketForHostRuntime({
      host: buildHost({
        daemonHostId: undefined,
        relayHostId: undefined,
        relayEndpointCandidates: [],
        signalUrl: undefined,
        transportMode: 'auto',
      }),
      bridgeSettings: {
        ...DEFAULT_BRIDGE_SETTINGS,
        transportMode: 'auto',
      },
      wsUrl: 'ws://127.0.0.1:3333/?token=legacy',
      transportRole: 'control',
    });

    const [, , options] = readTraversalSocketConstructorCall();
    expect(options?.overrideUrl).toBe('ws://127.0.0.1:3333/?token=legacy&ztermTransport=control');
  });

  it('treats relay route identity as incompatible with legacy wsUrl override', () => {
    expect(shouldUseLegacyWsOverrideForHostRuntime(buildHost({
      relayEndpointCandidates: [{
        id: 'relay-rtc:mac-studio',
        kind: 'relay-rtc',
        relayHostId: 'mac-studio',
        authRequired: true,
        lastSeenAt: '2026-07-18T00:00:00.000Z',
      }],
    }))).toBe(false);
    expect(shouldUseLegacyWsOverrideForHostRuntime(buildHost({
      relayEndpointCandidates: [],
      daemonHostId: undefined,
      relayHostId: undefined,
      signalUrl: undefined,
      transportMode: 'auto',
    }))).toBe(true);
  });

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
