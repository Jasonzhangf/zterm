// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useOpenTabRestoreRuntimeSync } from './useOpenTabRestoreRuntimeSync';

const resolveRemoteRestorableOpenTabStateMock = vi.fn();

vi.mock('../lib/open-tab-restore', () => ({
  resolveRemoteRestorableOpenTabState: (...args: unknown[]) => resolveRemoteRestorableOpenTabStateMock(...args),
}));

function createRef<T>(value: T) {
  return { current: value };
}

describe('useOpenTabRestoreRuntimeSync cold restore transport truth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveRemoteRestorableOpenTabStateMock.mockResolvedValue({
      tabs: [{
        sessionId: 'session-1',
        hostId: 'host-1',
        connectionName: 'local-test',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'zterm_mirror_lab',
        createdAt: 1,
      }],
      activeSessionId: 'session-1',
      droppedTabs: [],
    });
  });

  it('explicitly resumes the restored active tab when the persisted page is terminal', async () => {
    const applyOpenTabState = vi.fn((nextState, options) => ({
      tabs: nextState.tabs,
      activeSessionId: nextState.activeSessionId ?? options?.preserveActiveSessionId ?? null,
    }));
    const createSession = vi.fn((host, options) => {
      expect(host).toEqual(expect.objectContaining({
        id: 'host-1',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'zterm_mirror_lab',
      }));
      expect(options).toEqual(expect.objectContaining({
        activate: false,
        connect: false,
        sessionId: 'session-1',
      }));
      return 'session-1';
    });

    renderHook(() => useOpenTabRestoreRuntimeSync({
      bridgeSettings: { servers: [], targetHost: '127.0.0.1', targetPort: 3333, targetAuthToken: '' } as any,
      hosts: [{
        id: 'host-1',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'zterm_mirror_lab',
        createdAt: 1,
      }] as any,
      hostsLoaded: true,
      runtimeActiveSessionId: null,
      createSession,
      runtimeSessionStructure: [],
      openTabStateRef: createRef({
        tabs: [{
          sessionId: 'session-1',
          hostId: 'host-1',
          connectionName: 'local-test',
          bridgeHost: '127.0.0.1',
          bridgePort: 3333,
          sessionName: 'zterm_mirror_lab',
          createdAt: 1,
        }],
        activeSessionId: 'session-1',
      }),
      restoredTabsHandledRef: createRef(false),
      hasPersistedOpenTabsTruthRef: createRef(true),
      closedOpenTabSessionIdsRef: createRef(new Set<string>()),
      closedOpenTabReuseKeysRef: createRef(new Set<string>()),
      pendingMaterializedOpenTabSessionIdsRef: createRef(new Set<string>()),
      restoreSwitchReason: 'explicit-resume',
      applyOpenTabState,
    }));

    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(applyOpenTabState).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeSessionId: 'session-1' }),
      expect.objectContaining({ switchRuntime: 'explicit-resume', markExplicitTruth: true }),
    );
  });

  it('keeps restore-sync when the persisted page is not terminal', async () => {
    const applyOpenTabState = vi.fn((nextState, options) => ({
      tabs: nextState.tabs,
      activeSessionId: nextState.activeSessionId ?? options?.preserveActiveSessionId ?? null,
    }));

    renderHook(() => useOpenTabRestoreRuntimeSync({
      bridgeSettings: { servers: [], targetHost: '127.0.0.1', targetPort: 3333, targetAuthToken: '' } as any,
      hosts: [{
        id: 'host-1',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'zterm_mirror_lab',
        createdAt: 1,
      }] as any,
      hostsLoaded: true,
      runtimeActiveSessionId: null,
      createSession: vi.fn(() => 'session-1'),
      runtimeSessionStructure: [],
      openTabStateRef: createRef({
        tabs: [{
          sessionId: 'session-1',
          hostId: 'host-1',
          connectionName: 'local-test',
          bridgeHost: '127.0.0.1',
          bridgePort: 3333,
          sessionName: 'zterm_mirror_lab',
          createdAt: 1,
        }],
        activeSessionId: 'session-1',
      }),
      restoredTabsHandledRef: createRef(false),
      hasPersistedOpenTabsTruthRef: createRef(true),
      closedOpenTabSessionIdsRef: createRef(new Set<string>()),
      closedOpenTabReuseKeysRef: createRef(new Set<string>()),
      pendingMaterializedOpenTabSessionIdsRef: createRef(new Set<string>()),
      restoreSwitchReason: 'restore-sync',
      applyOpenTabState,
    }));

    await waitFor(() => expect(applyOpenTabState).toHaveBeenCalled());
    expect(applyOpenTabState).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeSessionId: 'session-1' }),
      expect.objectContaining({ switchRuntime: 'restore-sync', markExplicitTruth: true }),
    );
  });

  it('re-materializes missing persisted tabs from OPEN_TABS even when another runtime session already exists', async () => {
    const applyOpenTabState = vi.fn((nextState, options) => ({
      tabs: nextState.tabs,
      activeSessionId: nextState.activeSessionId ?? options?.preserveActiveSessionId ?? null,
    }));
    const createSession = vi.fn((host, options) => {
      expect(host).toEqual(expect.objectContaining({
        id: 'host-2',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'zterm_mirror_lab_2',
      }));
      expect(options).toEqual(expect.objectContaining({
        activate: false,
        connect: false,
        sessionId: 'session-2',
      }));
      return 'session-2';
    });
    const pendingMaterializedOpenTabSessionIdsRef = createRef(new Set<string>());

    renderHook(() => useOpenTabRestoreRuntimeSync({
      bridgeSettings: { servers: [], targetHost: '127.0.0.1', targetPort: 3333, targetAuthToken: '' } as any,
      hosts: [
        {
          id: 'host-1',
          bridgeHost: '127.0.0.1',
          bridgePort: 3333,
          sessionName: 'zterm_mirror_lab',
          createdAt: 1,
        },
        {
          id: 'host-2',
          bridgeHost: '127.0.0.1',
          bridgePort: 3333,
          sessionName: 'zterm_mirror_lab_2',
          createdAt: 2,
        },
      ] as any,
      hostsLoaded: true,
      runtimeActiveSessionId: 'session-1',
      createSession,
      runtimeSessionStructure: [{
        id: 'session-1',
        hostId: 'host-1',
        connectionName: 'local-test-1',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'zterm_mirror_lab',
        authToken: undefined,
        autoCommand: undefined,
        customName: undefined,
        createdAt: 1,
      }],
      openTabStateRef: createRef({
        tabs: [
          {
            sessionId: 'session-1',
            hostId: 'host-1',
            connectionName: 'local-test-1',
            bridgeHost: '127.0.0.1',
            bridgePort: 3333,
            sessionName: 'zterm_mirror_lab',
            createdAt: 1,
          },
          {
            sessionId: 'session-2',
            hostId: 'host-2',
            connectionName: 'local-test-2',
            bridgeHost: '127.0.0.1',
            bridgePort: 3333,
            sessionName: 'zterm_mirror_lab_2',
            createdAt: 2,
          },
        ],
        activeSessionId: 'session-2',
      }),
      restoredTabsHandledRef: createRef(true),
      hasPersistedOpenTabsTruthRef: createRef(true),
      closedOpenTabSessionIdsRef: createRef(new Set<string>()),
      closedOpenTabReuseKeysRef: createRef(new Set<string>()),
      pendingMaterializedOpenTabSessionIdsRef,
      restoreSwitchReason: 'explicit-resume',
      applyOpenTabState,
    }));

    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(pendingMaterializedOpenTabSessionIdsRef.current.has('session-2')).toBe(true);
    expect(applyOpenTabState).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeSessionId: 'session-2' }),
      expect.objectContaining({ switchRuntime: 'explicit-resume', markExplicitTruth: true }),
    );
  });
});
