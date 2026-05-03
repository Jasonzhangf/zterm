import { describe, expect, it } from 'vitest';
import { createSessionDebugMetricsStore } from './session-debug-metrics-store';

describe('session-debug-metrics-store', () => {
  it('builds rate metrics from wire stats snapshots', () => {
    const store = createSessionDebugMetricsStore();
    store.recordTxBytes('s1', 'abcd');
    store.recordRxBytes('s1', 'abcdefgh');
    store.recordRenderCommit('s1');
    store.recordRefreshRequest('s1');

    const metrics = store.refresh([
      {
        sessionId: 's1',
        sessionState: 'connected',
        active: true,
        pullStatePurpose: 'tail-refresh',
        bufferPullActive: true,
      },
    ], 1000);

    expect(metrics.s1).toMatchObject({
      uplinkBps: 4,
      downlinkBps: 8,
      renderHz: 1,
      pullHz: 1,
      bufferPullActive: true,
      status: 'refreshing',
      active: true,
    });
  });

  it('falls back to synthetic waiting metrics when no sample exists yet', () => {
    const store = createSessionDebugMetricsStore();
    expect(store.getMetrics('s1', 'connecting', false, 123)).toEqual({
      uplinkBps: 0,
      downlinkBps: 0,
      renderHz: 0,
      pullHz: 0,
      bufferPullActive: false,
      status: 'connecting',
      active: false,
      updatedAt: 123,
    });
  });

  it('overrides active flag immediately without waiting for next refresh tick', () => {
    const store = createSessionDebugMetricsStore();
    store.refresh([
      {
        sessionId: 's1',
        sessionState: 'connected',
        active: false,
        pullStatePurpose: null,
        bufferPullActive: false,
      },
    ], 1000);

    expect(store.getMetrics('s1', 'connected', true, 2000)?.active).toBe(true);
  });
});
