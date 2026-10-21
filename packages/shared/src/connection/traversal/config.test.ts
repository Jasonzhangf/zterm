import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BRIDGE_SETTINGS } from '../bridge-settings';
import {
  buildTraversalPlan,
  buildTraversalPlanCached,
  clearTraversalPlanCache,
} from './config';
import type { TraversalCandidateScope } from './types';

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
      'rtc-relay',
      'rtc-direct',
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
      'rtc-relay',
      'rtc-direct',
    ]);
    expect(buildTraversalPlanCached(
      targetWithRtcDirectory,
      settingsWithRtc,
      undefined,
      BOUND_INITIAL,
    )).toBe(boundPlan);
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
      'relay-rtc:daemon-a',
      'rtc-direct:daemon-a',
    ]);
    expect(JSON.stringify(rtc)).not.toContain('daemon-b');
    expect(JSON.stringify(rtc)).not.toContain('198.51.100.20');
  });
});
