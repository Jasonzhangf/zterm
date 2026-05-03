// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isRuntimeDebugEnabled,
  RUNTIME_DEBUG_CONSOLE_STORAGE_KEY,
  RUNTIME_DEBUG_STORAGE_KEY,
  drainRuntimeDebugEntries,
  runtimeDebug,
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
    vi.restoreAllMocks();
  });

  it('toggles the runtime debug flag through storage', () => {
    expect(isRuntimeDebugEnabled()).toBe(false);

    setRuntimeDebugEnabled(true);
    expect(window.localStorage.getItem(RUNTIME_DEBUG_STORAGE_KEY)).toBe('1');
    expect(isRuntimeDebugEnabled()).toBe(true);

    setRuntimeDebugEnabled(false);
    expect(window.localStorage.getItem(RUNTIME_DEBUG_STORAGE_KEY)).toBe(null);
    expect(isRuntimeDebugEnabled()).toBe(false);
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
});
