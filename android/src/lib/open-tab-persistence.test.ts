// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from './types';
import type { Session } from './types';
import {
  buildPersistedOpenTabFromHostSession,
  clearClosedTabReuseKeysForOwner,
  findReusableOpenTabSession,
  persistOpenTabsState,
  persistClosedTabReuseKeys,
  readPersistedActiveSessionId,
  readPersistedActiveSessionIdState,
  readPersistedClosedTabReuseKeys,
  readPersistedOpenTabsState,
  resolveHostForPersistedOpenTab,
} from './open-tab-persistence';
import { dedupePersistedOpenTabs } from './open-tab-intent';

function makeSession(overrides?: Partial<Session>): Session {
  return {
    id: 'session-1',
    hostId: 'host-1',
    connectionName: 'conn-1',
    bridgeHost: '100.127.23.27',
    bridgePort: 3333,
    daemonHostId: 'daemon-host-1',
    sessionName: 'tmux-1',
    title: 'tab-1',
    ws: null,
    state: 'connected',
    hasUnread: false,
    createdAt: 1,
    daemonHeadRevision: 1,
    daemonHeadEndIndex: 10,
    buffer: {
      lines: [],
      gapRanges: [],
      startIndex: 0,
      endIndex: 10,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 10,
      cols: 80,
      rows: 24,
      cursorKeysApp: false,
      cursor: null,
      updateKind: 'replace',
      revision: 1,
    },
    ...overrides,
  };
}

