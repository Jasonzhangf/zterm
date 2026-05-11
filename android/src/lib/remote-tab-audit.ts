import { runtimeDebug } from './runtime-debug';
import { fetchRemoteTmuxSessionNamesByOwner, filterRestorableOpenTabsByRemoteSessionNames } from './open-tab-restore';
import { normalizeOpenTabIntentState } from './open-tab-intent';
import type { BridgeSettings } from './bridge-settings';
import type { Host, PersistedOpenTab, SessionGroupHistory } from './types';

export interface RemoteTabAuditDeps {
  openTabStateRef: { current: { tabs: PersistedOpenTab[]; activeSessionId: string | null } };
  sessionGroups: SessionGroupHistory[];
  bridgeSettingsRef: { current: BridgeSettings };
  hostsRef: { current: Host[] };
  sessionsRef: { current: any[] };
  runtimeActiveSessionIdRef: { current: string | null };
  remoteOpenTabAuditTokenRef: { current: number };
  pruneSessionGroupSelectionToRemoteTruth: (target: { bridgeHost: string; bridgePort: number; daemonHostId?: string }, remoteSessionNames: string[]) => void;
  applyClosedOpenTabIntent: (sessionId: string, options: any) => void;
}

export async function auditOpenTabsAgainstRemoteSessions(
  reason: string,
  deps: RemoteTabAuditDeps,
) {
  const currentTabs = deps.openTabStateRef.current.tabs;
  const auditTargets = [
    ...currentTabs,
    ...deps.sessionGroups,
  ];
  if (auditTargets.length === 0) {
    return;
  }

  const auditToken = deps.remoteOpenTabAuditTokenRef.current + 1;
  deps.remoteOpenTabAuditTokenRef.current = auditToken;
  const sessionNamesByTarget = await fetchRemoteTmuxSessionNamesByOwner({
    targets: auditTargets,
    bridgeSettings: deps.bridgeSettingsRef.current,
    hosts: deps.hostsRef.current,
  });
  if (deps.remoteOpenTabAuditTokenRef.current !== auditToken) {
    return;
  }

  const prunedOwnerKeys = new Set<string>();
  for (const target of auditTargets) {
    const ownerKey = `${target.daemonHostId?.trim() ? `daemon:${target.daemonHostId.trim()}` : `bridge:${target.bridgeHost.trim()}::${Math.max(0, Math.floor(target.bridgePort || 0))}`}`;
    if (prunedOwnerKeys.has(ownerKey)) {
      continue;
    }
    prunedOwnerKeys.add(ownerKey);
    const remoteSessionNames = sessionNamesByTarget.get(ownerKey);
    if (!remoteSessionNames) {
      continue;
    }
    deps.pruneSessionGroupSelectionToRemoteTruth({
      bridgeHost: target.bridgeHost,
      bridgePort: target.bridgePort,
      daemonHostId: target.daemonHostId,
    }, remoteSessionNames);
  }

  const remoteAvailability = filterRestorableOpenTabsByRemoteSessionNames({
    tabs: currentTabs,
    sessionNamesByTarget,
  });
  const normalizedRemoteState = normalizeOpenTabIntentState(
    remoteAvailability.restorableTabs,
    deps.openTabStateRef.current.activeSessionId,
  );
  const remoteState = {
    tabs: normalizedRemoteState.tabs,
    activeSessionId: normalizedRemoteState.activeSessionId,
    droppedTabs: remoteAvailability.droppedTabs,
  };
  if (deps.remoteOpenTabAuditTokenRef.current !== auditToken) {
    return;
  }

  const droppedTabs = remoteState.droppedTabs.filter((tab) => (
    deps.openTabStateRef.current.tabs.some((currentTab) => currentTab.sessionId === tab.sessionId)
  ));
  if (droppedTabs.length === 0) {
    return;
  }

  runtimeDebug('app.open-tabs.remote-session-prune', {
    reason,
    droppedSessionIds: droppedTabs.map((tab) => tab.sessionId),
    droppedTargets: droppedTabs.map((tab) => `${tab.bridgeHost}:${tab.bridgePort}:${tab.sessionName}`),
    remainingSessionIds: remoteState.tabs.map((tab) => tab.sessionId),
  });

  for (const tab of droppedTabs) {
    const runtimeSessions = deps.sessionsRef.current;
    if (!deps.openTabStateRef.current.tabs.some((currentTab) => currentTab.sessionId === tab.sessionId)) {
      continue;
    }
    deps.applyClosedOpenTabIntent(tab.sessionId, {
      runtimeSessions,
      runtimeActiveSessionId: deps.runtimeActiveSessionIdRef.current,
      fallbackSessionIds: runtimeSessions
        .filter((session) => session.id !== tab.sessionId)
        .map((session) => session.id),
      closeRuntimeSession: runtimeSessions.some((session) => session.id === tab.sessionId),
      clearDraft: true,
      source: `remote-session-audit:${reason}`,
    });
  }
}
