import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import {
  persistOpenTabsState,
  readPersistedActiveSessionId,
  readPersistedOpenTabsState,
  readPersistedClosedTabReuseKeys,
  persistClosedTabReuseKeys,
} from '../lib/open-tab-persistence';
import { fetchRemoteTmuxSessionNamesByOwner, filterRestorableOpenTabsByRemoteSessionNames } from '../lib/open-tab-restore';
import {
  deriveCloseOpenTabIntent,
  normalizeOpenTabIntentState,
  openTabIntentStatesEqual,
} from '../lib/open-tab-intent';
import { createForegroundRefreshRuntime } from '../lib/app-foreground-refresh';
import { openConnectionsPage, openTerminalPage, type AppPageState } from '../lib/page-state';
import { runtimeDebug } from '../lib/runtime-debug';
import type { BridgeSettings } from '../lib/bridge-settings';
import type { Host, PersistedOpenTab, Session, SessionGroupHistory } from '../lib/types';
import { useOpenTabLifecycleEffects, type OpenTabAuditReason } from './useOpenTabLifecycleEffects';
import { useOpenTabRestoreRuntimeSync } from './useOpenTabRestoreRuntimeSync';
import { useOpenTabSessionActions } from './useOpenTabSessionActions';

function buildSessionStructureSignature(
  sessions: Array<Pick<
    Session,
    'id' | 'hostId' | 'connectionName' | 'bridgeHost' | 'bridgePort' | 'daemonHostId' | 'sessionName' | 'authToken' | 'autoCommand' | 'customName' | 'createdAt'
  >>,
) {
  return JSON.stringify(sessions.map((session) => ({
    id: session.id,
    hostId: session.hostId,
    connectionName: session.connectionName,
    bridgeHost: session.bridgeHost,
    bridgePort: session.bridgePort,
    daemonHostId: session.daemonHostId || '',
    sessionName: session.sessionName,
    authToken: session.authToken || '',
    autoCommand: session.autoCommand || '',
    customName: session.customName || '',
    createdAt: session.createdAt,
  })));
}

interface UseOpenTabRuntimeOptions {
  bridgeSettings: BridgeSettings;
  hosts: Host[];
  hostsLoaded: boolean;
  sessions: Session[];
  sessionGroups: SessionGroupHistory[];
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
  closeSession: (sessionId: string) => void;
  switchSession: (sessionId: string) => void;
  moveSession: (sessionId: string, toIndex: number) => void;
  renameSession: (sessionId: string, name: string) => void;
  resumeActiveSessionTransport: (sessionId: string) => boolean;
  clearSessionDraft: (sessionId: string) => void;
  ensureTerminalPageVisible: () => void;
  setPageState: Dispatch<SetStateAction<AppPageState>>;
  pruneSessionGroupSelectionToRemoteTruth: (target: { bridgeHost: string; bridgePort: number; daemonHostId?: string }, remoteSessionNames: string[]) => void;
  onForegroundActiveChange?: (active: boolean) => void;
}

export interface OpenTabRuntimeRefs {
  runtimeActiveSessionIdRef: MutableRefObject<string | null>;
  sessionsRef: MutableRefObject<Session[]>;
  hostsRef: MutableRefObject<Host[]>;
  bridgeSettingsRef: MutableRefObject<BridgeSettings>;
  openTabStateRef: MutableRefObject<{
    tabs: PersistedOpenTab[];
    activeSessionId: string | null;
  }>;
  closedOpenTabSessionIdsRef: MutableRefObject<Set<string>>;
  closedOpenTabReuseKeysRef: MutableRefObject<Set<string>>;
  terminalActiveSessionIdRef: MutableRefObject<string | null>;
  ensureTerminalPageVisibleRef: MutableRefObject<() => void>;
  renameSessionRef: MutableRefObject<(sessionId: string, name: string) => void>;
}

export interface OpenTabRuntimeResult {
  openTabState: {
    tabs: PersistedOpenTab[];
    activeSessionId: string | null;
  };
  terminalSessions: Session[];
  terminalActiveSession: Session | null;
  sessionIds: string[];
  followResetEpoch: number;
  runtimeRefs: OpenTabRuntimeRefs;
  applyOpenTabState: (
    nextState: { tabs: PersistedOpenTab[]; activeSessionId: string | null },
    options?: { fallbackActiveSessionId?: string | null; switchRuntime?: boolean; markExplicitTruth?: boolean },
  ) => { tabs: PersistedOpenTab[]; activeSessionId: string | null };
  handleSwitchSession: (sessionId: string) => void;
  handleMoveSession: (sessionId: string, toIndex: number) => void;
  handleRenameSession: (sessionId: string, name: string) => void;
  handleCloseSession: (sessionId: string, source?: string) => void;
  handleResumeSession: (sessionId: string) => void;
  auditOpenTabsAgainstRemoteSessions: (reason: OpenTabAuditReason) => Promise<void>;
}

