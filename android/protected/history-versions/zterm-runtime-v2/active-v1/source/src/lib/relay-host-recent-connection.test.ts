import { describe, expect, it } from 'vitest';
import type { BrowserStorageLike } from './browser-storage';
import {
  RECENT_RELAY_HOST_CONNECTION_WINDOW_MS,
  isRelayHostRecentlyConnected,
  readRecentRelayHostConnections,
  rememberRelayHostConnection,
} from './relay-host-recent-connection';

function createMemoryStorage(): { storage: BrowserStorageLike; dump: () => Record<string, unknown> } {
  const map = new Map<string, string>();
  return {
    storage: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, String(value));
      },
      removeItem: (key: string) => {
        map.delete(key);
      },
    },
    dump: () => {
      const raw = map.get('zterm:recentRelayHostConnections:v1');
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    },
  };
}

describe('relay-host-recent-connection', () => {
  it('remembers a connected daemon hostId and reads it back', () => {
    const { storage, dump } = createMemoryStorage();
    const now = Date.now();
    rememberRelayHostConnection('mac-studio', storage, now);
    expect(dump()['mac-studio']).toBe(now);
    expect(isRelayHostRecentlyConnected('mac-studio', storage, now + 1000)).toBe(true);
    expect(isRelayHostRecentlyConnected('other-host', storage, now + 1000)).toBe(false);
  });

  it('trims entries older than the 7-day window', () => {
    const { storage } = createMemoryStorage();
    const now = Date.now();
    rememberRelayHostConnection('fresh-host', storage, now);
    rememberRelayHostConnection('old-host', storage, now - RECENT_RELAY_HOST_CONNECTION_WINDOW_MS - 60_000);
    const read = readRecentRelayHostConnections(storage, now);
    expect([...read.keys()].sort()).toEqual(['fresh-host']);
  });

  it('tolerates corrupted storage data', () => {
    const { storage } = createMemoryStorage();
    storage.setItem('zterm:recentRelayHostConnections:v1', '{not-json');
    expect(readRecentRelayHostConnections(storage, Date.now()).size).toBe(0);
    expect(isRelayHostRecentlyConnected('mac-studio', storage, Date.now())).toBe(false);
  });

  it('is a no-op without storage', () => {
    expect(() => rememberRelayHostConnection('mac-studio', null, Date.now())).not.toThrow();
    expect(isRelayHostRecentlyConnected('mac-studio', null, Date.now())).toBe(false);
    expect(readRecentRelayHostConnections(null, Date.now()).size).toBe(0);
  });

  it('ignores empty and malformed hostIds', () => {
    const { storage, dump } = createMemoryStorage();
    const now = Date.now();
    rememberRelayHostConnection('', storage, now);
    rememberRelayHostConnection('   ', storage, now);
    expect(Object.keys(dump())).toHaveLength(0);
  });
});
