import { useEffect, type MutableRefObject } from 'react';
import {
  buildOpenTabSessionCreateOptions,
} from '../lib/open-tab-open-policy';
import {
  buildPersistedOpenTabReuseKeyVariants,
  persistClosedTabReuseKeys,
  resolveHostForPersistedOpenTab,
} from '../lib/open-tab-persistence';
import { resolveRemoteRestorableOpenTabState } from '../lib/open-tab-restore';
import {
  derivePersistedOpenTabRestorePlan,
  deriveRuntimeOpenTabSyncDecision,
  normalizeOpenTabIntentState,
} from '../lib/open-tab-intent';
import { runtimeDebug } from '../lib/runtime-debug';
import type { OpenTabRuntimeSwitchReason } from '../lib/open-tab-runtime-switch';
import type { BridgeSettings } from '../lib/bridge-settings';
import type { Host, PersistedOpenTab, Session } from '../lib/types';

interface ApplyOpenTabStateFn {
  (
    nextState: {
      tabs: PersistedOpenTab[];
      activeSessionId: string | null;
    },
    options?: { fallbackActiveSessionId?: string | null; switchRuntime?: OpenTabRuntimeSwitchReason; markExplicitTruth?: boolean },
  ): {
    tabs: PersistedOpenTab[];
    activeSessionId: string | null;
  };
}

interface UseOpenTabRestoreRuntimeSyncOptions {
  bridgeSettings: BridgeSettings;
  hosts: Host[];
  hostsLoaded: boolean;
  restoreSwitchReason: OpenTabRuntimeSwitchReason;
  runtimeActiveSessionId: string | null;
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
  applyOpenTabState: ApplyOpenTabStateFn;
}

