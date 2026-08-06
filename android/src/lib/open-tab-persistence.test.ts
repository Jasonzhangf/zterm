// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
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

  it('clears legacy persisted tabs instead of restoring them on cold start', () => {
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
    localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, 'new');
    localStorage.setItem(STORAGE_KEYS.SAVED_TAB_LISTS, JSON.stringify([{ id: 'saved' }]));

    const state = readPersistedOpenTabsState();
    expect(state.status).toBe('empty');
    expect(state.hasStoredValue).toBe(false);
    expect(state.tabs).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEYS.OPEN_TABS)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.SAVED_TAB_LISTS)).toBeNull();
  });

  it('does not persist runtime tabs or active id', () => {
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
    expect(readPersistedOpenTabsState().tabs).toEqual([]);
    expect(readPersistedActiveSessionId()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.OPEN_TABS)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBeNull();
  });

  it('removes invalid legacy persisted open-tab storage without treating it as truth', () => {
    localStorage.setItem(STORAGE_KEYS.OPEN_TABS, JSON.stringify({ tabs: [] }));

    const state = readPersistedOpenTabsState();

    expect(state.status).toBe('empty');
    expect(state.hasStoredValue).toBe(false);
    expect(state.tabs).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEYS.OPEN_TABS)).toBeNull();
  });

  it('reports legacy open-tab cleanup failures as explicit failed state', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        removeItem: () => {
          throw new Error('storage remove blocked');
        },
      },
    });

    const state = readPersistedOpenTabsState();

    expect(state.status).toBe('failed');
    expect(state.hasStoredValue).toBe(false);
    expect(state.tabs).toEqual([]);
    expect('error' in state && state.error).toBeInstanceOf(Error);
  });

  it('reports legacy active-session cleanup failures as explicit failed state', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        removeItem: () => {
          throw new Error('active remove blocked');
        },
      },
    });

    const state = readPersistedActiveSessionIdState();

    expect(state.status).toBe('failed');
    expect(state.activeSessionId).toBeNull();
    expect('error' in state && state.error).toBeInstanceOf(Error);
  });

  it('reports open-tab cleanup failures as explicit failure result', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        removeItem: () => {
          throw new Error('storage remove blocked');
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

  it('only reuses an open tab when the persisted sessionId matches a managed session exactly', () => {
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

    // exact match: persisted sessionId maps to the connected session
    expect(findReusableOpenTabSession({
      sessionId: 'active',
      sessions: [stale, active],
      activeSessionId: 'active',
    })?.id).toBe('active');

    // persisted sessionId does NOT match any managed session; host+sessionName
    // must NOT be used as a fallback. This is the rcc<->rcc2 cross-display guard.
    expect(findReusableOpenTabSession({
      sessionId: 'persisted-but-missing',
      sessions: [stale, active],
      activeSessionId: 'active',
    })).toBeNull();
  });

  it('does NOT reuse by daemonHostId + sessionName when bridge endpoint changed (the rcc/rcc2 case)', () => {
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

    // Persisted tab carries no sessionId (legacy fallback) — must NOT auto-reuse
    // the wrong session just because host+sessionName match. Caller must mint a new
    // sessionId via SessionContext.createSession.
    expect(findReusableOpenTabSession({
      sessionId: '',
      sessions: [active],
      activeSessionId: 'active',
    })).toBeNull();
  });

  it('prefers the exact persisted host id over ambiguous endpoint projections', () => {
    expect(resolveHostForPersistedOpenTab({
      tab: {
        sessionId: 'saved-zterm',
        hostId: 'host-stale',
        connectionName: 'Conn stale',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-old',
        sessionName: 'zterm',
        authToken: 'token-old',
        createdAt: 1,
      },
      hosts: [
        {
          id: 'host-stale',
          createdAt: 1,
          name: 'Conn stale',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          daemonHostId: 'daemon-old',
          relayHostId: 'daemon-old',
          sessionName: 'zterm',
          authToken: 'token-old',
          authType: 'password',
          tags: [],
          pinned: false,
          lastConnected: 11,
        },
        {
          id: 'host-fresh',
          createdAt: 2,
          name: 'Conn fresh',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          daemonHostId: 'daemon-new',
          relayHostId: 'daemon-new',
          sessionName: '',
          authToken: 'token-fresh',
          authType: 'password',
          tags: ['relay-directory'],
          pinned: true,
          lastConnected: 99,
        },
      ],
      fallbackIdPrefix: 'saved',
      fallbackLastConnected: 9,
    })).toEqual(expect.objectContaining({
      id: 'host-stale',
      name: 'Conn stale',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      daemonHostId: 'daemon-old',
      relayHostId: 'daemon-old',
      sessionName: 'zterm',
      authToken: 'token-old',
      lastConnected: 11,
    }));
  });

  it('uses a unique endpoint projection when the persisted host id is gone', () => {
    expect(resolveHostForPersistedOpenTab({
      tab: {
        sessionId: 'saved-zterm',
        hostId: 'host-stale',
        connectionName: 'Conn stale',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-old',
        sessionName: 'zterm',
        authToken: 'token-old',
        createdAt: 1,
      },
      hosts: [
        {
          id: 'host-fresh',
          createdAt: 2,
          name: 'Conn fresh',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          daemonHostId: 'daemon-new',
          relayHostId: 'daemon-new',
          sessionName: '',
          authToken: 'token-fresh',
          authType: 'password',
          tags: ['relay-directory'],
          pinned: true,
          lastConnected: 99,
        },
      ],
      fallbackIdPrefix: 'saved',
      fallbackLastConnected: 9,
    })).toEqual(expect.objectContaining({
      id: 'host-fresh',
      name: 'Conn fresh',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      daemonHostId: 'daemon-new',
      relayHostId: 'daemon-new',
      sessionName: 'zterm',
      authToken: 'token-fresh',
      lastConnected: 99,
    }));
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

  it('clears legacy closed-tab reuse keys without restoring them', () => {
    localStorage.setItem('zterm:closed-tab-reuse-keys', '{bad-json');

    expect(Array.from(readPersistedClosedTabReuseKeys())).toEqual([]);
    expect(localStorage.getItem('zterm:closed-tab-reuse-keys')).toBeNull();
  });

  it('keeps closed-tab reuse keys in memory only and does not persist them', () => {
    persistClosedTabReuseKeys(new Set(['daemon:a:main', 'daemon:b:logs']));

    expect(localStorage.getItem('zterm:closed-tab-reuse-keys')).toBeNull();
    expect(Array.from(readPersistedClosedTabReuseKeys())).toEqual([]);
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
  // S1 red-test: session identity must be looked up by client-owned sessionId only.
  // Two sessions with the same sessionName must NOT collapse into the same session
  // when no explicit sessionId is provided; that is the rcc<->rcc2 cross-display bug.
  it('refuses to reuse a session by host+sessionName alone when no client sessionId is provided', () => {
    const active = makeSession({
      id: 'session-active',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      daemonHostId: 'daemon-host-1',
      sessionName: 'rcc',
      authToken: 'token-rcc',
      createdAt: 2,
      state: 'connected',
    });

    expect(findReusableOpenTabSession({
      sessions: [active],
      sessionId: '',
      activeSessionId: 'session-active',
    })).toBeNull();
  });

  it('only returns a session when the caller supplies an exact client sessionId that matches', () => {
    const active = makeSession({
      id: 'session-active',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      daemonHostId: 'daemon-host-1',
      sessionName: 'rcc',
      authToken: 'token-rcc',
      createdAt: 2,
      state: 'connected',
    });
    const other = makeSession({
      id: 'session-other',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      daemonHostId: 'daemon-host-1',
      sessionName: 'rcc2',
      authToken: 'token-rcc',
      createdAt: 3,
      state: 'connected',
    });

    expect(findReusableOpenTabSession({
      sessions: [active, other],
      sessionId: '',
      activeSessionId: 'session-other',
    })).toBeNull();
  });

});
