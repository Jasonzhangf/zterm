// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import type { PersistedOpenTab, Session } from './types';
import {
  activateOpenTabIntentSession,
  closeOpenTabIntentSession,
  deriveCloseOpenTabIntent,
  derivePersistedOpenTabRestorePlan,
  deriveRuntimeOpenTabSyncDecision,
  materializeOpenTabRuntimeSessions,
  mergeRuntimeSessionsIntoOpenTabIntentState,
  moveOpenTabIntentSession,
  normalizeOpenTabIntentState,
  renameOpenTabIntentSession,
  resolveRestoredOpenTabIntentState,
  resolveSavedOpenTabsImportPlan,
  resolveRequestedOpenTabActiveSessionId,
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
  it('normalizes persisted tab intent state without merging distinct open tab session ids', () => {
    const state = normalizeOpenTabIntentState([
      makeTab('old', { sessionName: 'zterm', authToken: 'token-z' }),
      makeTab('new', { sessionName: 'zterm', authToken: 'token-z', createdAt: 2, customName: 'Keep Me' }),
    ], 'new');

    expect(state).toEqual({
      tabs: [
        expect.objectContaining({
          sessionId: 'old',
        }),
        expect.objectContaining({
          sessionId: 'new',
          customName: 'Keep Me',
        }),
      ],
      activeSessionId: 'new',
    });
  });

  it('does not dedupe tabs from different daemonHostId even when sessionName matches', () => {
    const state = normalizeOpenTabIntentState([
      makeTab('daemon-a', {
        daemonHostId: 'daemon-a',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'shared',
      }),
      makeTab('daemon-b', {
        daemonHostId: 'daemon-b',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'shared',
      }),
    ], 'daemon-b');

    expect(state.tabs.map((tab) => tab.sessionId)).toEqual(['daemon-a', 'daemon-b']);
    expect(state.activeSessionId).toBe('daemon-b');
  });

  it('lets runtime-only sessions bootstrap open tabs only when there is no persisted explicit open-tab truth yet', () => {
    const decision = deriveRuntimeOpenTabSyncDecision({
      currentState: normalizeOpenTabIntentState([], null),
      runtimeSessions: [makeSession('s1'), makeSession('s2', { createdAt: 2 })],
      runtimeActiveSessionId: 's2',
      restoredTabsHandled: false,
      hasPersistedOpenTabsTruth: false,
      closedSessionIds: new Set<string>(),
    });

    expect(decision).toEqual({
      kind: 'bootstrap',
      state: {
        tabs: [
          expect.objectContaining({ sessionId: 's1' }),
          expect.objectContaining({ sessionId: 's2' }),
        ],
        activeSessionId: 's2',
      },
    });
  });

  it('derives runtime switch decision when persisted active truth differs from runtime active session', () => {
    const decision = deriveRuntimeOpenTabSyncDecision({
      currentState: normalizeOpenTabIntentState([makeTab('s1'), makeTab('s2')], 's1'),
      runtimeSessions: [makeSession('s1'), makeSession('s2')],
      runtimeActiveSessionId: 's2',
      restoredTabsHandled: false,
      hasPersistedOpenTabsTruth: true,
      closedSessionIds: new Set<string>(),
    });

    expect(decision).toEqual({
      kind: 'switch',
      activeSessionId: 's1',
    });
  });

  it('does not let runtime active session backwrite explicit open-tab active truth after restore settles', () => {
    const decision = deriveRuntimeOpenTabSyncDecision({
      currentState: normalizeOpenTabIntentState([makeTab('s1'), makeTab('s2')], 's1'),
      runtimeSessions: [makeSession('s1'), makeSession('s2')],
      runtimeActiveSessionId: 's2',
      restoredTabsHandled: true,
      hasPersistedOpenTabsTruth: true,
      closedSessionIds: new Set<string>(),
    });

    expect(decision).toEqual({ kind: 'noop' });
  });

  it('does not append runtime-only sessions when OPEN_TABS already exists as explicit client truth', () => {
    const state = mergeRuntimeSessionsIntoOpenTabIntentState(
      normalizeOpenTabIntentState([makeTab('s1')], 's1'),
      [makeSession('s1'), makeSession('s2'), makeSession('s3')],
      new Set(['s3']),
    );

    expect(state.tabs.map((tab) => tab.sessionId)).toEqual(['s1']);
  });

  it('does not merge a runtime semantic duplicate back after that reuse key was explicitly closed', () => {
    const state = mergeRuntimeSessionsIntoOpenTabIntentState(
      normalizeOpenTabIntentState([
        makeTab('persisted-old', {
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          sessionName: 'tmux-shared',
          authToken: 'shared-token',
          createdAt: 1,
        }),
        makeTab('s2', { createdAt: 2 }),
      ], 's2'),
      [
        makeSession('runtime-new', {
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          sessionName: 'tmux-shared',
          authToken: 'shared-token',
        }),
        makeSession('s2', { createdAt: 2 }),
      ],
      new Set<string>(),
      new Set<string>(['bridge:100.127.23.27::3333::session:tmux-shared']),
    );

    expect(state.tabs.map((tab) => tab.sessionId)).toEqual(['persisted-old', 's2']);
    expect(state.activeSessionId).toBe('s2');
  });

  it('does not rewrite an old bridge-only persisted tab to a different runtime session id', () => {
    const state = mergeRuntimeSessionsIntoOpenTabIntentState(
      normalizeOpenTabIntentState([
        makeTab('persisted-bridge', {
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          sessionName: 'zterm',
          authToken: 'token-z',
          createdAt: 1,
        }),
      ], 'persisted-bridge'),
      [
        makeSession('runtime-daemon', {
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          daemonHostId: 'daemon-Macstudio.local-128564413166185f',
          sessionName: 'zterm',
          authToken: 'token-z',
          createdAt: 2,
        }),
      ],
      new Set<string>(),
    );

    expect(state.tabs).toEqual([
      expect.objectContaining({
        sessionId: 'persisted-bridge',
        bridgeHost: '100.66.1.82',
        sessionName: 'zterm',
      }),
    ]);
    expect(state.activeSessionId).toBe('persisted-bridge');
  });

  it('does not replace a distinct persisted tab with a semantic duplicate runtime session id', () => {
    const state = mergeRuntimeSessionsIntoOpenTabIntentState(
      normalizeOpenTabIntentState([
        makeTab('persisted-old', {
          sessionName: 'tmux-shared',
          authToken: 'shared-token',
          customName: 'Keep Me',
          createdAt: 1,
        }),
        makeTab('s2', { createdAt: 2 }),
      ], 'persisted-old'),
      [
        makeSession('runtime-new', {
          sessionName: 'tmux-shared',
          authToken: 'shared-token',
          customName: undefined,
        }),
        makeSession('s2', { createdAt: 2 }),
      ],
      new Set<string>(),
    );

    expect(state.tabs).toEqual([
      expect.objectContaining({
        sessionId: 'persisted-old',
        sessionName: 'tmux-shared',
        customName: 'Keep Me',
      }),
      expect.objectContaining({ sessionId: 's2' }),
    ]);
    expect(state.activeSessionId).toBe('persisted-old');
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

  it('upserts a new distinct session id without deleting an existing semantic peer', () => {
    const state = upsertOpenTabIntentSession(
      normalizeOpenTabIntentState([
        makeTab('persisted-old', {
          sessionName: 'tmux-shared',
          authToken: 'shared-token',
          customName: 'Keep Me',
          createdAt: 1,
        }),
        makeTab('s2', { createdAt: 2 }),
      ], 'persisted-old'),
      makeTab('runtime-new', {
        sessionName: 'tmux-shared',
        authToken: 'shared-token',
        createdAt: 3,
      }),
      { activate: true },
    );

    expect(state.tabs).toEqual([
      expect.objectContaining({
        sessionId: 'persisted-old',
        sessionName: 'tmux-shared',
        authToken: 'shared-token',
        customName: 'Keep Me',
        createdAt: 1,
      }),
      expect.objectContaining({ sessionId: 's2' }),
      expect.objectContaining({
        sessionId: 'runtime-new',
        sessionName: 'tmux-shared',
        authToken: 'shared-token',
        createdAt: 3,
      }),
    ]);
    expect(state.activeSessionId).toBe('runtime-new');
  });

  it('upserts a distinct semantic peer without activation and preserves the existing active tab', () => {
    const state = upsertOpenTabIntentSession(
      normalizeOpenTabIntentState([
        makeTab('persisted-old', {
          sessionName: 'tmux-shared',
          authToken: 'shared-token',
          customName: 'Keep Me',
          createdAt: 1,
        }),
        makeTab('s2', { createdAt: 2 }),
      ], 's2'),
      makeTab('runtime-new', {
        sessionName: 'tmux-shared',
        authToken: 'shared-token',
        createdAt: 3,
      }),
      { activate: false, fallbackActiveSessionId: 's2' },
    );

    expect(state.tabs).toEqual([
      expect.objectContaining({
        sessionId: 'persisted-old',
        customName: 'Keep Me',
        createdAt: 1,
      }),
      expect.objectContaining({ sessionId: 's2' }),
      expect.objectContaining({
        sessionId: 'runtime-new',
        createdAt: 3,
      }),
    ]);
    expect(state.activeSessionId).toBe('s2');
  });

  it('materializes explicit open tabs from persisted truth when runtime transport disappeared', () => {
    const sessions = materializeOpenTabRuntimeSessions([
      makeTab('demo-tab', {
        connectionName: 'Mac',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'demo',
        customName: 'demo',
      }),
      makeTab('zterm-tab', {
        sessionName: 'zterm',
      }),
    ], [
      makeSession('zterm-tab', { state: 'connected', sessionName: 'zterm' }),
    ]);

    expect(sessions.map((session) => session.id)).toEqual(['demo-tab', 'zterm-tab']);
    expect(sessions[0]).toEqual(expect.objectContaining({
      id: 'demo-tab',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      sessionName: 'demo',
      title: 'demo',
      state: 'closed',
      ws: null,
    }));
    expect(sessions[1]).toEqual(expect.objectContaining({
      id: 'zterm-tab',
      state: 'connected',
    }));
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

  it('does not close a different persisted tab just because it shares the same bridge target', () => {
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

    expect(state.tabs.map((tab) => tab.sessionId)).toEqual(['persisted-old', 's2']);
    expect(state.activeSessionId).toBe('persisted-old');
  });

  it('derives close intent result with reuse-key truth in the same pure module', () => {
    const result = deriveCloseOpenTabIntent(
      normalizeOpenTabIntentState([
        makeTab('persisted-old', {
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          sessionName: 'tmux-shared',
          authToken: 'shared-token',
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

    expect(result.closedReuseKey).toBe('bridge:100.127.23.27::3333::session:tmux-shared');
    expect(result.closedReuseKeyVariants).toEqual(['bridge:100.127.23.27::3333::session:tmux-shared']);
    expect(result.nextState.tabs.map((tab) => tab.sessionId)).toEqual(['persisted-old', 's2']);
    expect(result.nextState.activeSessionId).toBe('persisted-old');
  });

  it('derives close intent reuse-key variants for daemon-owned tabs so reopen can clear every semantic tombstone shape', () => {
    const result = deriveCloseOpenTabIntent(
      normalizeOpenTabIntentState([
        makeTab('daemon-live', {
          daemonHostId: 'daemon-a',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          sessionName: 'tmux-shared',
        }),
      ], 'daemon-live'),
      'daemon-live',
      {
        runtimeActiveSessionId: 'daemon-live',
        fallbackSessionIds: [],
        runtimeSessions: [
          makeSession('daemon-live', {
            daemonHostId: 'daemon-a',
            bridgeHost: '100.127.23.27',
            bridgePort: 3333,
            sessionName: 'tmux-shared',
          }),
        ],
      },
    );

    expect(result.closedReuseKey).toBe('daemon:daemon-a::session:tmux-shared');
    expect(result.closedReuseKeyVariants).toEqual([
      'daemon:daemon-a::session:tmux-shared',
      'bridge:100.127.23.27::3333::session:tmux-shared',
    ]);
  });

  it('unions persisted-tab and runtime-session reuse-key variants when close hits a bridge-persisted tab already reused by a daemon-owned runtime session', () => {
    const result = deriveCloseOpenTabIntent(
      normalizeOpenTabIntentState([
        makeTab('persisted-bridge', {
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          sessionName: 'tmux-shared',
        }),
      ], 'persisted-bridge'),
      'runtime-daemon',
      {
        runtimeActiveSessionId: 'runtime-daemon',
        fallbackSessionIds: [],
        runtimeSessions: [
          makeSession('runtime-daemon', {
            daemonHostId: 'daemon-a',
            bridgeHost: '100.127.23.27',
            bridgePort: 3333,
            sessionName: 'tmux-shared',
          }),
        ],
      },
    );

    expect(result.closedReuseKey).toBe('daemon:daemon-a::session:tmux-shared');
    expect(new Set(result.closedReuseKeyVariants)).toEqual(new Set([
      'bridge:100.127.23.27::3333::session:tmux-shared',
      'daemon:daemon-a::session:tmux-shared',
    ]));
  });

  it('resolves restored session-id remap with a single pure rule', () => {
    const state = resolveRestoredOpenTabIntentState(
      normalizeOpenTabIntentState([makeTab('saved-a'), makeTab('saved-b')], 'saved-b'),
      new Map([
        ['saved-a', 'saved-a-new'],
        ['saved-b', 'saved-b-new'],
      ]),
    );

    expect(state.tabs.map((tab) => tab.sessionId)).toEqual(['saved-a-new', 'saved-b-new']);
    expect(state.activeSessionId).toBe('saved-b-new');
  });

  it('derives persisted restore plan with normalized active tab truth', () => {
    expect(derivePersistedOpenTabRestorePlan(
      normalizeOpenTabIntentState([makeTab('s1'), makeTab('s2')], 'missing'),
    )).toEqual({
      kind: 'restore',
      tabs: [
        expect.objectContaining({ sessionId: 's1' }),
        expect.objectContaining({ sessionId: 's2' }),
      ],
      activeSessionId: 's1',
    });
  });

  it('resolves saved-tab import plan with import-only dedupe plus requested focus in one pure module', () => {
    const plan = resolveSavedOpenTabsImportPlan([
      makeTab('saved-a', {
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'alpha',
        authToken: 'token-a',
      }),
      makeTab('saved-b-stale', {
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'beta',
        authToken: 'token-b',
      }),
      makeTab('saved-b-new', {
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'beta',
        authToken: 'token-b',
        createdAt: 2,
        customName: 'Keep Me',
      }),
    ], 'saved-b-new');

    expect(plan.tabs.map((tab) => tab.sessionId)).toEqual(['saved-a', 'saved-b-new']);
    expect(plan.activeSessionId).toBe('saved-b-new');
  });

  it('resolves requested focus session id from imported tabs with a single pure rule', () => {
    expect(resolveRequestedOpenTabActiveSessionId([
      makeTab('saved-a'),
      makeTab('saved-b'),
    ], 'saved-b')).toBe('saved-b');

    expect(resolveRequestedOpenTabActiveSessionId([
      makeTab('saved-a'),
      makeTab('saved-b'),
    ], 'missing')).toBe('saved-a');
  });
});
