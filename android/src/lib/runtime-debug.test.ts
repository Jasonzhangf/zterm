// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RUNTIME_DEBUG_TTL_MS,
  MAX_RUNTIME_DEBUG_QUEUE,
  isRuntimeDebugEnabled,
  RUNTIME_DEBUG_CONSOLE_STORAGE_KEY,
  RUNTIME_DEBUG_EXPIRES_AT_STORAGE_KEY,
  RUNTIME_DEBUG_STORAGE_KEY,
  drainRuntimeDebugEntries,
  runtimeDebug,
  resetRuntimeDebugStateForTests,
  shouldCollectRuntimeDebugScope,
  setRuntimeDebugEnabled,
} from './runtime-debug';

describe('runtime debug storage flag', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, String(value));
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
        clear: () => {
          storage.clear();
        },
      },
    });
    while (drainRuntimeDebugEntries().length > 0) {
      // drain shared queue between tests
    }
    resetRuntimeDebugStateForTests();
    vi.restoreAllMocks();
  });

  it('toggles the runtime debug flag through storage', () => {
    expect(isRuntimeDebugEnabled()).toBe(false);

    setRuntimeDebugEnabled(true);
    expect(window.localStorage.getItem(RUNTIME_DEBUG_STORAGE_KEY)).toBe('1');
    expect(Number(window.localStorage.getItem(RUNTIME_DEBUG_EXPIRES_AT_STORAGE_KEY))).toBeGreaterThan(Date.now());
    expect(isRuntimeDebugEnabled()).toBe(true);

    setRuntimeDebugEnabled(false);
    expect(window.localStorage.getItem(RUNTIME_DEBUG_STORAGE_KEY)).toBe(null);
    expect(window.localStorage.getItem(RUNTIME_DEBUG_EXPIRES_AT_STORAGE_KEY)).toBe(null);
    expect(isRuntimeDebugEnabled()).toBe(false);
  });

  it('expires runtime debug upload and clears legacy permanent flags', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      setRuntimeDebugEnabled(true);
      expect(isRuntimeDebugEnabled()).toBe(true);

      vi.setSystemTime(1_000 + DEFAULT_RUNTIME_DEBUG_TTL_MS + 1);
      expect(isRuntimeDebugEnabled()).toBe(false);
      expect(window.localStorage.getItem(RUNTIME_DEBUG_STORAGE_KEY)).toBe(null);
      expect(window.localStorage.getItem(RUNTIME_DEBUG_EXPIRES_AT_STORAGE_KEY)).toBe(null);

      window.localStorage.setItem(RUNTIME_DEBUG_STORAGE_KEY, '1');
      resetRuntimeDebugStateForTests();
      expect(isRuntimeDebugEnabled()).toBe(false);
      expect(window.localStorage.getItem(RUNTIME_DEBUG_STORAGE_KEY)).toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it('queues debug entries without mirroring to console by default', () => {
    const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    setRuntimeDebugEnabled(true);
    runtimeDebug('session.input.send', { sessionId: 's1' });

    const entries = drainRuntimeDebugEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.scope).toBe('session.input.send');
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('stores the console mirror flag separately from the debug queue flag', () => {
    setRuntimeDebugEnabled(true);
    window.localStorage.setItem(RUNTIME_DEBUG_CONSOLE_STORAGE_KEY, '1');
    runtimeDebug('session.ws.connected', { sessionId: 's1' });
    expect(window.localStorage.getItem(RUNTIME_DEBUG_STORAGE_KEY)).toBe('1');
    expect(window.localStorage.getItem(RUNTIME_DEBUG_CONSOLE_STORAGE_KEY)).toBe('1');
  });

  it('keeps reliable input events when the debug queue overflows', () => {
    setRuntimeDebugEnabled(true);
    for (let index = 0; index < MAX_RUNTIME_DEBUG_QUEUE + 8; index += 1) {
      runtimeDebug('session.ws.connect.buffer-sync', { sessionId: `s${index}` });
    }
    runtimeDebug('session.input.reliable-send', { sessionId: 'input-1', bytes: 8 });

    const entries = [];
    while (true) {
      const batch = drainRuntimeDebugEntries();
      entries.push(...batch);
      if (batch.length === 0) {
        break;
      }
    }
    expect(entries.some((entry) => entry.scope === 'session.input.reliable-send')).toBe(true);
  });

  it('keeps render gate inspect evidence when the debug queue overflows', () => {
    setRuntimeDebugEnabled(true);
    for (let index = 0; index < MAX_RUNTIME_DEBUG_QUEUE + 8; index += 1) {
      runtimeDebug('session.ws.connect.buffer-sync', { sessionId: `s${index}` });
    }
    runtimeDebug('session.render-gate.flush.inspect', { sessionId: 'render-1' });

    const entries = [];
    while (true) {
      const batch = drainRuntimeDebugEntries();
      entries.push(...batch);
      if (batch.length === 0) {
        break;
      }
    }
    expect(entries.some((entry) => entry.scope === 'session.render-gate.flush.inspect')).toBe(true);
  });

  it('samples high-frequency active tick scopes before enqueueing', () => {
    vi.useFakeTimers();
    try {
      setRuntimeDebugEnabled(true);
      runtimeDebug('session.transport.active-tick', { sessionId: 's1', seq: 1 });
      runtimeDebug('session.transport.active-tick', { sessionId: 's1', seq: 2 });
      vi.advanceTimersByTime(600);
      runtimeDebug('session.transport.active-tick', { sessionId: 's1', seq: 3 });

      const entries = drainRuntimeDebugEntries();
      expect(entries.map((entry) => entry.scope)).toEqual([
        'session.transport.active-tick',
        'session.transport.active-tick',
      ]);
      expect(entries[0]?.payload).toContain('"seq":1');
      expect(entries[1]?.payload).toContain('"seq":3');
    } finally {
      vi.useRealTimers();
    }
  });

  it('samples inspect scopes before any heavy payload is built', () => {
    vi.useFakeTimers();
    try {
      setRuntimeDebugEnabled(true);
      expect(shouldCollectRuntimeDebugScope('session.buffer.apply.inspect')).toBe(true);
      expect(shouldCollectRuntimeDebugScope('session.buffer.apply.inspect')).toBe(false);
      vi.advanceTimersByTime(1600);
      expect(shouldCollectRuntimeDebugScope('session.buffer.apply.inspect')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
