import { describe, expect, it, afterEach, vi } from 'vitest';
import { DEFAULT_BRIDGE_SETTINGS } from '../bridge-settings';
import { buildTraversalPlan, buildTraversalPlanCached, clearTraversalPlanCache, resolveTraversalConfigFromHost } from './config';

describe('buildTraversalPlan', () => {
  it('keeps Tailscale ahead of UDP direct and TURN Relay on a merged daemon target', () => {
    const plan = buildTraversalPlan(
      {
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        authToken: 'wterm-token',
        daemonHostId: 'mac-studio',
        relayHostId: 'mac-studio',
        transportMode: 'auto',
        relayEndpointCandidates: [{
          id: 'relay-rtc:mac-studio',
          kind: 'relay-rtc',
          relayHostId: 'mac-studio',
          authRequired: true,
          lastSeenAt: '2026-07-27T02:25:21.247Z',
        }],
      },
      {
        ...DEFAULT_BRIDGE_SETTINGS,
        traversalRelay: {
          relayBaseUrl: 'https://relay.example.test/relay/',
          accessToken: 'access-1',
          userId: 'user-1',
          username: 'jason',
          deviceId: 'android-1',
          deviceName: 'Android',
          platform: 'android',
          wsDevicesUrl: 'wss://relay.example.test/relay/ws/devices',
          wsHostUrl: 'wss://relay.example.test/relay/ws/host',
          wsClientUrl: 'wss://relay.example.test/relay/ws/client',
          turnUrl: 'turn:relay.example.test:3478?transport=udp',
          turnUsername: 'turn-user',
          turnCredential: 'turn-secret',
          updatedAt: 1,
        },
      },
    );

    expect(plan.candidates.map((candidate) => candidate.path)).toEqual([
      'tailscale',
      'rtc-direct',
      'rtc-relay',
    ]);
    expect(plan.candidates[0]).toMatchObject({
      kind: 'ws',
      path: 'tailscale',
      endpoint: '100.66.1.82:3333',
      url: 'ws://100.66.1.82:3333/?token=wterm-token',
    });
  });

  it('uses relay directory direct endpoint auth token for logged-in new devices', () => {
    const plan = buildTraversalPlan(
      {
        bridgeHost: '',
        bridgePort: 3333,
        authToken: '',
        daemonHostId: 'mac-studio',
        relayHostId: 'mac-studio',
        transportMode: 'auto',
        relayEndpointCandidates: [
          {
            id: 'tailscale:100.66.1.82:3333',
            kind: 'tailscale',
            host: '100.66.1.82',
            port: 3333,
            authToken: 'daemon-token',
            authRequired: true,
            lastSeenAt: '2026-08-01T01:01:55.431Z',
          },
          {
            id: 'relay-rtc:mac-studio',
            kind: 'relay-rtc',
            relayHostId: 'mac-studio',
            authToken: 'daemon-token',
            authRequired: true,
            lastSeenAt: '2026-08-01T01:01:55.431Z',
          },
        ],
      },
      {
        ...DEFAULT_BRIDGE_SETTINGS,
        traversalRelay: {
          relayBaseUrl: 'https://relay.example.test/relay/',
          accessToken: 'access-1',
          userId: 'user-1',
          username: 'jason',
          deviceId: 'android-1',
          deviceName: 'Android',
          platform: 'android',
          wsDevicesUrl: 'wss://relay.example.test/relay/ws/devices',
          wsHostUrl: 'wss://relay.example.test/relay/ws/host',
          wsClientUrl: 'wss://relay.example.test/relay/ws/client',
          turnUrl: 'turn:relay.example.test:3478?transport=udp',
          turnUsername: 'turn-user',
          turnCredential: 'turn-secret',
          updatedAt: 1,
        },
      },
    );

    expect(plan.candidates[0]).toMatchObject({
      id: 'tailscale:100.66.1.82:3333',
      kind: 'ws',
      path: 'tailscale',
      url: 'ws://100.66.1.82:3333/?token=daemon-token',
    });
    expect(plan.candidates.map((candidate) => candidate.path)).toEqual([
      'tailscale',
      'rtc-direct',
      'rtc-relay',
    ]);
  });

  it('keeps same-endpoint directory candidates when their auth tokens differ', () => {
    const plan = buildTraversalPlan(
      {
        bridgeHost: '',
        bridgePort: 3333,
        authToken: '',
        daemonHostId: 'mac-studio',
        transportMode: 'auto',
        relayEndpointCandidates: [
          {
            id: 'tailscale-stale',
            kind: 'tailscale',
            host: '100.66.1.82',
            port: 3333,
            authToken: 'stale-token',
            authRequired: true,
            lastSeenAt: '2026-08-01T01:01:55.431Z',
          },
          {
            id: 'tailscale-fresh',
            kind: 'tailscale',
            host: '100.66.1.82',
            port: 3333,
            authToken: 'fresh-token',
            authRequired: true,
            lastSeenAt: '2026-08-01T01:02:55.431Z',
          },
        ],
      },
      { ...DEFAULT_BRIDGE_SETTINGS, traversalRelay: undefined },
    );

    expect(plan.candidates.filter((candidate) => candidate.path === 'tailscale')).toHaveLength(2);
    expect(plan.candidates.map((candidate) => candidate.kind === 'ws' ? candidate.url : '')).toEqual([
      'ws://100.66.1.82:3333/?token=stale-token',
      'ws://100.66.1.82:3333/?token=fresh-token',
    ]);
  });

  it('lets a fresh relay directory endpoint token replace a stale saved host token for the same direct URL', () => {
    const plan = buildTraversalPlan(
      {
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        authToken: 'stale-saved-token',
        daemonHostId: 'mac-studio',
        relayHostId: 'mac-studio',
        tailscaleHost: '100.66.1.82',
        transportMode: 'auto',
        relayEndpointCandidates: [
          {
            id: 'tailscale:100.66.1.82:3333',
            kind: 'tailscale',
            host: '100.66.1.82',
            port: 3333,
            authToken: 'fresh-directory-token',
            authRequired: true,
            lastSeenAt: '2026-08-01T04:20:00.000Z',
          },
          {
            id: 'relay-rtc:mac-studio',
            kind: 'relay-rtc',
            relayHostId: 'mac-studio',
            authToken: 'fresh-directory-token',
            authRequired: true,
            lastSeenAt: '2026-08-01T04:20:00.000Z',
          },
        ],
      },
      {
        ...DEFAULT_BRIDGE_SETTINGS,
        traversalRelay: {
          relayBaseUrl: 'https://relay.example.test/relay/',
          accessToken: 'access-1',
          userId: 'user-1',
          username: 'jason',
          deviceId: 'android-1',
          deviceName: 'Android',
          platform: 'android',
          wsDevicesUrl: 'wss://relay.example.test/relay/ws/devices',
          wsHostUrl: 'wss://relay.example.test/relay/ws/host',
          wsClientUrl: 'wss://relay.example.test/relay/ws/client',
          turnUrl: 'turn:relay.example.test:3478?transport=udp',
          turnUsername: 'turn-user',
          turnCredential: 'turn-secret',
          updatedAt: 1,
        },
      },
    );

    expect(plan.candidates[0]).toMatchObject({
      id: 'tailscale:100.66.1.82:3333',
      kind: 'ws',
      path: 'tailscale',
      endpoint: '100.66.1.82:3333',
      url: 'ws://100.66.1.82:3333/?token=fresh-directory-token',
    });
    expect(plan.candidates.map((candidate) => candidate.kind === 'ws' ? candidate.url : candidate.endpoint))
      .not.toContain('ws://100.66.1.82:3333/?token=stale-saved-token');
  });

  it('orders logged-in auto candidates as Tailscale -> UDP direct -> TURN Relay -> direct IPv6 -> non-LAN IPv4', () => {
    const plan = buildTraversalPlan(
      {
        bridgeHost: '203.0.113.10',
        bridgePort: 3333,
        authToken: 'token',
        relayHostId: 'daemon-host-a',
        tailscaleHost: 'mac.tailnet.ts.net',
        ipv6Host: '240e:1234::10',
        ipv4Host: '203.0.113.10',
        transportMode: 'auto',
      },
      {
        ...DEFAULT_BRIDGE_SETTINGS,
        transportMode: 'auto',
        traversalRelay: {
          relayBaseUrl: 'https://relay.example.test/relay/',
          accessToken: 'access-1',
          userId: 'user-1',
          username: 'jason',
          deviceId: 'tablet-1',
          deviceName: 'Jason Tablet',
          platform: 'android',
          wsDevicesUrl: 'wss://relay.example.test/relay/ws/devices',
          wsHostUrl: 'wss://relay.example.test/relay/ws/host',
          wsClientUrl: 'wss://relay.example.test/relay/ws/client',
          turnUrl: 'turn:turn.example.com:3478?transport=udp',
          turnUsername: 'alice',
          turnCredential: 'secret',
          updatedAt: 1,
        },
      },
    );

    expect(plan.candidates.map((candidate) => candidate.path)).toEqual([
      'tailscale',
      'ipv4',
      'ipv6',
      'rtc-direct',
      'rtc-relay',
    ]);
    expect(plan.candidates[3]).toMatchObject({
      kind: 'rtc',
      path: 'rtc-direct',
      endpoint: 'rtc-direct:daemon-host-a',
      iceTransportPolicy: 'all',
      iceServers: [{ urls: 'stun:turn.example.com:3478' }],
    });
    expect(JSON.stringify(plan.candidates[3])).not.toContain('secret');
  });

  it('ignores stale saved traversal priority in auto mode', () => {
    const plan = buildTraversalPlan(
      {
        bridgeHost: '203.0.113.10',
        bridgePort: 3333,
        authToken: 'token',
        tailscaleHost: 'mac.tailnet.ts.net',
        ipv6Host: '240e:1234::10',
        ipv4Host: '203.0.113.10',
        relayHostId: 'daemon-host-a',
        transportMode: 'auto',
      },
      {
        ...DEFAULT_BRIDGE_SETTINGS,
        signalUrl: '',
        turnServerUrl: '',
        turnUsername: '',
        turnCredential: '',
        transportMode: 'auto',
        traversalPathPriority: ['rtc-relay', 'ipv4', 'rtc-direct', 'tailscale', 'ipv6'],
        traversalRelay: {
          relayBaseUrl: 'http://159.75.134.56/relay/',
          accessToken: 'access-1',
          userId: 'user-1',
          username: 'jason',
          deviceId: 'tablet-1',
          deviceName: 'Jason Tablet',
          platform: 'android',
          wsDevicesUrl: 'ws://159.75.134.56/relay/ws/devices',
          wsHostUrl: 'ws://159.75.134.56/relay/ws/host',
          wsClientUrl: 'ws://159.75.134.56/relay/ws/client',
          turnUrl: 'turn:claw.codewhisper.cc:3479?transport=udp',
          turnUsername: 'ztermturn',
          turnCredential: 'turn-pass',
          updatedAt: 1,
        },
      },
    );

    expect(plan.candidates.map((candidate) => candidate.path)).toEqual([
      'tailscale',
      'ipv4',
      'ipv6',
      'rtc-direct',
      'rtc-relay',
    ]);
  });

  it('uses override url as a single direct candidate', () => {
    const plan = buildTraversalPlan(
      {
        bridgeHost: '100.64.0.2',
        bridgePort: 3333,
        authToken: 'token',
      },
      {
        ...DEFAULT_BRIDGE_SETTINGS,
        signalUrl: '',
        turnServerUrl: 'turn:turn.example.com:3478?transport=udp',
        turnUsername: 'alice',
        turnCredential: 'secret',
        transportMode: 'auto',
        traversalRelay: undefined,
      },
      'ws://127.0.0.1:3333/ws',
    );

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({
      kind: 'ws',
      endpoint: 'ws://127.0.0.1:3333/ws',
    });
  });

  it('can disable rtc candidates in websocket mode', () => {
    const plan = buildTraversalPlan(
      {
        bridgeHost: '203.0.113.10',
        bridgePort: 3333,
        authToken: 'token',
      },
      {
        signalUrl: 'wss://signal.example.com/signal',
        turnServerUrl: 'turn:turn.example.com:3478?transport=udp',
        turnUsername: 'alice',
        turnCredential: 'secret',
        transportMode: 'websocket',
        traversalRelay: undefined,
      },
    );

    expect(plan.candidates.every((candidate) => candidate.kind === 'ws')).toBe(true);
  });

  it('accepts raw host:port as a single normalized websocket endpoint', () => {
    const plan = buildTraversalPlan(
      {
        bridgeHost: '100.127.23.27:40807',
        bridgePort: 3333,
        authToken: 'token',
        transportMode: 'websocket',
      },
      {
        ...DEFAULT_BRIDGE_SETTINGS,
        signalUrl: '',
        turnServerUrl: '',
        turnUsername: '',
        turnCredential: '',
        transportMode: 'websocket',
        traversalRelay: undefined,
      },
    );

    expect(plan.candidates).toContainEqual(expect.objectContaining({
      kind: 'ws',
      endpoint: '100.127.23.27:40807',
      url: 'ws://100.127.23.27:40807/?token=token',
    }));
  });

  it('keeps local/LAN direct websocket candidates independent from tailscale', () => {
    const plan = buildTraversalPlan(
      {
        bridgeHost: '192.168.1.20',
        bridgePort: 40807,
        authToken: 'token',
        transportMode: 'websocket',
      },
      {
        signalUrl: '',
        turnServerUrl: '',
        turnUsername: '',
        turnCredential: '',
        transportMode: 'websocket',
        traversalRelay: undefined,
      },
    );

    expect(plan.candidates).toEqual([
      expect.objectContaining({
        kind: 'ws',
        path: 'lan',
        endpoint: '192.168.1.20:40807',
        url: 'ws://192.168.1.20:40807/?token=token',
      }),
    ]);
  });

  it('requires explicit signal url in webrtc mode', () => {
    expect(() =>
      buildTraversalPlan(
        {
          bridgeHost: '203.0.113.10',
          bridgePort: 3333,
          authToken: 'token',
          transportMode: 'webrtc',
        },
        {
          signalUrl: '',
          turnServerUrl: 'turn:turn.example.com:3478?transport=udp',
          turnUsername: 'alice',
          turnCredential: 'secret',
          transportMode: 'webrtc',
          traversalRelay: undefined,
        },
      )).toThrow('WebRTC mode requires explicit signalUrl and relay daemon target');
  });

  it('prefers relay control-plane ws client url and builds separate rtc-direct and TURN candidates', () => {
    const plan = buildTraversalPlan(
      {
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        authToken: 'token-a',
        relayHostId: 'daemon-host-a',
        transportMode: 'webrtc',
      },
      {
        signalUrl: '',
        turnServerUrl: '',
        turnUsername: '',
        turnCredential: '',
        transportMode: 'webrtc',
        traversalRelay: {
          relayBaseUrl: 'http://159.75.134.56/relay/',
          accessToken: 'access-1',
          userId: 'user-1',
          username: 'jason',
          deviceId: 'tablet-1',
          deviceName: 'Jason Tablet',
          platform: 'android',
          wsDevicesUrl: 'ws://159.75.134.56/relay/ws/devices',
          wsHostUrl: 'ws://159.75.134.56/relay/ws/host',
          wsClientUrl: 'ws://159.75.134.56/relay/ws/client',
          turnUrl: 'turn:claw.codewhisper.cc:3479?transport=udp',
          turnUsername: 'ztermturn',
          turnCredential: 'turn-pass',
          updatedAt: 1,
        },
      },
    );

    expect(plan.candidates).toContainEqual(expect.objectContaining({
      kind: 'rtc',
      path: 'rtc-direct',
      signalUrl: 'ws://159.75.134.56/relay/ws/client?token=access-1&hostId=daemon-host-a&deviceId=tablet-1',
      endpoint: 'rtc-direct:daemon-host-a',
      iceTransportPolicy: 'all',
      iceServers: [{ urls: 'stun:claw.codewhisper.cc:3479' }],
    }));
    expect(plan.candidates).toContainEqual(expect.objectContaining({
      kind: 'rtc',
      path: 'rtc-relay',
      signalUrl: 'ws://159.75.134.56/relay/ws/client?token=access-1&hostId=daemon-host-a&deviceId=tablet-1',
      endpoint: 'relay:daemon-host-a',
      iceTransportPolicy: 'relay',
      iceServers: [{
        urls: 'turn:claw.codewhisper.cc:3479?transport=udp',
        username: 'ztermturn',
        credential: 'turn-pass',
      }],
    }));
  });

  it('uses daemonHostId as the relay host identity for restored open tabs', () => {
    const plan = buildTraversalPlan(
      {
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        authToken: 'token-a',
        daemonHostId: 'daemon-host-a',
        transportMode: 'auto',
      },
      {
        signalUrl: '',
        turnServerUrl: '',
        turnUsername: '',
        turnCredential: '',
        transportMode: 'auto',
        traversalPathPriority: ['ipv4', 'tailscale', 'rtc-direct', 'ipv6', 'rtc-relay'],
        traversalRelay: {
          relayBaseUrl: 'http://159.75.134.56/relay/',
          accessToken: 'access-1',
          userId: 'user-1',
          username: 'jason',
          deviceId: 'tablet-1',
          deviceName: 'Jason Tablet',
          platform: 'android',
          wsDevicesUrl: 'ws://159.75.134.56/relay/ws/devices',
          wsHostUrl: 'ws://159.75.134.56/relay/ws/host',
          wsClientUrl: 'ws://159.75.134.56/relay/ws/client',
          turnUrl: 'turn:claw.codewhisper.cc:3479?transport=udp',
          turnUsername: 'ztermturn',
          turnCredential: 'turn-pass',
          updatedAt: 1,
        },
      },
    );

    expect(plan.candidates).toContainEqual(expect.objectContaining({
      kind: 'rtc',
      path: 'rtc-direct',
      signalUrl: 'ws://159.75.134.56/relay/ws/client?token=access-1&hostId=daemon-host-a&deviceId=tablet-1',
      endpoint: 'rtc-direct:daemon-host-a',
      iceTransportPolicy: 'all',
    }));
  });

  it('builds route candidates from relay directory endpoints without local bridge preset', () => {
    const plan = buildTraversalPlan(
      {
        bridgeHost: '',
        bridgePort: 3333,
        authToken: 'token-a',
        transportMode: 'auto',
        relayEndpointCandidates: [
          {
            id: 'lan:192.168.50.20:3333',
            kind: 'lan',
            host: '192.168.50.20',
            port: 3333,
            authRequired: true,
            lastSeenAt: '2026-06-28T10:00:00.000Z',
          },
          {
            id: 'rtc-direct:daemon-host-a',
            kind: 'rtc-direct',
            relayHostId: 'daemon-host-a',
            authRequired: true,
            lastSeenAt: '2026-06-28T10:00:00.000Z',
          },
          {
            id: 'direct:tailscale:daemon-host-a',
            kind: 'tailscale',
            host: 'mac.tailnet.ts.net',
            port: 3333,
            authRequired: true,
            lastSeenAt: '2026-06-28T10:00:00.000Z',
          },
          {
            id: 'relay-rtc:daemon-host-a',
            kind: 'relay-rtc',
            relayHostId: 'daemon-host-a',
            authRequired: true,
            lastSeenAt: '2026-06-28T10:00:00.000Z',
          },
        ],
      },
      {
        signalUrl: '',
        turnServerUrl: '',
        turnUsername: '',
        turnCredential: '',
        transportMode: 'auto',
        traversalPathPriority: ['ipv4', 'tailscale', 'rtc-direct', 'ipv6', 'rtc-relay'],
        traversalRelay: {
          relayBaseUrl: 'http://159.75.134.56/relay/',
          accessToken: 'access-1',
          userId: 'user-1',
          username: 'jason',
          deviceId: 'tablet-1',
          deviceName: 'Jason Tablet',
          platform: 'android',
          wsDevicesUrl: 'ws://159.75.134.56/relay/ws/devices',
          wsHostUrl: 'ws://159.75.134.56/relay/ws/host',
          wsClientUrl: 'ws://159.75.134.56/relay/ws/client',
          turnUrl: 'turn:claw.codewhisper.cc:3479?transport=udp',
          turnUsername: 'ztermturn',
          turnCredential: 'turn-pass',
          updatedAt: 1,
        },
      },
    );

    expect(plan.candidates.some((candidate) => candidate.endpoint === '192.168.50.20:3333')).toBe(true);
    expect(plan.candidates).toContainEqual(expect.objectContaining({
      id: 'direct:tailscale:daemon-host-a',
      kind: 'ws',
      path: 'tailscale',
      endpoint: 'mac.tailnet.ts.net:3333',
      url: 'ws://mac.tailnet.ts.net:3333/?token=token-a',
    }));
    expect(plan.candidates).toContainEqual(expect.objectContaining({
      id: 'rtc-direct:daemon-host-a',
      kind: 'rtc',
      path: 'rtc-direct',
      signalUrl: 'ws://159.75.134.56/relay/ws/client?token=access-1&hostId=daemon-host-a&deviceId=tablet-1',
      endpoint: 'rtc-direct:daemon-host-a',
      iceTransportPolicy: 'all',
    }));
    expect(plan.candidates).toContainEqual(expect.objectContaining({
      id: 'relay-rtc:daemon-host-a',
      kind: 'rtc',
      path: 'rtc-relay',
      signalUrl: 'ws://159.75.134.56/relay/ws/client?token=access-1&hostId=daemon-host-a&deviceId=tablet-1',
      endpoint: 'relay:daemon-host-a',
      iceTransportPolicy: 'relay',
    }));
  });

  it('preserves relay directory endpoint candidates when resolving traversal config from a saved host draft', () => {
    const resolved = resolveTraversalConfigFromHost(
      {
        id: 'host-1',
        createdAt: 1,
        name: 'Relay main',
        bridgeHost: 'daemon-host-a',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-a',
        relayHostId: 'daemon-host-a',
        relayDeviceId: 'device-a',
        sessionName: 'main',
        authType: 'password',
        tags: [],
        pinned: false,
        relayEndpointCandidates: [
          {
            id: 'direct:tailscale:daemon-host-a',
            kind: 'tailscale',
            host: 'mac.tailnet.ts.net',
            port: 3333,
            authRequired: true,
            lastSeenAt: '2026-06-28T10:00:00.000Z',
          },
        ],
      },
      {
        ...DEFAULT_BRIDGE_SETTINGS,
        signalUrl: '',
        turnServerUrl: '',
        turnUsername: '',
        turnCredential: '',
        transportMode: 'auto',
        traversalPathPriority: ['ipv4', 'tailscale', 'rtc-direct', 'ipv6', 'rtc-relay'],
      },
    );

    expect(resolved.target.relayEndpointCandidates).toEqual([
      expect.objectContaining({
        id: 'direct:tailscale:daemon-host-a',
        kind: 'tailscale',
        host: 'mac.tailnet.ts.net',
      }),
    ]);
  });

  it('fails fast in webrtc relay mode when no relay daemon device is selected', () => {
    expect(() =>
      buildTraversalPlan(
        {
          bridgeHost: '100.64.0.10',
          bridgePort: 3333,
          authToken: 'token-a',
          transportMode: 'webrtc',
        },
        {
          signalUrl: '',
          turnServerUrl: '',
          turnUsername: '',
          turnCredential: '',
          transportMode: 'webrtc',
          traversalRelay: {
            relayBaseUrl: 'http://159.75.134.56/relay/',
            accessToken: 'access-1',
            userId: 'user-1',
            username: 'jason',
            deviceId: 'tablet-1',
            deviceName: 'Jason Tablet',
            platform: 'android',
            wsDevicesUrl: 'ws://159.75.134.56/relay/ws/devices',
            wsHostUrl: 'ws://159.75.134.56/relay/ws/host',
            wsClientUrl: 'ws://159.75.134.56/relay/ws/client',
            turnUrl: 'turn:154.40.36.9:3479?transport=udp',
            turnUsername: 'ztermturn',
            turnCredential: 'turn-pass',
            updatedAt: 1,
          },
        },
      )).toThrow('WebRTC relay mode requires selecting an online relay daemon device');
  });
});

