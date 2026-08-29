import { runtimeDebug } from './runtime-debug';
import { fetchRemoteTmuxSessionNamesByOwner } from './open-tab-restore';
import type { BridgeSettings } from './bridge-settings';
import { resolveRelayDaemonCanonicalHostId } from './relay-account-directory';
import type { Host, PersistedOpenTab, Session, SessionGroupHistory, TraversalRelayDeviceSnapshot } from './types';
import type { TerminalMuxTargetClientMessage } from '@zterm/shared/protocol';

export interface RemoteTabAuditDeps {
  openTabStateRef: { current: { tabs: PersistedOpenTab[]; activeSessionId: string | null } };
  sessionGroups: SessionGroupHistory[];
  bridgeSettingsRef: { current: BridgeSettings };
  hostsRef: { current: Host[] };
  relayDevices?: TraversalRelayDeviceSnapshot[];
  sessionsRef?: { current: Session[] };
  prioritySessionIdsRef?: { current: Array<string | null | undefined> };
  manageTmuxSessionsOnOpenTransport?: (
    sessionId: string,
    message: TerminalMuxTargetClientMessage,
  ) => Promise<string[] | null>;
  remoteOpenTabAuditTokenRef: { current: number };
  pruneSessionGroupSelectionToRemoteTruth: (target: { bridgeHost: string; bridgePort: number; daemonHostId?: string }, remoteSessionNames: string[]) => void;
}

function buildAuditOwnerKey(target: Pick<PersistedOpenTab | SessionGroupHistory, 'daemonHostId' | 'bridgeHost' | 'bridgePort'>) {
  const ownerKey = target.daemonHostId?.trim()
    ? `daemon:${target.daemonHostId.trim()}`
    : `bridge:${target.bridgeHost.trim()}::${Math.max(0, Math.floor(target.bridgePort || 0))}`;
  return ('terminalBackend' in target && target.terminalBackend === 'herdr')
    ? `${ownerKey}::backend:herdr`
    : ownerKey;
}

function canonicalizeAuditTarget<T extends {
  daemonHostId?: string;
  bridgeHost: string;
  bridgePort: number;
  authToken?: string;
}>(target: T, relayDevices: TraversalRelayDeviceSnapshot[]): T {
  const canonicalDaemonHostId = resolveRelayDaemonCanonicalHostId({
    daemonHostId: target.daemonHostId,
    authToken: target.authToken,
    bridgeHost: target.bridgeHost,
    bridgePort: target.bridgePort,
  }, relayDevices);
  return canonicalDaemonHostId && canonicalDaemonHostId !== target.daemonHostId?.trim()
    ? { ...target, daemonHostId: canonicalDaemonHostId }
    : target;
}

function shouldAuditSessionGroups(reason: string) {
  return reason !== 'visibilitychange'
    && reason !== 'resume'
    && reason !== 'appStateChange'
    && reason !== 'online';
}

export async function auditOpenTabsAgainstRemoteSessions(
  reason: string,
  deps: RemoteTabAuditDeps,
) {
  const currentTabs = deps.openTabStateRef.current.tabs;
  const includeSessionGroups = shouldAuditSessionGroups(reason);
  const auditTargets = [
    ...currentTabs,
    ...(includeSessionGroups ? deps.sessionGroups : []),
  ];
  if (auditTargets.length === 0) {
    return;
  }

  const auditToken = deps.remoteOpenTabAuditTokenRef.current + 1;
  deps.remoteOpenTabAuditTokenRef.current = auditToken;
  const canonicalAuditTargets = auditTargets.map((target) => (
    canonicalizeAuditTarget(target, deps.relayDevices || [])
  ));
  const sessionNamesByTarget = await fetchRemoteTmuxSessionNamesByOwner({
    targets: canonicalAuditTargets,
    bridgeSettings: deps.bridgeSettingsRef.current,
    hosts: deps.hostsRef.current,
    relayDevices: deps.relayDevices,
    openSessions: deps.sessionsRef?.current,
    prioritySessionIds: deps.prioritySessionIdsRef?.current,
    manageTmuxSessionsOnOpenTransport: deps.manageTmuxSessionsOnOpenTransport,
  });
  if (deps.remoteOpenTabAuditTokenRef.current !== auditToken) {
    return;
  }

  const prunedOwnerKeys = new Set<string>();
  for (const target of canonicalAuditTargets) {
    const ownerKey = buildAuditOwnerKey(target);
    if (prunedOwnerKeys.has(ownerKey)) {
      continue;
    }
    prunedOwnerKeys.add(ownerKey);
    const remoteSessionNames = sessionNamesByTarget.get(ownerKey);
    if (!remoteSessionNames || remoteSessionNames.length === 0) {
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
    const canonicalTab = canonicalizeAuditTarget(tab, deps.relayDevices || []);
    const remoteSessionNames = sessionNamesByTarget.get(buildAuditOwnerKey(canonicalTab));
    // If no entry in map at all, or entry is empty array, treat as "unknown" - do NOT close tabs
    if (!remoteSessionNames || remoteSessionNames.length === 0) {
      return false;
    }
    // Only flag as missing if we have a non-empty confirmed session list AND our tab is not in it
    return !new Set(remoteSessionNames).has(tab.sessionName.trim());
  });
  if (missingTabs.length > 0) {
    runtimeDebug('app.open-tabs.remote-session-missing', {
      reason,
      sessionIds: missingTabs.map((tab) => tab.sessionId),
      targets: missingTabs.map((tab) => `${tab.bridgeHost}:${tab.bridgePort}:${tab.sessionName}`),
    });
  }

}
