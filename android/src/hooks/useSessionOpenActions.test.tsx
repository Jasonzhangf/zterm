// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionOpenActions } from './useSessionOpenActions';
import { normalizeOpenTabIntentState } from '../lib/open-tab-intent';
import { buildPersistedOpenTabReuseKey } from '../lib/open-tab-persistence';

const resolveRemoteRestorableOpenTabStateMock = vi.fn();

vi.mock('../lib/open-tab-restore', () => ({
  resolveRemoteRestorableOpenTabState: (...args: unknown[]) => resolveRemoteRestorableOpenTabStateMock(...args),
}));

function createRef<T>(value: T) {
  return { current: value };
}

function createOptions(overrides: Partial<any> = {}) {
  const openTabStateRef = createRef(normalizeOpenTabIntentState([], null));
  const closedOpenTabSessionIdsRef = createRef(new Set<string>());
  const closedOpenTabReuseKeysRef = createRef(new Set<string>());
  const setBridgeSettings = vi.fn();
  const upsertHost = vi.fn((host: any) => ({
    id: host.id || `persisted:${host.bridgeHost}:${host.bridgePort}:${host.sessionName}`,
    createdAt: host.createdAt || Date.now(),
    ...host,
  }));
  const createSession = vi.fn((host: any, options?: any) => (
    options?.sessionId || `runtime:${host.daemonHostId || host.relayHostId || host.bridgeHost}:${host.sessionName}`
  ));
  const recordSessionOpen = vi.fn();
  const recordSessionGroupOpen = vi.fn();
  const setSessionGroupSelection = vi.fn();
  const deleteSessionGroup = vi.fn();
  const ensureTerminalPageVisible = vi.fn();
  const setPageState = vi.fn();
  const persistOpenTabIntentState = vi.fn((nextState: { tabs: any[]; activeSessionId: string | null }, persistOptions?: { fallbackActiveSessionId?: string | null }) => {
    const normalized = normalizeOpenTabIntentState(
      nextState.tabs,
      nextState.activeSessionId ?? persistOptions?.fallbackActiveSessionId ?? null,
    );
    openTabStateRef.current = normalized;
    return normalized;
  });

  const runtimeRefs = {
    activeSessionIdRef: createRef<string | null>(overrides.runtimeActiveSessionId ?? null),
    sessionsRef: createRef<any[]>(overrides.sessions ?? []),
    hostsRef: createRef<any[]>(overrides.hosts ?? []),
    bridgeSettingsRef: createRef(overrides.bridgeSettings || {
      servers: [],
      targetHost: '',
      targetPort: 3333,
      targetAuthToken: '',
    }),
    openTabStateRef,
    closedOpenTabSessionIdsRef,
    closedOpenTabReuseKeysRef,
    terminalActiveSessionIdRef: createRef<string | null>(overrides.runtimeActiveSessionId ?? null),
    ensureTerminalPageVisibleRef: createRef(ensureTerminalPageVisible),
    persistAndSwitchExplicitOpenTabsRef: createRef<((tabs: any[], activeSessionId: string | null) => any) | null>((tabs: any[], activeSessionId: string | null) => {
      const normalized = normalizeOpenTabIntentState(tabs, activeSessionId);
      openTabStateRef.current = normalized;
      return normalized;
    }),
    renameSessionRef: createRef(vi.fn()),
  };

  const options = {
    bridgeSettings: overrides.bridgeSettings || {
      servers: [{
        id: 'preset-1',
        name: 'Daemon A',
        targetHost: '100.127.23.27',
        targetPort: 3333,
        authToken: 'token-a',
        relayHostId: 'daemon-a',
      }],
      targetHost: '100.127.23.27',
      targetPort: 3333,
      targetAuthToken: 'token-a',
    },
    setBridgeSettings,
    hosts: overrides.hosts || [],
    upsertHost,
    deleteSessionGroup,
    recordSessionOpen,
    recordSessionGroupOpen,
    setSessionGroupSelection,
    createSession,
    runtimeActiveSessionId: overrides.runtimeActiveSessionId ?? null,
    runtimeRefs,
    ensureTerminalPageVisible,
    persistOpenTabIntentState,
    setPageState,
  };

  return {
    options,
    refs: {
      openTabStateRef,
      closedOpenTabSessionIdsRef,
      closedOpenTabReuseKeysRef,
    },
    spies: {
      setBridgeSettings,
      upsertHost,
      createSession,
      recordSessionOpen,
      recordSessionGroupOpen,
      setSessionGroupSelection,
      deleteSessionGroup,
      ensureTerminalPageVisible,
      persistOpenTabIntentState,
      setPageState,
    },
  };
}