export function useOpenTabRestoreRuntimeSync(options: UseOpenTabRestoreRuntimeSyncOptions) {
  const {
    bridgeSettings,
    hosts,
    hostsLoaded,
    restoreSwitchReason,
    runtimeActiveSessionId,
    createSession,
    runtimeSessionStructure,
    openTabStateRef,
    restoredTabsHandledRef,
    hasPersistedOpenTabsTruthRef,
    closedOpenTabSessionIdsRef,
    closedOpenTabReuseKeysRef,
    applyOpenTabState,
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
            hosts,
          });
          if (cancelled) {
            return;
          }
          if (initialRestoreState.droppedTabs.length > 0) {
            runtimeDebug('app.open-tabs.restore.drop-missing-remote-sessions', {
              droppedSessionIds: initialRestoreState.droppedTabs.map((tab) => tab.sessionId),
              droppedTargets: initialRestoreState.droppedTabs.map((tab) => `${tab.bridgeHost}:${tab.bridgePort}:${tab.sessionName}`),
            });
            // Permanently mark dropped tabs as "do not open"
            for (const tab of initialRestoreState.droppedTabs) {
              const reuseKeys = buildPersistedOpenTabReuseKeyVariants({
                daemonHostId: tab.daemonHostId,
                bridgeHost: tab.bridgeHost,
                bridgePort: tab.bridgePort,
                sessionName: tab.sessionName,
              });
              reuseKeys.forEach((key) => closedOpenTabReuseKeysRef.current.add(key));
            }
            persistClosedTabReuseKeys(closedOpenTabReuseKeysRef.current);
          }
          currentOpenTabState = applyOpenTabState({
            tabs: initialRestoreState.tabs,
            activeSessionId: initialRestoreState.activeSessionId,
          }, {
            markExplicitTruth: initialRestorePlan.tabs.length > 0,
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
          applyOpenTabState(runtimeSyncDecision.state, {
            markExplicitTruth: false,
          });
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
          applyOpenTabState(runtimeSyncDecision.state, {
            markExplicitTruth: hasPersistedOpenTabsTruthRef.current,
          });
          return;
        }

        if (runtimeSyncDecision.kind === 'switch' && runtimeSyncDecision.activeSessionId) {
          applyOpenTabState({
            tabs: currentOpenTabState.tabs,
            activeSessionId: runtimeSyncDecision.activeSessionId,
          }, {
            switchRuntime: restoreSwitchReason,
          });
        }
        return;
      }

      restoredTabsHandledRef.current = true;
      const restorePlan = derivePersistedOpenTabRestorePlan(currentOpenTabState);
      if (restorePlan.kind === 'empty') {
        applyOpenTabState({ tabs: [], activeSessionId: null });
        return;
      }

      const remoteRestoreState = initialRemoteRestoreApplied
        ? currentOpenTabState
        : await (async () => {
          const restoreState = await resolveRemoteRestorableOpenTabState({
            tabs: restorePlan.tabs,
            activeSessionId: restorePlan.activeSessionId,
            bridgeSettings,
            hosts,
          });
          if (cancelled) {
            return currentOpenTabState;
          }
          if (restoreState.droppedTabs.length > 0) {
            runtimeDebug('app.open-tabs.restore.drop-missing-remote-sessions', {
              droppedSessionIds: restoreState.droppedTabs.map((tab) => tab.sessionId),
              droppedTargets: restoreState.droppedTabs.map((tab) => `${tab.bridgeHost}:${tab.bridgePort}:${tab.sessionName}`),
            });
            for (const tab of restoreState.droppedTabs) {
              const reuseKeys = buildPersistedOpenTabReuseKeyVariants({
                daemonHostId: tab.daemonHostId,
                bridgeHost: tab.bridgeHost,
                bridgePort: tab.bridgePort,
                sessionName: tab.sessionName,
              });
              reuseKeys.forEach((key) => closedOpenTabReuseKeysRef.current.add(key));
            }
            persistClosedTabReuseKeys(closedOpenTabReuseKeysRef.current);
          }
          return {
            tabs: restoreState.tabs,
            activeSessionId: restoreState.activeSessionId,
          };
        })();
      if (cancelled) {
        return;
      }
      if (remoteRestoreState.tabs.length === 0) {
        applyOpenTabState(remoteRestoreState, {
          markExplicitTruth: restorePlan.tabs.length > 0,
        });
        return;
      }

      const restoredRuntimeTabs: PersistedOpenTab[] = [];
      for (const tab of remoteRestoreState.tabs) {
        const createdSessionId = createSession(
          resolveHostForPersistedOpenTab({
            tab,
            hosts,
          }),
          buildOpenTabSessionCreateOptions('cold-restore', {
            customName: tab.customName,
            createdAt: tab.createdAt,
            sessionId: tab.sessionId,
          }),
        );
        const restoredSessionId =
          typeof createdSessionId === 'string' && createdSessionId.trim().length > 0
            ? createdSessionId
            : tab.sessionId;
        restoredRuntimeTabs.push(
          restoredSessionId === tab.sessionId
            ? tab
            : {
                ...tab,
                sessionId: restoredSessionId,
              },
        );
      }

      const restoredRuntimeState = normalizeOpenTabIntentState(
        restoredRuntimeTabs,
        remoteRestoreState.activeSessionId,
      );
      applyOpenTabState(
        restoredRuntimeState,
        restoredRuntimeState.activeSessionId
          ? {
              switchRuntime: restoreSwitchReason,
              markExplicitTruth: restorePlan.tabs.length > 0,
            }
          : {
              markExplicitTruth: restorePlan.tabs.length > 0,
            },
      );
      return;
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
    hosts,
    hostsLoaded,
    restoreSwitchReason,
    applyOpenTabState,
    runtimeActiveSessionId,
    runtimeSessionStructure,
    openTabStateRef,
    restoredTabsHandledRef,
    hasPersistedOpenTabsTruthRef,
    closedOpenTabSessionIdsRef,
    closedOpenTabReuseKeysRef,
    createSession,
  ]);
}
