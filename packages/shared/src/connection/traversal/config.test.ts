import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BRIDGE_SETTINGS } from '../bridge-settings';
import {
  buildTraversalPlan,
  buildTraversalPlanCached,
  clearTraversalPlanCache,
} from './config';
import type {
  RtcTraversalCandidate,
  TraversalCandidateScope,
  TraversalSettingsSource,
} from './types';

const BOUND_INITIAL = 'bound-initial' as TraversalCandidateScope;

const targetWithRtcDirectory = {
  bridgeHost: '203.0.113.10',
  bridgePort: 3333,
  authToken: 'daemon-token',
  daemonHostId: 'daemon-a',
  relayHostId: 'daemon-a',
  ipv4Host: '203.0.113.10',
  transportMode: 'auto' as const,
  relayEndpointCandidates: [
    {
      id: 'ws-ipv4-daemon-a',
      kind: 'ipv4' as const,
      host: '203.0.113.10',
      port: 3333,
      relayHostId: 'daemon-a',
      authToken: 'daemon-token',
      authRequired: true,
      lastSeenAt: '2026-10-20T00:00:00.000Z',
    },
    {
      id: 'rtc-direct-daemon-a',
      kind: 'rtc-direct' as const,
      host: '203.0.113.20',
      port: 4444,
      relayHostId: 'daemon-a',
      authRequired: true,
      lastSeenAt: '2026-10-20T00:00:00.000Z',
    },
    {
      id: 'relay-rtc-daemon-a',
      kind: 'relay-rtc' as const,
      host: 'relay.example.test',
      port: 3478,
      relayHostId: 'daemon-a',
      authRequired: true,
      lastSeenAt: '2026-10-20T00:00:00.000Z',
    },
  ],
};

const settingsWithRtc = {
  ...DEFAULT_BRIDGE_SETTINGS,
  transportMode: 'auto' as const,
  traversalRelay: {
    relayBaseUrl: 'https://relay.example.test/relay/',
    accessToken: 'account-access-token',
    userId: 'user-a',
    username: 'jason',
    deviceId: 'cli-device-a',
    deviceName: 'CLI',
    platform: 'node',
    wsDevicesUrl: 'wss://relay.example.test/relay/ws/devices',
    wsHostUrl: 'wss://relay.example.test/relay/ws/host',
    wsClientUrl: 'wss://relay.example.test/relay/ws/client',
    turnUrl: 'turn:relay.example.test:3478?transport=udp',
    turnUsername: 'turn-user',
    turnCredential: 'turn-secret',
    updatedAt: 1,
  },
};

const settingsWithRelay: TraversalSettingsSource = {
  ...settingsWithRtc,
  rtcIceTransportPolicy: 'relay',
};

const targetWithRelayOnlyDirectory = {
  ...targetWithRtcDirectory,
  relayEndpointCandidates: [
    targetWithRtcDirectory.relayEndpointCandidates[0],
    targetWithRtcDirectory.relayEndpointCandidates[2],
  ],
};

const targetWithSignalOnlyDirectory = {
  ...targetWithRtcDirectory,
  relayEndpointCandidates: undefined,
  signalUrl: 'wss://relay.example.test/relay/ws/client',
};

afterEach(() => {
  clearTraversalPlanCache();
});