describe('buildTraversalPlanCached', () => {
  const cachedTarget = {
    bridgeHost: '100.66.1.82',
    bridgePort: 3333,
    authToken: 'token',
    daemonHostId: 'mac-studio',
    relayHostId: 'mac-studio',
    transportMode: 'websocket' as const,
  };

  afterEach(() => {
    clearTraversalPlanCache();
    vi.useRealTimers();
  });

  it('reuses the cached plan within the TTL window', () => {
    const first = buildTraversalPlanCached(cachedTarget, DEFAULT_BRIDGE_SETTINGS);
    const second = buildTraversalPlanCached(cachedTarget, DEFAULT_BRIDGE_SETTINGS);
    expect(second).toBe(first);
  });

  it('rebuilds the plan after the TTL window expires', () => {
    vi.useFakeTimers();
    const first = buildTraversalPlanCached(cachedTarget, DEFAULT_BRIDGE_SETTINGS);
    vi.advanceTimersByTime(5001);
    const rebuilt = buildTraversalPlanCached(cachedTarget, DEFAULT_BRIDGE_SETTINGS);
    expect(rebuilt).not.toBe(first);
    // And a fresh build is cached again for the new window.
    expect(buildTraversalPlanCached(cachedTarget, DEFAULT_BRIDGE_SETTINGS)).toBe(rebuilt);
  });
});