describe('useSessionOpenActions explicit-open truth', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resolveRemoteRestorableOpenTabStateMock.mockReset();
    resolveRemoteRestorableOpenTabStateMock.mockImplementation(async ({ tabs, activeSessionId }: any) => ({
      tabs,
      activeSessionId: activeSessionId || tabs[0]?.sessionId || null,
      droppedTabs: [],
    }));
  });

  it('clears close tombstones when explicitly reopening a previously closed semantic tab', () => {
    const target = {
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      daemonHostId: 'daemon-a',
      relayHostId: 'daemon-a',
      authToken: 'token-a',
    };
    const runtimeSessionId = 'runtime:daemon-a:shared';
    const reuseKey = buildPersistedOpenTabReuseKey({
      daemonHostId: 'daemon-a',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      sessionName: 'shared',
    });
    const harness = createOptions();
    harness.refs.closedOpenTabSessionIdsRef.current.add(runtimeSessionId);
    harness.refs.closedOpenTabReuseKeysRef.current.add(reuseKey);
    harness.spies.createSession.mockReturnValue(runtimeSessionId);

    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    act(() => {
      result.current.handleOpenSingleTmuxSession(target as any, 'shared');
    });

    expect(harness.refs.closedOpenTabSessionIdsRef.current.has(runtimeSessionId)).toBe(false);
    expect(harness.refs.closedOpenTabReuseKeysRef.current.has(reuseKey)).toBe(false);
    expect(harness.refs.openTabStateRef.current).toEqual({
      tabs: [
        expect.objectContaining({
          sessionId: runtimeSessionId,
          daemonHostId: 'daemon-a',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          sessionName: 'shared',
        }),
      ],
      activeSessionId: runtimeSessionId,
    });
    expect(harness.spies.recordSessionOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        daemonHostId: 'daemon-a',
        sessionName: 'shared',
      }),
    );
  });

  it('deduplicates duplicate tmux session names before multi-open so one semantic tab opens once', () => {
    const target = {
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      daemonHostId: 'daemon-a',
      relayHostId: 'daemon-a',
      authToken: 'token-a',
    };
    const harness = createOptions();
    harness.spies.createSession.mockImplementation((host: any) => `runtime:${host.daemonHostId || host.relayHostId}:${host.sessionName}`);

    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    act(() => {
      result.current.handleOpenMultipleTmuxSessions(target as any, ['alpha', 'alpha', 'beta', 'beta']);
    });

    expect(harness.spies.createSession).toHaveBeenCalledTimes(2);
    expect(harness.refs.openTabStateRef.current.tabs).toEqual([
      expect.objectContaining({ sessionId: 'runtime:daemon-a:alpha', sessionName: 'alpha' }),
      expect.objectContaining({ sessionId: 'runtime:daemon-a:beta', sessionName: 'beta' }),
    ]);
    expect(harness.refs.openTabStateRef.current.activeSessionId).toBe('runtime:daemon-a:alpha');
    expect(harness.spies.recordSessionGroupOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        daemonHostId: 'daemon-a',
        sessionNames: ['alpha', 'beta'],
      }),
    );
  });

  it('loads saved tab list through the unified remote-restorable helper before opening tabs', async () => {
    const harness = createOptions({
      hosts: [
        {
          id: 'host-a',
          createdAt: 1,
          name: 'Conn A',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          daemonHostId: 'daemon-a',
          relayHostId: 'daemon-a',
          sessionName: 'alpha',
          authToken: 'token-a',
          authType: 'password',
          tags: [],
          pinned: false,
        },
      ],
    });

    resolveRemoteRestorableOpenTabStateMock.mockResolvedValueOnce({
      tabs: [
        {
          sessionId: 'saved-a',
          hostId: 'host-a',
          connectionName: 'Conn A',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          daemonHostId: 'daemon-a',
          sessionName: 'alpha',
          authToken: 'token-a',
          createdAt: 1,
        },
      ],
      activeSessionId: 'saved-a',
      droppedTabs: [
        {
          sessionId: 'saved-gone',
          hostId: 'host-gone',
          connectionName: 'Gone',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          daemonHostId: 'daemon-a',
          sessionName: 'gone',
          authToken: 'token-a',
          createdAt: 2,
        },
      ],
    });

    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    await act(async () => {
      await result.current.handleLoadSavedTabList([
        {
          sessionId: 'saved-a',
          hostId: 'host-a',
          connectionName: 'Conn A',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          daemonHostId: 'daemon-a',
          sessionName: 'alpha',
          authToken: 'token-a',
          createdAt: 1,
        },
        {
          sessionId: 'saved-gone',
          hostId: 'host-gone',
          connectionName: 'Gone',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          daemonHostId: 'daemon-a',
          sessionName: 'gone',
          authToken: 'token-a',
          createdAt: 2,
        },
      ], 'saved-gone');
    });

    expect(resolveRemoteRestorableOpenTabStateMock).toHaveBeenCalledWith({
      tabs: [
        expect.objectContaining({ sessionId: 'saved-a' }),
        expect.objectContaining({ sessionId: 'saved-gone' }),
      ],
      activeSessionId: 'saved-gone',
      bridgeSettings: harness.options.runtimeRefs.bridgeSettingsRef.current,
    });
    expect(harness.spies.createSession).toHaveBeenCalledTimes(1);
    expect(harness.refs.openTabStateRef.current.tabs.map((tab) => tab.sessionId)).toEqual(['saved-a']);
    expect(harness.refs.openTabStateRef.current.activeSessionId).toBe('saved-a');
  });
});
