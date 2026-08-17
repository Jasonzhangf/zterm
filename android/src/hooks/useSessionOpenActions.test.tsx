// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionOpenActions } from './useSessionOpenActions';
import { normalizeOpenTabIntentState } from '../lib/open-tab-intent';
import { buildPersistedOpenTabReuseKey, buildPersistedOpenTabReuseKeyVariants } from '../lib/open-tab-persistence';
import type { OpenTabRuntimeSwitchReason } from '../lib/open-tab-runtime-switch';

const resolveRemoteRestorableOpenTabStateMock = vi.fn();
const createTmuxSessionMock = vi.fn();
const fetchTmuxSessionsMock = vi.fn();
const fetchTmuxSessionCatalogMock = vi.fn();
const killTmuxSessionMock = vi.fn();

vi.mock('../lib/open-tab-restore', () => ({
  resolveRemoteRestorableOpenTabState: (...args: unknown[]) => resolveRemoteRestorableOpenTabStateMock(...args),
}));

vi.mock('../lib/tmux-sessions', () => ({
  createTmuxSession: (...args: unknown[]) => createTmuxSessionMock(...args),
  fetchTmuxSessions: (...args: unknown[]) => fetchTmuxSessionsMock(...args),
  fetchTmuxSessionCatalog: (...args: unknown[]) => fetchTmuxSessionCatalogMock(...args),
  killTmuxSession: (...args: unknown[]) => killTmuxSessionMock(...args),
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
  const markSessionGroupEntered = vi.fn();
  const deleteSessionGroup = vi.fn();
  const pruneSessionGroupSelectionToRemoteTruth = vi.fn();
  const ensureTerminalPageVisible = vi.fn();
  const closeSession = vi.fn();
  const switchSession = vi.fn();
  const renameRemoteSession = vi.fn();
  const setPageState = vi.fn();
  const auditOpenTabsAgainstRemoteSessions = vi.fn(async () => undefined);
  const onError = overrides.onError || vi.fn();
  const manageTmuxSessionsOnOpenTransport = overrides.manageTmuxSessionsOnOpenTransport || vi.fn(async () => null);
  const queryTerminalSessionCatalogOnOpenTransport = overrides.queryTerminalSessionCatalogOnOpenTransport || vi.fn(async () => null);
  const applyOpenTabState = vi.fn((nextState: { tabs: any[]; activeSessionId: string | null }, persistOptions?: { preserveActiveSessionId?: string | null; switchRuntime?: OpenTabRuntimeSwitchReason }) => {
    const normalized = normalizeOpenTabIntentState(
      nextState.tabs,
      nextState.activeSessionId ?? persistOptions?.preserveActiveSessionId ?? null,
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
    sessionGroups: overrides.sessionGroups || [],
    relayDevices: overrides.relayDevices || [],
    deleteSessionGroup,
    pruneSessionGroupSelectionToRemoteTruth,
    setSessionGroupSelection,
    markSessionGroupEntered,
    createSession,
    closeSession,
    switchSession,
    runtimeActiveSessionId: overrides.runtimeActiveSessionId ?? null,
    runtimeRefs,
    ensureTerminalPageVisible,
    applyOpenTabState,
    manageTmuxSessionsOnOpenTransport,
    queryTerminalSessionCatalogOnOpenTransport,
    renameRemoteSession,
    setPageState,
    onError,
    auditOpenTabsAgainstRemoteSessions,
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
      markSessionGroupEntered,
      deleteSessionGroup,
      pruneSessionGroupSelectionToRemoteTruth,
      ensureTerminalPageVisible,
      closeSession,
      switchSession,
      renameRemoteSession,
      applyOpenTabState,
      setPageState,
      onError,
      auditOpenTabsAgainstRemoteSessions,
      manageTmuxSessionsOnOpenTransport,
      queryTerminalSessionCatalogOnOpenTransport,
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
    fetchTmuxSessionsMock.mockReset();
    fetchTmuxSessionsMock.mockResolvedValue([]);
    fetchTmuxSessionCatalogMock.mockReset();
    fetchTmuxSessionCatalogMock.mockResolvedValue({ sessionNames: [], sessionCatalog: [] });
    killTmuxSessionMock.mockReset();
    killTmuxSessionMock.mockResolvedValue([]);
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

  it('can materialize a drawer group session without activating it for preview selection', () => {
    const harness = createOptions();
    harness.spies.createSession.mockReturnValue('runtime:daemon-a:remote-beta');
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    let openedSessionId = '';
    act(() => {
      openedSessionId = result.current.handleOpenGroupSession({
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        authToken: 'token-a',
      }, 'remote-beta', { activate: false, navigate: false });
    });

    expect(openedSessionId).toBe('runtime:daemon-a:remote-beta');
    expect(harness.spies.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        sessionName: 'remote-beta',
      }),
      expect.objectContaining({ activate: false }),
    );
    expect(harness.spies.applyOpenTabState).toHaveBeenCalledWith(
      expect.objectContaining({
        tabs: [expect.objectContaining({
          sessionId: 'runtime:daemon-a:remote-beta',
          sessionName: 'remote-beta',
        })],
      }),
      undefined,
    );
    expect(harness.spies.ensureTerminalPageVisible).not.toHaveBeenCalled();
  });

  it('preserves the Herdr backend when materializing a drawer catalog session', () => {
    const harness = createOptions();
    harness.spies.createSession.mockReturnValue('runtime:daemon-a:shared-herdr');
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    act(() => {
      result.current.handleOpenGroupSession({
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        relayHostId: 'daemon-a',
        terminalBackend: 'herdr',
        authToken: 'token-a',
      }, 'shared', { activate: false, navigate: false });
    });

    expect(harness.spies.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        daemonHostId: 'daemon-a',
        terminalBackend: 'herdr',
        sessionName: 'shared',
        tags: ['herdr', 'shared'],
      }),
      expect.objectContaining({ activate: false }),
    );
  });

  it('preserves drawer route-aware target truth when materializing a remote group session', () => {
    const relayEndpointCandidates = [{
      id: 'relay-rtc:daemon-a',
      kind: 'relay-rtc' as const,
      relayHostId: 'daemon-a',
      authRequired: true,
      lastSeenAt: '2026-07-17T00:00:00.000Z',
    }];
    const harness = createOptions();
    harness.spies.createSession.mockReturnValue('runtime:daemon-a:remote-beta');
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    act(() => {
      result.current.handleOpenGroupSession({
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        relayHostId: 'daemon-a',
        authToken: 'token-a',
        relayEndpointCandidates,
        transportMode: 'auto',
      } as any, 'remote-beta', { activate: false, navigate: false });
    });

    expect(harness.spies.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        relayHostId: 'daemon-a',
        sessionName: 'remote-beta',
        relayEndpointCandidates,
        transportMode: 'auto',
      }),
      expect.objectContaining({ activate: false }),
    );
  });

  it('clears reopened semantic tab tombstones in memory without saving tab state', () => {
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
  });

  it('clears all semantic reuse-key variants without saving tab state', () => {
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
    const bridgeSettings = {
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
    };
    const harness = createOptions({ bridgeSettings });
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    act(() => {
      result.current.handleAddNew();
    });

    expect(harness.spies.ensureTerminalPageVisible).not.toHaveBeenCalled();
    expect(result.current.pickerMode).toBe('new-connection');
    expect(result.current.pickerTarget).toEqual(expect.objectContaining({
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      authToken: 'token-a',
    }));
  });

  it('opens a saved direct connection session from Home without opening the picker', async () => {
    const harness = createOptions();
    harness.spies.createSession.mockReturnValue('runtime:mac-studio:zterm');
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));
    const savedHost = {
      id: 'saved-tailscale-a',
      createdAt: 1,
      name: 'Mac Studio',
      bridgeHost: '100.66.1.82',
      bridgePort: 3333,
      daemonHostId: 'mac-studio',
      sessionName: 'zterm',
      authToken: 'token-a',
      tailscaleHost: 'mac-studio.tailnet.ts.net',
      relayEndpointCandidates: [],
      authType: 'password' as const,
      tags: ['tailscale'],
      pinned: false,
    };

    await act(async () => {
      result.current.handleOpenSavedConnection(savedHost);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createTmuxSessionMock).not.toHaveBeenCalled();
    expect(harness.spies.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        sessionName: 'zterm',
        authToken: 'token-a',
        tailscaleHost: 'mac-studio.tailnet.ts.net',
      }),
      expect.objectContaining({ activate: false }),
    );
    expect(harness.spies.ensureTerminalPageVisible).toHaveBeenCalledTimes(1);
    expect(result.current.pickerMode).toBeNull();
    expect(harness.refs.openTabStateRef.current).toEqual({
      tabs: [expect.objectContaining({
        sessionId: 'runtime:mac-studio:zterm',
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        sessionName: 'zterm',
      })],
      activeSessionId: 'runtime:mac-studio:zterm',
    });
  });

  it('opens the first remote tmux session for a Home server row without saved session history', async () => {
    const harness = createOptions();
    fetchTmuxSessionsMock.mockResolvedValueOnce(['zterm', 'agentpi']);
    harness.spies.createSession.mockReturnValue('runtime:mac-studio:agentpi');
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));
    const savedServer = {
      id: 'bridge-preset:mac-studio',
      createdAt: 1,
      name: 'Mac Studio',
      bridgeHost: '100.66.1.82',
      bridgePort: 3333,
      daemonHostId: 'mac-studio',
      relayHostId: 'mac-studio',
      sessionName: '',
      authToken: 'token-a',
      relayEndpointCandidates: [],
      authType: 'password' as const,
      tags: ['bridge-server'],
      pinned: false,
    };

    await act(async () => {
      result.current.handleOpenSavedConnection(savedServer);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchTmuxSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        relayHostId: 'mac-studio',
        authToken: 'token-a',
      }),
      expect.any(Object),
    );
    expect(createTmuxSessionMock).not.toHaveBeenCalled();
    expect(harness.spies.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        sessionName: 'agentpi',
      }),
      expect.objectContaining({ activate: false }),
    );
    expect(harness.spies.markSessionGroupEntered).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
      }),
      'agentpi',
    );
    expect(harness.spies.ensureTerminalPageVisible).toHaveBeenCalledTimes(1);
    expect(result.current.pickerMode).toBeNull();
  });

  it('opens the last entered session for a Home server row before the first remote session', async () => {
    const harness = createOptions({
      sessionGroups: [{
        id: 'daemon:mac-studio',
        name: 'Mac Studio',
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        authToken: 'token-a',
        sessionNames: ['agentpi', 'zterm'],
        lastOpenedSessionName: 'zterm',
        lastOpenedAt: 10,
      }],
    });
    fetchTmuxSessionsMock.mockResolvedValueOnce(['agentpi', 'zterm']);
    harness.spies.createSession.mockReturnValue('runtime:mac-studio:zterm');
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));
    const savedServer = {
      id: 'bridge-preset:mac-studio',
      createdAt: 1,
      name: 'Mac Studio',
      bridgeHost: '100.66.1.82',
      bridgePort: 3333,
      daemonHostId: 'mac-studio',
      relayHostId: 'mac-studio',
      sessionName: '',
      authToken: 'token-a',
      relayEndpointCandidates: [],
      authType: 'password' as const,
      tags: ['bridge-server'],
      pinned: false,
    };

    await act(async () => {
      result.current.handleOpenSavedConnection(savedServer);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createTmuxSessionMock).not.toHaveBeenCalled();
    expect(harness.spies.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        sessionName: 'zterm',
      }),
      expect.objectContaining({ activate: false }),
    );
    expect(harness.spies.markSessionGroupEntered).toHaveBeenCalledWith(
      expect.objectContaining({ daemonHostId: 'mac-studio' }),
      'zterm',
    );
  });

  it('creates a generated tmux session only when the Home server has no remote sessions', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T06:07:08.000Z'));
    const harness = createOptions();
    fetchTmuxSessionsMock.mockResolvedValueOnce([]);
    harness.spies.createSession.mockReturnValue('runtime:mac-studio:zterm-20260715-060708');
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));
    const savedServer = {
      id: 'bridge-preset:mac-studio',
      createdAt: 1,
      name: 'Mac Studio',
      bridgeHost: '100.66.1.82',
      bridgePort: 3333,
      daemonHostId: 'mac-studio',
      relayHostId: 'mac-studio',
      sessionName: '',
      authToken: 'token-a',
      relayEndpointCandidates: [],
      authType: 'password' as const,
      tags: ['bridge-server'],
      pinned: false,
    };

    await act(async () => {
      result.current.handleOpenSavedConnection(savedServer);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createTmuxSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        relayHostId: 'mac-studio',
        authToken: 'token-a',
      }),
      expect.any(Object),
      'zterm-20260715-060708',
    );
    expect(harness.spies.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        sessionName: 'zterm-20260715-060708',
      }),
      expect.objectContaining({ activate: false }),
    );
    expect(harness.spies.ensureTerminalPageVisible).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('resumes the existing current-process Home server session when it matches last-entered history', () => {
    const harness = createOptions({
      runtimeActiveSessionId: 'runtime:mac-studio:zterm',
      sessionGroups: [{
        id: 'daemon:mac-studio',
        name: 'Mac Studio',
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        sessionNames: ['zterm', 'zterm-20260717-123456'],
        lastOpenedSessionName: 'zterm',
        lastOpenedAt: 10,
      }],
      sessions: [
        {
          id: 'runtime:mac-studio:zterm',
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          daemonHostId: 'mac-studio',
          sessionName: 'zterm',
          state: 'connected',
          createdAt: 10,
        },
        {
          id: 'runtime:mac-studio:generated',
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          daemonHostId: 'mac-studio',
          sessionName: 'zterm-20260717-123456',
          state: 'connected',
          createdAt: 20,
        },
      ],
    });
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));
    const savedServer = {
      id: 'bridge-preset:mac-studio',
      createdAt: 1,
      name: 'Mac Studio',
      bridgeHost: '100.66.1.82',
      bridgePort: 3333,
      daemonHostId: 'mac-studio',
      relayHostId: 'mac-studio',
      sessionName: '',
      authToken: 'token-a',
      relayEndpointCandidates: [],
      authType: 'password' as const,
      tags: ['bridge-server'],
      pinned: false,
    };

    act(() => {
      result.current.handleOpenSavedConnection(savedServer);
    });

    expect(createTmuxSessionMock).not.toHaveBeenCalled();
    expect(fetchTmuxSessionsMock).not.toHaveBeenCalled();
    expect(harness.spies.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        relayHostId: 'mac-studio',
        sessionName: 'zterm',
      }),
      expect.objectContaining({
        activate: false,
        sessionId: 'runtime:mac-studio:zterm',
        createdAt: 10,
      }),
    );
    expect(harness.spies.applyOpenTabState).toHaveBeenCalledWith(
      expect.objectContaining({
        activeSessionId: 'runtime:mac-studio:zterm',
        tabs: expect.arrayContaining([
          expect.objectContaining({
            sessionId: 'runtime:mac-studio:zterm',
            bridgeHost: '100.66.1.82',
            bridgePort: 3333,
            daemonHostId: 'mac-studio',
            sessionName: 'zterm',
          }),
        ]),
      }),
      { switchRuntime: 'explicit-resume' },
    );
    expect(harness.spies.switchSession).not.toHaveBeenCalled();
    expect(harness.spies.ensureTerminalPageVisible).toHaveBeenCalledTimes(1);
  });

  it('rebinds an existing direct session to the current relay-aware route before resuming it', () => {
    const relayEndpointCandidates = [
      {
        id: 'direct:tailscale:mac-studio',
        kind: 'tailscale' as const,
        host: '100.66.1.82',
        port: 3333,
        authRequired: true,
        lastSeenAt: '2026-07-20T00:00:00.000Z',
      },
      {
        id: 'relay-rtc:mac-studio',
        kind: 'relay-rtc' as const,
        relayHostId: 'mac-studio',
        authRequired: true,
        lastSeenAt: '2026-07-20T00:00:00.000Z',
      },
    ];
    const harness = createOptions({
      runtimeActiveSessionId: 'runtime:mac-studio:zterm',
      sessions: [{
        id: 'runtime:mac-studio:zterm',
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        sessionName: 'zterm',
        state: 'connected',
        createdAt: 10,
        customName: 'Main Shell',
      }],
    });
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));
    const relayServer = {
      id: 'relay-device:mac-studio',
      createdAt: 1,
      name: 'Mac Studio',
      bridgeHost: '100.66.1.82',
      bridgePort: 3333,
      daemonHostId: 'mac-studio',
      relayHostId: 'mac-studio',
      relayDeviceId: 'mac-studio-device',
      sessionName: 'zterm',
      authToken: 'token-a',
      transportMode: 'auto' as const,
      relayEndpointCandidates,
      authType: 'password' as const,
      tags: ['relay-directory'],
      pinned: false,
    };

    act(() => {
      result.current.handleOpenSavedConnection(relayServer);
    });

    expect(fetchTmuxSessionsMock).not.toHaveBeenCalled();
    expect(harness.spies.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        relayHostId: 'mac-studio',
        relayDeviceId: 'mac-studio-device',
        sessionName: 'zterm',
        transportMode: 'auto',
        relayEndpointCandidates,
      }),
      {
        activate: false,
        sessionId: 'runtime:mac-studio:zterm',
        createdAt: 10,
        customName: 'Main Shell',
      },
    );
    expect(harness.spies.applyOpenTabState).toHaveBeenCalledWith(
      expect.objectContaining({
        activeSessionId: 'runtime:mac-studio:zterm',
      }),
      { switchRuntime: 'explicit-resume' },
    );
    expect(harness.spies.closeSession).not.toHaveBeenCalled();
    expect(harness.spies.ensureTerminalPageVisible).toHaveBeenCalledTimes(1);
  });

  it('opens a relay directory Home server row through endpoint candidates without a local preset', async () => {
    const harness = createOptions({
      bridgeSettings: {
        servers: [],
        targetHost: '',
        targetPort: 3333,
        targetAuthToken: '',
        signalUrl: '',
        turnServerUrl: '',
        turnUsername: '',
        turnCredential: '',
        transportMode: 'auto',
        traversalRelay: {
          relayBaseUrl: 'https://relay.codewhisper.cc:18443/relay/',
          accessToken: 'relay-token',
          userId: 'u1',
          username: 'jason',
          deviceId: 'android-1',
          deviceName: 'ZTerm Android',
          platform: 'android',
          wsDevicesUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/devices',
          wsHostUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/host',
          wsClientUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/client',
          turnUrl: 'turn:relay.codewhisper.cc:3478?transport=udp',
          turnUsername: 'turn-user',
          turnCredential: 'turn-secret',
          updatedAt: 1,
        },
      },
    });
    fetchTmuxSessionsMock.mockResolvedValueOnce(['zterm']);
    harness.spies.createSession.mockReturnValue('runtime:mac-studio:zterm');
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));
    const relayServer = {
      id: 'relay-device:mac-studio-device:mac-studio',
      createdAt: 1,
      name: 'Mac Studio',
      bridgeHost: '',
      bridgePort: 3333,
      daemonHostId: 'mac-studio',
      relayHostId: 'mac-studio',
      relayDeviceId: 'mac-studio-device',
      sessionName: '',
      authToken: '',
      relayEndpointCandidates: [
        {
          id: 'direct:tailscale:mac-studio',
          kind: 'tailscale' as const,
          host: 'mac-studio.tailnet.ts.net',
          port: 3333,
          authRequired: true,
          lastSeenAt: '2026-07-15T06:00:00.000Z',
        },
        {
          id: 'relay-rtc:mac-studio',
          kind: 'relay-rtc' as const,
          relayHostId: 'mac-studio',
          authRequired: true,
          lastSeenAt: '2026-07-15T06:00:00.000Z',
        },
      ],
      authType: 'password' as const,
      tags: ['relay-directory'],
      pinned: false,
    };

    await act(async () => {
      result.current.handleOpenSavedConnection(relayServer);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchTmuxSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: 'mac-studio.tailnet.ts.net',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        relayHostId: 'mac-studio',
        relayDeviceId: 'mac-studio-device',
        relayEndpointCandidates: expect.arrayContaining([
          expect.objectContaining({ kind: 'tailscale', host: 'mac-studio.tailnet.ts.net' }),
          expect.objectContaining({ kind: 'relay-rtc', relayHostId: 'mac-studio' }),
        ]),
      }),
      expect.any(Object),
    );
    expect(createTmuxSessionMock).not.toHaveBeenCalled();
    expect(harness.spies.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: 'mac-studio.tailnet.ts.net',
        daemonHostId: 'mac-studio',
        relayHostId: 'mac-studio',
        relayDeviceId: 'mac-studio-device',
        sessionName: 'zterm',
      }),
      expect.objectContaining({ activate: false }),
    );
    expect(harness.spies.ensureTerminalPageVisible).toHaveBeenCalledTimes(1);
  });

  it('creates a blank daemon session directly from drawer host key instead of opening the picker', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-30T04:05:06.000Z'));
    const onSessionsOpenedInPane = vi.fn();
    const harness = createOptions({
      bridgeSettings: {
        servers: [{
          id: 'preset-a',
          name: 'Machine A',
          targetHost: '100.75.122.121',
          targetPort: 3333,
          authToken: 'token-win',
          relayHostId: 'daemon-a',
        }],
        targetHost: '100.75.122.121',
        targetPort: 3333,
        targetAuthToken: 'token-win',
      },
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
      result.current.handleOpenQuickTabPicker('pane-2', 'daemon-a', {
        sessionName: 'work-api',
        cwd: '~/code/api',
      });
      await Promise.resolve();
    });

    expect(result.current.pickerMode).toBeNull();
    expect(createTmuxSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: '100.75.122.121',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        relayHostId: 'daemon-a',
        authToken: 'token-win',
        transportMode: 'auto',
        relayEndpointCandidates: [
          expect.objectContaining({ kind: 'relay-rtc', relayHostId: 'daemon-a' }),
        ],
      }),
      expect.any(Object),
      'work-api',
      { cwd: '~/code/api' },
    );
    expect(harness.spies.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        daemonHostId: 'daemon-a',
        sessionName: 'work-api',
        transportMode: 'auto',
        relayEndpointCandidates: [
          expect.objectContaining({ kind: 'relay-rtc', relayHostId: 'daemon-a' }),
        ],
      }),
      expect.any(Object),
    );
    expect(onSessionsOpenedInPane).toHaveBeenCalledWith(['runtime:daemon-a:work-api'], 'pane-2');
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
      undefined,
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
    expect(harness.spies.setSessionGroupSelection).toHaveBeenCalledWith({
      name: 'daemon-a',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      daemonHostId: 'daemon-a',
      authToken: undefined,
      sessionNames: ['alpha', 'beta'],
    });
    expect(auditOpenTabsAgainstRemoteSessions).toHaveBeenCalledWith('session-picker-refresh');
  });

  it('refreshes drawer host sessions through the same remote catalog owner', async () => {
    const auditOpenTabsAgainstRemoteSessions = vi.fn(async () => undefined);
    const harness = createOptions({
      runtimeActiveSessionId: 'active-zterm',
    });
    harness.refs.openTabStateRef.current = normalizeOpenTabIntentState([
      {
        sessionId: 'active-zterm',
        hostId: 'host-a',
        connectionName: 'Daemon A',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        sessionName: 'zterm',
        createdAt: 1,
      },
      {
        sessionId: 'stale-routecodex2',
        hostId: 'host-a',
        connectionName: 'Daemon A',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        sessionName: 'routecodex2',
        createdAt: 2,
      },
    ], 'active-zterm');
    fetchTmuxSessionCatalogMock.mockResolvedValueOnce({
      sessionNames: ['beta', 'alpha', 'beta'],
      sessionCatalog: [
        { name: 'alpha', backend: 'tmux' },
        { name: 'beta', backend: 'tmux' },
      ],
    });
    const { result } = renderHook(() => useSessionOpenActions({
      ...(harness.options as any),
      auditOpenTabsAgainstRemoteSessions,
    }));

    await act(async () => {
      await result.current.handleRefreshDrawerHostSessions('daemon-a');
    });

    expect(fetchTmuxSessionCatalogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        relayHostId: 'daemon-a',
        authToken: 'token-a',
      }),
      expect.any(Object),
    );
    expect(harness.spies.setSessionGroupSelection).toHaveBeenCalledWith({
      name: 'daemon-a',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      daemonHostId: 'daemon-a',
      terminalBackend: 'tmux',
      authToken: 'token-a',
      sessionNames: ['alpha', 'beta'],
    });
    expect(harness.spies.pruneSessionGroupSelectionToRemoteTruth).toHaveBeenCalledWith(
      {
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        terminalBackend: 'tmux',
      },
      ['alpha', 'beta'],
    );
    expect(auditOpenTabsAgainstRemoteSessions).toHaveBeenCalledWith('session-picker-refresh');
    expect(harness.refs.openTabStateRef.current.activeSessionId).toBe('active-zterm');
    expect(harness.spies.applyOpenTabState).not.toHaveBeenCalled();
    expect(harness.spies.createSession).not.toHaveBeenCalled();
    expect(harness.spies.switchSession).not.toHaveBeenCalled();
  });

  it('refreshes the unified daemon catalog so running Herdr sessions enter the drawer history', async () => {
    const auditOpenTabsAgainstRemoteSessions = vi.fn(async () => undefined);
    const harness = createOptions();
    fetchTmuxSessionCatalogMock.mockResolvedValueOnce({
      sessionNames: ['zterm', 'hd-codex'],
      sessionCatalog: [
        { name: 'zterm', backend: 'tmux' },
        { name: 'hd-codex', backend: 'herdr' },
      ],
    });
    const { result } = renderHook(() => useSessionOpenActions({
      ...(harness.options as any),
      auditOpenTabsAgainstRemoteSessions,
    }));

    await act(async () => {
      await result.current.handleRefreshDrawerHostSessions('daemon-a');
    });

    expect(fetchTmuxSessionCatalogMock).toHaveBeenCalledTimes(1);
    expect(fetchTmuxSessionCatalogMock).toHaveBeenCalledWith(
      expect.objectContaining({ daemonHostId: 'daemon-a' }),
      expect.any(Object),
    );
    expect(harness.spies.setSessionGroupSelection).toHaveBeenCalledWith(expect.objectContaining({
      terminalBackend: 'tmux',
      sessionNames: ['zterm'],
    }));
    expect(harness.spies.setSessionGroupSelection).toHaveBeenCalledWith(expect.objectContaining({
      terminalBackend: 'herdr',
      sessionNames: ['hd-codex'],
    }));
    expect(harness.spies.pruneSessionGroupSelectionToRemoteTruth).toHaveBeenCalledWith(
      expect.objectContaining({ terminalBackend: 'tmux' }),
      ['zterm'],
    );
    expect(harness.spies.pruneSessionGroupSelectionToRemoteTruth).toHaveBeenCalledWith(
      expect.objectContaining({ terminalBackend: 'herdr' }),
      ['hd-codex'],
    );
  });

  it('keeps tmux projection when the unified catalog has no Herdr sessions', async () => {
    const auditOpenTabsAgainstRemoteSessions = vi.fn(async () => undefined);
    const harness = createOptions();
    fetchTmuxSessionCatalogMock.mockResolvedValueOnce({
      sessionNames: ['tmux-main'],
      sessionCatalog: [{ name: 'tmux-main', backend: 'tmux' }],
    });
    const { result } = renderHook(() => useSessionOpenActions({
      ...(harness.options as any),
      auditOpenTabsAgainstRemoteSessions,
    }));

    await act(async () => {
      await result.current.handleRefreshDrawerHostSessions('daemon-a');
    });

    expect(harness.spies.setSessionGroupSelection).toHaveBeenCalledWith(expect.objectContaining({
      terminalBackend: 'tmux',
      sessionNames: ['tmux-main'],
    }));
  });

  it('refreshes drawer host sessions through an existing open mux target transport when available', async () => {
    const queryTerminalSessionCatalogOnOpenTransport = vi.fn(async () => ({
      sessionNames: ['alpha', 'beta'],
      sessionCatalog: [
        { name: 'alpha', backend: 'tmux' },
        { name: 'beta', backend: 'tmux' },
      ],
    }));
    const harness = createOptions({
      runtimeActiveSessionId: 'active-zterm',
      queryTerminalSessionCatalogOnOpenTransport,
      sessions: [{
        id: 'active-zterm',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        sessionName: 'zterm',
        state: 'connected',
        createdAt: 10,
      }],
    });
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    await act(async () => {
      await result.current.handleRefreshDrawerHostSessions('daemon-a');
    });

    expect(queryTerminalSessionCatalogOnOpenTransport).toHaveBeenCalledWith(
      'active-zterm',
      { type: 'list-sessions' },
    );
    expect(harness.spies.manageTmuxSessionsOnOpenTransport).not.toHaveBeenCalled();
    expect(fetchTmuxSessionCatalogMock).not.toHaveBeenCalled();
    expect(fetchTmuxSessionsMock).not.toHaveBeenCalled();
    expect(harness.spies.setSessionGroupSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        daemonHostId: 'daemon-a',
        terminalBackend: 'tmux',
        sessionNames: ['alpha', 'beta'],
      }),
    );
  });

  it('does not fallback to a second tmux management socket when existing mux target management fails', async () => {
    const queryTerminalSessionCatalogOnOpenTransport = vi.fn(async () => {
      throw new Error('mux target request timeout');
    });
    const harness = createOptions({
      runtimeActiveSessionId: 'active-zterm',
      queryTerminalSessionCatalogOnOpenTransport,
      sessions: [{
        id: 'active-zterm',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        sessionName: 'zterm',
        state: 'connected',
        createdAt: 10,
      }],
    });
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    await expect(result.current.handleRefreshDrawerHostSessions('daemon-a')).rejects.toThrow('mux target request timeout');
    expect(fetchTmuxSessionCatalogMock).not.toHaveBeenCalled();
    expect(fetchTmuxSessionsMock).not.toHaveBeenCalled();
  });

  it('falls back to the legacy tmux management pool only when no matching open target session exists', async () => {
    const manageTmuxSessionsOnOpenTransport = vi.fn(async () => null);
    const harness = createOptions({
      manageTmuxSessionsOnOpenTransport,
      sessions: [],
    });
    fetchTmuxSessionCatalogMock.mockResolvedValueOnce({
      sessionNames: ['alpha'],
      sessionCatalog: [{ name: 'alpha', backend: 'tmux' }],
    });
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    await act(async () => {
      await result.current.handleRefreshDrawerHostSessions('daemon-a');
    });

    expect(manageTmuxSessionsOnOpenTransport).not.toHaveBeenCalled();
    expect(fetchTmuxSessionCatalogMock).toHaveBeenCalledWith(
      expect.objectContaining({ daemonHostId: 'daemon-a' }),
      expect.any(Object),
    );
  });

  it('does not open a legacy tmux management socket when a matching session has no ready mux transport', async () => {
    const queryTerminalSessionCatalogOnOpenTransport = vi.fn(async () => null);
    const harness = createOptions({
      runtimeActiveSessionId: 'active-zterm',
      queryTerminalSessionCatalogOnOpenTransport,
      sessions: [{
        id: 'active-zterm',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        sessionName: 'zterm',
        state: 'connecting',
        createdAt: 10,
      }],
    });
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    await expect(result.current.handleRefreshDrawerHostSessions('daemon-a'))
      .rejects.toThrow('Existing terminal transport is unavailable for session catalog refresh');

    expect(queryTerminalSessionCatalogOnOpenTransport).toHaveBeenCalledWith(
      'active-zterm',
      { type: 'list-sessions' },
    );
    expect(fetchTmuxSessionCatalogMock).not.toHaveBeenCalled();
    expect(fetchTmuxSessionsMock).not.toHaveBeenCalled();
  });

  it('uses an existing open mux target transport when the drawer target session is not open locally', async () => {
    const manageTmuxSessionsOnOpenTransport = vi.fn(async () => ['alpha']);
    const harness = createOptions({
      runtimeActiveSessionId: 'active-zterm',
      manageTmuxSessionsOnOpenTransport,
      sessions: [{
        id: 'active-zterm',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        sessionName: 'zterm',
        state: 'connected',
        createdAt: 10,
      }],
    });
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    await act(async () => {
      await result.current.handleCloseGroupSession({
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        relayHostId: 'daemon-a',
        authToken: 'token-a',
      }, 'beta');
    });

    expect(manageTmuxSessionsOnOpenTransport).toHaveBeenCalledWith(
      'active-zterm',
      { type: 'tmux-kill-session', payload: { sessionName: 'beta' } },
    );
    expect(killTmuxSessionMock).not.toHaveBeenCalled();
    expect(fetchTmuxSessionsMock).not.toHaveBeenCalled();
    expect(harness.spies.setSessionGroupSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        daemonHostId: 'daemon-a',
        sessionNames: ['alpha'],
      }),
    );
  });

  it('disconnects a matching open session before killing it on the remote target', async () => {
    const manageTmuxSessionsOnOpenTransport = vi.fn(async () => {
      expect(harness.spies.closeSession).toHaveBeenCalledWith('session-beta', { preserveTargetTransport: true });
      expect(harness.refs.openTabStateRef.current).toEqual({
        tabs: [{
          sessionId: 'session-beta',
          hostId: 'daemon-a',
          connectionName: 'Daemon A',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          daemonHostId: 'daemon-a',
          sessionName: 'beta',
          authToken: 'token-a',
          createdAt: 20,
        }],
        activeSessionId: 'session-beta',
      });
      expect(harness.spies.applyOpenTabState).not.toHaveBeenCalled();
      return ['alpha'];
    });
    const harness = createOptions({
      runtimeActiveSessionId: 'active-zterm',
      manageTmuxSessionsOnOpenTransport,
      sessions: [
        {
          id: 'active-zterm',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          daemonHostId: 'daemon-a',
          sessionName: 'zterm',
          state: 'connected',
          createdAt: 10,
        },
        {
          id: 'session-beta',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          daemonHostId: 'daemon-a',
          sessionName: 'beta',
          state: 'connected',
          createdAt: 20,
        },
      ],
    });
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));
    harness.refs.openTabStateRef.current = normalizeOpenTabIntentState([{
      sessionId: 'session-beta',
      hostId: 'daemon-a',
      connectionName: 'Daemon A',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      daemonHostId: 'daemon-a',
      sessionName: 'beta',
      authToken: 'token-a',
      createdAt: 20,
    }], 'session-beta');

    await act(async () => {
      await result.current.handleCloseGroupSession({
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        relayHostId: 'daemon-a',
        authToken: 'token-a',
      }, 'beta');
    });

    expect(harness.spies.switchSession).not.toHaveBeenCalled();
    expect(harness.spies.closeSession).toHaveBeenNthCalledWith(1, 'session-beta', { preserveTargetTransport: true });
    expect(harness.spies.closeSession).toHaveBeenNthCalledWith(2, 'session-beta');
    expect(harness.refs.openTabStateRef.current).toEqual({
      tabs: [],
      activeSessionId: null,
    });
    expect(harness.refs.closedOpenTabSessionIdsRef.current.has('session-beta')).toBe(true);
    expect(manageTmuxSessionsOnOpenTransport).toHaveBeenCalledWith(
      'active-zterm',
      { type: 'tmux-kill-session', payload: { sessionName: 'beta' } },
    );
    expect(manageTmuxSessionsOnOpenTransport).not.toHaveBeenCalledWith(
      'session-beta',
      { type: 'tmux-kill-session', payload: { sessionName: 'beta' } },
    );
    expect(killTmuxSessionMock).not.toHaveBeenCalled();
  });

  it('uses the preserved transport of the only matching open session for the remote kill', async () => {
    const manageTmuxSessionsOnOpenTransport = vi.fn(async () => ['alpha']);
    const harness = createOptions({
      manageTmuxSessionsOnOpenTransport,
      sessions: [{
        id: 'session-beta',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        sessionName: 'beta',
        state: 'connected',
        createdAt: 10,
      }],
    });
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    await act(async () => {
      await result.current.handleCloseGroupSession({
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        relayHostId: 'daemon-a',
        authToken: 'token-a',
      }, 'beta');
    });

    expect(harness.spies.closeSession).toHaveBeenNthCalledWith(1, 'session-beta', { preserveTargetTransport: true });
    expect(harness.spies.closeSession).toHaveBeenNthCalledWith(2, 'session-beta');
    expect(manageTmuxSessionsOnOpenTransport).toHaveBeenCalledWith(
      'session-beta',
      { type: 'tmux-kill-session', payload: { sessionName: 'beta' } },
    );
    expect(killTmuxSessionMock).not.toHaveBeenCalled();
  });

  it('does not close unrelated sessions when killing a drawer remote session', async () => {
    const manageTmuxSessionsOnOpenTransport = vi.fn(async () => ['alpha']);
    const harness = createOptions({
      runtimeActiveSessionId: 'active-zterm',
      manageTmuxSessionsOnOpenTransport,
      sessions: [{
        id: 'active-zterm',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        sessionName: 'zterm',
        state: 'connected',
        createdAt: 10,
      }],
    });
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    await act(async () => {
      await result.current.handleCloseGroupSession({
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        relayHostId: 'daemon-a',
        authToken: 'token-a',
      }, 'beta');
    });

    expect(harness.spies.closeSession).not.toHaveBeenCalled();
    expect(manageTmuxSessionsOnOpenTransport).toHaveBeenCalledWith(
      'active-zterm',
      { type: 'tmux-kill-session', payload: { sessionName: 'beta' } },
    );
  });

  it('does not report a successful close when the remote kill fails after local disconnect', async () => {
    const manageTmuxSessionsOnOpenTransport = vi.fn(async () => null);
    const harness = createOptions({
      manageTmuxSessionsOnOpenTransport,
      sessions: [{
        id: 'session-beta',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        sessionName: 'beta',
        state: 'connected',
        createdAt: 10,
      }],
    });
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));
    harness.refs.openTabStateRef.current = normalizeOpenTabIntentState([{
      sessionId: 'session-beta',
      hostId: 'daemon-a',
      connectionName: 'Daemon A',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      daemonHostId: 'daemon-a',
      sessionName: 'beta',
      authToken: 'token-a',
      createdAt: 20,
    }], 'session-beta');

    await expect(result.current.handleCloseGroupSession({
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      daemonHostId: 'daemon-a',
      relayHostId: 'daemon-a',
      authToken: 'token-a',
    }, 'beta')).rejects.toThrow('Existing terminal transport is unavailable for tmux management');

    expect(harness.spies.closeSession).toHaveBeenNthCalledWith(1, 'session-beta', { preserveTargetTransport: true });
    expect(harness.spies.closeSession).toHaveBeenNthCalledWith(2, 'session-beta');
    expect(manageTmuxSessionsOnOpenTransport).toHaveBeenCalledWith(
      'session-beta',
      { type: 'tmux-kill-session', payload: { sessionName: 'beta' } },
    );
    expect(harness.spies.setSessionGroupSelection).not.toHaveBeenCalled();
    expect(harness.refs.openTabStateRef.current).toEqual({
      tabs: [],
      activeSessionId: null,
    });
    expect(harness.spies.applyOpenTabState).toHaveBeenCalledWith(
      {
        tabs: [],
        activeSessionId: null,
      },
      undefined,
    );
  });

  it('finalizes the stopped session and switches away when the remote kill times out', async () => {
    const manageTmuxSessionsOnOpenTransport = vi.fn(async () => {
      throw new Error('Timed out while managing tmux sessions');
    });
    const harness = createOptions({
      runtimeActiveSessionId: 'session-beta',
      manageTmuxSessionsOnOpenTransport,
      sessions: [{
        id: 'session-beta',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        sessionName: 'beta',
        state: 'connected',
        createdAt: 20,
      }],
    });
    harness.refs.openTabStateRef.current = normalizeOpenTabIntentState([{
      sessionId: 'session-beta',
      hostId: 'daemon-a',
      connectionName: 'Daemon A',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      daemonHostId: 'daemon-a',
      sessionName: 'beta',
      authToken: 'token-a',
      createdAt: 20,
    }], 'session-beta');
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    await expect(result.current.handleCloseGroupSession({
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      daemonHostId: 'daemon-a',
      relayHostId: 'daemon-a',
      authToken: 'token-a',
    }, 'beta')).rejects.toThrow('Timed out while managing tmux sessions');

    expect(harness.spies.closeSession).toHaveBeenNthCalledWith(1, 'session-beta', { preserveTargetTransport: true });
    expect(harness.spies.closeSession).toHaveBeenNthCalledWith(2, 'session-beta');
    expect(harness.spies.applyOpenTabState).toHaveBeenCalledWith(
      {
        tabs: [],
        activeSessionId: null,
      },
      undefined,
    );
    expect(harness.refs.closedOpenTabSessionIdsRef.current.has('session-beta')).toBe(true);
  });

  it('refreshes a relay daemon drawer host through a route-aware target instead of the saved direct route', async () => {
    const harness = createOptions({
      bridgeSettings: {
        servers: [{
          id: 'preset-a',
          name: 'Machine A',
          targetHost: '100.75.122.121',
          targetPort: 3333,
          authToken: 'token-win',
          relayHostId: 'daemon-a',
        }],
        targetHost: '100.75.122.121',
        targetPort: 3333,
        targetAuthToken: 'token-win',
      },
      relayDevices: [{
        deviceId: 'device-a',
        deviceName: 'Machine A',
        platform: 'win32',
        appVersion: '0.1.3',
        updatedAt: new Date().toISOString(),
        client: { connected: false, lastSeenAt: new Date().toISOString() },
        daemon: {
          connected: true,
          lastSeenAt: new Date().toISOString(),
          hostId: 'daemon-a',
          version: '0.1.3',
          endpoints: [
            { id: 'direct:tailscale:daemon-a', kind: 'tailscale', host: '100.75.122.121', port: 3333, authRequired: true, lastSeenAt: new Date().toISOString() },
            { id: 'relay-a', kind: 'relay-rtc', relayHostId: 'daemon-a', authRequired: true, lastSeenAt: new Date().toISOString() },
          ],
          sessions: [],
        },
      }],
    });
    fetchTmuxSessionCatalogMock.mockResolvedValueOnce({
      sessionNames: ['alpha'],
      sessionCatalog: [{ name: 'alpha', backend: 'tmux' }],
    });
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    await act(async () => {
      await result.current.handleRefreshDrawerHostSessions('daemon-a');
    });

    expect(fetchTmuxSessionCatalogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: '100.75.122.121',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        relayHostId: 'daemon-a',
        authToken: 'token-win',
        transportMode: 'auto',
        relayEndpointCandidates: expect.arrayContaining([
          expect.objectContaining({ kind: 'tailscale', host: '100.75.122.121' }),
          expect.objectContaining({ kind: 'relay-rtc', relayHostId: 'daemon-a' }),
        ]),
      }),
      expect.any(Object),
    );
  });

  it('does not expose saved-tab list loading from the session-open owner', () => {
    const harness = createOptions();
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    expect('handleLoadSavedTabList' in result.current).toBe(false);
    expect(resolveRemoteRestorableOpenTabStateMock).not.toHaveBeenCalled();
  });

  it('rebuilds a force-relay tab inside the session-open owner', () => {
    const harness = createOptions({
      bridgeSettings: {
        servers: [{
          id: 'preset-1',
          name: 'Preset A',
          targetHost: '100.127.23.27',
          targetPort: 3333,
          authToken: 'token-a',
          relayHostId: 'daemon-a',
          relayDeviceId: 'device-a',
        }],
        targetHost: '100.127.23.27',
        targetPort: 3333,
        targetAuthToken: 'token-a',
        defaultServerId: 'preset-1',
        traversalRelay: { accessToken: 'relay-token' },
      },
      sessions: [{
        id: 'session-live',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        sessionName: 'shared',
        authToken: 'token-a',
        state: 'connected',
      }],
    });
    harness.refs.openTabStateRef.current = normalizeOpenTabIntentState([{
      sessionId: 'session-live',
      hostId: 'host-a',
      connectionName: 'Conn A',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      daemonHostId: 'daemon-a',
      sessionName: 'shared',
      authToken: 'token-a',
      createdAt: 1000,
      customName: 'Custom Shared',
    }], 'session-live');

    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    act(() => {
      result.current.handleForceRelaySession('session-live');
    });

    expect(harness.spies.closeSession).toHaveBeenCalledWith('session-live');
    expect(harness.spies.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        relayHostId: 'daemon-a',
        sessionName: 'shared',
        transportMode: 'webrtc',
      }),
      expect.objectContaining({
        sessionId: 'session-live',
        createdAt: 1000,
        customName: 'Custom Shared',
      }),
    );
    expect(harness.spies.switchSession).toHaveBeenCalledWith('session-live');
    expect(harness.spies.ensureTerminalPageVisible).toHaveBeenCalledTimes(1);
  });

  it('does not rebuild force-relay when explicit relay prerequisites are missing', () => {
    const harness = createOptions();
    harness.refs.openTabStateRef.current = normalizeOpenTabIntentState([{
      sessionId: 'session-live',
      hostId: 'host-a',
      connectionName: 'Conn A',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      sessionName: 'shared',
      authToken: 'token-a',
      createdAt: 1000,
    }], 'session-live');

    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    act(() => {
      result.current.handleForceRelaySession('session-live');
    });

    expect(harness.spies.onError).toHaveBeenCalledWith('请先在 Settings 登录 Relay 控制面。');
    expect(harness.spies.closeSession).not.toHaveBeenCalled();
    expect(harness.spies.createSession).not.toHaveBeenCalled();
    expect(harness.spies.switchSession).not.toHaveBeenCalled();
  });

  it('rebuilds a session back to auto mode inside the session-open owner', () => {
    const harness = createOptions({
      sessions: [{
        id: 'session-live',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        sessionName: 'shared',
        authToken: 'token-a',
        state: 'connected',
      }],
    });
    harness.refs.openTabStateRef.current = normalizeOpenTabIntentState([{
      sessionId: 'session-live',
      hostId: 'host-a',
      connectionName: 'Conn A',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      daemonHostId: 'daemon-a',
      sessionName: 'shared',
      authToken: 'token-a',
      createdAt: 1000,
    }], 'session-live');

    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    act(() => {
      result.current.handleUseAutoSession('session-live');
    });

    expect(harness.spies.closeSession).toHaveBeenCalledWith('session-live');
    expect(harness.spies.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        relayHostId: 'daemon-a',
        sessionName: 'shared',
        transportMode: 'auto',
      }),
      expect.objectContaining({
        sessionId: 'session-live',
        createdAt: 1000,
      }),
    );
    expect(harness.spies.switchSession).toHaveBeenCalledWith('session-live');
    expect(harness.spies.ensureTerminalPageVisible).toHaveBeenCalledTimes(1);
  });

  it('keeps closed-tab tombstones in memory when saved-tab loading is absent', () => {
    const reuseKey = buildPersistedOpenTabReuseKey({
      daemonHostId: 'daemon-a',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      sessionName: 'alpha',
    });
    const harness = createOptions();
    harness.refs.closedOpenTabReuseKeysRef.current = new Set([reuseKey]);
    const { result } = renderHook(() => useSessionOpenActions({
      ...(harness.options as any),
      runtimeRefs: {
        ...harness.options.runtimeRefs,
        closedOpenTabReuseKeysRef: harness.refs.closedOpenTabReuseKeysRef,
      },
    }));

    expect('handleLoadSavedTabList' in result.current).toBe(false);
    expect(harness.refs.closedOpenTabReuseKeysRef.current.has(reuseKey)).toBe(true);
    expect(harness.refs.openTabStateRef.current.tabs).toEqual([]);
  });
});

