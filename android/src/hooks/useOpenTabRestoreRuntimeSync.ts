import { useEffect, type MutableRefObject } from 'react';
import { resolveHostForPersistedOpenTab } from '../lib/open-tab-persistence';
import { resolveRemoteRestorableOpenTabState } from '../lib/open-tab-restore';
import {
  derivePersistedOpenTabRestorePlan,
  deriveRuntimeOpenTabSyncDecision,
  normalizeOpenTabIntentState,
  resolveRestoredOpenTabIntentState,
} from '../lib/open-tab-intent';
import { runtimeDebug } from '../lib/runtime-debug';
import type { BridgeSettings } from '../lib/bridge-settings';
import type { Host, PersistedOpenTab, Session } from '../lib/types';

interface PersistOpenTabIntentStateFn {
  (
    nextState: {
      tabs: PersistedOpenTab[];
      activeSessionId: string | null;
    },
    options?: { fallbackActiveSessionId?: string | null },
  ): {
    tabs: PersistedOpenTab[];
    activeSessionId: string | null;
  };
}

interface UseOpenTabRestoreRuntimeSyncOptions {
  bridgeSettings: BridgeSettings;
  hosts: Host[];
  hostsLoaded: boolean;
  runtimeActiveSessionId: string | null;
  runtimeSessionStructure: Array<Pick<
    Session,
    'id' | 'hostId' | 'connectionName' | 'bridgeHost' | 'bridgePort' | 'daemonHostId' | 'sessionName' | 'authToken' | 'autoCommand' | 'customName' | 'createdAt'
  >>;
  openTabStateRef: MutableRefObject<{
    tabs: PersistedOpenTab[];
    activeSessionId: string | null;
  }>;
  restoredTabsHandledRef: MutableRefObject<boolean>;
  hasPersistedOpenTabsTruthRef: MutableRefObject<boolean>;
  closedOpenTabSessionIdsRef: MutableRefObject<Set<string>>;
  closedOpenTabReuseKeysRef: MutableRefObject<Set<string>>;
  persistOpenTabIntentState: PersistOpenTabIntentStateFn;
  persistAndSwitchExplicitOpenTabs: (tabs: PersistedOpenTab[], activeSessionId: string | null) => {
    tabs: PersistedOpenTab[];
    activeSessionId: string | null;
  };
  requestRuntimeActiveSessionSwitch: (nextActiveSessionId: string | null) => void;
  createSession: (
    host: Host,
    options?: {
      activate?: boolean;
      connect?: boolean;
      customName?: string;
      createdAt?: number;
      sessionId?: string;
    },
  ) => string;
}