export function useOpenTabRuntime(options: UseOpenTabRuntimeOptions): OpenTabRuntimeResult {
  const {
    bridgeSettings,
    hosts,
    hostsLoaded,
    sessions,
    sessionGroups,
    runtimeActiveSessionId,
    createSession,
    closeSession,
    switchSession,
    moveSession,
    renameSession,
    clearSessionDraft,
    ensureTerminalPageVisible,
    setPageState,
    pruneSessionGroupSelectionToRemoteTruth,
    onForegroundActiveChange,
  } = options;

  const persistedOpenTabsBootstrapRef = useRef(readPersistedOpenTabsState());
  const [openTabState, setOpenTabState] = useState(() => normalizeOpenTabIntentState(
    persistedOpenTabsBootstrapRef.current.tabs,
    readPersistedActiveSessionId(),
  ));
  const openTabStateRef = useRef(openTabState);
  const hasPersistedOpenTabsTruthRef = useRef(persistedOpenTabsBootstrapRef.current.hasStoredValue);
  const closedOpenTabSessionIdsRef = useRef(new Set<string>());
  const closedOpenTabReuseKeysRef = useRef(readPersistedClosedTabReuseKeys());
  const restoredTabsHandledRef = useRef(false);
  const foregroundRefreshRuntimeRef = useRef(createForegroundRefreshRuntime());
  const sessionsRef = useRef(sessions);
  const runtimeActiveSessionIdRef = useRef<string | null>(runtimeActiveSessionId);
  const bridgeSettingsRef = useRef(bridgeSettings);
  const hostsRef = useRef(hosts);
  const ensureTerminalPageVisibleRef = useRef<() => void>(() => undefined);
  const renameSessionRef = useRef(renameSession);
  const remoteOpenTabAuditTokenRef = useRef(0);
  const connectedSessionIdsRef = useRef<Set<string>>(new Set(
    sessions
      .filter((session) => session.state === 'connected')
      .map((session) => session.id),
  ));
  const [followResetEpoch, setFollowResetEpoch] = useState(0);

  const sessionStructureSignature = useMemo(
    () => buildSessionStructureSignature(sessions),
    [sessions],
  );
  const sessionIdsSignature = useMemo(
    () => sessions.map((session) => session.id).join('||'),
    [sessionStructureSignature],
  );
  const sessionIds = useMemo(
    () => sessions.map((session) => session.id),
    [sessionIdsSignature, sessions],
  );

  const terminalSessions = useMemo(() => {
    if (openTabState.tabs.length === 0) {
      return [] as Session[];
    }
    const runtimeSessionsById = new Map(sessions.map((session) => [session.id, session]));
    return openTabState.tabs
      .map((tab) => runtimeSessionsById.get(tab.sessionId) || null)
      .filter((session): session is Session => session !== null);
  }, [openTabState.tabs, sessions]);

  const terminalActiveSession = useMemo(() => {
    if (terminalSessions.length === 0) {
      return null;
    }
    const runtimeSessionsById = new Map(terminalSessions.map((session) => [session.id, session]));
    const explicitActiveSessionId = hasPersistedOpenTabsTruthRef.current
      ? openTabState.activeSessionId
      : null;
    return runtimeSessionsById.get(explicitActiveSessionId || '')
      || runtimeSessionsById.get(runtimeActiveSessionId || '')
      || runtimeSessionsById.get(openTabState.activeSessionId || '')
      || terminalSessions[0]
      || null;
  }, [openTabState.activeSessionId, runtimeActiveSessionId, terminalSessions]);

  const terminalActiveSessionIdRef = useRef<string | null>(terminalActiveSession?.id || null);

  const persistExplicitOpenTabs = useCallback((
    tabs: PersistedOpenTab[],
    activeSessionId: string | null,
    persistOptions?: { markExplicitTruth?: boolean },
  ) => {
    const nextState = normalizeOpenTabIntentState(tabs, activeSessionId);
    if (!openTabIntentStatesEqual(openTabStateRef.current, nextState)) {
      setOpenTabState(nextState);
    }
    openTabStateRef.current = nextState;
    if (persistOptions?.markExplicitTruth !== false) {
      hasPersistedOpenTabsTruthRef.current = true;
    }
    persistOpenTabsState(nextState.tabs, nextState.activeSessionId);
    return nextState;
  }, []);

  const requestRuntimeActiveSessionSwitch = useCallback((nextActiveSessionId: string | null) => {
    if (!nextActiveSessionId) {
      return;
    }
    if (nextActiveSessionId === runtimeActiveSessionIdRef.current) {
      return;
    }
    switchSession(nextActiveSessionId);
  }, [switchSession]);

  const persistAndSwitchExplicitOpenTabs = useCallback((tabs: PersistedOpenTab[], activeSessionId: string | null) => {
    const nextState = persistExplicitOpenTabs(tabs, activeSessionId);
    requestRuntimeActiveSessionSwitch(nextState.activeSessionId);
    return nextState;
  }, [persistExplicitOpenTabs, requestRuntimeActiveSessionSwitch]);

  const applyOpenTabState = useCallback((nextState: {
    tabs: PersistedOpenTab[];
    activeSessionId: string | null;
  }, persistOptions?: {
    fallbackActiveSessionId?: string | null;
    switchRuntime?: boolean;
    markExplicitTruth?: boolean;
  }) => {
    const normalizedActiveSessionId = nextState.activeSessionId ?? persistOptions?.fallbackActiveSessionId ?? null;
    if (persistOptions?.switchRuntime) {
      return persistAndSwitchExplicitOpenTabs(nextState.tabs, normalizedActiveSessionId);
    }
    return persistExplicitOpenTabs(nextState.tabs, normalizedActiveSessionId, {
      markExplicitTruth: persistOptions?.markExplicitTruth,
    });
  }, [persistAndSwitchExplicitOpenTabs, persistExplicitOpenTabs]);

  const applyClosedOpenTabIntent = useCallback((sessionId: string, closeOptions?: {
    runtimeActiveSessionId?: string | null;
    fallbackSessionIds?: string[];
    runtimeSessions?: Array<Pick<Session, 'id' | 'bridgeHost' | 'bridgePort' | 'daemonHostId' | 'sessionName' | 'authToken'>>;
    closeRuntimeSession?: boolean;
    clearDraft?: boolean;
    source?: string;
  }) => {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      return openTabStateRef.current;
    }

    const runtimeSessions = closeOptions?.runtimeSessions || sessionsRef.current;
    const closeResult = deriveCloseOpenTabIntent(openTabStateRef.current, normalizedSessionId, {
      runtimeActiveSessionId: closeOptions?.runtimeActiveSessionId ?? runtimeActiveSessionIdRef.current,
      fallbackSessionIds: closeOptions?.fallbackSessionIds ?? runtimeSessions.map((session) => session.id),
      runtimeSessions,
    });
    if (closeResult.closedReuseKeyVariants.length > 0) {
      closeResult.closedReuseKeyVariants.forEach((key) => {
        closedOpenTabReuseKeysRef.current.add(key);
      });
      persistClosedTabReuseKeys(closedOpenTabReuseKeysRef.current);
    }
    const nextOpenTabState = closeResult.nextState;

    closedOpenTabSessionIdsRef.current.add(normalizedSessionId);
    applyOpenTabState(nextOpenTabState);

    if (closeOptions?.clearDraft) {
      clearSessionDraft(normalizedSessionId);
    }
    if (closeOptions?.closeRuntimeSession) {
      closeSession(normalizedSessionId);
    }

    setPageState((current) => {
      if (current.kind !== 'terminal') {
        return current;
      }
      if (nextOpenTabState.tabs.length === 0) {
        return openConnectionsPage();
      }
      return openTerminalPage();
    });

    return nextOpenTabState;
  }, [applyOpenTabState, clearSessionDraft, closeSession, setPageState]);

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
  }, [applyClosedOpenTabIntent, pruneSessionGroupSelectionToRemoteTruth, sessionGroups]);

  useEffect(() => {
    sessionsRef.current = sessions;
    runtimeActiveSessionIdRef.current = runtimeActiveSessionId;
    bridgeSettingsRef.current = bridgeSettings;
    hostsRef.current = hosts;
    terminalActiveSessionIdRef.current = terminalActiveSession?.id || null;
  }, [
    bridgeSettings,
    hosts,
    openTabState.activeSessionId,
    runtimeActiveSessionId,
    sessions,
    terminalActiveSession,
  ]);

  useEffect(() => {
    const nextConnectedSessionIds = new Set(
      sessions
        .filter((session) => session.state === 'connected')
        .map((session) => session.id),
    );
    const hasNewConnectedSession = [...nextConnectedSessionIds].some((sessionId) => !connectedSessionIdsRef.current.has(sessionId));
    connectedSessionIdsRef.current = nextConnectedSessionIds;
    if (!hasNewConnectedSession) {
      return;
    }
    void auditOpenTabsAgainstRemoteSessions('connect').catch((error) => {
      console.error('[App] Failed to audit remote session truth on connect:', error);
    });
  }, [auditOpenTabsAgainstRemoteSessions, sessions]);

  const initialRemoteSessionAuditDoneRef = useRef(false);
  useEffect(() => {
    if (initialRemoteSessionAuditDoneRef.current) {
      return;
    }
    if (openTabState.tabs.length > 0 || sessions.length > 0) {
      return;
    }
    if (sessionGroups.length === 0) {
      return;
    }
    initialRemoteSessionAuditDoneRef.current = true;
    void auditOpenTabsAgainstRemoteSessions('connect').catch((error) => {
      console.error('[App] Failed to audit remote session truth on cold-start session-group restore:', error);
    });
  }, [auditOpenTabsAgainstRemoteSessions, openTabState.tabs.length, sessionGroups, sessions.length]);

  useEffect(() => {
    ensureTerminalPageVisibleRef.current = ensureTerminalPageVisible;
  }, [ensureTerminalPageVisible]);

  useEffect(() => {
    renameSessionRef.current = renameSession;
  }, [renameSession]);

  const runtimeSessionStructure = useMemo(() => sessions.map((session) => ({
    id: session.id,
    hostId: session.hostId,
    connectionName: session.connectionName,
    bridgeHost: session.bridgeHost,
    bridgePort: session.bridgePort,
    daemonHostId: session.daemonHostId,
    sessionName: session.sessionName,
    authToken: session.authToken,
    autoCommand: session.autoCommand,
    customName: session.customName,
    createdAt: session.createdAt,
  })), [sessionStructureSignature]);

  useOpenTabRestoreRuntimeSync({
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
    applyOpenTabState,
    createSession,
  });

  useEffect(() => {
    if (!openTabState.activeSessionId) {
      return;
    }
    ensureTerminalPageVisible();
  }, [ensureTerminalPageVisible, openTabState.activeSessionId]);

  const bumpFollowResetEpoch = useCallback(() => {
    setFollowResetEpoch((current) => current + 1);
  }, []);

  useOpenTabLifecycleEffects({
    sessionsRef,
    openTabStateRef,
    runtimeActiveSessionIdRef,
    foregroundRefreshRuntimeRef,
    onForegroundActiveChange,
    auditOpenTabsAgainstRemoteSessions,
    applyClosedOpenTabIntent,
    bumpFollowResetEpoch,
  });

  const {
    handleSwitchSession,
    handleMoveSession,
    handleRenameSession,
    handleCloseSession,
    handleResumeSession,
  } = useOpenTabSessionActions({
    openTabStateRef,
    sessionsRef,
    runtimeActiveSessionIdRef,
    applyOpenTabState,
    ensureTerminalPageVisible,
    moveSession,
    renameSession,
    applyClosedOpenTabIntent,
  });

  const runtimeRefs = useMemo<OpenTabRuntimeRefs>(() => ({
    runtimeActiveSessionIdRef,
    sessionsRef,
    hostsRef,
    bridgeSettingsRef,
    openTabStateRef,
    closedOpenTabSessionIdsRef,
    closedOpenTabReuseKeysRef,
    terminalActiveSessionIdRef,
    ensureTerminalPageVisibleRef,
    renameSessionRef,
  }), []);

  return {
    openTabState,
    terminalSessions,
    terminalActiveSession,
    sessionIds,
    followResetEpoch,
    runtimeRefs,
    applyOpenTabState,
    handleSwitchSession,
    handleMoveSession,
    handleRenameSession,
    handleCloseSession,
    handleResumeSession,
    auditOpenTabsAgainstRemoteSessions,
  };
}
