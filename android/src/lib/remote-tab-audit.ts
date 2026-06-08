import { runtimeDebug } from './runtime-debug';
import { fetchRemoteTmuxSessionNamesByOwner } from './open-tab-restore';
import type { BridgeSettings } from './bridge-settings';
import type { Host, PersistedOpenTab, SessionGroupHistory } from './types';

export interface RemoteTabAuditDeps {
  openTabStateRef: { current: { tabs: PersistedOpenTab[]; activeSessionId: string | null } };
  sessionGroups: SessionGroupHistory[];
  bridgeSettingsRef: { current: BridgeSettings };
  hostsRef: { current: Host[] };
  remoteOpenTabAuditTokenRef: { current: number };
  pruneSessionGroupSelectionToRemoteTruth: (target: { bridgeHost: string; bridgePort: number; daemonHostId?: string }, remoteSessionNames: string[]) => void;
}

function buildAuditOwnerKey(target: Pick<PersistedOpenTab | SessionGroupHistory, 'daemonHostId' | 'bridgeHost' | 'bridgePort'>) {
  return target.daemonHostId?.trim()
    ? `daemon:${target.daemonHostId.trim()}`
    : `bridge:${target.bridgeHost.trim()}::${Math.max(0, Math.floor(target.bridgePort || 0))}`;
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
    const ownerKey = buildAuditOwnerKey(target);
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

  if (deps.remoteOpenTabAuditTokenRef.current !== auditToken) {
    return;
  }

  const missingTabs = currentTabs.filter((tab) => {
    const remoteSessionNames = sessionNamesByTarget.get(buildAuditOwnerKey(tab));
    if (!remoteSessionNames) {
      return false;
    }
    return !new Set(remoteSessionNames).has(tab.sessionName.trim());
  });
  if (missingTabs.length === 0) {
    return;
  }

  runtimeDebug('app.open-tabs.remote-session-missing', {
    reason,
    sessionIds: missingTabs.map((tab) => tab.sessionId),
    targets: missingTabs.map((tab) => `${tab.bridgeHost}:${tab.bridgePort}:${tab.sessionName}`),
  });
}
