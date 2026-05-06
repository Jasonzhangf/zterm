// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { STORAGE_KEYS } from './types';
import type { Session } from './types';
import {
  buildPersistedOpenTabFromHostSession,
  findReusableOpenTabSession,
  persistOpenTabsState,
  readPersistedActiveSessionId,
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

    expect(readPersistedOpenTabsState().tabs.map((tab) => tab.sessionId)).toEqual(['old', 'new']);
  });

  it('persists exactly the provided tabs and active id without second normalization', () => {
    persistOpenTabsState([
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

    expect(readPersistedOpenTabsState().tabs.map((tab) => tab.sessionId)).toEqual(['s1']);
    expect(readPersistedActiveSessionId()).toBe('missing-active');
  });

  it('deduplicates persisted tabs by bridge target + tmux session while keeping preferred metadata', () => {
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
});
