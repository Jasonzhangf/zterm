import { runtimeDebug } from './runtime-debug';
import { resolveRemoteRestorableOpenTabState } from './open-tab-restore';
import {
  buildPersistedOpenTabFromHostSession,
  buildPersistedOpenTabReuseKey,
  persistClosedTabReuseKeys,
  resolveHostForPersistedOpenTab,
} from './open-tab-persistence';
import { openConnectionsPage } from './page-state';
import type { OpenTabRuntimeSwitchReason } from './open-tab-runtime-switch';
import type { Host, PersistedOpenTab } from './types';
import type { BridgeSettings } from './bridge-settings';

export interface LoadSavedTabListDeps {
  bridgeSettingsRef: { current: BridgeSettings };
  hostsRef: { current: Host[] };
  closedOpenTabReuseKeysRef: { current: Set<string> };
  openDraftAsSessionRef: { current: ((host: Host, options?: { rememberName?: string; activate?: boolean; navigate?: boolean; sessionId?: string }) => { sessionId: string; host: Host } | null) | null };
  renameSessionRef: { current: (sessionId: string, name: string) => void };
  applyOpenTabState: (state: { tabs: PersistedOpenTab[]; activeSessionId: string | null }, options?: { switchRuntime?: OpenTabRuntimeSwitchReason }) => void;
  setPageState: (state: any) => void;
  ensureTerminalPageVisibleRef: { current: () => void };
}

export async function loadSavedTabList(
  tabs: PersistedOpenTab[],
  requestedActiveSessionId: string | undefined,
  deps: LoadSavedTabListDeps,
  options?: { clearMatchingTombstones?: boolean },
) {
  const importPlan = await resolveRemoteRestorableOpenTabState({
    tabs,
    activeSessionId: requestedActiveSessionId?.trim() || null,
    bridgeSettings: deps.bridgeSettingsRef.current,
    hosts: deps.hostsRef.current,
  });
  if (importPlan.droppedTabs.length > 0) {
    runtimeDebug('app.saved-tab-list.drop-missing-remote-sessions', {
      droppedSessionIds: importPlan.droppedTabs.map((tab) => tab.sessionId),
      droppedTargets: importPlan.droppedTabs.map((tab) => tab.bridgeHost + ':' + tab.bridgePort + ':' + tab.sessionName),
    });
  }
  const filteredTabs = options?.clearMatchingTombstones
    ? importPlan.tabs.map((tab) => {
        const reuseKey = buildPersistedOpenTabReuseKey(tab);
        if (deps.closedOpenTabReuseKeysRef.current.has(reuseKey)) {
          deps.closedOpenTabReuseKeysRef.current.delete(reuseKey);
          persistClosedTabReuseKeys(deps.closedOpenTabReuseKeysRef.current);
          runtimeDebug('app.saved-tab-list.clear-tombstone', {
            sessionId: tab.sessionId,
            sessionName: tab.sessionName,
          });
        }
        return tab;
      })
    : importPlan.tabs.filter((tab) => {
        const reuseKey = buildPersistedOpenTabReuseKey(tab);
        if (deps.closedOpenTabReuseKeysRef.current.has(reuseKey)) {
          runtimeDebug('app.saved-tab-list.skip-closed', {
            sessionId: tab.sessionId,
            sessionName: tab.sessionName,
          });
          return false;
        }
        return true;
      });
  if (filteredTabs.length === 0) {
    deps.applyOpenTabState({ tabs: [], activeSessionId: null });
    deps.setPageState(openConnectionsPage());
    return;
  }
  const openedTabs: PersistedOpenTab[] = [];
  runtimeDebug('app.saved-tab-list.load', {
    requestedActiveSessionId: requestedActiveSessionId || null,
    sessionIds: filteredTabs.map((tab) => tab.sessionId),
    bridgeTargets: filteredTabs.map((tab) => tab.bridgeHost + ':' + tab.bridgePort + ':' + tab.sessionName),
  });

  filteredTabs.forEach((tab) => {
    const host: Host = resolveHostForPersistedOpenTab({
      tab,
      hosts: deps.hostsRef.current,
      fallbackIdPrefix: 'saved',
      fallbackLastConnected: Date.now(),
    });
    const opened = deps.openDraftAsSessionRef.current?.(host, {
      rememberName: host.name,
      activate: false,
      navigate: false,
      sessionId: tab.sessionId,
    });
    if (!opened) {
      throw new Error('openDraftAsSession ref unavailable while loading saved tab list');
    }
    openedTabs.push(buildPersistedOpenTabFromHostSession({
      sessionId: opened.sessionId,
      host: opened.host,
      customName: tab.customName,
      createdAt: tab.createdAt,
    }));
    if (tab.customName?.trim()) {
      deps.renameSessionRef.current(opened.sessionId, tab.customName.trim());
    }
  });

  const activeSessionId = importPlan.activeSessionId
    ? (openedTabs.find((tab) => tab.sessionId === importPlan.activeSessionId)?.sessionId || openedTabs[0]?.sessionId || null)
    : null;

  if (activeSessionId) {
    deps.applyOpenTabState({ tabs: openedTabs, activeSessionId }, { switchRuntime: 'explicit-resume' });
    deps.ensureTerminalPageVisibleRef.current();
  }
}
