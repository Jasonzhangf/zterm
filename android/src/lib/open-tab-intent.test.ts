// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import type { PersistedOpenTab, Session } from './types';
import {
  activateOpenTabIntentSession,
  buildBootstrapOpenTabIntentStateFromSessions,
  closeOpenTabIntentSession,
  mergeRuntimeSessionsIntoOpenTabIntentState,
  moveOpenTabIntentSession,
  normalizeOpenTabIntentState,
  renameOpenTabIntentSession,
  resolveRequestedOpenTabFocusSessionId,
  upsertOpenTabIntentSession,
} from './open-tab-intent';

function makeSession(id: string, overrides?: Partial<Session>): Session {
  return {
    id,
    hostId: `host-${id}`,
    connectionName: `conn-${id}`,
    bridgeHost: '100.127.23.27',
    bridgePort: 3333,
    sessionName: `tmux-${id}`,
    title: `tab-${id}`,
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

function makeTab(sessionId: string, overrides?: Partial<PersistedOpenTab>): PersistedOpenTab {
  return {
    sessionId,
    hostId: `host-${sessionId}`,
    connectionName: `conn-${sessionId}`,
    bridgeHost: '100.127.23.27',
    bridgePort: 3333,
    sessionName: `tmux-${sessionId}`,
    authToken: `token-${sessionId}`,
    createdAt: 1,
    ...overrides,
  };
}

describe('open-tab intent truth', () => {
  it('normalizes and deduplicates persisted tab intent state', () => {
    const state = normalizeOpenTabIntentState([
      makeTab('old', { sessionName: 'zterm', authToken: 'token-z' }),
      makeTab('new', { sessionName: 'zterm', authToken: 'token-z', createdAt: 2, customName: 'Keep Me' }),
    ], 'new');

    expect(state).toEqual({
      tabs: [
        expect.objectContaining({
          sessionId: 'new',
          customName: 'Keep Me',
        }),
      ],
      activeSessionId: 'new',
    });
  });

  it('builds bootstrap state directly from runtime sessions', () => {
    const state = buildBootstrapOpenTabIntentStateFromSessions([
      makeSession('s1'),
      makeSession('s2', { createdAt: 2 }),
    ], 's2');

    expect(state.tabs.map((tab) => tab.sessionId)).toEqual(['s1', 's2']);
    expect(state.activeSessionId).toBe('s2');
  });

  it('merges new runtime sessions without reintroducing explicitly closed ids', () => {
    const state = mergeRuntimeSessionsIntoOpenTabIntentState(
      normalizeOpenTabIntentState([makeTab('s1')], 's1'),
      [makeSession('s1'), makeSession('s2'), makeSession('s3')],
      new Set(['s3']),
    );

    expect(state.tabs.map((tab) => tab.sessionId)).toEqual(['s1', 's2']);
  });

  it('upserts, activates, renames and moves with a single pure truth module', () => {
    const opened = upsertOpenTabIntentSession(
      normalizeOpenTabIntentState([makeTab('s1')], 's1'),
      makeTab('s2', { createdAt: 2 }),
      { activate: true },
    );
    const renamed = renameOpenTabIntentSession(opened, 's2', 'renamed');
    const moved = moveOpenTabIntentSession(renamed, 's2', 0);
    const activated = activateOpenTabIntentSession(moved, 's1');

    expect(moved.tabs[0]?.sessionId).toBe('s2');
    expect(moved.tabs[0]?.customName).toBe('renamed');
    expect(activated.activeSessionId).toBe('s1');
  });

  it('closes active tab and falls through to next persisted/runtime candidate', () => {
    const state = closeOpenTabIntentSession(
      normalizeOpenTabIntentState([makeTab('s1'), makeTab('s2')], 's1'),
      's1',
      {
        runtimeActiveSessionId: 's1',
        fallbackSessionIds: ['s2', 's3'],
      },
    );

    expect(state.tabs.map((tab) => tab.sessionId)).toEqual(['s2']);
    expect(state.activeSessionId).toBe('s2');
  });

  it('closes the persisted representative for the same bridge target instead of only deleting the runtime session id', () => {
    const state = closeOpenTabIntentSession(
      normalizeOpenTabIntentState([
        makeTab('persisted-old', {
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          sessionName: 'tmux-shared',
          authToken: 'shared-token',
          createdAt: 1,
        }),
        makeTab('s2'),
      ], 'persisted-old'),
      'runtime-new',
      {
        runtimeActiveSessionId: 'runtime-new',
        fallbackSessionIds: ['s2'],
        runtimeSessions: [
          makeSession('runtime-new', {
            bridgeHost: '100.127.23.27',
            bridgePort: 3333,
            sessionName: 'tmux-shared',
            authToken: 'shared-token',
          }),
          makeSession('s2'),
        ],
      },
    );

    expect(state.tabs.map((tab) => tab.sessionId)).toEqual(['s2']);
    expect(state.activeSessionId).toBe('s2');
  });

  it('resolves requested focus session id from imported tabs with a single pure rule', () => {
    expect(resolveRequestedOpenTabFocusSessionId([
      makeTab('saved-a'),
      makeTab('saved-b'),
    ], 'saved-b')).toBe('saved-b');

    expect(resolveRequestedOpenTabFocusSessionId([
      makeTab('saved-a'),
      makeTab('saved-b'),
    ], 'missing')).toBe('saved-a');
  });
});
