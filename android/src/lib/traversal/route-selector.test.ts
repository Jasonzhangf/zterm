import { describe, expect, it } from 'vitest';
import { TraversalRouteHealthCache } from './route-health-cache';
import { selectBestTraversalRoute } from './route-selector';
import type { TraversalPlanCandidate } from './types';

const candidates = [
  {
    id: 'direct:lan',
    kind: 'ws',
    path: 'ipv4',
    endpoint: '192.168.1.20:3333',
    url: 'ws://192.168.1.20:3333',
  },
  {
    id: 'rtc-direct:daemon-a',
    kind: 'rtc',
    path: 'rtc-direct',
    endpoint: 'rtc-direct:daemon-a',
    signalUrl: 'wss://relay.example.com/ws/client?hostId=daemon-a',
    iceServers: [],
    iceTransportPolicy: 'all',
  },
  {
    id: 'direct:tailscale',
    kind: 'ws',
    path: 'tailscale',
    endpoint: 'mac.tailnet.ts.net:3333',
    url: 'ws://mac.tailnet.ts.net:3333',
  },
  {
    id: 'direct:ipv4',
    kind: 'ws',
    path: 'ipv4',
    endpoint: '203.0.113.10:3333',
    url: 'ws://203.0.113.10:3333',
  },
  {
    id: 'relay-rtc:daemon-a',
    kind: 'rtc',
    path: 'rtc-relay',
    endpoint: 'relay',
    signalUrl: 'wss://relay.example.com/ws/client?hostId=daemon-a',
    iceServers: [],
    iceTransportPolicy: 'relay',
  },
] satisfies TraversalPlanCandidate[];

