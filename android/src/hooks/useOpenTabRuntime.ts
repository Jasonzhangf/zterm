import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import {
  persistOpenTabsState,
  readPersistedActiveSessionId,
  readPersistedOpenTabsState,
  readPersistedClosedTabReuseKeys,
  persistClosedTabReuseKeys,
} from '../lib/open-tab-persistence';
import { resolveRemoteRestorableOpenTabState } from '../lib/open-tab-restore';
import {
  deriveCloseOpenTabIntent,
  normalizeOpenTabIntentState,
  openTabIntentStatesEqual,
} from '../lib/open-tab-intent';
import { createForegroundRefreshRuntime } from '../lib/app-foreground-refresh';
import { openConnectionsPage, openTerminalPage, type AppPageState } from '../lib/page-state';
import { runtimeDebug } from '../lib/runtime-debug';
import type { BridgeSettings } from '../lib/bridge-settings';
import type { Host, PersistedOpenTab, Session } from '../lib/types';
import { useOpenTabLifecycleEffects } from './useOpenTabLifecycleEffects';
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
  onForegroundActiveChange?: (active: boolean) => void;
}

export interface OpenTabRuntimeRefs {
  activeSessionIdRef: MutableRefObject<string | null>;
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
  persistAndSwitchExplicitOpenTabsRef: MutableRefObject<((tabs: PersistedOpenTab[], activeSessionId: string | null) => {
    tabs: PersistedOpenTab[];
    activeSessionId: string | null;
  }) | null>;
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
  persistOpenTabIntentState: (
    nextState: { tabs: PersistedOpenTab[]; activeSessionId: string | null },
    options?: { fallbackActiveSessionId?: string | null },
  ) => { tabs: PersistedOpenTab[]; activeSessionId: string | null };
  handleSwitchSession: (sessionId: string) => void;
  handleMoveSession: (sessionId: string, toIndex: number) => void;
  handleRenameSession: (sessionId: string, name: string) => void;
  handleCloseSession: (sessionId: string, source?: string) => void;
  handleResumeSession: (sessionId: string) => void;
}

