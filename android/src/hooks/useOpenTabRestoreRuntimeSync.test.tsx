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
      activeSessionId: nextState.activeSessionId ?? options?.fallbackActiveSessionId ?? null,
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
      activeSessionId: nextState.activeSessionId ?? options?.fallbackActiveSessionId ?? null,
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
});