describe('open-tab persistence truth', () => {
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
  });

  it('reads persisted tabs as raw storage truth without policy dedupe', () => {
    localStorage.setItem(STORAGE_KEYS.OPEN_TABS, JSON.stringify([
      {
        sessionId: 'old',
        hostId: 'host-z',
        connectionName: 'Conn Z',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'zterm',
        authToken: 'token-z',
        createdAt: 1,
      },
      {
        sessionId: 'new',
        hostId: 'host-z',
        connectionName: 'Conn Z',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'zterm',
        authToken: 'token-z',
        createdAt: 2,
      },
    ]));

    const state = readPersistedOpenTabsState();
    expect(state.status).toBe('available');
    expect(state.tabs.map((tab) => tab.sessionId)).toEqual(['old', 'new']);
  });

  it('persists exactly the provided tabs and active id without second normalization', () => {
    const result = persistOpenTabsState([
      {
        sessionId: 's1',
        hostId: 'host-1',
        connectionName: 'Conn 1',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'tmux-1',
        authToken: 'token-1',
        createdAt: 1,
      },
    ], 'missing-active');

    expect(result).toEqual({ ok: true });
    expect(readPersistedOpenTabsState().tabs.map((tab) => tab.sessionId)).toEqual(['s1']);
    expect(readPersistedActiveSessionId()).toBe('missing-active');
  });

  it('reports invalid persisted open-tab storage without pretending empty truth', () => {
    localStorage.setItem(STORAGE_KEYS.OPEN_TABS, JSON.stringify({ tabs: [] }));

    const state = readPersistedOpenTabsState();

    expect(state.status).toBe('invalid');
    expect(state.hasStoredValue).toBe(true);
    expect(state.tabs).toEqual([]);
    expect('error' in state && state.error).toBeTruthy();
  });

  it('reports open-tab read failures as explicit failed state', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error('storage read blocked');
        },
      },
    });

    const state = readPersistedOpenTabsState();

    expect(state.status).toBe('failed');
    expect(state.hasStoredValue).toBe(true);
    expect(state.tabs).toEqual([]);
    expect('error' in state && state.error).toBeInstanceOf(Error);
  });

  it('reports active-session read failures as explicit failed state', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error('active read blocked');
        },
      },
    });

    const state = readPersistedActiveSessionIdState();

    expect(state.status).toBe('failed');
    expect(state.activeSessionId).toBeNull();
    expect('error' in state && state.error).toBeInstanceOf(Error);
  });

  it('reports open-tab write failures as explicit failure result', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        setItem: () => {
          throw new Error('storage write blocked');
        },
      },
    });

    const result = persistOpenTabsState([
      {
        sessionId: 's1',
        hostId: 'host-1',
        connectionName: 'Conn 1',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'tmux-1',
        createdAt: 1,
      },
    ], 's1');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBeInstanceOf(Error);
  });

  it('deduplicates persisted tabs only by physical sessionId, not by bridge target + tmux session', () => {
    expect(dedupePersistedOpenTabs([
      {
        sessionId: 'old',
        hostId: 'host-z',
        connectionName: 'Conn Z',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'zterm',
        authToken: 'token-z',
        createdAt: 1,
      },
      {
        sessionId: 'new',
        hostId: 'host-z',
        connectionName: 'Conn Z',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'zterm',
        authToken: 'token-z',
        customName: 'Keep Me',
        createdAt: 2,
      },
    ])).toEqual([
      expect.objectContaining({
        sessionId: 'old',
      }),
      expect.objectContaining({
        sessionId: 'new',
        customName: 'Keep Me',
      }),
    ]);
  });

  it('reuses the same live session truth with the same semantic rule as SessionContext managed-session reuse', () => {
    const active = makeSession({
      id: 'active',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      sessionName: 'zterm',
      authToken: 'token-z',
      createdAt: 2,
      state: 'connected',
    });
    const stale = makeSession({
      id: 'stale',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      sessionName: 'zterm',
      authToken: 'token-z',
      createdAt: 1,
      state: 'idle',
    });

    expect(findReusableOpenTabSession({
      sessions: [stale, active],
      host: {
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-1',
        sessionName: 'zterm',
        authToken: 'token-z',
      },
      activeSessionId: 'active',
    })?.id).toBe('active');
  });

  it('reuses by daemonHostId + sessionName even if bridge endpoint changed', () => {
    const active = makeSession({
      id: 'active',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      daemonHostId: 'daemon-host-1',
      sessionName: 'zterm',
      authToken: 'token-z',
      createdAt: 2,
      state: 'connected',
    });

    expect(findReusableOpenTabSession({
      sessions: [active],
      host: {
        bridgeHost: '100.64.0.10',
        bridgePort: 4444,
        daemonHostId: 'daemon-host-1',
        sessionName: 'zterm',
        authToken: 'token-z',
      },
      activeSessionId: 'active',
    })?.id).toBe('active');
  });

  it('resolves a persisted tab into a restorable host with a single shared mapping rule', () => {
    expect(resolveHostForPersistedOpenTab({
      tab: {
        sessionId: 'saved-b',
        hostId: 'host-b',
        connectionName: 'Conn B',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'beta',
        authToken: 'token-b',
        customName: 'Keep Me',
        createdAt: 2,
      },
      hosts: [],
      fallbackIdPrefix: 'saved',
      fallbackLastConnected: 9,
    })).toEqual(expect.objectContaining({
      id: 'host-b',
      name: 'Conn B',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      sessionName: 'beta',
      authToken: 'token-b',
      lastConnected: 9,
    }));
  });

  it('prefers the current semantic host truth when the persisted host id is gone but the same daemon/session was re-saved under a new host id', () => {
    expect(resolveHostForPersistedOpenTab({
      tab: {
        sessionId: 'saved-main',
        hostId: 'host-stale',
        connectionName: 'Conn stale',
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        sessionName: 'main',
        authToken: 'token-stale',
        createdAt: 1,
      },
      hosts: [{
        id: 'host-fresh',
        createdAt: 2,
        name: 'Conn fresh',
        bridgeHost: '100.127.23.27',
        bridgePort: 4444,
        daemonHostId: 'daemon-a',
        relayHostId: 'daemon-a',
        sessionName: 'main',
        authToken: 'token-fresh',
        authType: 'password',
        tags: [],
        pinned: true,
        lastConnected: 99,
      }],
      fallbackIdPrefix: 'saved',
      fallbackLastConnected: 9,
    })).toEqual(expect.objectContaining({
      id: 'host-fresh',
      name: 'Conn fresh',
      bridgeHost: '100.127.23.27',
      bridgePort: 4444,
      daemonHostId: 'daemon-a',
      sessionName: 'main',
      authToken: 'token-fresh',
      lastConnected: 99,
    }));
  });

  it('builds a persisted open tab from imported host/session truth with one mapping rule', () => {
    expect(buildPersistedOpenTabFromHostSession({
      sessionId: 'saved-b-new',
      host: {
        id: 'host-b',
        name: 'Conn B',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'beta',
        authToken: 'token-b',
        autoCommand: 'pwd',
      },
      customName: ' Keep Me ',
      createdAt: 2,
    })).toEqual(expect.objectContaining({
      sessionId: 'saved-b-new',
      hostId: 'host-b',
      connectionName: 'Conn B',
      sessionName: 'beta',
      authToken: 'token-b',
      autoCommand: 'pwd',
      customName: 'Keep Me',
    }));
  });

  it('logs and returns empty closed-tab reuse keys when storage payload is invalid', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.setItem('zterm:closed-tab-reuse-keys', '{bad-json');

    expect(Array.from(readPersistedClosedTabReuseKeys())).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      '[open-tab-persistence] Failed to restore closed tab reuse keys:',
      expect.any(SyntaxError),
    );

    errorSpy.mockRestore();
  });

  it('persists and restores closed-tab reuse keys through one storage truth', () => {
    persistClosedTabReuseKeys(new Set(['daemon:a:main', 'daemon:b:logs']));

    expect(Array.from(readPersistedClosedTabReuseKeys())).toEqual(['daemon:a:main', 'daemon:b:logs']);
  });

  it('clears all semantic closed-tab tombstone variants for a reopened owner through one helper', () => {
    const keys = new Set([
      'daemon:daemon-a::session:shared',
      'bridge:100.127.23.27::3333::session:shared',
      'daemon:daemon-b::session:other',
    ]);

    expect(clearClosedTabReuseKeysForOwner(keys, {
      daemonHostId: 'daemon-a',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      sessionName: 'shared',
    })).toBe(true);

    expect(Array.from(keys)).toEqual(['daemon:daemon-b::session:other']);
  });
});
