// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import type { Session } from './types';
import {
  buildPersistedOpenTabFromHostSession,
  dedupePersistedOpenTabs,
  findReusableOpenTabSession,
  resolveHostForPersistedOpenTab,
} from './open-tab-persistence';

function makeSession(overrides?: Partial<Session>): Session {
  return {
    id: 'session-1',
    hostId: 'host-1',
    connectionName: 'conn-1',
    bridgeHost: '100.127.23.27',
    bridgePort: 3333,
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