describe('useSessionOpenActions remote tmux rename', () => {
  it('renames the remote tmux session through the open mux transport and migrates local identity only after success', async () => {
    const manageTmuxSessionsOnOpenTransport = vi.fn(async () => ['renamed']);
    const harness = createOptions({
      manageTmuxSessionsOnOpenTransport,
      runtimeActiveSessionId: 'active-zterm',
      sessions: [{
        id: 'active-zterm',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        sessionName: 'old-name',
        state: 'connected',
        createdAt: 10,
      }],
    });
    harness.refs.openTabStateRef.current = normalizeOpenTabIntentState([{
      sessionId: 'active-zterm',
      hostId: 'host-a',
      connectionName: 'Daemon A',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      daemonHostId: 'daemon-a',
      sessionName: 'old-name',
      createdAt: 10,
    }], 'active-zterm');
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    await act(async () => {
      await result.current.handleRenameRemoteSession('active-zterm', '  new session  ');
    });

    expect(manageTmuxSessionsOnOpenTransport).toHaveBeenCalledWith(
      'active-zterm',
      { type: 'tmux-rename-session', payload: { sessionName: 'old-name', nextSessionName: 'new-session' } },
    );
    expect(harness.spies.renameRemoteSession).toHaveBeenCalledWith('active-zterm', 'new-session');
    expect(harness.refs.openTabStateRef.current.tabs.find((tab) => tab.sessionId === 'active-zterm')?.sessionName).toBe('new-session');
    expect(harness.spies.setSessionGroupSelection).toHaveBeenCalled();
  });

  it('does not migrate local identity when the remote rename fails', async () => {
    const manageTmuxSessionsOnOpenTransport = vi.fn(async () => {
      throw new Error('rename failed');
    });
    const harness = createOptions({
      manageTmuxSessionsOnOpenTransport,
      runtimeActiveSessionId: 'active-zterm',
      sessions: [{
        id: 'active-zterm',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        sessionName: 'old-name',
        state: 'connected',
        createdAt: 10,
      }],
    });
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    await expect(result.current.handleRenameRemoteSession('active-zterm', 'new-name')).rejects.toThrow('rename failed');
    expect(harness.spies.renameRemoteSession).not.toHaveBeenCalled();
    expect(harness.refs.openTabStateRef.current.tabs).toHaveLength(0);
  });

  it('is a no-op for empty or unchanged names', async () => {
    const manageTmuxSessionsOnOpenTransport = vi.fn(async () => ['old-name']);
    const harness = createOptions({
      manageTmuxSessionsOnOpenTransport,
      runtimeActiveSessionId: 'active-zterm',
      sessions: [{
        id: 'active-zterm',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        sessionName: 'old-name',
        state: 'connected',
        createdAt: 10,
      }],
    });
    const { result } = renderHook(() => useSessionOpenActions(harness.options as any));

    await act(async () => {
      await result.current.handleRenameRemoteSession('active-zterm', '   ');
      await result.current.handleRenameRemoteSession('active-zterm', 'old-name');
    });

    expect(manageTmuxSessionsOnOpenTransport).not.toHaveBeenCalled();
    expect(harness.spies.renameRemoteSession).not.toHaveBeenCalled();
  });
});
