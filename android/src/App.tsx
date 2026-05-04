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
  buildPersistedOpenTabReuseKey,
  persistOpenTabsState,
  readPersistedActiveSessionId,
  readPersistedOpenTabsState,
  resolveHostForPersistedOpenTab,
} from './lib/open-tab-persistence';
import {
  activateOpenTabIntentSession,
  buildBootstrapOpenTabIntentStateFromSessions,
  closeOpenTabIntentSession,
  mergeRuntimeSessionsIntoOpenTabIntentState,
  moveOpenTabIntentSession,
  normalizeOpenTabIntentState,
  openTabIntentStatesEqual,
  renameOpenTabIntentSession,
  resolveRequestedOpenTabFocusSessionId,
  upsertOpenTabIntentSession,
} from './lib/open-tab-intent';
import { dedupePersistedOpenTabs } from './lib/open-tab-persistence';
import {
  createForegroundRefreshRuntime,
  markForegroundRuntimeHidden,
  performForegroundRefresh,
} from './lib/app-foreground-refresh';
import {
  openConnectionPropertiesPage,
  openConnectionsPage,
  openSettingsPage,
  openTerminalPage,
  resolvePersistedPageStateTruth,
  type AppPageState,
} from './lib/page-state';
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
    'id' | 'hostId' | 'connectionName' | 'bridgeHost' | 'bridgePort' | 'sessionName' | 'authToken' | 'autoCommand' | 'customName' | 'createdAt'
  >>,
) {
  return JSON.stringify(sessions.map((session) => sessionShapeFromSession(session)));
}

