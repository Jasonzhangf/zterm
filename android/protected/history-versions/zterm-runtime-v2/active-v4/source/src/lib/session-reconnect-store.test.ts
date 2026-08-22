import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSessionReconnectStore,
  isSessionReconnectInFlight,
  type SessionReconnectRuntime,
} from './session-reconnect-store';

function makeTimer(delayMs = 1000) {
  return setTimeout(() => undefined, delayMs) as unknown as number;
}

describe('session reconnect store', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates idle runtime as the only empty phase', () => {
    const store = createSessionReconnectStore();
    const runtime = store.ensure('s1');
    expect(runtime).toEqual({
      phase: 'idle',
      attempt: 0,
      nextDelayMs: null,
    });
    expect(store.isInFlight('s1')).toBe(false);
  });

  it('schedules one timer and reports reconnect in flight', () => {
    vi.useFakeTimers();
    const store = createSessionReconnectStore();
    const timer = makeTimer();
    store.schedule('s1', {
      attempt: 2,
      nextDelayMs: null,
      timer,
    });

    expect(store.read('s1')).toEqual({
      phase: 'scheduled',
      attempt: 2,
      nextDelayMs: null,
      timer,
    });
    expect(store.isInFlight('s1')).toBe(true);
  });

  it('clears the previous scheduled timer when replacing a schedule', () => {
    vi.useFakeTimers();
    const store = createSessionReconnectStore();
    const firstTimer = makeTimer();
    const secondTimer = makeTimer();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    store.schedule('s1', { attempt: 1, timer: firstTimer });
    store.schedule('s1', { attempt: 1, timer: secondTimer });

    expect(clearTimeoutSpy).toHaveBeenCalledWith(firstTimer);
    expect(store.read('s1')).toEqual(expect.objectContaining({
      phase: 'scheduled',
      timer: secondTimer,
    }));
  });

  it('marks scheduled runtime as connecting without carrying a timer into the connecting phase', () => {
    vi.useFakeTimers();
    const store = createSessionReconnectStore();
    const timer = makeTimer();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    store.schedule('s1', { attempt: 3, timer });

    const next = store.markConnecting('s1');

    expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
    expect(next).toEqual({
      phase: 'connecting',
      attempt: 3,
      nextDelayMs: null,
    });
    if (next?.phase === 'connecting') {
      expect('timer' in next).toBe(false);
    }
    expect(store.isInFlight('s1')).toBe(true);
  });

  it('treats only scheduled and connecting phases as in flight', () => {
    vi.useFakeTimers();
    const idle: SessionReconnectRuntime = { phase: 'idle', attempt: 0, nextDelayMs: null };
    const scheduled: SessionReconnectRuntime = {
      phase: 'scheduled',
      attempt: 1,
      nextDelayMs: null,
      timer: makeTimer(),
    };
    const connecting: SessionReconnectRuntime = { phase: 'connecting', attempt: 1, nextDelayMs: null };

    expect(isSessionReconnectInFlight(null)).toBe(false);
    expect(isSessionReconnectInFlight(idle)).toBe(false);
    expect(isSessionReconnectInFlight(scheduled)).toBe(true);
    expect(isSessionReconnectInFlight(connecting)).toBe(true);
  });

  it('deleteSession and clearAll clear scheduled timers before dropping state', () => {
    vi.useFakeTimers();
    const store = createSessionReconnectStore();
    const timer1 = makeTimer();
    const timer2 = makeTimer();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    store.schedule('s1', { timer: timer1 });
    store.schedule('s2', { timer: timer2 });

    store.deleteSession('s1');
    expect(clearTimeoutSpy).toHaveBeenCalledWith(timer1);
    expect(store.read('s1')).toBeNull();
    expect(store.read('s2')).not.toBeNull();

    store.clearAll();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(timer2);
    expect(Array.from(store.values())).toEqual([]);
  });

  it('keeps manual-close markers in the reconnect owner and clears them per session', () => {
    vi.useFakeTimers();
    const store = createSessionReconnectStore();

    store.markManualClosed('s1');
    store.schedule('s1', { timer: makeTimer() });
    store.markStaleTransportProbe('s1', 10);

    expect(store.isManualClosed('s1')).toBe(true);

    store.deleteSession('s1');

    expect(store.isManualClosed('s1')).toBe(false);
    expect(store.read('s1')).toBeNull();
    expect(store.readStaleTransportProbeAt('s1')).toBe(0);
  });

  it('tracks stale transport probe markers without replacing an active probe', () => {
    const store = createSessionReconnectStore();

    expect(store.markStaleTransportProbeIfAbsent('s1', 100)).toBe(true);
    expect(store.markStaleTransportProbeIfAbsent('s1', 200)).toBe(false);
    expect(store.readStaleTransportProbeAt('s1')).toBe(100);

    store.clearStaleTransportProbe('s1');

    expect(store.readStaleTransportProbeAt('s1')).toBe(0);
  });
});