describe('buildTraversalPlan candidate scope', () => {
  it('keeps the mode-default auto plan WebSocket-only when a WS candidate exists', () => {
    const plan = buildTraversalPlan(targetWithRtcDirectory, settingsWithRtc);

    expect(plan.candidates.map((candidate) => candidate.path)).toEqual(['ipv4']);
    expect(plan.candidates.every((candidate) => candidate.kind === 'ws')).toBe(true);
  });

  it('adds all legal directory RTC candidates for bound-initial without changing policy order', () => {
    const plan = buildTraversalPlan(
      targetWithRtcDirectory,
      settingsWithRtc,
      undefined,
      BOUND_INITIAL,
    );

    expect(plan.candidates.map((candidate) => candidate.path)).toEqual([
      'ipv4',
      'rtc-direct',
      'rtc-relay',
    ]);

    const rtcCandidates = plan.candidates.filter((candidate) => candidate.kind === 'rtc');
    expect(rtcCandidates).toHaveLength(2);
    for (const candidate of rtcCandidates) {
      expect(candidate.signalUrl).toContain('token=account-access-token');
      expect(candidate.signalUrl).toContain('hostId=daemon-a');
      expect(candidate.signalUrl).toContain('deviceId=cli-device-a');
      expect(candidate.signalUrl).not.toContain('daemon-token');
    }
    expect(plan.candidates).toContainEqual(expect.objectContaining({
      id: 'rtc-direct-daemon-a',
      kind: 'rtc',
      path: 'rtc-direct',
      endpoint: '203.0.113.20:4444',
      iceTransportPolicy: 'all',
    }));
    expect(plan.candidates).toContainEqual(expect.objectContaining({
      id: 'relay-rtc-daemon-a',
      kind: 'rtc',
      path: 'rtc-relay',
      endpoint: 'relay:daemon-a',
      iceTransportPolicy: 'relay',
    }));
  });

  it('synthesizes rtc-direct from signaling and bound identity when the directory only advertises relay-rtc', () => {
    const plan = buildTraversalPlan(
      targetWithRelayOnlyDirectory,
      settingsWithRtc,
      undefined,
      BOUND_INITIAL,
    );

    expect(plan.candidates.map((candidate) => candidate.path)).toEqual([
      'ipv4',
      'rtc-direct',
      'rtc-relay',
    ]);
    expect(plan.candidates).toContainEqual(expect.objectContaining({
      id: 'rtc-direct:daemon-a',
      kind: 'rtc',
      path: 'rtc-direct',
      iceTransportPolicy: 'all',
    }));
    const allPolicyPlan = buildTraversalPlan(
      targetWithRelayOnlyDirectory,
      {
        ...settingsWithRtc,
        rtcIceTransportPolicy: 'all',
      },
      undefined,
      BOUND_INITIAL,
    );
    expect(allPolicyPlan.candidates).toEqual(plan.candidates);
  });

  it('omits advertised rtc-direct under explicit relay and keeps the first WS plus relay TURN candidate', () => {
    const plan = buildTraversalPlan(
      targetWithRtcDirectory,
      settingsWithRelay,
      undefined,
      BOUND_INITIAL,
    );

    expect(plan.candidates.map((candidate) => candidate.path)).toEqual([
      'ipv4',
      'rtc-relay',
    ]);
    expect(plan.candidates[0]).toMatchObject({
      kind: 'ws',
      path: 'ipv4',
      url: 'ws://203.0.113.10:3333/?token=daemon-token',
    });
    expect(plan.candidates.some((candidate) => candidate.path === 'rtc-direct')).toBe(false);

    const relay = plan.candidates.find(
      (candidate): candidate is RtcTraversalCandidate =>
        candidate.kind === 'rtc' && candidate.path === 'rtc-relay',
    );
    expect(relay).toMatchObject({
      id: 'relay-rtc-daemon-a',
      kind: 'rtc',
      path: 'rtc-relay',
      endpoint: 'relay:daemon-a',
      iceTransportPolicy: 'relay',
    });
    expect(relay?.signalUrl).toContain('token=account-access-token');
    expect(relay?.signalUrl).toContain('hostId=daemon-a');
    expect(relay?.signalUrl).toContain('deviceId=cli-device-a');
    expect(relay?.signalUrl).not.toContain('daemon-token');
    expect(relay?.iceServers).toEqual([{
      urls: 'turn:relay.example.test:3478?transport=udp',
      username: 'turn-user',
      credential: 'turn-secret',
    }]);
  });

  it('omits synthesized rtc-direct from a relay-only directory under explicit relay', () => {
    const plan = buildTraversalPlan(
      targetWithRelayOnlyDirectory,
      settingsWithRelay,
      undefined,
      BOUND_INITIAL,
    );

    expect(plan.candidates.map((candidate) => candidate.path)).toEqual([
      'ipv4',
      'rtc-relay',
    ]);
    expect(plan.candidates.some((candidate) => candidate.kind === 'rtc' && candidate.path === 'rtc-direct')).toBe(false);
  });

  it('does not manufacture rtc-direct under explicit relay when no TURN inputs exist', () => {
    const plan = buildTraversalPlan(
      targetWithSignalOnlyDirectory,
      {
        ...DEFAULT_BRIDGE_SETTINGS,
        signalUrl: 'wss://relay.example.test/relay/ws/client',
        traversalRelay: undefined,
        rtcIceTransportPolicy: 'relay',
      } satisfies TraversalSettingsSource,
      undefined,
      BOUND_INITIAL,
    );

    expect(plan.candidates.map((candidate) => candidate.path)).toEqual(['ipv4']);
    expect(plan.candidates.every((candidate) => candidate.kind === 'ws')).toBe(true);
  });

  it('keeps cached mode-default and bound-initial plans separate', () => {
    const defaultPlan = buildTraversalPlanCached(targetWithRtcDirectory, settingsWithRtc);
    const boundPlan = buildTraversalPlanCached(
      targetWithRtcDirectory,
      settingsWithRtc,
      undefined,
      BOUND_INITIAL,
    );

    expect(boundPlan).not.toBe(defaultPlan);
    expect(defaultPlan.candidates.map((candidate) => candidate.path)).toEqual(['ipv4']);
    expect(boundPlan.candidates.map((candidate) => candidate.path)).toEqual([
      'ipv4',
      'rtc-direct',
      'rtc-relay',
    ]);
    expect(buildTraversalPlanCached(
      targetWithRtcDirectory,
      settingsWithRtc,
      undefined,
      BOUND_INITIAL,
    )).toBe(boundPlan);
  });

  it('keeps cached bound-initial plans separated by rtcIceTransportPolicy', () => {
    const autoPlan = buildTraversalPlanCached(
      targetWithRtcDirectory,
      settingsWithRtc,
      undefined,
      BOUND_INITIAL,
    );
    const relayPlan = buildTraversalPlanCached(
      targetWithRtcDirectory,
      settingsWithRelay,
      undefined,
      BOUND_INITIAL,
    );

    expect(autoPlan.candidates.map((candidate) => candidate.path)).toContain('rtc-direct');
    expect(relayPlan.candidates.map((candidate) => candidate.path)).not.toContain('rtc-direct');
    expect(relayPlan).not.toBe(autoPlan);
    expect(buildTraversalPlanCached(
      targetWithRtcDirectory,
      settingsWithRelay,
      undefined,
      BOUND_INITIAL,
    )).toBe(relayPlan);
  });

  it('does not invent RTC inputs or reuse another daemon directory endpoint', () => {
    const noRtcInputs = buildTraversalPlan(
      {
        bridgeHost: '203.0.113.10',
        bridgePort: 3333,
        authToken: 'daemon-token',
        daemonHostId: 'daemon-a',
        relayHostId: 'daemon-a',
        ipv4Host: '203.0.113.10',
        transportMode: 'auto',
      },
      {
        ...DEFAULT_BRIDGE_SETTINGS,
        signalUrl: '',
        traversalRelay: undefined,
      },
      undefined,
      BOUND_INITIAL,
    );
    expect(noRtcInputs.candidates.map((candidate) => candidate.path)).toEqual(['ipv4']);

    const crossDaemon = buildTraversalPlan(
      {
        ...targetWithRtcDirectory,
        relayEndpointCandidates: [
          targetWithRtcDirectory.relayEndpointCandidates[0],
          {
            id: 'rtc-direct-daemon-b',
            kind: 'rtc-direct',
            host: '198.51.100.20',
            port: 4444,
            relayHostId: 'daemon-b',
            authRequired: true,
            lastSeenAt: '2026-10-20T00:00:00.000Z',
          },
          {
            id: 'relay-rtc-daemon-b',
            kind: 'relay-rtc',
            host: 'relay-b.example.test',
            port: 3478,
            relayHostId: 'daemon-b',
            authRequired: true,
            lastSeenAt: '2026-10-20T00:00:00.000Z',
          },
        ],
      },
      settingsWithRtc,
      undefined,
      BOUND_INITIAL,
    );
    const rtc = crossDaemon.candidates.filter((candidate) => candidate.kind === 'rtc');
    expect(rtc.map((candidate) => candidate.id)).toEqual([
      'rtc-direct:daemon-a',
      'relay-rtc:daemon-a',
    ]);
    expect(JSON.stringify(rtc)).not.toContain('daemon-b');
    expect(JSON.stringify(rtc)).not.toContain('198.51.100.20');
  });
});
