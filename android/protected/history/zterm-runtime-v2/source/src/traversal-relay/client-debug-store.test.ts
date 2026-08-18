import { describe, expect, it } from 'vitest';
import { TraversalRelayClientDebugStore } from './client-debug-store';

describe('TraversalRelayClientDebugStore', () => {
  it('stores bounded logs per user/device and returns latest-first query results', () => {
    const store = new TraversalRelayClientDebugStore();
    store.appendLogs('user-1', 'device-a', [
      { seq: 1, ts: '2026-05-08T00:00:01.000Z', scope: 'alpha', payload: '1' },
      { seq: 2, ts: '2026-05-08T00:00:02.000Z', scope: 'beta', payload: '2' },
    ]);

    expect(store.listLogs('user-1', { deviceId: 'device-a', limit: 10 }).map((entry) => entry.scope)).toEqual(['beta', 'alpha']);
    expect(store.listDeviceSummaries('user-1')).toEqual([
      expect.objectContaining({ deviceId: 'device-a', logCount: 2, latestLogScope: 'beta' }),
    ]);
  });

  it('stores the latest snapshot per device', () => {
    const store = new TraversalRelayClientDebugStore();
    store.setSnapshot('user-1', 'device-a', {
      requestId: 'req-1',
      reason: 'manual',
      snapshot: { keyboardInset: 320 },
    });

    expect(store.getSnapshot('user-1', 'device-a')).toEqual(
      expect.objectContaining({ requestId: 'req-1', reason: 'manual', snapshot: { keyboardInset: 320 } }),
    );
  });
});
