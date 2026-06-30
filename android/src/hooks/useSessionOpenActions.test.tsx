// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionOpenActions } from './useSessionOpenActions';
import { normalizeOpenTabIntentState } from '../lib/open-tab-intent';
import { buildPersistedOpenTabReuseKey, buildPersistedOpenTabReuseKeyVariants } from '../lib/open-tab-persistence';
import type { OpenTabRuntimeSwitchReason } from '../lib/open-tab-runtime-switch';

const resolveRemoteRestorableOpenTabStateMock = vi.fn();
const createTmuxSessionMock = vi.fn();

vi.mock('../lib/open-tab-restore', () => ({
  resolveRemoteRestorableOpenTabState: (...args: unknown[]) => resolveRemoteRestorableOpenTabStateMock(...args),
}));

vi.mock('../lib/tmux-sessions', () => ({
  createTmuxSession: (...args: unknown[]) => createTmuxSessionMock(...args),
}));

function createRef<T>(value: T) {
  return { current: value };
}

function createOptions(overrides: Partial<any> = {}) {
  const openTabStateRef = createRef(normalizeOpenTabIntentState([], null));
  const closedOpenTabSessionIdsRef = createRef(new Set<string>());
  const closedOpenTabReuseKeysRef = createRef(new Set<string>());
  const pendingMaterializedOpenTabSessionIdsRef = createRef(new Set<string>());
  const setBridgeSettings = vi.fn();
  const createSession = vi.fn((host: any, options?: any) => (
    options?.sessionId || `runtime:${host.daemonHostId || host.relayHostId || host.bridgeHost}:${host.sessionName}`
  ));
  const setSessionGroupSelection = vi.fn();
  const deleteSessionGroup = vi.fn();
  const pruneSessionGroupSelectionToRemoteTruth = vi.fn();
  const ensureTerminalPageVisible = vi.fn();
  const setPageState = vi.fn();
  const applyOpenTabState = vi.fn((nextState: { tabs: any[]; activeSessionId: string | null }, persistOptions?: { fallbackActiveSessionId?: string | null; switchRuntime?: OpenTabRuntimeSwitchReason }) => {
    const normalized = normalizeOpenTabIntentState(
      nextState.tabs,
      nextState.activeSessionId ?? persistOptions?.fallbackActiveSessionId ?? null,
    );
    openTabStateRef.current = normalized;
    return normalized;
  });

  const runtimeRefs = {
    runtimeActiveSessionIdRef: createRef<string | null>(overrides.runtimeActiveSessionId ?? null),
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
    pendingMaterializedOpenTabSessionIdsRef,
    terminalActiveSessionIdRef: createRef<string | null>(overrides.runtimeActiveSessionId ?? null),
    ensureTerminalPageVisibleRef: createRef(ensureTerminalPageVisible),
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
    relayDevices: overrides.relayDevices || [],
    deleteSessionGroup,
    pruneSessionGroupSelectionToRemoteTruth,
    setSessionGroupSelection,
    createSession,
    runtimeActiveSessionId: overrides.runtimeActiveSessionId ?? null,
    runtimeRefs,
    ensureTerminalPageVisible,
    applyOpenTabState,
    setPageState,
  };

  return {
    options,
    refs: {
      openTabStateRef,
      closedOpenTabSessionIdsRef,
      closedOpenTabReuseKeysRef,
      pendingMaterializedOpenTabSessionIdsRef,
    },
    spies: {
      setBridgeSettings,
      createSession,
      setSessionGroupSelection,
      deleteSessionGroup,
      pruneSessionGroupSelectionToRemoteTruth,
      ensureTerminalPageVisible,
      applyOpenTabState,
      setPageState,
    },
  };
}

