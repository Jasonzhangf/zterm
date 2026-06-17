import { describe, expect, it } from 'vitest';
import {
  resolvePassiveTickTransportHealth,
  resolvePassiveVisibleRefreshTickMs,
} from './session-context-lifecycle';

describe('P1 passive visible pane fast lane', () => {
  describe('resolvePassiveVisibleRefreshTickMs', () => {
    it('keeps legacy slow lane when no transport health is provided', () => {
      const result = resolvePassiveVisibleRefreshTickMs(33);
      expect(result).toBe(198); // 33 * 6
      expect(result).toBeGreaterThanOrEqual(160);
    });

    it('returns fast lane 16-50ms for good transport', () => {
      const result = resolvePassiveVisibleRefreshTickMs(33, {
        bufferedBytes: 0,
        backpressured: false,
        connected: true,
      });
      expect(result).toBeGreaterThanOrEqual(16);
      expect(result).toBeLessThanOrEqual(50);
    });

    it('returns slow lane >=100ms for backpressured transport', () => {
      const result = resolvePassiveVisibleRefreshTickMs(33, {
        bufferedBytes: 200 * 1024,
        backpressured: true,
        connected: true,
      });
      expect(result).toBeGreaterThanOrEqual(100);
    });

    it('returns slow lane >=100ms for disconnected transport', () => {
      const result = resolvePassiveVisibleRefreshTickMs(33, {
        bufferedBytes: 0,
        backpressured: false,
        connected: false,
      });
      expect(result).toBeGreaterThanOrEqual(100);
    });

    it('returns medium lane 50-100ms for moderate buffered bytes', () => {
      const result = resolvePassiveVisibleRefreshTickMs(33, {
        bufferedBytes: 64 * 1024,
        backpressured: false,
        connected: true,
      });
      expect(result).toBeGreaterThanOrEqual(50);
      expect(result).toBeLessThan(100);
    });
  });

  describe('resolvePassiveTickTransportHealth', () => {
    it('reads bufferedAmount from transportRuntimeStore', () => {
      const health = resolvePassiveTickTransportHealth(
        's1',
        'connected',
        {
          current: {
            sessions: new Map([
              ['s1', { activeSocket: { bufferedAmount: 42 * 1024 } }],
            ]),
          },
        },
      );
      expect(health).toEqual({
        bufferedBytes: 42 * 1024,
        backpressured: false,
        connected: true,
      });
    });

    it('marks transport backpressured at >=128KiB', () => {
      const health = resolvePassiveTickTransportHealth(
        's1',
        'connected',
        {
          current: {
            sessions: new Map([
              ['s1', { activeSocket: { bufferedAmount: 200 * 1024 } }],
            ]),
          },
        },
      );
      expect(health).toEqual({
        bufferedBytes: 200 * 1024,
        backpressured: true,
        connected: true,
      });
    });

    it('reports disconnected even if no socket is present', () => {
      const health = resolvePassiveTickTransportHealth(
        's1',
        'disconnected',
        {
          current: {
            sessions: new Map(),
          },
        },
      );
      expect(health).toEqual({
        bufferedBytes: 0,
        backpressured: false,
        connected: false,
      });
    });
  });
});