export function useOpenTabRuntime(options: UseOpenTabRuntimeOptions): OpenTabRuntimeResult {
  const {
    bridgeSettings,
    hosts,
    hostsLoaded,
    sessions,
    runtimeActiveSessionId,
    createSession,
    closeSession,
    switchSession,
    moveSession,
    renameSession,
    resumeActiveSessionTransport,
    clearSessionDraft,
    ensureTerminalPageVisible,
    setPageState,
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
  const [pendingTerminalActiveSwitch, setPendingTerminalActiveSwitch] = useState<{
    targetSessionId: string;
    sourceRuntimeActiveSessionId: string | null;
  } | null>(null);
  const pendingTerminalActiveSwitchRef = useRef<{
    targetSessionId: string;
    sourceRuntimeActiveSessionId: string | null;
  } | null>(null);
  const restoredTabsHandledRef = useRef(false);
  const foregroundRefreshRuntimeRef = useRef(createForegroundRefreshRuntime());
  const sessionsRef = useRef(sessions);
  const activeSessionIdRef = useRef<string | null>(runtimeActiveSessionId);
  const bridgeSettingsRef = useRef(bridgeSettings);
  const resumeActiveSessionTransportRef = useRef(resumeActiveSessionTransport);
  const hostsRef = useRef(hosts);
  const ensureTerminalPageVisibleRef = useRef<() => void>(() => undefined);
  const persistAndSwitchExplicitOpenTabsRef = useRef<((tabs: PersistedOpenTab[], activeSessionId: string | null) => {
    tabs: PersistedOpenTab[];
    activeSessionId: string | null;
  }) | null>(null);
  const renameSessionRef = useRef(renameSession);
  const remoteOpenTabAuditTokenRef = useRef(0);
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
    const pendingTargetSessionId = pendingTerminalActiveSwitch?.targetSessionId || '';
    const shouldPreferPendingTerminalTarget =
      !!pendingTargetSessionId
      && openTabState.activeSessionId === pendingTargetSessionId
      && runtimeSessionsById.has(pendingTargetSessionId)
      && runtimeActiveSessionId === pendingTerminalActiveSwitch?.sourceRuntimeActiveSessionId
      && runtimeActiveSessionId !== pendingTargetSessionId;
    return (shouldPreferPendingTerminalTarget
      ? runtimeSessionsById.get(pendingTargetSessionId)
      : null)
      || runtimeSessionsById.get(runtimeActiveSessionId || '')
      || runtimeSessionsById.get(openTabState.activeSessionId || '')
      || terminalSessions[0]
      || null;
  }, [openTabState.activeSessionId, pendingTerminalActiveSwitch, runtimeActiveSessionId, terminalSessions]);

  const terminalActiveSessionIdRef = useRef<string | null>(terminalActiveSession?.id || null);

  const persistExplicitOpenTabs = useCallback((tabs: PersistedOpenTab[], activeSessionId: string | null) => {
    const nextState = normalizeOpenTabIntentState(tabs, activeSessionId);
    if (!openTabIntentStatesEqual(openTabStateRef.current, nextState)) {
      setOpenTabState(nextState);
    }
    openTabStateRef.current = nextState;
    hasPersistedOpenTabsTruthRef.current = true;
    persistOpenTabsState(nextState.tabs, nextState.activeSessionId);
    return nextState;
  }, []);

  const persistOpenTabIntentState = useCallback((nextState: {
    tabs: PersistedOpenTab[];
    activeSessionId: string | null;
  }, persistOptions?: {
    fallbackActiveSessionId?: string | null;
  }) => {
    return persistExplicitOpenTabs(
      nextState.tabs,
      nextState.activeSessionId ?? persistOptions?.fallbackActiveSessionId ?? null,
    );
  }, [persistExplicitOpenTabs]);

  const beginPendingTerminalActiveSwitch = useCallback((targetSessionId: string | null, sourceRuntimeActiveSessionId: string | null) => {
    const normalizedTargetSessionId = typeof targetSessionId === 'string' ? targetSessionId.trim() : '';
    if (!normalizedTargetSessionId) {
      pendingTerminalActiveSwitchRef.current = null;
      setPendingTerminalActiveSwitch(null);
      return;
    }
    const nextPendingSwitch = {
      targetSessionId: normalizedTargetSessionId,
      sourceRuntimeActiveSessionId: typeof sourceRuntimeActiveSessionId === 'string' && sourceRuntimeActiveSessionId.trim()
        ? sourceRuntimeActiveSessionId.trim()
        : null,
    };
    const currentPendingSwitch = pendingTerminalActiveSwitchRef.current;
    if (
      currentPendingSwitch?.targetSessionId === nextPendingSwitch.targetSessionId
      && currentPendingSwitch?.sourceRuntimeActiveSessionId === nextPendingSwitch.sourceRuntimeActiveSessionId
    ) {
      return;
    }
    pendingTerminalActiveSwitchRef.current = nextPendingSwitch;
    setPendingTerminalActiveSwitch(nextPendingSwitch);
  }, []);

  const clearPendingTerminalActiveSwitch = useCallback(() => {
    if (!pendingTerminalActiveSwitchRef.current) {
      return;
    }
    pendingTerminalActiveSwitchRef.current = null;
    setPendingTerminalActiveSwitch(null);
  }, []);

  const requestRuntimeActiveSessionSwitch = useCallback((nextActiveSessionId: string | null) => {
    if (!nextActiveSessionId) {
      clearPendingTerminalActiveSwitch();
      return;
    }
    if (nextActiveSessionId !== activeSessionIdRef.current) {
      beginPendingTerminalActiveSwitch(nextActiveSessionId, activeSessionIdRef.current);
    } else {
      clearPendingTerminalActiveSwitch();
    }
    switchSession(nextActiveSessionId);
  }, [beginPendingTerminalActiveSwitch, clearPendingTerminalActiveSwitch, switchSession]);

  const persistAndSwitchExplicitOpenTabs = useCallback((tabs: PersistedOpenTab[], activeSessionId: string | null) => {
    const nextState = persistExplicitOpenTabs(tabs, activeSessionId);
    requestRuntimeActiveSessionSwitch(nextState.activeSessionId);
    return nextState;
  }, [persistExplicitOpenTabs, requestRuntimeActiveSessionSwitch]);

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
      runtimeActiveSessionId: closeOptions?.runtimeActiveSessionId ?? activeSessionIdRef.current,
      fallbackSessionIds: closeOptions?.fallbackSessionIds ?? runtimeSessions.map((session) => session.id),
      runtimeSessions,
    });
    if (closeResult.closedReuseKey) {
      closedOpenTabReuseKeysRef.current.add(closeResult.closedReuseKey);
      persistClosedTabReuseKeys(closedOpenTabReuseKeysRef.current);
    }
    const nextOpenTabState = closeResult.nextState;

    closedOpenTabSessionIdsRef.current.add(normalizedSessionId);
    persistOpenTabIntentState(nextOpenTabState);

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
  }, [clearSessionDraft, closeSession, persistOpenTabIntentState, setPageState]);

  const auditOpenTabsAgainstRemoteSessions = useCallback(async (reason: 'visibilitychange' | 'resume' | 'appStateChange') => {
    const currentTabs = openTabStateRef.current.tabs;
    if (currentTabs.length === 0) {
      return;
    }

    const auditToken = remoteOpenTabAuditTokenRef.current + 1;
    remoteOpenTabAuditTokenRef.current = auditToken;
    const remoteState = await resolveRemoteRestorableOpenTabState({
      tabs: currentTabs,
      activeSessionId: openTabStateRef.current.activeSessionId,
      bridgeSettings: bridgeSettingsRef.current,
    });
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
        runtimeActiveSessionId: activeSessionIdRef.current,
        fallbackSessionIds: runtimeSessions
          .filter((session) => session.id !== tab.sessionId)
          .map((session) => session.id),
        closeRuntimeSession: runtimeSessions.some((session) => session.id === tab.sessionId),
        clearDraft: true,
        source: `remote-session-audit:${reason}`,
      });
    }
  }, [applyClosedOpenTabIntent]);

  useEffect(() => {
    sessionsRef.current = sessions;
    activeSessionIdRef.current = runtimeActiveSessionId;
    bridgeSettingsRef.current = bridgeSettings;
    hostsRef.current = hosts;
    terminalActiveSessionIdRef.current = terminalActiveSession?.id || null;
    resumeActiveSessionTransportRef.current = resumeActiveSessionTransport;
  }, [
    bridgeSettings,
    hosts,
    resumeActiveSessionTransport,
    runtimeActiveSessionId,
    sessions,
    terminalActiveSession,
  ]);

  useEffect(() => {
    const pendingSwitch = pendingTerminalActiveSwitchRef.current;
    if (!pendingSwitch) {
      return;
    }
    const hasPendingTargetRuntimeSession = sessions.some((session) => session.id === pendingSwitch.targetSessionId);
    const pendingTargetStillRequested = openTabState.activeSessionId === pendingSwitch.targetSessionId;
    const runtimeActiveSettled =
      runtimeActiveSessionId === pendingSwitch.targetSessionId
      || runtimeActiveSessionId !== pendingSwitch.sourceRuntimeActiveSessionId;
    if (!hasPendingTargetRuntimeSession || !pendingTargetStillRequested || runtimeActiveSettled) {
      clearPendingTerminalActiveSwitch();
    }
  }, [clearPendingTerminalActiveSwitch, openTabState.activeSessionId, sessions, runtimeActiveSessionId]);

  useEffect(() => {
    ensureTerminalPageVisibleRef.current = ensureTerminalPageVisible;
  }, [ensureTerminalPageVisible]);

  useEffect(() => {
    persistAndSwitchExplicitOpenTabsRef.current = persistAndSwitchExplicitOpenTabs;
  }, [persistAndSwitchExplicitOpenTabs]);

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
    persistOpenTabIntentState,
    persistAndSwitchExplicitOpenTabs,
    requestRuntimeActiveSessionSwitch,
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
    activeSessionIdRef,
    resumeActiveSessionTransportRef,
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
    activeSessionIdRef,
    persistOpenTabIntentState,
    requestRuntimeActiveSessionSwitch,
    ensureTerminalPageVisible,
    moveSession,
    renameSession,
    applyClosedOpenTabIntent,
  });

  const runtimeRefs = useMemo<OpenTabRuntimeRefs>(() => ({
    activeSessionIdRef,
    sessionsRef,
    hostsRef,
    bridgeSettingsRef,
    openTabStateRef,
    closedOpenTabSessionIdsRef,
    closedOpenTabReuseKeysRef,
    terminalActiveSessionIdRef,
    ensureTerminalPageVisibleRef,
    persistAndSwitchExplicitOpenTabsRef,
    renameSessionRef,
  }), []);

  return {
    openTabState,
    terminalSessions,
    terminalActiveSession,
    sessionIds,
    followResetEpoch,
    runtimeRefs,
    persistOpenTabIntentState,
    handleSwitchSession,
    handleMoveSession,
    handleRenameSession,
    handleCloseSession,
    handleResumeSession,
  };
}