export function useOpenTabRestoreRuntimeSync(options: UseOpenTabRestoreRuntimeSyncOptions) {
  const {
    bridgeSettings,
    hosts,
    hostsLoaded,
    runtimeActiveSessionId,
    runtimeSessionStructure,
    openTabStateRef,
    restoredTabsHandledRef,
    hasPersistedOpenTabsTruthRef,
    closedOpenTabSessionIdsRef,
    closedOpenTabReuseKeysRef,
    persistOpenTabIntentState,
    persistAndSwitchExplicitOpenTabs,
    requestRuntimeActiveSessionSwitch,
    createSession,
  } = options;

  useEffect(() => {
    if (!hostsLoaded) {
      return;
    }

    let cancelled = false;

    const run = async () => {
      let currentOpenTabState = openTabStateRef.current;
      let initialRemoteRestoreApplied = false;
      if (!restoredTabsHandledRef.current && currentOpenTabState.tabs.length > 0) {
        const initialRestorePlan = derivePersistedOpenTabRestorePlan(currentOpenTabState);
        if (initialRestorePlan.kind === 'restore') {
          const initialRestoreState = await resolveRemoteRestorableOpenTabState({
            tabs: initialRestorePlan.tabs,
            activeSessionId: initialRestorePlan.activeSessionId,
            bridgeSettings,
          });
          if (cancelled) {
            return;
          }
          if (initialRestoreState.droppedTabs.length > 0) {
            runtimeDebug('app.open-tabs.restore.drop-missing-remote-sessions', {
              droppedSessionIds: initialRestoreState.droppedTabs.map((tab) => tab.sessionId),
              droppedTargets: initialRestoreState.droppedTabs.map((tab) => `${tab.bridgeHost}:${tab.bridgePort}:${tab.sessionName}`),
            });
          }
          currentOpenTabState = persistOpenTabIntentState({
            tabs: initialRestoreState.tabs,
            activeSessionId: initialRestoreState.activeSessionId,
          });
          initialRemoteRestoreApplied = true;
        }
      }

      if (runtimeSessionStructure.length > 0) {
        const runtimeSyncDecision = deriveRuntimeOpenTabSyncDecision({
          currentState: currentOpenTabState,
          runtimeSessions: runtimeSessionStructure,
          runtimeActiveSessionId,
          restoredTabsHandled: initialRemoteRestoreApplied ? false : restoredTabsHandledRef.current,
          hasPersistedOpenTabsTruth: hasPersistedOpenTabsTruthRef.current,
          closedSessionIds: closedOpenTabSessionIdsRef.current,
          closedReuseKeys: closedOpenTabReuseKeysRef.current,
        });
        restoredTabsHandledRef.current = true;
        if (cancelled) {
          return;
        }
        if (runtimeSyncDecision.kind === 'bootstrap' && runtimeSyncDecision.state) {
          runtimeDebug('app.open-tabs.bootstrap-from-runtime', {
            activeSessionId: runtimeActiveSessionId,
            runtimeSessionIds: runtimeSessionStructure.map((session) => session.id),
          });
          persistOpenTabIntentState(runtimeSyncDecision.state);
          return;
        }

        if (runtimeSyncDecision.kind === 'noop' && currentOpenTabState.tabs.length === 0 && hasPersistedOpenTabsTruthRef.current) {
          return;
        }

        if (runtimeSyncDecision.kind === 'merge' && runtimeSyncDecision.state) {
          runtimeDebug('app.open-tabs.runtime-merge-rewrite', {
            beforeSessionIds: currentOpenTabState.tabs.map((tab) => tab.sessionId),
            afterSessionIds: runtimeSyncDecision.state.tabs.map((tab) => tab.sessionId),
            activeSessionId: runtimeSyncDecision.state.activeSessionId,
          });
          persistOpenTabIntentState(runtimeSyncDecision.state);
          return;
        }

        if (runtimeSyncDecision.kind === 'switch' && runtimeSyncDecision.activeSessionId) {
          persistAndSwitchExplicitOpenTabs(currentOpenTabState.tabs, runtimeSyncDecision.activeSessionId);
        }
        return;
      }

      restoredTabsHandledRef.current = true;
      const restorePlan = derivePersistedOpenTabRestorePlan(currentOpenTabState);
      if (restorePlan.kind === 'empty') {
        persistOpenTabIntentState({ tabs: [], activeSessionId: null });
        return;
      }

      const remoteRestoreState = initialRemoteRestoreApplied
        ? currentOpenTabState
        : await (async () => {
          const restoreState = await resolveRemoteRestorableOpenTabState({
            tabs: restorePlan.tabs,
            activeSessionId: restorePlan.activeSessionId,
            bridgeSettings,
          });
          if (cancelled) {
            return currentOpenTabState;
          }
          if (restoreState.droppedTabs.length > 0) {
            runtimeDebug('app.open-tabs.restore.drop-missing-remote-sessions', {
              droppedSessionIds: restoreState.droppedTabs.map((tab) => tab.sessionId),
              droppedTargets: restoreState.droppedTabs.map((tab) => `${tab.bridgeHost}:${tab.bridgePort}:${tab.sessionName}`),
            });
          }
          return {
            tabs: restoreState.tabs,
            activeSessionId: restoreState.activeSessionId,
          };
        })();
      if (cancelled) {
        return;
      }
      persistOpenTabIntentState(remoteRestoreState);

      if (remoteRestoreState.tabs.length === 0) {
        return;
      }

      const persistedTabs = remoteRestoreState.tabs;
      const nextActiveSessionId = remoteRestoreState.activeSessionId;
      const restoredSessionIdRemap = new Map<string, string>();
      for (const tab of persistedTabs) {
        const host = resolveHostForPersistedOpenTab({
          tab,
          hosts,
          fallbackIdPrefix: 'restored',
        });

        const restoredSessionId = createSession(host, {
          activate: tab.sessionId === nextActiveSessionId,
          connect: tab.sessionId === nextActiveSessionId,
          customName: tab.customName,
          createdAt: tab.createdAt,
          sessionId: tab.sessionId,
        });
        runtimeDebug('app.session.restore.persisted-tab', {
          requestedSessionId: tab.sessionId,
          restoredSessionId,
          bridgeHost: tab.bridgeHost,
          bridgePort: tab.bridgePort,
          sessionName: tab.sessionName,
          activate: tab.sessionId === nextActiveSessionId,
        });
        if (restoredSessionId !== tab.sessionId) {
          restoredSessionIdRemap.set(tab.sessionId, restoredSessionId);
        }
      }
      if (restoredSessionIdRemap.size > 0 || nextActiveSessionId) {
        const restoredIntentState = resolveRestoredOpenTabIntentState(
          normalizeOpenTabIntentState(persistedTabs, nextActiveSessionId),
          restoredSessionIdRemap,
        );
        const resolvedTabs = restoredIntentState.tabs;
        const restoredActiveSessionId = restoredIntentState.activeSessionId;
        if (restoredSessionIdRemap.size > 0) {
          if (restoredActiveSessionId) {
            persistAndSwitchExplicitOpenTabs(resolvedTabs, restoredActiveSessionId);
          } else {
            persistOpenTabIntentState({
              tabs: resolvedTabs,
              activeSessionId: null,
            });
          }
        } else if (restoredActiveSessionId) {
          requestRuntimeActiveSessionSwitch(restoredActiveSessionId);
        }
      }
    };

    void run().catch((error) => {
      restoredTabsHandledRef.current = true;
      console.error('[App] Failed to restore persisted open tabs:', error);
    });

    return () => {
      cancelled = true;
    };
  }, [
    bridgeSettings,
    createSession,
    hosts,
    hostsLoaded,
    persistAndSwitchExplicitOpenTabs,
    persistOpenTabIntentState,
    requestRuntimeActiveSessionSwitch,
    runtimeActiveSessionId,
    runtimeSessionStructure,
    openTabStateRef,
    restoredTabsHandledRef,
    hasPersistedOpenTabsTruthRef,
    closedOpenTabSessionIdsRef,
    closedOpenTabReuseKeysRef,
  ]);
}