describe('selectBestTraversalRoute', () => {
  it('defaults Auto selection to Tailscale before UDP direct and Relay when no LAN route exists', () => {
    const selection = selectBestTraversalRoute({
      candidates: [
        candidates[4]!,
        candidates[1]!,
        candidates[2]!,
      ],
    });

    expect(selection.selected).toMatchObject({ id: 'direct:tailscale', path: 'tailscale' });
    expect(selection.diagnostics.map((item) => item.path)).toEqual([
      'rtc-relay',
      'rtc-direct',
      'tailscale',
    ]);
  });

  it('does not give private LAN a priority bonus over remote routes', () => {
    const selection = selectBestTraversalRoute({
      candidates,
    });

    expect(selection.selected).toMatchObject({ id: 'direct:tailscale', path: 'tailscale' });
    expect(selection.diagnostics.find((item) => item.candidateId === 'direct:lan')?.reasons).not.toContain('ipv4:private-lan');
  });

  it('selects Tailscale after the LAN candidate records an ordinary reachability failure', () => {
    const cache = new TraversalRouteHealthCache();
    const scope = { accountId: 'u1', daemonHostId: 'daemon-a' };
    cache.recordFailure(scope, candidates[0], 'LAN endpoint unreachable');

    const selection = selectBestTraversalRoute({
      candidates: [candidates[0], candidates[2]],
      healthCache: cache,
      scope,
    });

    expect(selection.selected).toMatchObject({ id: 'direct:tailscale', path: 'tailscale' });
    expect(selection.diagnostics.find((item) => item.candidateId === 'direct:lan')).toMatchObject({
      selectable: false,
      health: { status: 'failure', error: 'LAN endpoint unreachable' },
    });
    expect(selection.diagnostics.find((item) => item.candidateId === 'direct:tailscale')).toMatchObject({
      selectable: true,
    });
  });

  it('selects Tailscale before WebRTC direct, public IPv4, and Relay by default', () => {
    const selection = selectBestTraversalRoute({
      candidates: candidates.filter((candidate) => candidate.id !== 'direct:lan'),
    });

    expect(selection.selected).toMatchObject({ id: 'direct:tailscale', path: 'tailscale' });
    expect(selection.diagnostics.find((item) => item.candidateId === 'direct:ipv4')?.reasons).toContain('health:unknown');
  });

  it('uses a recent successful route lease before probing unknown higher-tier routes', () => {
    const cache = new TraversalRouteHealthCache({ now: () => 1000 });
    cache.recordSuccess({ accountId: 'u1', daemonHostId: 'daemon-a' }, candidates[1], 35);

    const selection = selectBestTraversalRoute({
      candidates: candidates.filter((candidate) => candidate.id !== 'direct:lan'),
      healthCache: cache,
      scope: { accountId: 'u1', daemonHostId: 'daemon-a' },
    });

    expect(selection.selected).toMatchObject({ id: 'rtc-direct:daemon-a', path: 'rtc-direct' });
    expect(selection.diagnostics.find((item) => item.candidateId === 'rtc-direct:daemon-a')).toMatchObject({
      selectable: true,
      health: { status: 'success', rttMs: 35 },
    });
  });

  it('rejects fresh unreachable and auth-failed candidates instead of treating relay as hidden fallback', () => {
    const cache = new TraversalRouteHealthCache({ now: () => 1000 });
    const nonLanCandidates = candidates.filter((candidate) => candidate.id !== 'direct:lan');
    cache.recordFailure({ accountId: 'u1', daemonHostId: 'daemon-a' }, nonLanCandidates[0], 'timeout');
    cache.recordFailure({ accountId: 'u1', daemonHostId: 'daemon-a' }, nonLanCandidates[1], 'timeout');
    cache.recordFailure({ accountId: 'u1', daemonHostId: 'daemon-a' }, nonLanCandidates[2], '401 unauthorized', { authFailure: true });
    cache.recordSuccess({ accountId: 'u1', daemonHostId: 'daemon-a' }, nonLanCandidates[3], 180);

    const selection = selectBestTraversalRoute({
      candidates: nonLanCandidates,
      healthCache: cache,
      scope: { accountId: 'u1', daemonHostId: 'daemon-a' },
    });

    expect(selection.selected).toMatchObject({ id: 'relay-rtc:daemon-a', path: 'rtc-relay' });
    expect(selection.diagnostics.find((item) => item.candidateId === 'direct:tailscale')).toMatchObject({
      selectable: false,
    });
    expect(selection.diagnostics.find((item) => item.candidateId === 'direct:ipv4')).toMatchObject({
      selectable: false,
      health: { status: 'auth-failure' },
    });
  });

  it('expires stale failure and lets direct candidate win again by policy score', () => {
    let now = 1000;
    const cache = new TraversalRouteHealthCache({ ttlMs: 50, now: () => now });
    const nonLanCandidates = candidates.filter((candidate) => candidate.id !== 'direct:lan');
    cache.recordFailure({ accountId: 'u1', daemonHostId: 'daemon-a' }, nonLanCandidates[0], 'timeout');
    cache.recordSuccess({ accountId: 'u1', daemonHostId: 'daemon-a' }, nonLanCandidates[3], 200);

    now = 1060;
    const selection = selectBestTraversalRoute({
      candidates: nonLanCandidates,
      healthCache: cache,
      scope: { accountId: 'u1', daemonHostId: 'daemon-a' },
    });

    expect(selection.selected).toMatchObject({ id: 'direct:tailscale', path: 'tailscale' });
    expect(selection.diagnostics.find((item) => item.candidateId === 'direct:tailscale')?.reasons).toContain('health:unknown');
  });

  it('keeps a successful relay lease until that lease receives an explicit failure signal', () => {
    let now = 1000;
    const cache = new TraversalRouteHealthCache({
      ttlMs: 5 * 60_000,
      now: () => now,
    });
    const tailscale = candidates[2]!;
    const relay = candidates[4]!;
    const scope = { accountId: 'u1', daemonHostId: 'daemon-a' };
    cache.recordFailure(scope, tailscale, 'network changed');
    cache.recordSuccess(scope, relay, 150);

    expect(selectBestTraversalRoute({
      candidates: [tailscale, relay],
      healthCache: cache,
      scope,
    }).selected).toMatchObject({ id: 'relay-rtc:daemon-a' });

    now = 1500;
    const stillQuarantined = selectBestTraversalRoute({
      candidates: [tailscale, relay],
      healthCache: cache,
      scope,
    });
    expect(stillQuarantined.selected).toMatchObject({ id: 'relay-rtc:daemon-a' });
    expect(stillQuarantined.diagnostics.find((item) => item.candidateId === 'direct:tailscale')).toMatchObject({
      selectable: false,
    });

    now = 2001;
    const recoveredSelection = selectBestTraversalRoute({
      candidates: [tailscale, relay],
      healthCache: cache,
      scope,
    });

    expect(recoveredSelection.selected).toMatchObject({ id: 'relay-rtc:daemon-a' });
    expect(recoveredSelection.diagnostics.find((item) => item.candidateId === 'direct:tailscale')).toMatchObject({
      selectable: true,
    });

    cache.recordFailure(scope, relay, 'relay lease closed');
    const nextSelection = selectBestTraversalRoute({
      candidates: [tailscale, relay],
      healthCache: cache,
      scope,
    });
    expect(nextSelection.selected).toMatchObject({ id: 'direct:tailscale' });
  });

  it('reprobes the least-bad candidate when every route is currently unhealthy', () => {
    const cache = new TraversalRouteHealthCache({ now: () => 1000 });
    const nonLanCandidates = candidates.filter((candidate) => candidate.id !== 'direct:lan');
    cache.recordFailure({ accountId: 'u1', daemonHostId: 'daemon-a' }, nonLanCandidates[0], 'timeout');
    cache.recordFailure({ accountId: 'u1', daemonHostId: 'daemon-a' }, nonLanCandidates[1], 'timeout');
    cache.recordFailure({ accountId: 'u1', daemonHostId: 'daemon-a' }, nonLanCandidates[2], 'timeout');
    cache.recordFailure({ accountId: 'u1', daemonHostId: 'daemon-a' }, nonLanCandidates[3], 'timeout');

    const selection = selectBestTraversalRoute({
      candidates: nonLanCandidates,
      healthCache: cache,
      scope: { accountId: 'u1', daemonHostId: 'daemon-a' },
      traversalPathPriority: ['tailscale', 'ipv4', 'rtc-relay'],
    });

    expect(selection.selected).toMatchObject({ id: 'direct:tailscale', path: 'tailscale' });
    expect(selection.diagnostics.every((item) => item.selectable === false)).toBe(true);
    expect(selection.diagnostics.find((item) => item.candidateId === 'rtc-direct:daemon-a')).toMatchObject({
      health: { status: 'failure', error: 'timeout' },
    });
  });

  it('keeps Tailscale ahead of UDP direct when neither route has a reusable lease', () => {
    const selection = selectBestTraversalRoute({
      candidates: candidates.filter((candidate) => candidate.id !== 'direct:lan'),
    });

    expect(selection.selected).toMatchObject({ id: 'direct:tailscale', path: 'tailscale' });
  });

  it('uses a recent UDP direct lease before probing Tailscale again', () => {
    const cache = new TraversalRouteHealthCache({ now: () => 1000 });
    const nonLanCandidates = candidates.filter((candidate) => candidate.id !== 'direct:lan');
    cache.recordSuccess({ accountId: 'u1', daemonHostId: 'daemon-a' }, nonLanCandidates[0], 80);

    const selection = selectBestTraversalRoute({
      candidates: nonLanCandidates,
      healthCache: cache,
      scope: { accountId: 'u1', daemonHostId: 'daemon-a' },
    });

    expect(selection.selected).toMatchObject({ id: 'rtc-direct:daemon-a', path: 'rtc-direct' });
    expect(selection.selected?.path).not.toBe('rtc-relay');
  });
});
