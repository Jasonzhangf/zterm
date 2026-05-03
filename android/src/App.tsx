/**
 * App - 主应用入口
 * 只负责页面级切换与跨页 orchestration。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { TmuxSessionPickerSheet } from './components/tmux/TmuxSessionPickerSheet';
import { SessionProvider, SESSION_STATUS_EVENT, useSession } from './contexts/SessionContext';
import { useAppUpdate } from './hooks/useAppUpdate';
import { useBridgeSettingsStorage } from './hooks/useBridgeSettingsStorage';
import { useHostStorage } from './hooks/useHostStorage';
import { useQuickActionStorage } from './hooks/useQuickActionStorage';
import { useShortcutActionStorage } from './hooks/useShortcutActionStorage';
import { useShortcutFrequencyStorage } from './hooks/useShortcutFrequencyStorage';
import { useSessionDraftStorage } from './hooks/useSessionDraftStorage';
import { useSessionHistoryStorage } from './hooks/useSessionHistoryStorage';
import { upsertBridgeServer } from './lib/bridge-settings';
import { runtimeDebug } from './lib/runtime-debug';
import { updateBridgeSettingsTerminalWidthMode } from './lib/terminal-width-mode-manager';
import {
  buildPersistedOpenTabFromHostSession,
  findReusableOpenTabSession,
  persistActiveSessionId,
  persistOpenTabsState,
  readPersistedActiveSessionId,
  readPersistedOpenTabs,
  resolveHostForPersistedOpenTab,
} from './lib/open-tab-persistence';
import {
  activateOpenTabIntentSession,
  buildBootstrapOpenTabIntentStateFromSessions,
  closeOpenTabIntentSession,
  mergeRuntimeSessionsIntoOpenTabIntentState,
  moveOpenTabIntentSession,
  normalizeOpenTabIntentState,
  renameOpenTabIntentSession,
  resolveRequestedOpenTabFocusSessionId,
  resolveRuntimeActiveSessionIdForOpenTabs,
  upsertOpenTabIntentSession,
} from './lib/open-tab-intent';
import { dedupePersistedOpenTabs } from './lib/open-tab-persistence';
import {
  createForegroundRefreshRuntime,
  markForegroundRuntimeHidden,
  performForegroundRefresh,
} from './lib/app-foreground-refresh';
import { openConnectionPropertiesPage, openConnectionsPage, openSettingsPage, openTerminalPage, type AppPageState } from './lib/page-state';
import {
  buildCleanDraft,
  buildDraftFromTmuxSession,
  buildPreferredTarget,
  buildTransientHostFromDraft,
  normalizeBridgeTarget,
  sortHostsForPicker,
  type BridgeTarget,
} from './lib/session-picker';
import { STORAGE_KEYS, type Host, type PersistedOpenTab, type Session } from './lib/types';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { ConnectionPropertiesPage } from './pages/ConnectionPropertiesPage';
import { SettingsPage } from './pages/SettingsPage';
import { TerminalPage } from './pages/TerminalPage';

interface AppContentProps {
  bridgeSettings: ReturnType<typeof useBridgeSettingsStorage>['settings'];
  setBridgeSettings: ReturnType<typeof useBridgeSettingsStorage>['setSettings'];
  onForegroundActiveChange?: (active: boolean) => void;
}

type PickerMode = 'new-connection' | 'quick-tab' | 'edit-group' | null;

function buildSessionStructureSignature(
  sessions: Array<Pick<
    Session,
    'id' | 'hostId' | 'connectionName' | 'bridgeHost' | 'bridgePort' | 'sessionName' | 'authToken' | 'autoCommand' | 'customName' | 'createdAt' | 'title' | 'state'
  >>,
) {
  return JSON.stringify(sessions.map((session) => sessionShapeFromSession(session)));
}

function sessionShapeFromSession(session: Pick<
  Session,
  'id' | 'hostId' | 'connectionName' | 'bridgeHost' | 'bridgePort' | 'sessionName' | 'authToken' | 'autoCommand' | 'customName' | 'createdAt' | 'title' | 'state'
>) {
  return {
    id: session.id,
    hostId: session.hostId,
    connectionName: session.connectionName,
    bridgeHost: session.bridgeHost,
    bridgePort: session.bridgePort,
    sessionName: session.sessionName,
    authToken: session.authToken || '',
    autoCommand: session.autoCommand || '',
    customName: session.customName || '',
    createdAt: session.createdAt,
    title: session.title,
    state: session.state,
  };
}

function readPersistedPageState(): AppPageState {
  if (typeof window === 'undefined') {
    return openConnectionsPage();
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEYS.ACTIVE_PAGE);
    if (!raw) {
      return openConnectionsPage();
    }
    const parsed = JSON.parse(raw) as Partial<AppPageState> | null;
    if (!parsed || typeof parsed !== 'object') {
      return openConnectionsPage();
    }
    if (parsed.kind === 'terminal') {
      const persistedActiveSessionId = readPersistedActiveSessionId();
      return openTerminalPage(persistedActiveSessionId || undefined);
    }
    if (parsed.kind === 'settings') {
      return openSettingsPage();
    }
    if (parsed.kind === 'connection-properties') {
      return openConnectionPropertiesPage({
        hostId: typeof parsed.hostId === 'string' ? parsed.hostId : undefined,
        draft: parsed.draft && typeof parsed.draft === 'object' ? parsed.draft : undefined,
      });
    }
  } catch (error) {
    console.error('[App] Failed to restore page state:', error);
  }

  return openConnectionsPage();
}

export function AppContent({ bridgeSettings, setBridgeSettings, onForegroundActiveChange }: AppContentProps) {
  const {
    preferences: appUpdatePreferences,
    latestManifest,
    availableManifest,
    checking: updateChecking,
    installing: updateInstalling,
    lastError: updateError,
    setPreferences: setAppUpdatePreferences,
    checkForUpdates,
    dismissAvailableManifest,
    skipCurrentVersion,
    ignoreUntilManualCheck,
    resetIgnorePolicy,
    startUpdate,
  } = useAppUpdate();
  const {
    state,
    scheduleStates = {},
    getSessionDebugMetrics,
    createSession,
    closeSession,
    switchSession,
    moveSession,
    renameSession,
    reconnectSession,
    resumeActiveSessionTransport,
    sendInput,
    sendImagePaste,
    sendFileAttach,
    requestRemoteScreenshot,
    sendMessageRaw,
    onFileTransferMessage,
    resizeTerminal,
    setTerminalWidthMode,
    updateSessionViewport,
    requestScheduleList,
    upsertScheduleJob,
    deleteScheduleJob,
    toggleScheduleJob,
    runScheduleJobNow,
    getSessionBufferStore,
    getSessionHeadStore,
  } = useSession();
  void sendMessageRaw;
  void onFileTransferMessage;
  const { hosts, isLoaded: hostsLoaded, addHost, upsertHost, updateHost, deleteHost } = useHostStorage();
  const { quickActions, setQuickActions } = useQuickActionStorage();
  const { shortcutActions, setShortcutActions } = useShortcutActionStorage();
  const shortcutFrequencyStorage = useShortcutFrequencyStorage();
  const { drafts: sessionDrafts, setDraft: setSessionDraft, clearDraft: clearSessionDraft, pruneDrafts } = useSessionDraftStorage();
  const { sessionGroups, recordSessionOpen, recordSessionGroupOpen, setSessionGroupSelection, deleteSessionGroup } = useSessionHistoryStorage();
  const [pageState, setPageState] = useState<AppPageState>(() => readPersistedPageState());
  const [inputResetEpochBySession, setInputResetEpochBySession] = useState<Record<string, number>>({});
  const [pickerMode, setPickerMode] = useState<PickerMode>(null);
  const [pickerTarget, setPickerTarget] = useState<BridgeTarget | null>(null);
  const [pickerInitialSessions, setPickerInitialSessions] = useState<string[]>([]);
  const openTabStateRef = useRef(normalizeOpenTabIntentState(
    readPersistedOpenTabs(),
    readPersistedActiveSessionId(),
  ));
  const closedOpenTabSessionIdsRef = useRef(new Set<string>());
  const restoredRouteHandledRef = useRef(false);
  const restoredTabsHandledRef = useRef(false);
  const foregroundRefreshRuntimeRef = useRef(createForegroundRefreshRuntime());
  const sessionsRef = useRef(state.sessions);
  const activeSessionIdRef = useRef<string | null>(state.activeSessionId);
  const resumeActiveSessionTransportRef = useRef(resumeActiveSessionTransport);
  const reconnectSessionRef = useRef(reconnectSession);

  const activeSession = useMemo(
    () => state.sessions.find((session) => session.id === state.activeSessionId) || null,
    [state.activeSessionId, state.sessions],
  );
  const sessions = state.sessions;
  const sessionStructureSignature = useMemo(
    () => buildSessionStructureSignature(sessions),
    [sessions],
  );

  const persistExplicitOpenTabs = useCallback((tabs: PersistedOpenTab[], activeSessionId: string | null) => {
    const nextState = normalizeOpenTabIntentState(tabs, activeSessionId);
    openTabStateRef.current = nextState;
    persistOpenTabsState(nextState.tabs, nextState.activeSessionId);
    return nextState;
  }, []);

  useEffect(() => {
    sessionsRef.current = state.sessions;
    activeSessionIdRef.current = state.activeSessionId;
    resumeActiveSessionTransportRef.current = resumeActiveSessionTransport;
    reconnectSessionRef.current = reconnectSession;
  }, [reconnectSession, resumeActiveSessionTransport, state.activeSessionId, state.sessions]);

  const runtimeSessionStructure = useMemo(() => sessions.map((session) => ({
    id: session.id,
    hostId: session.hostId,
    connectionName: session.connectionName,
    bridgeHost: session.bridgeHost,
    bridgePort: session.bridgePort,
    sessionName: session.sessionName,
    authToken: session.authToken,
    autoCommand: session.autoCommand,
    customName: session.customName,
    createdAt: session.createdAt,
    title: session.title,
    state: session.state,
  })), [sessionStructureSignature]);

  useEffect(() => {
    if (!hostsLoaded) {
      return;
    }

    if (runtimeSessionStructure.length > 0) {
      const currentOpenTabState = openTabStateRef.current;
      const shouldBootstrapFromRuntime =
        !restoredTabsHandledRef.current
        && currentOpenTabState.tabs.length === 0;
      restoredTabsHandledRef.current = true;
      if (shouldBootstrapFromRuntime) {
        const bootstrapState = buildBootstrapOpenTabIntentStateFromSessions(runtimeSessionStructure, state.activeSessionId);
        persistExplicitOpenTabs(bootstrapState.tabs, bootstrapState.activeSessionId);
        return;
      }

      const runtimeMergedState = mergeRuntimeSessionsIntoOpenTabIntentState(
        currentOpenTabState,
        runtimeSessionStructure,
        closedOpenTabSessionIdsRef.current,
      );
      if (runtimeMergedState !== currentOpenTabState) {
        persistExplicitOpenTabs(runtimeMergedState.tabs, runtimeMergedState.activeSessionId);
        return;
      }

      const nextActiveSessionId = resolveRuntimeActiveSessionIdForOpenTabs(
        currentOpenTabState,
        runtimeSessionStructure,
        state.activeSessionId,
      );
      if (
        nextActiveSessionId
        && state.activeSessionId !== nextActiveSessionId
      ) {
        switchSession(nextActiveSessionId);
      }
      return;
    }

    restoredTabsHandledRef.current = true;
    const currentOpenTabState = openTabStateRef.current;
    const persistedTabs = currentOpenTabState.tabs;
    if (persistedTabs.length === 0) {
      persistExplicitOpenTabs([], null);
      return;
    }

    const persistedActiveSessionId = currentOpenTabState.activeSessionId;
    const nextActiveSessionId =
      (persistedActiveSessionId && persistedTabs.some((tab) => tab.sessionId === persistedActiveSessionId)
        ? persistedActiveSessionId
        : persistedTabs[0]?.sessionId) || null;
    let restoredActiveResolvedSessionId: string | null = null;
    for (const tab of persistedTabs) {
      const host: Host = resolveHostForPersistedOpenTab({
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
      if (tab.sessionId === nextActiveSessionId) {
        restoredActiveResolvedSessionId = restoredSessionId;
      }
    }
    if (restoredActiveResolvedSessionId || nextActiveSessionId) {
      switchSession(restoredActiveResolvedSessionId || nextActiveSessionId!);
    }
  }, [
    createSession,
    hosts,
    hostsLoaded,
    persistExplicitOpenTabs,
    runtimeSessionStructure,
    state.activeSessionId,
    switchSession,
  ]);

  useEffect(() => {
    if (restoredRouteHandledRef.current || sessions.length === 0) {
      return;
    }

    restoredRouteHandledRef.current = true;
    const persistedPage = readPersistedPageState();
    if (persistedPage.kind === 'terminal') {
      const restoredActiveSessionId = state.activeSessionId && sessions.some((session) => session.id === state.activeSessionId)
        ? state.activeSessionId
        : null;
      const targetSessionId =
        restoredActiveSessionId
        || activeSession?.id
        || sessions[0].id;
      if (targetSessionId && activeSession?.id !== targetSessionId) {
        switchSession(targetSessionId);
      }
      setPageState(openTerminalPage(targetSessionId));
      return;
    }
    setPageState(persistedPage);
  }, [activeSession, sessions, switchSession]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify(pageState));
    } catch (error) {
      console.error('[App] Failed to persist page state:', error);
    }
  }, [pageState]);

  useEffect(() => {
    pruneDrafts(sessions.map((session) => session.id));
  }, [pruneDrafts, sessions]);

  useEffect(() => {
    const notifyResume = (reason: 'visibilitychange' | 'resume' | 'appStateChange') => {
      performForegroundRefresh({
        reason,
        sessions: sessionsRef.current.map((session) => ({ id: session.id, state: session.state })),
        activeSessionId: activeSessionIdRef.current,
        resumeActiveSessionTransport: resumeActiveSessionTransportRef.current,
        reconnectSession: reconnectSessionRef.current,
        runtime: foregroundRefreshRuntimeRef.current,
        log: (entry) => {
          console.debug('[App] foreground resume actions ->', entry);
        },
      });
    };

    const markHidden = () => {
      onForegroundActiveChange?.(false);
      markForegroundRuntimeHidden(foregroundRefreshRuntimeRef.current, document.visibilityState);
    };

    const onVisibilityChange = () => {
      runtimeDebug('app.visibility.change', {
        visibilityState: document.visibilityState,
        wasHidden: foregroundRefreshRuntimeRef.current.wasHidden,
      });
      if (document.visibilityState === 'hidden') {
        markHidden();
        return;
      }

      if (document.visibilityState === 'visible' && foregroundRefreshRuntimeRef.current.wasHidden) {
        onForegroundActiveChange?.(true);
        foregroundRefreshRuntimeRef.current.wasHidden = false;
        notifyResume('visibilitychange');
      }
    };

    const onDocumentResume = () => {
      onForegroundActiveChange?.(true);
      foregroundRefreshRuntimeRef.current.wasHidden = false;
      runtimeDebug('app.document.resume', {});
      notifyResume('resume');
    };

    const appStateListenerHandle = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      runtimeDebug('app.capacitor.appStateChange', {
        isActive,
        wasHidden: foregroundRefreshRuntimeRef.current.wasHidden,
      });
      if (!isActive) {
        markHidden();
        return;
      }
      onForegroundActiveChange?.(true);
      foregroundRefreshRuntimeRef.current.wasHidden = false;
      notifyResume('appStateChange');
    });

    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('resume', onDocumentResume as EventListener);
    document.addEventListener('pause', markHidden as EventListener);

    return () => {
      void Promise.resolve(appStateListenerHandle)
        .then((listener) => listener?.remove?.())
        .catch((error) => {
          console.warn('[App] Failed to remove app state listener:', error);
        });
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('resume', onDocumentResume as EventListener);
      document.removeEventListener('pause', markHidden as EventListener);
    };
  }, [onForegroundActiveChange]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const onSessionStatus = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; type?: 'closed' | 'error'; message?: string }>).detail;
      const sessionId = typeof detail?.sessionId === 'string' ? detail.sessionId.trim() : '';
      if (!sessionId || detail?.type !== 'closed') {
        return;
      }
      closedOpenTabSessionIdsRef.current.add(sessionId);
      const nextOpenTabState = closeOpenTabIntentSession(openTabStateRef.current, sessionId, {
        runtimeActiveSessionId: state.activeSessionId,
        fallbackSessionIds: state.sessions.map((session) => session.id),
        runtimeSessions: state.sessions,
      });
      persistExplicitOpenTabs(nextOpenTabState.tabs, nextOpenTabState.activeSessionId);
    };

    window.addEventListener(SESSION_STATUS_EVENT, onSessionStatus as EventListener);
    return () => {
      window.removeEventListener(SESSION_STATUS_EVENT, onSessionStatus as EventListener);
    };
  }, [persistExplicitOpenTabs]);

  const sortedHosts = useMemo(() => sortHostsForPicker(hosts, pickerTarget), [hosts, pickerTarget]);

  const editingHost = useMemo(() => {
    if (pageState.kind !== 'connection-properties' || !pageState.hostId) {
      return undefined;
    }
    return hosts.find((host) => host.id === pageState.hostId);
  }, [hosts, pageState]);

  const editingDraft = useMemo(() => {
    if (pageState.kind !== 'connection-properties') {
      return undefined;
    }
    return pageState.draft;
  }, [pageState]);

  const rememberBridgeTarget = useCallback((target: BridgeTarget, name?: string) => {
    setBridgeSettings((current) =>
      upsertBridgeServer(current, {
        name: name || target.bridgeHost,
        targetHost: target.bridgeHost,
        targetPort: target.bridgePort,
        authToken: target.authToken,
      }),
    );
  }, [setBridgeSettings]);

  const rememberConnectionHost = useCallback((host: Omit<Host, 'id' | 'createdAt'>) => {
    return upsertHost({
      ...host,
      lastConnected: Date.now(),
    });
  }, [upsertHost]);

  const openDraftAsSession = useCallback((
    draft: Omit<Host, 'id' | 'createdAt'>,
    options?: { rememberName?: string; activate?: boolean; navigate?: boolean; sessionId?: string },
  ) => {
    rememberBridgeTarget(normalizeBridgeTarget(draft), options?.rememberName || draft.name || draft.bridgeHost);
    const persistedHost = rememberConnectionHost(buildTransientHostFromDraft(draft));
    const existingSession = findReusableOpenTabSession({
      sessions: state.sessions,
      host: persistedHost,
      activeSessionId: state.activeSessionId,
    });
    const shouldActivate = options?.activate !== false;

    if (existingSession) {
      closedOpenTabSessionIdsRef.current.delete(existingSession.id);
      const nextOpenTabState = upsertOpenTabIntentSession(
        openTabStateRef.current,
        buildPersistedOpenTabFromHostSession({
          sessionId: existingSession.id,
          host: persistedHost,
          customName: existingSession.customName,
          createdAt: existingSession.createdAt,
        }),
        {
          activate: shouldActivate,
          fallbackActiveSessionId: state.activeSessionId,
        },
      );
      if (shouldActivate) {
        switchSession(existingSession.id);
      }
      persistExplicitOpenTabs(nextOpenTabState.tabs, nextOpenTabState.activeSessionId);
      recordSessionOpen({
        connectionName: persistedHost.name,
        bridgeHost: persistedHost.bridgeHost,
        bridgePort: persistedHost.bridgePort,
        sessionName: persistedHost.sessionName,
        authToken: persistedHost.authToken,
      });
      if (options?.navigate !== false) {
        setPageState(openTerminalPage(existingSession.id));
      }
      return { sessionId: existingSession.id, host: persistedHost };
    }

    const sessionId = createSession(persistedHost, {
      activate: shouldActivate,
      ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
    });
    closedOpenTabSessionIdsRef.current.delete(sessionId);
    const openedTab: PersistedOpenTab = {
      sessionId,
      hostId: persistedHost.id,
      connectionName: persistedHost.name,
      bridgeHost: persistedHost.bridgeHost,
      bridgePort: persistedHost.bridgePort,
      sessionName: persistedHost.sessionName,
      authToken: persistedHost.authToken,
      autoCommand: persistedHost.autoCommand,
      createdAt: Date.now(),
    };
    const nextOpenTabState = upsertOpenTabIntentSession(
      openTabStateRef.current,
      openedTab,
      {
        activate: shouldActivate,
        fallbackActiveSessionId: state.activeSessionId,
      },
    );
    persistExplicitOpenTabs(nextOpenTabState.tabs, nextOpenTabState.activeSessionId);
    recordSessionOpen({
      connectionName: persistedHost.name,
      bridgeHost: persistedHost.bridgeHost,
      bridgePort: persistedHost.bridgePort,
      sessionName: persistedHost.sessionName,
      authToken: persistedHost.authToken,
    });
    if (options?.navigate !== false) {
      setPageState(openTerminalPage(sessionId));
    }
    return { sessionId, host: persistedHost };
  }, [
    createSession,
    persistExplicitOpenTabs,
    recordSessionOpen,
    rememberBridgeTarget,
    rememberConnectionHost,
    sessions,
    state.activeSessionId,
    switchSession,
  ]);

  const openSessionPicker = useCallback((mode: Exclude<PickerMode, null>, options?: {
    target?: BridgeTarget | null;
    initialSelectedSessions?: string[];
  }) => {
    setPickerMode(mode);
    setPickerInitialSessions(options?.initialSelectedSessions || []);
    setPickerTarget(
      options?.target || buildPreferredTarget(
        bridgeSettings.servers,
        {
          bridgeHost: bridgeSettings.targetHost,
          bridgePort: bridgeSettings.targetPort,
          authToken: bridgeSettings.targetAuthToken,
        },
        mode === 'quick-tab' ? activeSession : null,
      ),
    );
  }, [activeSession, bridgeSettings]);

  const handleQuickConnectDraft = useCallback((draft: Omit<Host, 'id' | 'createdAt'>, rememberName?: string) => {
    return openDraftAsSession(draft, { rememberName, activate: true, navigate: true }).sessionId;
  }, [openDraftAsSession]);

  const handleOpenMultipleTmuxSessions = useCallback((target: BridgeTarget, sessionNames: string[]) => {
    if (sessionNames.length === 0) {
      return;
    }
    let focusSessionId: string | null = null;
    sessionNames.forEach((sessionName, index) => {
      const draft = buildDraftFromTmuxSession(hosts, bridgeSettings.servers, target, sessionName);
      const sessionId = openDraftAsSession(draft, {
        rememberName: target.bridgeHost,
        activate: index === 0,
        navigate: false,
      }).sessionId;
      if (!focusSessionId) {
        focusSessionId = sessionId;
      }
    });
    recordSessionGroupOpen({
      name: `${target.bridgeHost} · ${sessionNames.length} tabs`,
      bridgeHost: target.bridgeHost,
      bridgePort: target.bridgePort,
      authToken: target.authToken,
      sessionNames,
    });
    setPickerMode(null);
    setPageState(openTerminalPage(focusSessionId || undefined));
  }, [bridgeSettings.servers, hosts, openDraftAsSession, recordSessionGroupOpen]);

  const handleOpenSingleTmuxSession = useCallback((target: BridgeTarget, sessionName: string) => {
    const draft = buildDraftFromTmuxSession(hosts, bridgeSettings.servers, target, sessionName);
    setPickerMode(null);
    handleQuickConnectDraft(draft, target.bridgeHost);
  }, [bridgeSettings.servers, handleQuickConnectDraft, hosts]);

  const handleSwitchSession = useCallback((sessionId: string) => {
    const nextOpenTabState = activateOpenTabIntentSession(openTabStateRef.current, sessionId);
    openTabStateRef.current = nextOpenTabState;
    persistActiveSessionId(nextOpenTabState.activeSessionId);
    switchSession(sessionId);
  }, [switchSession]);

  const handleMoveSession = useCallback((sessionId: string, toIndex: number) => {
    const nextOpenTabState = moveOpenTabIntentSession(openTabStateRef.current, sessionId, toIndex);
    persistExplicitOpenTabs(nextOpenTabState.tabs, nextOpenTabState.activeSessionId || state.activeSessionId);
    moveSession(sessionId, toIndex);
  }, [moveSession, persistExplicitOpenTabs, state.activeSessionId]);

  const handleRenameSession = useCallback((sessionId: string, name: string) => {
    const nextOpenTabState = renameOpenTabIntentSession(openTabStateRef.current, sessionId, name);
    persistExplicitOpenTabs(nextOpenTabState.tabs, nextOpenTabState.activeSessionId || state.activeSessionId);
    renameSession(sessionId, name);
  }, [persistExplicitOpenTabs, renameSession, state.activeSessionId]);

  const handleCloseSession = useCallback((sessionId: string, source = 'unknown') => {
    const nextSessions = sessions.filter((session) => session.id !== sessionId);
    const nextOpenTabState = closeOpenTabIntentSession(openTabStateRef.current, sessionId, {
      runtimeActiveSessionId: state.activeSessionId,
      fallbackSessionIds: nextSessions.map((session) => session.id),
      runtimeSessions: sessions,
    });
    runtimeDebug('app.session.close.request', {
      sessionId,
      source,
      activeSessionId: state.activeSessionId,
      sessions: sessions.map((session) => ({ id: session.id, state: session.state, title: session.title })),
    });
    console.warn('[App] close session request', {
      sessionId,
      source,
      activeSessionId: state.activeSessionId,
      sessionCount: sessions.length,
    });

    closedOpenTabSessionIdsRef.current.add(sessionId);
    persistExplicitOpenTabs(nextOpenTabState.tabs, nextOpenTabState.activeSessionId);
    clearSessionDraft(sessionId);
    closeSession(sessionId);
    if (sessions.length === 1) {
      setPageState(openConnectionsPage());
    }
  }, [clearSessionDraft, closeSession, persistExplicitOpenTabs, sessions, state.activeSessionId]);

  const handleResumeSession = useCallback((sessionId: string) => {
    handleSwitchSession(sessionId);
    setPageState(openTerminalPage(sessionId));
  }, [handleSwitchSession]);

  const handleOpenGroupSession = useCallback((group: { bridgeHost: string; bridgePort: number; authToken?: string }, sessionName: string) => {
    handleQuickConnectDraft(
      {
        name: `${group.bridgeHost} · ${sessionName}`,
        bridgeHost: group.bridgeHost,
        bridgePort: group.bridgePort,
        sessionName,
        authToken: group.authToken || '',
        authType: 'password',
        password: undefined,
        privateKey: undefined,
        autoCommand: '',
        tags: ['tmux', sessionName],
        pinned: false,
        lastConnected: Date.now(),
      },
      group.bridgeHost,
    );
  }, [handleQuickConnectDraft]);

  const handleEditServerGroup = useCallback((group: {
    bridgeHost: string;
    bridgePort: number;
    authToken?: string;
  }, sessionNames: string[]) => {
    openSessionPicker('edit-group', {
      target: {
        bridgeHost: group.bridgeHost,
        bridgePort: group.bridgePort,
        authToken: group.authToken,
      },
      initialSelectedSessions: sessionNames,
    });
  }, [openSessionPicker]);

  const handleSaveServerGroupSelection = useCallback((group: {
    bridgeHost: string;
    bridgePort: number;
    authToken?: string;
  }, sessionNames: string[]) => {
    setSessionGroupSelection({
      name: `${group.bridgeHost} · ${sessionNames.length} tabs`,
      bridgeHost: group.bridgeHost,
      bridgePort: group.bridgePort,
      authToken: group.authToken,
      sessionNames,
    });
  }, [setSessionGroupSelection]);

  const handleDeleteServerGroup = useCallback((group: {
    bridgeHost: string;
    bridgePort: number;
  }) => {
    deleteSessionGroup(group);
  }, [deleteSessionGroup]);

  const handleOpenServerGroups = useCallback((groups: Array<{
    name: string;
    bridgeHost: string;
    bridgePort: number;
    authToken?: string;
    sessionNames: string[];
  }>) => {
    let focusSessionId: string | null = null;

    groups.forEach((group) => {
      const uniqueSessionNames = [...new Set(group.sessionNames.filter((item) => item.trim().length > 0))];
      if (uniqueSessionNames.length === 0) {
        return;
      }

      uniqueSessionNames.forEach((sessionName, index) => {
        const draft = buildDraftFromTmuxSession(
          hosts,
          bridgeSettings.servers,
          {
            bridgeHost: group.bridgeHost,
            bridgePort: group.bridgePort,
            authToken: group.authToken,
          },
          sessionName,
        );
        const sessionId = openDraftAsSession(draft, {
          rememberName: group.bridgeHost,
          activate: !focusSessionId && index === 0,
          navigate: false,
        }).sessionId;
        if (!focusSessionId) {
          focusSessionId = sessionId;
        }
      });

      recordSessionGroupOpen({
        name: group.name,
        bridgeHost: group.bridgeHost,
        bridgePort: group.bridgePort,
        authToken: group.authToken,
        sessionNames: uniqueSessionNames,
      });
    });

    if (focusSessionId) {
      setPageState(openTerminalPage(focusSessionId));
    }
  }, [bridgeSettings.servers, hosts, openDraftAsSession, recordSessionGroupOpen]);

  const handleLoadSavedTabList = useCallback((tabs: PersistedOpenTab[], requestedActiveSessionId?: string) => {
    const dedupedTabs = dedupePersistedOpenTabs(tabs);
    const openedTabs: PersistedOpenTab[] = [];

    dedupedTabs.forEach((tab) => {
      const host: Host = resolveHostForPersistedOpenTab({
        tab,
        hosts,
        fallbackIdPrefix: 'saved',
        fallbackLastConnected: Date.now(),
      });

      const opened = openDraftAsSession(host, {
        rememberName: host.name,
        activate: false,
        navigate: false,
        sessionId: tab.sessionId,
      });

      openedTabs.push(buildPersistedOpenTabFromHostSession({
        sessionId: opened.sessionId,
        host: opened.host,
        customName: tab.customName,
        createdAt: tab.createdAt,
      }));

      if (tab.customName?.trim()) {
        renameSession(opened.sessionId, tab.customName.trim());
      }
    });

    const requestedImportedFocusSessionId = resolveRequestedOpenTabFocusSessionId(dedupedTabs, requestedActiveSessionId);
    const focusSessionId =
      requestedImportedFocusSessionId
        ? (openedTabs.find((tab) => tab.sessionId === requestedImportedFocusSessionId)?.sessionId || openedTabs[0]?.sessionId || null)
        : null;

    if (focusSessionId) {
      persistExplicitOpenTabs(openedTabs, focusSessionId);
      switchSession(focusSessionId);
      setPageState(openTerminalPage(focusSessionId));
    }
  }, [hosts, openDraftAsSession, persistExplicitOpenTabs, renameSession, switchSession]);

  const handleResize = useCallback((sessionId: string, cols: number, rows: number) => {
    console.log('[App] Terminal resize:', sessionId, cols, rows);
    resizeTerminal(sessionId, cols, rows);
  }, [resizeTerminal]);

  const handleAddNew = useCallback(() => {
    openSessionPicker('new-connection');
  }, [openSessionPicker]);

  const handleEdit = useCallback((host: Host) => {
    setPageState(openConnectionPropertiesPage({ hostId: host.id }));
  }, []);

  const handleSaveHost = useCallback((hostData: Omit<Host, 'id' | 'createdAt'>) => {
    if (editingHost) {
      updateHost(editingHost.id, hostData);
    } else {
      addHost(hostData);
    }
    rememberBridgeTarget(normalizeBridgeTarget(hostData), hostData.name);
    setPageState(openConnectionsPage());
  }, [editingHost, addHost, updateHost, rememberBridgeTarget]);

  const handleCancelHostForm = useCallback(() => {
    setPageState(openConnectionsPage());
  }, []);

  const handleDelete = useCallback((host: Host) => {
    deleteHost(host.id);
  }, [deleteHost]);

  const bumpInputResetEpoch = useCallback((sessionId: string) => {
    const targetSessionId = sessionId.trim();
    if (!targetSessionId) {
      return;
    }
    setInputResetEpochBySession((current) => ({
      ...current,
      [targetSessionId]: (current[targetSessionId] || 0) + 1,
    }));
  }, []);

  const handleTerminalInput = useCallback((sessionId: string, data: string) => {
    bumpInputResetEpoch(sessionId);
    sendInput(sessionId, data);
  }, [bumpInputResetEpoch, sendInput]);

  const handleSendSessionDraft = useCallback((sessionId: string, value: string) => {
    if (!value) {
      return;
    }
    const normalized = value.replace(/\r?\n/g, '\r');
    const payload = /[\r\n]$/.test(normalized) ? normalized : `${normalized}\r`;
    if (activeSession?.id !== sessionId) {
      handleSwitchSession(sessionId);
    }
    handleTerminalInput(sessionId, payload);
    clearSessionDraft(sessionId);
  }, [activeSession?.id, clearSessionDraft, handleSwitchSession, handleTerminalInput]);

  const handleSelectCleanSession = useCallback((target: BridgeTarget) => {
    rememberBridgeTarget(target, target.bridgeHost);
    const draft = buildCleanDraft(target);
    setPickerMode(null);
    if (pickerMode === 'quick-tab') {
      handleQuickConnectDraft(draft, target.bridgeHost);
      return;
    }
    if (pickerMode === 'edit-group') {
      setPickerMode('edit-group');
      setPickerTarget(target);
      setPickerInitialSessions([]);
      return;
    }
    setPageState(openConnectionPropertiesPage({ draft }));
  }, [handleQuickConnectDraft, pickerMode, rememberBridgeTarget]);

  return (
    <div
      style={{
        height: '100dvh',
        width: '100vw',
        backgroundColor: '#edf2f6',
        display: 'flex',
        justifyContent: 'center',
        overflow: 'hidden',
        overscrollBehavior: 'none',
      }}
    >
      <div style={{ width: '100%', height: '100dvh', overflow: 'hidden' }}>
        {pageState.kind === 'connections' && (
          <ConnectionsPage
            hosts={sortedHosts}
            sessions={sessions}
            sessionGroups={sessionGroups}
            onResumeSession={handleResumeSession}
            onOpenGroupSession={handleOpenGroupSession}
            onOpenServerGroups={handleOpenServerGroups}
            onEditServerGroup={handleEditServerGroup}
            onSaveServerGroupSelection={handleSaveServerGroupSelection}
            onDeleteServerGroup={handleDeleteServerGroup}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onAddNew={handleAddNew}
            onOpenSettings={() => setPageState(openSettingsPage())}
          />
        )}

        {pageState.kind === 'connection-properties' && (
          <ConnectionPropertiesPage
            host={editingHost}
            draft={editingDraft}
            bridgeSettings={bridgeSettings}
            onSave={handleSaveHost}
            onCancel={handleCancelHostForm}
          />
        )}

        {pageState.kind === 'settings' && (
          <SettingsPage
            settings={bridgeSettings}
            updatePreferences={appUpdatePreferences}
            latestManifest={latestManifest}
            updateChecking={updateChecking}
            updateInstalling={updateInstalling}
            updateError={updateError}
            onSave={(next) => {
              setBridgeSettings((current) => ({
                ...next,
                terminalWidthMode: updateBridgeSettingsTerminalWidthMode(current, next.terminalWidthMode).terminalWidthMode,
              }));
              setPageState(openConnectionsPage());
            }}
            onUpdatePreferencesChange={setAppUpdatePreferences}
            onCheckForUpdate={(nextPreferences) => {
              setAppUpdatePreferences(nextPreferences);
              void checkForUpdates({ manual: true, manifestUrlOverride: nextPreferences.manifestUrl });
            }}
            onInstallUpdate={() => {
              void startUpdate();
            }}
            onResetUpdateIgnorePolicy={resetIgnorePolicy}
            onTerminalThemeChange={(themeId) => {
              setBridgeSettings((current) => ({
                ...current,
                terminalThemeId: themeId,
              }));
            }}
            onBack={() => setPageState(openConnectionsPage())}
          />
        )}

        {pageState.kind === 'terminal' && (
          <TerminalPage
            sessions={sessions}
            activeSession={activeSession}
            getSessionDebugMetrics={getSessionDebugMetrics}
            sessionBufferStore={getSessionBufferStore()}
            sessionHeadStore={getSessionHeadStore()}
            onSwitchSession={handleSwitchSession}
            onMoveSession={handleMoveSession}
            onRenameSession={handleRenameSession}
            onCloseSession={handleCloseSession}
            onOpenConnections={() => setPageState(openConnectionsPage())}
            onOpenQuickTabPicker={() => openSessionPicker('quick-tab')}
            onResize={handleResize}
            onTerminalInput={handleTerminalInput}
            inputResetEpochBySession={inputResetEpochBySession}
            onTerminalVisibleRangeChange={(sessionId, viewState) => {
              updateSessionViewport(sessionId, viewState);
            }}
            onImagePaste={sendImagePaste}
            onFileAttach={sendFileAttach}
            onOpenSettings={() => setPageState(openSettingsPage())}
            onRequestRemoteScreenshot={requestRemoteScreenshot}
            quickActions={quickActions}
            shortcutActions={shortcutActions}
            onQuickActionInput={(sequence, sessionId) => {
              const targetSessionId = sessionId || activeSession?.id;
              if (!targetSessionId) {
                return;
              }
              handleTerminalInput(targetSessionId, sequence);
            }}
            onQuickActionsChange={setQuickActions}
            onShortcutActionsChange={setShortcutActions}
            sessionDraft={activeSession ? (sessionDrafts[activeSession.id] || '') : ''}
            sessionDrafts={sessionDrafts}
            onSessionDraftChange={(value, sessionId) => {
              const targetSessionId = sessionId || activeSession?.id;
              if (!targetSessionId) {
                return;
              }
              setSessionDraft(targetSessionId, value);
            }}
            onSessionDraftSend={(value, sessionId) => {
              const targetSessionId = sessionId || activeSession?.id;
              if (!targetSessionId) {
                return;
              }
              handleSendSessionDraft(targetSessionId, value);
            }}
            onLoadSavedTabList={handleLoadSavedTabList}
            scheduleState={activeSession ? scheduleStates[activeSession.id] || null : null}
            scheduleStateBySessionId={scheduleStates}
            onRequestScheduleList={requestScheduleList}
            onUpsertScheduleJob={upsertScheduleJob}
            onDeleteScheduleJob={deleteScheduleJob}
            onToggleScheduleJob={toggleScheduleJob}
            onRunScheduleJobNow={runScheduleJobNow}
            terminalThemeId={bridgeSettings.terminalThemeId}
            terminalWidthMode={bridgeSettings.terminalWidthMode}
            onTerminalWidthModeChange={setTerminalWidthMode}
            onSendMessage={sendMessageRaw}
            onFileTransferMessage={onFileTransferMessage}
            shortcutSmartSort={bridgeSettings.shortcutSmartSort}
            shortcutFrequencyMap={bridgeSettings.shortcutSmartSort ? shortcutFrequencyStorage.getFrequencyMap() : undefined}
            onShortcutUse={bridgeSettings.shortcutSmartSort ? shortcutFrequencyStorage.recordShortcutUse : undefined}
          />
        )}
      </div>

      <TmuxSessionPickerSheet
        mode={pickerMode === 'quick-tab' ? 'quick-tab' : pickerMode === 'edit-group' ? 'edit-group' : 'new-connection'}
        open={pickerMode !== null}
        servers={bridgeSettings.servers}
        bridgeSettings={bridgeSettings}
        initialTarget={pickerTarget}
        initialSelectedSessions={pickerInitialSessions}
        onClose={() => setPickerMode(null)}
        onOpenTmuxSession={handleOpenSingleTmuxSession}
        onOpenMultipleTmuxSessions={handleOpenMultipleTmuxSessions}
        onSelectCleanSession={handleSelectCleanSession}
        onSaveGroupSelection={(target, sessionNames) => {
          handleSaveServerGroupSelection(target, sessionNames);
          setPickerMode(null);
        }}
      />

      {availableManifest && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 300,
            backgroundColor: 'rgba(8, 12, 18, 0.48)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
          }}
        >
          <div
            style={{
              width: 'min(420px, calc(100vw - 24px))',
              borderRadius: '24px',
              backgroundColor: '#fff',
              color: '#111827',
              boxShadow: '0 24px 70px rgba(0,0,0,0.28)',
              padding: '22px',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
            }}
          >
            <div>
              <div style={{ fontSize: '22px', fontWeight: 800 }}>发现新版本</div>
              <div style={{ marginTop: '6px', fontSize: '14px', lineHeight: 1.6, color: '#5b6478' }}>
                当前版本与服务器版本不一致，可以下载并调起系统安装。
              </div>
            </div>

            <div
              style={{
                borderRadius: '18px',
                backgroundColor: '#f6f8fb',
                padding: '14px 16px',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
              }}
            >
              <div style={{ fontSize: '14px', fontWeight: 700 }}>Remote: {availableManifest.versionName}</div>
              <div style={{ fontSize: '13px', color: '#5b6478' }}>versionCode {availableManifest.versionCode}</div>
              {availableManifest.notes.map((item, index) => (
                <div key={`${item}-${index}`} style={{ fontSize: '13px', color: '#374151' }}>
                  - {item}
                </div>
              ))}
            </div>

            {updateError ? (
              <div style={{ fontSize: '13px', lineHeight: 1.5, color: '#dc2626' }}>
                {updateError}
              </div>
            ) : null}

            <div style={{ display: 'grid', gap: '10px' }}>
              <button
                onClick={() => {
                  void startUpdate(availableManifest);
                }}
                disabled={updateInstalling}
                style={{
                  minHeight: '46px',
                  borderRadius: '16px',
                  border: 'none',
                  backgroundColor: '#111827',
                  color: '#fff',
                  fontWeight: 800,
                  cursor: updateInstalling ? 'wait' : 'pointer',
                }}
              >
                {updateInstalling ? '准备安装…' : '立即升级'}
              </button>
              <button
                onClick={() => skipCurrentVersion(availableManifest)}
                style={{
                  minHeight: '42px',
                  borderRadius: '14px',
                  border: 'none',
                  backgroundColor: '#eef2f8',
                  color: '#111827',
                  fontWeight: 700,
                }}
              >
                跳过当前版本
              </button>
              <button
                onClick={ignoreUntilManualCheck}
                style={{
                  minHeight: '42px',
                  borderRadius: '14px',
                  border: 'none',
                  backgroundColor: '#eef2f8',
                  color: '#111827',
                  fontWeight: 700,
                }}
              >
                一直忽略，直到手动检查
              </button>
              <button
                onClick={dismissAvailableManifest}
                style={{
                  minHeight: '40px',
                  borderRadius: '14px',
                  border: '1px solid #d8dee8',
                  backgroundColor: '#fff',
                  color: '#5b6478',
                  fontWeight: 700,
                }}
              >
                先不处理
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const { settings: bridgeSettings, setSettings: setBridgeSettings } = useBridgeSettingsStorage();
  const [appForegroundActive, setAppForegroundActive] = useState(
    typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );

  return (
    <SessionProvider
      terminalCacheLines={bridgeSettings.terminalCacheLines}
      bridgeSettings={bridgeSettings}
      appForegroundActive={appForegroundActive}
    >
      <AppContent
        bridgeSettings={bridgeSettings}
        setBridgeSettings={setBridgeSettings}
        onForegroundActiveChange={setAppForegroundActive}
      />
    </SessionProvider>
  );
}