function sessionShapeFromSession(session: Pick<
  Session,
  'id' | 'hostId' | 'connectionName' | 'bridgeHost' | 'bridgePort' | 'sessionName' | 'authToken' | 'autoCommand' | 'customName' | 'createdAt'
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
    setLiveSessionIds,
    resumeActiveSessionTransport,
    sendInput,
    sendImagePaste,
    sendFileAttach,
    requestRemoteScreenshot,
    sendMessageRaw,
    onFileTransferMessage,
    updateSessionViewport,
    requestScheduleList,
    upsertScheduleJob,
    deleteScheduleJob,
    toggleScheduleJob,
    runScheduleJobNow,
    getSessionRenderBufferStore,
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
  const [followResetEpoch, setFollowResetEpoch] = useState(0);
  const [pickerMode, setPickerMode] = useState<PickerMode>(null);
  const [pickerTarget, setPickerTarget] = useState<BridgeTarget | null>(null);
  const [pickerInitialSessions, setPickerInitialSessions] = useState<string[]>([]);
  const persistedOpenTabsBootstrapRef = useRef(readPersistedOpenTabsState());
  const [openTabState, setOpenTabState] = useState(() => normalizeOpenTabIntentState(
    persistedOpenTabsBootstrapRef.current.tabs,
    readPersistedActiveSessionId(),
  ));
  const openTabStateRef = useRef(openTabState);
  const hasPersistedOpenTabsTruthRef = useRef(persistedOpenTabsBootstrapRef.current.hasStoredValue);
  const closedOpenTabSessionIdsRef = useRef(new Set<string>());
  const closedOpenTabReuseKeysRef = useRef(new Set<string>());
  const restoredRouteHandledRef = useRef(false);
  const restoredTabsHandledRef = useRef(false);
  const foregroundRefreshRuntimeRef = useRef(createForegroundRefreshRuntime());
  const sessionsRef = useRef(state.sessions);
  const activeSessionIdRef = useRef<string | null>(state.activeSessionId);
  const bridgeSettingsRef = useRef(bridgeSettings);
  const resumeActiveSessionTransportRef = useRef(resumeActiveSessionTransport);
  const hostsRef = useRef(hosts);
  const ensureTerminalPageFocusRef = useRef<(sessionId?: string | null) => void>(() => undefined);
  const openDraftAsSessionRef = useRef<((host: Host, options?: {
    rememberName?: string;
    activate?: boolean;
    navigate?: boolean;
    sessionId?: string;
  }) => { sessionId: string; host: Host }) | null>(null);
  const persistAndSwitchExplicitOpenTabsRef = useRef<((tabs: PersistedOpenTab[], activeSessionId: string | null) => {
    tabs: PersistedOpenTab[];
    activeSessionId: string | null;
  }) | null>(null);
  const renameSessionRef = useRef(renameSession);

  const activeSession = useMemo(
    () => state.sessions.find((session) => session.id === state.activeSessionId) || null,
    [state.activeSessionId, state.sessions],
  );
  const sessions = state.sessions;
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
    return runtimeSessionsById.get(state.activeSessionId || '')
      || runtimeSessionsById.get(openTabState.activeSessionId || '')
      || terminalSessions[0]
      || null;
  }, [openTabState.activeSessionId, state.activeSessionId, terminalSessions]);
  const terminalActiveSessionIdRef = useRef<string | null>(terminalActiveSession?.id || null);
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

  const persistAndSwitchExplicitOpenTabs = useCallback((tabs: PersistedOpenTab[], activeSessionId: string | null) => {
    const nextState = persistExplicitOpenTabs(tabs, activeSessionId);
    if (nextState.activeSessionId) {
      switchSession(nextState.activeSessionId);
    }
    return nextState;
  }, [persistExplicitOpenTabs, switchSession]);

  const ensureTerminalPageFocus = useCallback((sessionId?: string | null) => {
    const normalizedSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
      ? sessionId.trim()
      : undefined;
    setPageState((current) => (
      current.kind === 'terminal' && current.focusSessionId === normalizedSessionId
        ? current
        : openTerminalPage(normalizedSessionId)
    ));
  }, []);

  const applyClosedOpenTabIntent = useCallback((sessionId: string, options?: {
    runtimeActiveSessionId?: string | null;
    fallbackSessionIds?: string[];
    runtimeSessions?: Array<Pick<Session, 'id' | 'bridgeHost' | 'bridgePort' | 'sessionName' | 'authToken'>>;
    closeRuntimeSession?: boolean;
    clearDraft?: boolean;
    source?: string;
  }) => {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      return openTabStateRef.current;
    }

    const runtimeSessions = options?.runtimeSessions || sessionsRef.current;
    const targetRuntimeSession = runtimeSessions.find((session) => session.id === normalizedSessionId) || null;
    const targetTab = openTabStateRef.current.tabs.find((tab) => tab.sessionId === normalizedSessionId) || null;
    const closedReuseKeySource = targetTab || targetRuntimeSession;
    if (closedReuseKeySource) {
      closedOpenTabReuseKeysRef.current.add(buildPersistedOpenTabReuseKey({
        bridgeHost: closedReuseKeySource.bridgeHost,
        bridgePort: closedReuseKeySource.bridgePort,
        sessionName: closedReuseKeySource.sessionName,
        authToken: closedReuseKeySource.authToken,
      }));
    }
    const nextOpenTabState = closeOpenTabIntentSession(openTabStateRef.current, normalizedSessionId, {
      runtimeActiveSessionId: options?.runtimeActiveSessionId ?? activeSessionIdRef.current,
      fallbackSessionIds: options?.fallbackSessionIds ?? runtimeSessions.map((session) => session.id),
      runtimeSessions,
    });

    closedOpenTabSessionIdsRef.current.add(normalizedSessionId);
    persistExplicitOpenTabs(nextOpenTabState.tabs, nextOpenTabState.activeSessionId);

    if (options?.clearDraft) {
      clearSessionDraft(normalizedSessionId);
    }
    if (options?.closeRuntimeSession) {
      closeSession(normalizedSessionId);
    }

    setPageState((current) => {
      if (current.kind !== 'terminal') {
        return current;
      }
      if (nextOpenTabState.tabs.length === 0) {
        return openConnectionsPage();
      }
      return openTerminalPage(nextOpenTabState.activeSessionId || undefined);
    });

    return nextOpenTabState;
  }, [clearSessionDraft, closeSession, persistExplicitOpenTabs]);

  useEffect(() => {
    sessionsRef.current = state.sessions;
    activeSessionIdRef.current = state.activeSessionId;
    bridgeSettingsRef.current = bridgeSettings;
    hostsRef.current = hosts;
    terminalActiveSessionIdRef.current = terminalActiveSession?.id || null;
    resumeActiveSessionTransportRef.current = resumeActiveSessionTransport;
  }, [
    bridgeSettings,
    hosts,
    resumeActiveSessionTransport,
    state.activeSessionId,
    state.sessions,
    terminalActiveSession,
  ]);

  useEffect(() => {
    ensureTerminalPageFocusRef.current = ensureTerminalPageFocus;
  }, [ensureTerminalPageFocus]);

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
    sessionName: session.sessionName,
    authToken: session.authToken,
    autoCommand: session.autoCommand,
    customName: session.customName,
    createdAt: session.createdAt,
  })), [sessionStructureSignature]);

  useEffect(() => {
    if (!hostsLoaded) {
      return;
    }

    if (runtimeSessionStructure.length > 0) {
      const currentOpenTabState = openTabStateRef.current;
      const shouldBootstrapFromRuntime =
        !restoredTabsHandledRef.current
        && currentOpenTabState.tabs.length === 0
        && !hasPersistedOpenTabsTruthRef.current;
      restoredTabsHandledRef.current = true;
      if (shouldBootstrapFromRuntime) {
        runtimeDebug('app.open-tabs.bootstrap-from-runtime', {
          activeSessionId: state.activeSessionId,
          runtimeSessionIds: runtimeSessionStructure.map((session) => session.id),
        });
        const bootstrapState = buildBootstrapOpenTabIntentStateFromSessions(runtimeSessionStructure, state.activeSessionId);
        persistExplicitOpenTabs(bootstrapState.tabs, bootstrapState.activeSessionId);
        return;
      }

      if (currentOpenTabState.tabs.length === 0 && hasPersistedOpenTabsTruthRef.current) {
        return;
      }

      const runtimeMergedState = mergeRuntimeSessionsIntoOpenTabIntentState(
        currentOpenTabState,
        runtimeSessionStructure,
        closedOpenTabSessionIdsRef.current,
        closedOpenTabReuseKeysRef.current,
      );
      if (runtimeMergedState !== currentOpenTabState) {
        runtimeDebug('app.open-tabs.runtime-merge-rewrite', {
          beforeSessionIds: currentOpenTabState.tabs.map((tab) => tab.sessionId),
          afterSessionIds: runtimeMergedState.tabs.map((tab) => tab.sessionId),
          activeSessionId: runtimeMergedState.activeSessionId,
        });
        persistExplicitOpenTabs(runtimeMergedState.tabs, runtimeMergedState.activeSessionId);
        return;
      }

      const requestedActiveSessionId = currentOpenTabState.activeSessionId;
      const runtimeSessionIds = new Set(runtimeSessionStructure.map((session) => session.id));
      if (
        requestedActiveSessionId
        && runtimeSessionIds.has(requestedActiveSessionId)
        && state.activeSessionId !== requestedActiveSessionId
      ) {
        persistAndSwitchExplicitOpenTabs(currentOpenTabState.tabs, requestedActiveSessionId);
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
    const restoredSessionIdRemap = new Map<string, string>();
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
      const resolvedTabs = restoredSessionIdRemap.size > 0
        ? persistedTabs.map((tab) => {
          const remappedSessionId = restoredSessionIdRemap.get(tab.sessionId);
          return remappedSessionId
            ? { ...tab, sessionId: remappedSessionId }
            : tab;
        })
        : persistedTabs;
      const restoredActiveSessionId = nextActiveSessionId
        ? (restoredSessionIdRemap.get(nextActiveSessionId) || nextActiveSessionId)
        : null;
      if (restoredSessionIdRemap.size > 0) {
        if (restoredActiveSessionId) {
          persistAndSwitchExplicitOpenTabs(resolvedTabs, restoredActiveSessionId);
        } else {
          persistExplicitOpenTabs(resolvedTabs, null);
        }
      } else if (restoredActiveSessionId) {
        switchSession(restoredActiveSessionId);
      }
    }
  }, [
    createSession,
    hosts,
    hostsLoaded,
    persistAndSwitchExplicitOpenTabs,
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
      const targetSessionId =
        (state.activeSessionId && sessions.some((session) => session.id === state.activeSessionId)
          ? state.activeSessionId
          : null)
        || activeSession?.id
        || sessions[0].id;
      ensureTerminalPageFocus(targetSessionId);
      return;
    }
    setPageState(persistedPage);
  }, [activeSession?.id, ensureTerminalPageFocus, sessionIdsSignature, sessions.length, state.activeSessionId]);

  useEffect(() => {
    if (!state.activeSessionId) {
      return;
    }
    ensureTerminalPageFocus(state.activeSessionId);
  }, [ensureTerminalPageFocus, state.activeSessionId]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      localStorage.setItem(
        STORAGE_KEYS.ACTIVE_PAGE,
        JSON.stringify(resolvePersistedPageStateTruth(pageState, state.activeSessionId)),
      );
    } catch (error) {
      console.error('[App] Failed to persist page state:', error);
    }
  }, [pageState, state.activeSessionId]);

  useEffect(() => {
    pruneDrafts(sessionIds);
  }, [pruneDrafts, sessionIds, sessionIdsSignature]);

  useEffect(() => {
    const notifyResume = (reason: 'visibilitychange' | 'resume' | 'appStateChange') => {
      setFollowResetEpoch((current) => current + 1);
      performForegroundRefresh({
        reason,
        sessions: sessionsRef.current.map((session) => ({ id: session.id, state: session.state })),
        activeSessionId: activeSessionIdRef.current,
        resumeActiveSessionTransport: resumeActiveSessionTransportRef.current,
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
      if (!sessionId) {
        return;
      }
      runtimeDebug('app.session.status', {
        sessionId,
        type: detail?.type || 'unknown',
        message: detail?.message || null,
        activeSessionId: activeSessionIdRef.current,
        sessions: sessionsRef.current.map((session) => ({
          id: session.id,
          state: session.state,
          title: session.title,
        })),
      });
      if (detail?.type === 'closed') {
        applyClosedOpenTabIntent(sessionId, {
          runtimeSessions: sessionsRef.current,
          runtimeActiveSessionId: activeSessionIdRef.current,
          fallbackSessionIds: sessionsRef.current
            .filter((session) => session.id !== sessionId)
            .map((session) => session.id),
          closeRuntimeSession: true,
          clearDraft: true,
          source: 'session-status-closed',
        });
      }
    };

    window.addEventListener(SESSION_STATUS_EVENT, onSessionStatus as EventListener);
    return () => {
      window.removeEventListener(SESSION_STATUS_EVENT, onSessionStatus as EventListener);
    };
  }, [applyClosedOpenTabIntent]);

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
    const shouldActivate = options?.activate !== false;
    runtimeDebug('app.session.open-draft', {
      requestedSessionId: options?.sessionId || null,
      bridgeHost: draft.bridgeHost,
      bridgePort: draft.bridgePort,
      sessionName: draft.sessionName,
      activate: shouldActivate,
      navigate: options?.navigate !== false,
    });

    const sessionId = createSession(persistedHost, {
      activate: shouldActivate,
      ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
    });
    closedOpenTabSessionIdsRef.current.delete(sessionId);
    closedOpenTabReuseKeysRef.current.delete(buildPersistedOpenTabReuseKey({
      bridgeHost: persistedHost.bridgeHost,
      bridgePort: persistedHost.bridgePort,
      sessionName: persistedHost.sessionName,
      authToken: persistedHost.authToken,
    }));
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
      ensureTerminalPageFocus(sessionId);
    }
    return { sessionId, host: persistedHost };
  }, [
    createSession,
    persistExplicitOpenTabs,
    ensureTerminalPageFocus,
    recordSessionOpen,
    rememberBridgeTarget,
    rememberConnectionHost,
    state.activeSessionId,
  ]);

  useEffect(() => {
    openDraftAsSessionRef.current = openDraftAsSession;
  }, [openDraftAsSession]);

  const openSessionPicker = useCallback((mode: Exclude<PickerMode, null>, options?: {
    target?: BridgeTarget | null;
    initialSelectedSessions?: string[];
  }) => {
    setPickerMode(mode);
    setPickerInitialSessions(options?.initialSelectedSessions || []);
    const currentBridgeSettings = bridgeSettingsRef.current;
    setPickerTarget(
      options?.target || buildPreferredTarget(
        currentBridgeSettings.servers,
        {
          bridgeHost: currentBridgeSettings.targetHost,
          bridgePort: currentBridgeSettings.targetPort,
          authToken: currentBridgeSettings.targetAuthToken,
        },
        mode === 'quick-tab'
          ? (sessionsRef.current.find((session) => session.id === terminalActiveSessionIdRef.current) || null)
          : null,
      ),
    );
  }, []);

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
    ensureTerminalPageFocus(focusSessionId || undefined);
  }, [bridgeSettings.servers, ensureTerminalPageFocus, hosts, openDraftAsSession, recordSessionGroupOpen]);

  const handleOpenSingleTmuxSession = useCallback((target: BridgeTarget, sessionName: string) => {
    const draft = buildDraftFromTmuxSession(hosts, bridgeSettings.servers, target, sessionName);
    setPickerMode(null);
    handleQuickConnectDraft(draft, target.bridgeHost);
  }, [bridgeSettings.servers, handleQuickConnectDraft, hosts]);

  const handleSwitchSession = useCallback((sessionId: string) => {
    const nextOpenTabState = activateOpenTabIntentSession(openTabStateRef.current, sessionId);
    persistExplicitOpenTabs(nextOpenTabState.tabs, nextOpenTabState.activeSessionId);
    if (nextOpenTabState.activeSessionId && nextOpenTabState.activeSessionId !== activeSessionIdRef.current) {
      switchSession(nextOpenTabState.activeSessionId);
    }
    ensureTerminalPageFocus(sessionId);
  }, [ensureTerminalPageFocus, persistExplicitOpenTabs, switchSession]);

  const handleMoveSession = useCallback((sessionId: string, toIndex: number) => {
    const nextOpenTabState = moveOpenTabIntentSession(openTabStateRef.current, sessionId, toIndex);
    persistExplicitOpenTabs(nextOpenTabState.tabs, nextOpenTabState.activeSessionId || activeSessionIdRef.current);
    moveSession(sessionId, toIndex);
  }, [moveSession, persistExplicitOpenTabs]);

  const handleRenameSession = useCallback((sessionId: string, name: string) => {
    const nextOpenTabState = renameOpenTabIntentSession(openTabStateRef.current, sessionId, name);
    persistExplicitOpenTabs(nextOpenTabState.tabs, nextOpenTabState.activeSessionId || activeSessionIdRef.current);
    renameSession(sessionId, name);
  }, [persistExplicitOpenTabs, renameSession]);

  const handleCloseSession = useCallback((sessionId: string, source = 'unknown') => {
    const runtimeSessions = sessionsRef.current;
    const runtimeActiveSessionId = activeSessionIdRef.current;
    runtimeDebug('app.session.close.request', {
      sessionId,
      source,
      activeSessionId: runtimeActiveSessionId,
      sessions: runtimeSessions.map((session) => ({ id: session.id, state: session.state, title: session.title })),
    });
    console.warn('[App] close session request', {
      sessionId,
      source,
      activeSessionId: runtimeActiveSessionId,
      sessionCount: runtimeSessions.length,
    });

    applyClosedOpenTabIntent(sessionId, {
      runtimeSessions,
      runtimeActiveSessionId,
      fallbackSessionIds: runtimeSessions.filter((session) => session.id !== sessionId).map((session) => session.id),
      closeRuntimeSession: true,
      clearDraft: true,
      source,
    });
  }, [applyClosedOpenTabIntent]);

  const handleResumeSession = useCallback((sessionId: string) => {
    handleSwitchSession(sessionId);
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
      ensureTerminalPageFocus(focusSessionId);
    }
  }, [bridgeSettings.servers, ensureTerminalPageFocus, hosts, openDraftAsSession, recordSessionGroupOpen]);

  const handleLoadSavedTabList = useCallback((tabs: PersistedOpenTab[], requestedActiveSessionId?: string) => {
    const dedupedTabs = dedupePersistedOpenTabs(tabs);
    const openedTabs: PersistedOpenTab[] = [];
    runtimeDebug('app.saved-tab-list.load', {
      requestedActiveSessionId: requestedActiveSessionId || null,
      sessionIds: dedupedTabs.map((tab) => tab.sessionId),
      bridgeTargets: dedupedTabs.map((tab) => `${tab.bridgeHost}:${tab.bridgePort}:${tab.sessionName}`),
    });

    dedupedTabs.forEach((tab) => {
      const host: Host = resolveHostForPersistedOpenTab({
        tab,
        hosts: hostsRef.current,
        fallbackIdPrefix: 'saved',
        fallbackLastConnected: Date.now(),
      });

      const opened = openDraftAsSessionRef.current?.(host, {
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
        renameSessionRef.current(opened.sessionId, tab.customName.trim());
      }
    });

    const requestedImportedFocusSessionId = resolveRequestedOpenTabFocusSessionId(dedupedTabs, requestedActiveSessionId);
    const focusSessionId =
      requestedImportedFocusSessionId
        ? (openedTabs.find((tab) => tab.sessionId === requestedImportedFocusSessionId)?.sessionId || openedTabs[0]?.sessionId || null)
        : null;

    if (focusSessionId) {
      const persistAndSwitch = persistAndSwitchExplicitOpenTabsRef.current;
      if (!persistAndSwitch) {
        throw new Error('persistAndSwitchExplicitOpenTabs ref unavailable while loading saved tab list');
      }
      persistAndSwitch(openedTabs, focusSessionId);
      ensureTerminalPageFocusRef.current(focusSessionId);
    }
  }, []);

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
    if (activeSessionIdRef.current !== sessionId) {
      handleSwitchSession(sessionId);
    }
    handleTerminalInput(sessionId, payload);
    clearSessionDraft(sessionId);
  }, [clearSessionDraft, handleSwitchSession, handleTerminalInput]);

  const handleOpenConnectionsPage = useCallback(() => {
    setPageState(openConnectionsPage());
  }, []);

  const handleOpenSettingsPage = useCallback(() => {
    setPageState(openSettingsPage());
  }, []);

  const handleOpenQuickTabPicker = useCallback(() => {
    openSessionPicker('quick-tab');
  }, [openSessionPicker]);

  const handleTerminalVisibleRangeChange = useCallback((sessionId: string, viewState: Parameters<typeof updateSessionViewport>[1]) => {
    updateSessionViewport(sessionId, viewState);
  }, [updateSessionViewport]);

  const handleQuickActionInput = useCallback((sequence: string, sessionId?: string) => {
    const targetSessionId = sessionId || terminalActiveSessionIdRef.current;
    if (!targetSessionId) {
      return;
    }
    handleTerminalInput(targetSessionId, sequence);
  }, [handleTerminalInput]);

  const handleSessionDraftChange = useCallback((value: string, sessionId?: string) => {
    const targetSessionId = sessionId || terminalActiveSessionIdRef.current;
    if (!targetSessionId) {
      return;
    }
    setSessionDraft(targetSessionId, value);
  }, [setSessionDraft]);

  const handleSessionDraftSend = useCallback((value: string, sessionId?: string) => {
    const targetSessionId = sessionId || terminalActiveSessionIdRef.current;
    if (!targetSessionId) {
      return;
    }
    handleSendSessionDraft(targetSessionId, value);
  }, [handleSendSessionDraft]);

  const sessionRenderBufferStore = useMemo(() => getSessionRenderBufferStore(), [getSessionRenderBufferStore]);
  const shortcutFrequencyMap = useMemo(
    () => (bridgeSettings.shortcutSmartSort ? shortcutFrequencyStorage.getFrequencyMap() : undefined),
    [bridgeSettings.shortcutSmartSort, shortcutFrequencyStorage],
  );
  const handleShortcutUse = bridgeSettings.shortcutSmartSort
    ? shortcutFrequencyStorage.recordShortcutUse
    : undefined;

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
            onOpenSettings={handleOpenSettingsPage}
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
            onBack={handleOpenConnectionsPage}
          />
        )}

        {pageState.kind === 'terminal' && (
          <TerminalPage
            sessions={terminalSessions}
            activeSession={terminalActiveSession}
            getSessionDebugMetrics={getSessionDebugMetrics}
            sessionBufferStore={sessionRenderBufferStore}
            onSwitchSession={handleSwitchSession}
            onMoveSession={handleMoveSession}
            onRenameSession={handleRenameSession}
            onCloseSession={handleCloseSession}
            onOpenConnections={handleOpenConnectionsPage}
            onOpenQuickTabPicker={handleOpenQuickTabPicker}
            onResize={undefined}
            onTerminalInput={handleTerminalInput}
            onLiveSessionIdsChange={setLiveSessionIds}
            inputResetEpochBySession={inputResetEpochBySession}
            followResetEpoch={followResetEpoch}
            onTerminalVisibleRangeChange={handleTerminalVisibleRangeChange}
            onImagePaste={sendImagePaste}
            onFileAttach={sendFileAttach}
            onOpenSettings={handleOpenSettingsPage}
            onRequestRemoteScreenshot={requestRemoteScreenshot}
            quickActions={quickActions}
            shortcutActions={shortcutActions}
            onQuickActionInput={handleQuickActionInput}
            onQuickActionsChange={setQuickActions}
            onShortcutActionsChange={setShortcutActions}
            sessionDraft={terminalActiveSession ? (sessionDrafts[terminalActiveSession.id] || '') : ''}
            onSessionDraftChange={handleSessionDraftChange}
            onSessionDraftSend={handleSessionDraftSend}
            onLoadSavedTabList={handleLoadSavedTabList}
            scheduleState={terminalActiveSession ? scheduleStates[terminalActiveSession.id] || null : null}
            onRequestScheduleList={requestScheduleList}
            onUpsertScheduleJob={upsertScheduleJob}
            onDeleteScheduleJob={deleteScheduleJob}
            onToggleScheduleJob={toggleScheduleJob}
            onRunScheduleJobNow={runScheduleJobNow}
            terminalThemeId={bridgeSettings.terminalThemeId}
            terminalWidthMode={bridgeSettings.terminalWidthMode}
            onSendMessage={sendMessageRaw}
            onFileTransferMessage={onFileTransferMessage}
            shortcutSmartSort={bridgeSettings.shortcutSmartSort}
            shortcutFrequencyMap={shortcutFrequencyMap}
            onShortcutUse={handleShortcutUse}
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