describe('useSessionOpenActions explicit-open truth', () => {
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
    vi.restoreAllMocks();
    localStorage.clear();
    createTmuxSessionMock.mockReset();
    createTmuxSessionMock.mockResolvedValue([]);
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
  });

  it('persists reopened semantic tab tombstone removal so cold launch no longer keeps it dead', () => {
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
    localStorage.setItem('zterm:closed-tab-reuse-keys', JSON.stringify([reuseKey]));
    const harness = createOptions();
    harness.refs.closedOpenTabReuseKeysRef.current = new Set([reuseKey]);
    harness.spies.createSession.mockReturnValue(runtimeSessionId);

    const { result } = renderHook(() => useSessionOpenActions({
      ...(harness.options as any),
      runtimeRefs: {
        ...harness.options.runtimeRefs,
        closedOpenTabReuseKeysRef: harness.refs.closedOpenTabReuseKeysRef,
      },
    }));

    act(() => {
      result.current.handleOpenSingleTmuxSession(target as any, 'shared');
    });

    expect(harness.refs.closedOpenTabReuseKeysRef.current.has(reuseKey)).toBe(false);
    expect(localStorage.getItem('zterm:closed-tab-reuse-keys')).toBe(JSON.stringify([]));
  });

  it('clears all semantic reuse-key variants when explicitly reopening a daemon-owned tab', () => {
    const target = {
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      daemonHostId: 'daemon-a',
      relayHostId: 'daemon-a',
      authToken: 'token-a',
    };
    const runtimeSessionId = 'runtime:daemon-a:shared';
    const reuseKeyVariants = buildPersistedOpenTabReuseKeyVariants({
      daemonHostId: 'daemon-a',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      sessionName: 'shared',
    });
    localStorage.setItem('zterm:closed-tab-reuse-keys', JSON.stringify(reuseKeyVariants));
    const harness = createOptions();
    harness.refs.closedOpenTabReuseKeysRef.current = new Set(reuseKeyVariants);
    harness.spies.createSession.mockReturnValue(runtimeSessionId);

    const { result } = renderHook(() => useSessionOpenActions({
      ...(harness.options as any),
      runtimeRefs: {
        ...harness.options.runtimeRefs,
        closedOpenTabReuseKeysRef: harness.refs.closedOpenTabReuseKeysRef,
      },
    }));

    act(() => {
      result.current.handleOpenSingleTmuxSession(target as any, 'shared');
    });

    expect(Array.from(harness.refs.closedOpenTabReuseKeysRef.current)).toEqual([]);
    expect(localStorage.getItem('zterm:closed-tab-reuse-keys')).toBe(JSON.stringify([]));
  });

  it('uses active runtime session auth truth as the preferred quick-tab picker target', () => {
    const harness = createOptions({
      runtimeActiveSessionId: 'session-live',
      sessions: [{
        id: 'session-live',
        bridgeHost: '100.64.0.88',
        bridgePort: 4444,
        daemonHostId: 'daemon-live',
        authToken: 'token-live',
      }],
      bridgeSettings: {
        servers: [{
          id: 'preset-1',
          name: 'Preset A',
          targetHost: '100.127.23.27',
          targetPort: 3333,
          authToken: 'token-a',
          relayHostId: 'daemon-a',
        }],
        targetHost: '100.127.23.27',
        targetPort: 3333,
        targetAuthToken: 'token-a',
      },
    });

    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    act(() => {
      result.current.handleOpenQuickTabPicker();
    });

    expect(result.current.pickerMode).toBe('quick-tab');
    expect(result.current.pickerTarget).toEqual(
      expect.objectContaining({
        bridgeHost: '100.64.0.88',
        bridgePort: 4444,
        daemonHostId: 'daemon-live',
        authToken: 'token-live',
      }),
    );
  });

  it('uses the main page entry to open the new-server connection picker', () => {
    const harness = createOptions();
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    act(() => {
      result.current.handleAddNew();
    });

    expect(harness.spies.ensureTerminalPageVisible).not.toHaveBeenCalled();
    expect(result.current.pickerMode).toBe('new-connection');
    expect(result.current.pickerTarget).toEqual(expect.objectContaining({
      bridgeHost: '',
      bridgePort: 3333,
    }));
  });

  it('creates a blank daemon session directly from drawer host key instead of opening the picker', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-30T04:05:06.000Z'));
    const onSessionsOpenedInPane = vi.fn();
    const harness = createOptions({
      relayDevices: [{
        deviceId: 'device-a',
        deviceName: 'Machine A',
        platform: 'win32',
        appVersion: '0.1.3',
        updatedAt: '2026-06-30T04:00:00.000Z',
        client: { connected: false, lastSeenAt: '2026-06-30T04:00:00.000Z' },
        daemon: {
          connected: true,
          lastSeenAt: '2026-06-30T04:00:00.000Z',
          hostId: 'daemon-a',
          version: '0.1.3',
          endpoints: [{ id: 'relay-a', kind: 'relay-rtc', relayHostId: 'daemon-a', authRequired: true, lastSeenAt: '2026-06-30T04:00:00.000Z' }],
          sessions: [],
        },
      }],
    });

    const { result } = renderHook(() => useSessionOpenActions({
      ...(harness.options as any),
      onSessionsOpenedInPane,
    }));

    await act(async () => {
      result.current.handleOpenQuickTabPicker('pane-2', 'daemon-a');
      await Promise.resolve();
    });

    expect(result.current.pickerMode).toBeNull();
    expect(createTmuxSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ daemonHostId: 'daemon-a', relayHostId: 'daemon-a' }),
      expect.any(Object),
      'zterm-20260630-040506',
    );
    expect(harness.spies.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ daemonHostId: 'daemon-a', sessionName: 'zterm-20260630-040506' }),
      expect.any(Object),
    );
    expect(onSessionsOpenedInPane).toHaveBeenCalledWith(['runtime:daemon-a:zterm-20260630-040506'], 'pane-2');
    vi.useRealTimers();
  });

  it('creates a blank session from drawer saved-server host key without requiring relayDevices', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-30T04:05:06.000Z'));
    const harness = createOptions({
      bridgeSettings: {
        servers: [{
          id: 'preset-a',
          name: 'Mac Studio',
          targetHost: '100.66.1.82',
          targetPort: 3333,
          authToken: 'token-a',
          relayHostId: 'mac-studio',
        }],
        targetHost: '100.66.1.82',
        targetPort: 3333,
        targetAuthToken: 'token-a',
      },
    });

    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    await act(async () => {
      result.current.handleOpenQuickTabPicker(undefined, 'mac-studio');
      await Promise.resolve();
    });

    expect(result.current.pickerMode).toBeNull();
    expect(createTmuxSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        relayHostId: 'mac-studio',
        authToken: 'token-a',
      }),
      expect.any(Object),
      'zterm-20260630-040506',
    );
    expect(harness.spies.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        sessionName: 'zterm-20260630-040506',
      }),
      expect.any(Object),
    );
    expect(harness.spies.ensureTerminalPageVisible).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
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
  });

  it('emits explicit pane-open intent for quick-tab single open instead of relying on later fallback pane guesses', () => {
    const target = {
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      daemonHostId: 'daemon-a',
      relayHostId: 'daemon-a',
      authToken: 'token-a',
    };
    const onSessionsOpenedInPane = vi.fn();
    const harness = createOptions();
    const { result } = renderHook(() => useSessionOpenActions({
      ...(harness.options as any),
      onSessionsOpenedInPane,
    }));

    act(() => {
      result.current.handleOpenQuickTabPicker('pane-2');
    });
    act(() => {
      result.current.handleOpenSingleTmuxSession(target as any, 'alpha');
    });

    expect(onSessionsOpenedInPane).toHaveBeenCalledWith(['runtime:daemon-a:alpha'], 'pane-2');
  });

  it('emits explicit pane-open intent for quick-tab multi-open with all opened sessionIds', () => {
    const target = {
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      daemonHostId: 'daemon-a',
      relayHostId: 'daemon-a',
      authToken: 'token-a',
    };
    const onSessionsOpenedInPane = vi.fn();
    const harness = createOptions();
    const { result } = renderHook(() => useSessionOpenActions({
      ...(harness.options as any),
      onSessionsOpenedInPane,
    }));

    act(() => {
      result.current.handleOpenQuickTabPicker('pane-2');
    });
    act(() => {
      result.current.handleOpenMultipleTmuxSessions(target as any, ['alpha', 'beta']);
    });

    expect(onSessionsOpenedInPane).toHaveBeenCalledWith(
      ['runtime:daemon-a:alpha', 'runtime:daemon-a:beta'],
      'pane-2',
    );
  });

  it('does not persist transient host storage when explicitly opening a tmux session', () => {
    const target = {
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      daemonHostId: 'daemon-a',
      relayHostId: 'daemon-a',
      authToken: 'token-a',
    };
    const harness = createOptions();
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    act(() => {
      result.current.handleOpenSingleTmuxSession(target as any, 'alpha');
    });

    expect(harness.refs.openTabStateRef.current.tabs).toEqual([
      expect.objectContaining({
        sessionId: 'runtime:daemon-a:alpha',
        sessionName: 'alpha',
      }),
    ]);
  });

  it('opens a tmux session with the current picker target transport truth instead of a stale remembered host endpoint', () => {
    const harness = createOptions({
      hosts: [{
        id: 'host-stale',
        createdAt: 1,
        name: 'Main',
        bridgeHost: '100.127.23.27',
        bridgePort: 4444,
        daemonHostId: 'daemon-a',
        relayHostId: 'daemon-a',
        relayDeviceId: 'daemon-device-old',
        sessionName: 'main',
        authToken: 'token-stale',
        transportMode: 'websocket',
        authType: 'password',
        tags: [],
        pinned: false,
      }],
    });
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    act(() => {
      result.current.handleOpenSingleTmuxSession({
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        relayHostId: 'daemon-a',
        relayDeviceId: 'daemon-device-new',
        authToken: 'token-fresh',
        transportMode: 'auto',
      } as any, 'main');
    });

    expect(harness.spies.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        relayHostId: 'daemon-a',
        relayDeviceId: 'daemon-device-new',
        authToken: 'token-fresh',
        transportMode: 'auto',
        sessionName: 'main',
      }),
      expect.anything(),
    );
  });



  it('prunes stored server-group session names against remote refresh truth before auditing open tabs', async () => {
    const auditOpenTabsAgainstRemoteSessions = vi.fn(async () => undefined);
    const harness = createOptions();
    const { result } = renderHook(() => useSessionOpenActions({
      ...(harness.options as any),
      auditOpenTabsAgainstRemoteSessions,
    }));

    await act(async () => {
      result.current.handleRemoteSessionsRefreshed({
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        relayHostId: 'daemon-a',
      } as any, ['beta', 'alpha', 'beta']);
    });

    expect(harness.spies.pruneSessionGroupSelectionToRemoteTruth).toHaveBeenCalledWith(
      {
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
      },
      ['alpha', 'beta'],
    );
    expect(auditOpenTabsAgainstRemoteSessions).toHaveBeenCalledWith('session-picker-refresh');
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
      hosts: harness.options.runtimeRefs.hostsRef.current,
    });
    expect(harness.spies.createSession).toHaveBeenCalledTimes(1);
    expect(harness.refs.openTabStateRef.current.tabs.map((tab) => tab.sessionId)).toEqual(['saved-a']);
    expect(harness.refs.openTabStateRef.current.activeSessionId).toBe('saved-a');
  });

  it('skips closed tabs and preserves their reuse tombstones when loading saved tab list', async () => {
    const reuseKey = buildPersistedOpenTabReuseKey({
      daemonHostId: 'daemon-a',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      sessionName: 'alpha',
    });
    localStorage.setItem('zterm:closed-tab-reuse-keys', JSON.stringify([reuseKey]));
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
    harness.refs.closedOpenTabReuseKeysRef.current = new Set([reuseKey]);
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
      droppedTabs: [],
    });

    const { result } = renderHook(() => useSessionOpenActions({
      ...(harness.options as any),
      runtimeRefs: {
        ...harness.options.runtimeRefs,
        closedOpenTabReuseKeysRef: harness.refs.closedOpenTabReuseKeysRef,
      },
    }));

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
      ], 'saved-a');
    });

    // Reuse key should remain — the tab was explicitly closed, so it must not be reopened
    expect(harness.refs.closedOpenTabReuseKeysRef.current.has(reuseKey)).toBe(true);
    expect(localStorage.getItem('zterm:closed-tab-reuse-keys')).toBe(JSON.stringify([reuseKey]));
    // No tabs should have been opened because the only candidate still has an explicit close tombstone.
    expect(harness.refs.openTabStateRef.current.tabs).toEqual([]);
  });
});
