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
  it('defaults Auto selection to Tailscale before UDP direct and Relay', () => {
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

  it('selects private LAN before Tailscale, WebRTC direct, and Relay when no route has recent health', () => {
    const selection = selectBestTraversalRoute({
      candidates,
      traversalPathPriority: ['ipv4', 'tailscale', 'rtc-direct', 'rtc-relay'],
    });

    expect(selection.selected).toMatchObject({ id: 'direct:lan', path: 'ipv4' });
    expect(selection.diagnostics.find((item) => item.candidateId === 'direct:lan')?.reasons).toContain('ipv4:private-lan');
  });

  it('selects Tailscale before public IPv4, WebRTC direct, and Relay by default', () => {
    const selection = selectBestTraversalRoute({
      candidates: candidates.filter((candidate) => candidate.id !== 'direct:lan'),
      traversalPathPriority: ['ipv4', 'tailscale', 'rtc-direct', 'rtc-relay'],
    });

    expect(selection.selected).toMatchObject({ id: 'direct:tailscale', path: 'tailscale' });
    expect(selection.diagnostics.find((item) => item.candidateId === 'direct:ipv4')?.reasons).toContain('ipv4:non-lan');
  });

  it('selects reachable direct candidate with recent low RTT success', () => {
    const cache = new TraversalRouteHealthCache({ now: () => 1000 });
    cache.recordSuccess({ accountId: 'u1', daemonHostId: 'daemon-a' }, candidates[3], 35);

    const selection = selectBestTraversalRoute({
      candidates: candidates.filter((candidate) => candidate.id !== 'direct:lan'),
      healthCache: cache,
      scope: { accountId: 'u1', daemonHostId: 'daemon-a' },
      traversalPathPriority: ['rtc-relay', 'ipv4', 'tailscale'],
    });

    expect(selection.selected).toMatchObject({ id: 'direct:ipv4', path: 'ipv4' });
    expect(selection.diagnostics.find((item) => item.candidateId === 'direct:ipv4')).toMatchObject({
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
      traversalPathPriority: ['tailscale', 'ipv4', 'rtc-relay'],
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
      traversalPathPriority: ['tailscale', 'ipv4', 'rtc-relay'],
    });

    expect(selection.selected).toMatchObject({ id: 'direct:tailscale', path: 'tailscale' });
    expect(selection.diagnostics.find((item) => item.candidateId === 'direct:tailscale')?.reasons).toContain('health:unknown');
  });

  it('reprobes a recovered Tailscale route after transient failure cooldown without process reset', () => {
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

    now = 2001;
    const recoveredSelection = selectBestTraversalRoute({
      candidates: [tailscale, relay],
      healthCache: cache,
      scope,
    });

    expect(recoveredSelection.selected).toMatchObject({ id: 'direct:tailscale' });
    expect(recoveredSelection.diagnostics.find((item) => item.candidateId === 'direct:tailscale')).toMatchObject({
      selectable: true,
    });
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
    expect(selection.diagnostics.find((item) => item.candidateId === 'direct:tailscale')).toMatchObject({
      health: { status: 'failure', error: 'timeout' },
    });
  });

  it('lets a slow Tailscale success lose to WebRTC direct before using Relay', () => {
    const cache = new TraversalRouteHealthCache({ now: () => 1000 });
    const nonLanCandidates = candidates.filter((candidate) => candidate.id !== 'direct:lan');
    cache.recordSuccess({ accountId: 'u1', daemonHostId: 'daemon-a' }, nonLanCandidates[1], 1200);

    const selection = selectBestTraversalRoute({
      candidates: nonLanCandidates,
      healthCache: cache,
      scope: { accountId: 'u1', daemonHostId: 'daemon-a' },
      traversalPathPriority: ['ipv4', 'tailscale', 'rtc-direct', 'rtc-relay'],
    });

    expect(selection.selected).toMatchObject({ id: 'rtc-direct:daemon-a', path: 'rtc-direct' });
    expect(selection.selected?.path).not.toBe('rtc-relay');
  });
});
