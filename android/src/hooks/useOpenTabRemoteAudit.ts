import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { fetchRemoteTmuxSessionNamesByOwner, filterRestorableOpenTabsByRemoteSessionNames } from '../lib/open-tab-restore';
import { normalizeOpenTabIntentState } from '../lib/open-tab-intent';
import { runtimeDebug } from '../lib/runtime-debug';
import type { BridgeSettings } from '../lib/bridge-settings';
import type { Host, PersistedOpenTab, Session, SessionGroupHistory } from '../lib/types';
import type { OpenTabAuditReason } from './useOpenTabLifecycleEffects';

interface UseOpenTabRemoteAuditOptions {
  bridgeSettingsRef: MutableRefObject<BridgeSettings>;
  hostsRef: MutableRefObject<Host[]>;
  sessions: Session[];
  sessionGroups: SessionGroupHistory[];
  openTabStateRef: MutableRefObject<{
    tabs: PersistedOpenTab[];
    activeSessionId: string | null;
  }>;
  runtimeActiveSessionIdRef: MutableRefObject<string | null>;
  sessionsRef: MutableRefObject<Session[]>;
  applyClosedOpenTabIntent: (
    sessionId: string,
    closeOptions?: {
      runtimeActiveSessionId?: string | null;
      fallbackSessionIds?: string[];
      runtimeSessions?: Array<Pick<Session, 'id' | 'bridgeHost' | 'bridgePort' | 'daemonHostId' | 'sessionName' | 'authToken'>>;
      closeRuntimeSession?: boolean;
      clearDraft?: boolean;
      source?: string;
    },
  ) => {
    tabs: PersistedOpenTab[];
    activeSessionId: string | null;
  };
  pruneSessionGroupSelectionToRemoteTruth: (
    target: { bridgeHost: string; bridgePort: number; daemonHostId?: string },
    remoteSessionNames: string[],
  ) => void;
  openTabTabsLength: number;
  sessionsLength: number;
}

export function useOpenTabRemoteAudit(options: UseOpenTabRemoteAuditOptions) {
  const {
    bridgeSettingsRef,
    hostsRef,
    sessions,
    sessionGroups,
    openTabStateRef,
    runtimeActiveSessionIdRef,
    sessionsRef,
    applyClosedOpenTabIntent,
    pruneSessionGroupSelectionToRemoteTruth,
    openTabTabsLength,
    sessionsLength,
  } = options;

  const remoteOpenTabAuditTokenRef = useRef(0);
  const connectedSessionIdsRef = useRef<Set<string>>(new Set());
  const initialRemoteSessionAuditDoneRef = useRef(false);

  const auditOpenTabsAgainstRemoteSessions = useCallback(async (reason: OpenTabAuditReason) => {
    const currentTabs = openTabStateRef.current.tabs;
    const auditTargets = [
      ...currentTabs,
      ...sessionGroups,
    ];
    if (auditTargets.length === 0) {
      return;
    }

    const auditToken = remoteOpenTabAuditTokenRef.current + 1;
    remoteOpenTabAuditTokenRef.current = auditToken;
    const sessionNamesByTarget = await fetchRemoteTmuxSessionNamesByOwner({
      targets: auditTargets,
      bridgeSettings: bridgeSettingsRef.current,
      hosts: hostsRef.current,
    });
    if (remoteOpenTabAuditTokenRef.current !== auditToken) {
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
      pruneSessionGroupSelectionToRemoteTruth({
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
      openTabStateRef.current.activeSessionId,
    );
    const remoteState = {
      tabs: normalizedRemoteState.tabs,
      activeSessionId: normalizedRemoteState.activeSessionId,
      droppedTabs: remoteAvailability.droppedTabs,
    };
    if (remoteOpenTabAuditTokenRef.current !== auditToken) {
      return;
    }

    const droppedTabs = remoteState.droppedTabs.filter((tab) => (
      openTabStateRef.current.tabs.some((currentTab) => currentTab.sessionId === tab.sessionId)
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
      const runtimeSessions = sessionsRef.current;
      if (!openTabStateRef.current.tabs.some((currentTab) => currentTab.sessionId === tab.sessionId)) {
        continue;
      }
      applyClosedOpenTabIntent(tab.sessionId, {
        runtimeSessions,
        runtimeActiveSessionId: runtimeActiveSessionIdRef.current,
        fallbackSessionIds: runtimeSessions
          .filter((session) => session.id !== tab.sessionId)
          .map((session) => session.id),
        closeRuntimeSession: runtimeSessions.some((session) => session.id === tab.sessionId),
        clearDraft: true,
        source: `remote-session-audit:${reason}`,
      });
    }
  }, [applyClosedOpenTabIntent, pruneSessionGroupSelectionToRemoteTruth, sessionGroups,
    bridgeSettingsRef, hostsRef, openTabStateRef, runtimeActiveSessionIdRef, sessionsRef]);

  // Audit on new connected sessions
  useEffect(() => {
    const nextConnectedSessionIds = new Set(
      sessions
        .filter((session) => session.state === 'connected')
        .map((session) => session.id),
    );
    const hasNewConnectedSession = [...nextConnectedSessionIds].some(
      (sessionId) => !connectedSessionIdsRef.current.has(sessionId),
    );
    connectedSessionIdsRef.current = nextConnectedSessionIds;
    if (!hasNewConnectedSession) {
      return;
    }
    void auditOpenTabsAgainstRemoteSessions('connect').catch((error) => {
      console.error('[App] Failed to audit remote session truth on connect:', error);
    });
  }, [auditOpenTabsAgainstRemoteSessions, sessions]);

  // Cold-start audit when only sessionGroups exist
  useEffect(() => {
    if (initialRemoteSessionAuditDoneRef.current) {
      return;
    }
    if (openTabTabsLength > 0 || sessionsLength > 0) {
      return;
    }
    if (sessionGroups.length === 0) {
      return;
    }
    initialRemoteSessionAuditDoneRef.current = true;
    void auditOpenTabsAgainstRemoteSessions('connect').catch((error) => {
      console.error('[App] Failed to audit remote session truth on cold-start session-group restore:', error);
    });
  }, [auditOpenTabsAgainstRemoteSessions, openTabTabsLength, sessionGroups, sessionsLength]);

  return auditOpenTabsAgainstRemoteSessions;
}
