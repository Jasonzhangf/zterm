import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionHeartbeatStore, type HeartbeatTimerHandle } from './session-heartbeat-store';

function makeInterval(callback: () => void, ms: number): HeartbeatTimerHandle {
  return setInterval(callback, ms) as unknown as HeartbeatTimerHandle;
}

describe('session-heartbeat-store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds caller-created ping interval handles per heartbeat key', () => {
    const store = createSessionHeartbeatStore();
    const timer = makeInterval(() => undefined, 1_000);

    expect(store.readPingInterval('s1')).toBeNull();
    store.setPingInterval('s1', timer);
    expect(store.readPingInterval('s1')).toBe(timer);
    expect(store.pingIntervalKeys()).toEqual(['s1']);

    store.clearPingInterval('s1');
    expect(store.readPingInterval('s1')).toBeNull();
    expect(store.pingIntervalKeys()).toEqual([]);
  });

  it('clearPingInterval clears the underlying interval so the callback stops firing', () => {
    const store = createSessionHeartbeatStore();
    const tick = vi.fn();
    store.setPingInterval('s1', makeInterval(tick, 1_000));

    vi.advanceTimersByTime(1_000);
    expect(tick).toHaveBeenCalledTimes(1);

    store.clearPingInterval('s1');
    vi.advanceTimersByTime(5_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('clearPingInterval is a no-op for unknown keys', () => {
    const store = createSessionHeartbeatStore();
    expect(() => store.clearPingInterval('missing')).not.toThrow();
  });

  it('replacing a handle for the same key keeps only the latest handle', () => {
    const store = createSessionHeartbeatStore();
    const first = makeInterval(() => undefined, 1_000);
    const second = makeInterval(() => undefined, 1_000);

    store.setPingInterval('s1', first);
    store.setPingInterval('s1', second);

    expect(store.readPingInterval('s1')).toBe(second);
    expect(store.pingIntervalKeys()).toEqual(['s1']);
    clearInterval(first);
    store.clearPingInterval('s1');
  });

  it('records and reads pong / server activity / terminal activity with 0 default', () => {
    const store = createSessionHeartbeatStore();

    expect(store.readLastPongAt('s1')).toBe(0);
    expect(store.readLastServerActivityAt('s1')).toBe(0);
    expect(store.readLastTerminalActivityAt('s1')).toBe(0);

    store.recordPong('s1', 1_000);
    store.recordServerActivity('s1', 2_000);
    store.recordTerminalActivity('s1', 3_000);

    expect(store.readLastPongAt('s1')).toBe(1_000);
    expect(store.readLastServerActivityAt('s1')).toBe(2_000);
    expect(store.readLastTerminalActivityAt('s1')).toBe(3_000);
  });

  it('defaults record timestamps to Date.now()', () => {
    const store = createSessionHeartbeatStore();
    vi.setSystemTime(123_456);

    store.recordPong('s1');
    store.recordServerActivity('s1');
    store.recordTerminalActivity('s1');

    expect(store.readLastPongAt('s1')).toBe(123_456);
    expect(store.readLastServerActivityAt('s1')).toBe(123_456);
    expect(store.readLastTerminalActivityAt('s1')).toBe(123_456);
  });

  it('keeps heartbeat keys independent (session vs target keys)', () => {
    const store = createSessionHeartbeatStore();
    store.recordPong('s1', 10);
    store.recordPong('target:host-a', 20);

    expect(store.readLastPongAt('s1')).toBe(10);
    expect(store.readLastPongAt('target:host-a')).toBe(20);
    expect(store.readLastPongAt('s2')).toBe(0);
  });

  it('deleteSession clears the interval handle and drops pong/server activity, keeping terminal activity', () => {
    const store = createSessionHeartbeatStore();
    const tick = vi.fn();
    store.setPingInterval('s1', makeInterval(tick, 1_000));
    store.recordPong('s1', 1_000);
    store.recordServerActivity('s1', 2_000);
    store.recordTerminalActivity('s1', 3_000);

    store.deleteSession('s1');

    expect(store.readPingInterval('s1')).toBeNull();
    expect(store.readLastPongAt('s1')).toBe(0);
    expect(store.readLastServerActivityAt('s1')).toBe(0);
    // clearSessionHeartbeat never touched lastTerminalActivityAt; keep parity.
    expect(store.readLastTerminalActivityAt('s1')).toBe(3_000);

    vi.advanceTimersByTime(5_000);
    expect(tick).not.toHaveBeenCalled();
  });

  it('deleteSession does not disturb other keys', () => {
    const store = createSessionHeartbeatStore();
    const keep = vi.fn();
    store.setPingInterval('s2', makeInterval(keep, 1_000));
    store.recordPong('s2', 42);

    store.deleteSession('s1');

    expect(store.readPingInterval('s2')).not.toBeNull();
    expect(store.readLastPongAt('s2')).toBe(42);
    store.clearPingInterval('s2');
  });

  it('clearAllPingIntervals clears every held interval (provider dispose path)', () => {
    const store = createSessionHeartbeatStore();
    const tickA = vi.fn();
    const tickB = vi.fn();
    store.setPingInterval('s1', makeInterval(tickA, 1_000));
    store.setPingInterval('target:host-a', makeInterval(tickB, 1_000));
    store.recordPong('s1', 7);

    store.clearAllPingIntervals();

    expect(store.pingIntervalKeys()).toEqual([]);
    vi.advanceTimersByTime(5_000);
    expect(tickA).not.toHaveBeenCalled();
    expect(tickB).not.toHaveBeenCalled();
    // clearAllPingIntervals only touches timers, not activity truth.
    expect(store.readLastPongAt('s1')).toBe(7);
  });
});
