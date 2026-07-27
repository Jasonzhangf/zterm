import { describe, expect, it } from 'vitest';
import { TraversalRouteHealthCache, buildTraversalRouteHealthKey } from './route-health-cache';
import type { TraversalPlanCandidate } from './types';

const candidate = {
  id: 'relay-rtc:daemon-a',
  kind: 'rtc',
  path: 'rtc-relay',
  endpoint: 'relay',
  signalUrl: 'wss://relay.example.com/ws/client?hostId=daemon-a',
  iceServers: [],
  iceTransportPolicy: 'relay',
} satisfies TraversalPlanCandidate;

describe('TraversalRouteHealthCache', () => {
  it('keys route health by account, daemon, and endpoint candidate id', () => {
    expect(buildTraversalRouteHealthKey(
      { accountId: 'account-a', daemonHostId: 'daemon-a' },
      candidate,
    )).toBe('account-a::daemon-a::relay-rtc:daemon-a');
  });

  it('stores success and expires stale entries by TTL', () => {
    let now = 1000;
    const cache = new TraversalRouteHealthCache({ ttlMs: 100, now: () => now });
    cache.recordSuccess({ accountId: 'u1', daemonHostId: 'daemon-a' }, candidate, 42);

    expect(cache.get({ accountId: 'u1', daemonHostId: 'daemon-a' }, candidate)).toMatchObject({
      status: 'success',
      rttMs: 42,
    });

    now = 1101;
    expect(cache.get({ accountId: 'u1', daemonHostId: 'daemon-a' }, candidate)).toBeNull();
  });

  it('does not leak route health across users or daemon hostIds', () => {
    const cache = new TraversalRouteHealthCache({ now: () => 1000 });
    cache.recordFailure({ accountId: 'u1', daemonHostId: 'daemon-a' }, candidate, 'timeout');

    expect(cache.get({ accountId: 'u2', daemonHostId: 'daemon-a' }, candidate)).toBeNull();
    expect(cache.get({ accountId: 'u1', daemonHostId: 'daemon-b' }, candidate)).toBeNull();
    expect(cache.get({ accountId: 'u1', daemonHostId: 'daemon-a' }, candidate)).toMatchObject({
      status: 'failure',
      error: 'timeout',
    });
  });

  it('expires an ordinary transient failure after the short reprobe cooldown', () => {
    let now = 1000;
    const cache = new TraversalRouteHealthCache({
      ttlMs: 5 * 60_000,
      now: () => now,
    });
    cache.recordFailure({ accountId: 'u1', daemonHostId: 'daemon-a' }, candidate, 'network changed');

    expect(cache.get({ accountId: 'u1', daemonHostId: 'daemon-a' }, candidate)).toMatchObject({
      status: 'failure',
    });

    now = 2001;
    expect(cache.get({ accountId: 'u1', daemonHostId: 'daemon-a' }, candidate)).toBeNull();
  });

  it('keeps authentication failures quarantined for the full health TTL', () => {
    let now = 1000;
    const cache = new TraversalRouteHealthCache({
      ttlMs: 5 * 60_000,
      now: () => now,
    });
    cache.recordFailure(
      { accountId: 'u1', daemonHostId: 'daemon-a' },
      candidate,
      '401 unauthorized',
      { authFailure: true },
    );

    now = 2001;
    expect(cache.get({ accountId: 'u1', daemonHostId: 'daemon-a' }, candidate)).toMatchObject({
      status: 'auth-failure',
      error: '401 unauthorized',
    });

    now = 301_001;
    expect(cache.get({ accountId: 'u1', daemonHostId: 'daemon-a' }, candidate)).toBeNull();
  });

  it('lists and snapshots only live records for the requested scope', () => {
    let now = 1000;
    const cache = new TraversalRouteHealthCache({ ttlMs: 100, now: () => now });
    cache.recordSuccess({ accountId: 'u1', daemonHostId: 'daemon-a' }, candidate, 18);
    cache.recordFailure({ accountId: 'u1', daemonHostId: 'daemon-a' }, {
      ...candidate,
      id: 'direct:tailscale',
      path: 'tailscale',
      endpoint: 'mac.tailnet.ts.net:3333',
      kind: 'ws',
      url: 'ws://mac.tailnet.ts.net:3333',
    }, 'timeout');
    cache.recordFailure({ accountId: 'u2', daemonHostId: 'daemon-a' }, candidate, 'other account');

    expect(cache.list({ accountId: 'u1', daemonHostId: 'daemon-a' })).toHaveLength(2);
    expect(cache.snapshot({ accountId: 'u1', daemonHostId: 'daemon-a' })).toMatchObject([
      expect.objectContaining({ status: 'failure' }),
      expect.objectContaining({ status: 'success', rttMs: 18 }),
    ]);

    now = 1101;
    expect(cache.list({ accountId: 'u1', daemonHostId: 'daemon-a' })).toHaveLength(0);
  });
});
