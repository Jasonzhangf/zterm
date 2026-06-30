import { describe, expect, it } from 'vitest';
import { TraversalRouteHealthCache } from './route-health-cache';
import { selectBestTraversalRoute } from './route-selector';
import type { TraversalPlanCandidate } from './types';

const candidates = [
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
  },
] satisfies TraversalPlanCandidate[];

describe('selectBestTraversalRoute', () => {
  it('selects reachable direct candidate with recent low RTT success', () => {
    const cache = new TraversalRouteHealthCache({ now: () => 1000 });
    cache.recordSuccess({ accountId: 'u1', daemonHostId: 'daemon-a' }, candidates[1], 35);

    const selection = selectBestTraversalRoute({
      candidates,
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
    cache.recordFailure({ accountId: 'u1', daemonHostId: 'daemon-a' }, candidates[0], 'timeout');
    cache.recordFailure({ accountId: 'u1', daemonHostId: 'daemon-a' }, candidates[1], '401 unauthorized', { authFailure: true });
    cache.recordSuccess({ accountId: 'u1', daemonHostId: 'daemon-a' }, candidates[2], 180);

    const selection = selectBestTraversalRoute({
      candidates,
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
    cache.recordFailure({ accountId: 'u1', daemonHostId: 'daemon-a' }, candidates[0], 'timeout');
    cache.recordSuccess({ accountId: 'u1', daemonHostId: 'daemon-a' }, candidates[2], 200);

    now = 1060;
    const selection = selectBestTraversalRoute({
      candidates,
      healthCache: cache,
      scope: { accountId: 'u1', daemonHostId: 'daemon-a' },
      traversalPathPriority: ['tailscale', 'ipv4', 'rtc-relay'],
    });

    expect(selection.selected).toMatchObject({ id: 'direct:tailscale', path: 'tailscale' });
    expect(selection.diagnostics.find((item) => item.candidateId === 'direct:tailscale')?.reasons).toContain('health:unknown');
  });

  it('reprobes the least-bad candidate when every route is currently unhealthy', () => {
    const cache = new TraversalRouteHealthCache({ now: () => 1000 });
    cache.recordFailure({ accountId: 'u1', daemonHostId: 'daemon-a' }, candidates[0], 'timeout');
    cache.recordFailure({ accountId: 'u1', daemonHostId: 'daemon-a' }, candidates[1], 'timeout');
    cache.recordFailure({ accountId: 'u1', daemonHostId: 'daemon-a' }, candidates[2], 'timeout');

    const selection = selectBestTraversalRoute({
      candidates,
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
});
