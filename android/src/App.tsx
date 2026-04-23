/**
 * App - 主应用入口
 * 只负责页面级切换与跨页 orchestration。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { TmuxSessionPickerSheet } from './components/tmux/TmuxSessionPickerSheet';
import { SessionProvider, useSession } from './contexts/SessionContext';
import { useAppUpdate } from './hooks/useAppUpdate';
import { useBridgeSettingsStorage } from './hooks/useBridgeSettingsStorage';
import { useHostStorage } from './hooks/useHostStorage';
import { useQuickActionStorage } from './hooks/useQuickActionStorage';
import { useShortcutActionStorage } from './hooks/useShortcutActionStorage';
import { useSessionDraftStorage } from './hooks/useSessionDraftStorage';
import { useSessionHistoryStorage } from './hooks/useSessionHistoryStorage';
import { upsertBridgeServer } from './lib/bridge-settings';
import { runtimeDebug } from './lib/runtime-debug';
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
import { STORAGE_KEYS, type Host, type PersistedOpenTab } from './lib/types';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { ConnectionPropertiesPage } from './pages/ConnectionPropertiesPage';
import { SettingsPage } from './pages/SettingsPage';
import { TerminalPage } from './pages/TerminalPage';

interface AppContentProps {
  bridgeSettings: ReturnType<typeof useBridgeSettingsStorage>['settings'];
  setBridgeSettings: ReturnType<typeof useBridgeSettingsStorage>['setSettings'];
}

type PickerMode = 'new-connection' | 'quick-tab' | 'edit-group' | null;

function summarizeResumeSessions(sessions: Array<{ id: string; state: string }>) {
  return sessions.map((session) => ({
    id: session.id,
    state: session.state,
  }));
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
      return openTerminalPage(typeof parsed.focusSessionId === 'string' ? parsed.focusSessionId : undefined);
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

function normalizePersistedOpenTab(input: unknown): PersistedOpenTab | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input as Partial<PersistedOpenTab>;
  const sessionId = typeof candidate.sessionId === 'string' ? candidate.sessionId.trim() : '';
  const hostId = typeof candidate.hostId === 'string' ? candidate.hostId.trim() : '';
  const bridgeHost = typeof candidate.bridgeHost === 'string' ? candidate.bridgeHost.trim() : '';
  const sessionName = typeof candidate.sessionName === 'string' ? candidate.sessionName.trim() : '';
  const connectionName = typeof candidate.connectionName === 'string' ? candidate.connectionName.trim() : '';

  if (!sessionId || !bridgeHost || !sessionName) {
    return null;
  }

  return {
    sessionId,
    hostId,
    connectionName: connectionName || sessionName,
    bridgeHost,
    bridgePort:
      typeof candidate.bridgePort === 'number' && Number.isFinite(candidate.bridgePort)
        ? candidate.bridgePort
        : 3333,
    sessionName,
    authToken: typeof candidate.authToken === 'string' ? candidate.authToken : undefined,
    autoCommand: typeof candidate.autoCommand === 'string' ? candidate.autoCommand : undefined,
    customName: typeof candidate.customName === 'string' && candidate.customName.trim()
      ? candidate.customName.trim()
      : undefined,
    createdAt:
      typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
        ? candidate.createdAt
        : Date.now(),
  };
}

function readPersistedOpenTabs() {
  if (typeof window === 'undefined') {
    return [] as PersistedOpenTab[];
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEYS.OPEN_TABS);
    if (!raw) {
      return [] as PersistedOpenTab[];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [] as PersistedOpenTab[];
    }
    return parsed
      .map(normalizePersistedOpenTab)
      .filter((item): item is PersistedOpenTab => item !== null);
  } catch (error) {
    console.error('[App] Failed to restore open tabs:', error);
    return [] as PersistedOpenTab[];
  }
}

function readPersistedActiveSessionId() {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION);
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  } catch (error) {
    console.error('[App] Failed to restore active session:', error);
    return null;
  }
}

export function AppContent({ bridgeSettings, setBridgeSettings }: AppContentProps) {
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
    createSession,
    closeSession,
    switchSession,
    moveSession,
    renameSession,
    reconnectSession,
    reconnectAllSessions,
    refreshSessionTail,
    sendInput,
    sendImagePaste,
    resizeTerminal,
    updateSessionViewport,
    requestViewportPrefetch,
    requestScheduleList,
    upsertScheduleJob,
    deleteScheduleJob,
    toggleScheduleJob,
    runScheduleJobNow,
  } = useSession();
  const { hosts, isLoaded: hostsLoaded, addHost, upsertHost, updateHost, deleteHost } = useHostStorage();
  const { quickActions, setQuickActions } = useQuickActionStorage();
  const { shortcutActions, setShortcutActions } = useShortcutActionStorage();
  const { drafts: sessionDrafts, setDraft: setSessionDraft, clearDraft: clearSessionDraft, pruneDrafts } = useSessionDraftStorage();
  const { sessionGroups, recordSessionOpen, recordSessionGroupOpen, setSessionGroupSelection, deleteSessionGroup } = useSessionHistoryStorage();
  const [pageState, setPageState] = useState<AppPageState>(() => readPersistedPageState());
  const [pickerMode, setPickerMode] = useState<PickerMode>(null);
  const [pickerTarget, setPickerTarget] = useState<BridgeTarget | null>(null);
  const [pickerInitialSessions, setPickerInitialSessions] = useState<string[]>([]);
  const restoredRouteHandledRef = useRef(false);
  const restoredTabsHandledRef = useRef(false);
  const wasHiddenRef = useRef(false);
  const lastResumeAtRef = useRef(0);

  const activeSession = useMemo(
    () => state.sessions.find((session) => session.id === state.activeSessionId) || null,
    [state.activeSessionId, state.sessions],
  );
  const sessions = state.sessions;

  useEffect(() => {
    if (!restoredTabsHandledRef.current && sessions.length === 0) {
      return;
    }
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const persistedTabs: PersistedOpenTab[] = sessions.map((session) => ({
        sessionId: session.id,
        hostId: session.hostId,
        connectionName: session.connectionName,
        bridgeHost: session.bridgeHost,
        bridgePort: session.bridgePort,
        sessionName: session.sessionName,
        authToken: session.authToken,
        autoCommand: session.autoCommand,
        customName: session.customName,
        createdAt: session.createdAt,
      }));
      localStorage.setItem(STORAGE_KEYS.OPEN_TABS, JSON.stringify(persistedTabs));
      if (state.activeSessionId) {
        localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, state.activeSessionId);
      } else {
        localStorage.removeItem(STORAGE_KEYS.ACTIVE_SESSION);
      }
    } catch (error) {
      console.error('[App] Failed to persist open tabs:', error);
    }
  }, [sessions, state.activeSessionId]);

  useEffect(() => {
    if (restoredTabsHandledRef.current || !hostsLoaded) {
      return;
    }

    if (sessions.length > 0) {
      restoredTabsHandledRef.current = true;
      return;
    }

    restoredTabsHandledRef.current = true;
    const persistedTabs = readPersistedOpenTabs();
    if (persistedTabs.length === 0) {
      return;
    }

    const persistedActiveSessionId = readPersistedActiveSessionId();
    for (const tab of persistedTabs) {
      const existingHost = hosts.find((host) => host.id === tab.hostId) || null;
      const host: Host = existingHost
        ? {
            ...existingHost,
            name: existingHost.name || tab.connectionName,
            bridgeHost: existingHost.bridgeHost || tab.bridgeHost,
            bridgePort: existingHost.bridgePort || tab.bridgePort,
            sessionName: existingHost.sessionName || tab.sessionName,
            authToken: existingHost.authToken || tab.authToken,
            autoCommand: existingHost.autoCommand || tab.autoCommand,
          }
        : {
            id: tab.hostId || `restored:${tab.bridgeHost}:${tab.bridgePort}:${tab.sessionName}`,
            createdAt: tab.createdAt,
            name: tab.connectionName,
            bridgeHost: tab.bridgeHost,
            bridgePort: tab.bridgePort,
            sessionName: tab.sessionName,
            authToken: tab.authToken,
            autoCommand: tab.autoCommand,
            authType: 'password',
            password: undefined,
            privateKey: undefined,
            tags: [],
            pinned: false,
            lastConnected: tab.createdAt,
          };

      createSession(host, {
        activate: false,
        customName: tab.customName,
        createdAt: tab.createdAt,
        sessionId: tab.sessionId,
      });
    }

    const nextActiveSessionId =
      (persistedActiveSessionId && persistedTabs.some((tab) => tab.sessionId === persistedActiveSessionId)
        ? persistedActiveSessionId
        : persistedTabs[0]?.sessionId) || null;
    if (nextActiveSessionId) {
      switchSession(nextActiveSessionId);
    }
  }, [createSession, hosts, hostsLoaded, sessions.length, switchSession]);

  const findReusableSession = useCallback((target: Pick<Host, 'bridgeHost' | 'bridgePort' | 'sessionName'>) => {
    const resolvedSessionName = target.sessionName.trim() || target.bridgeHost.trim();
    return state.sessions.find(
      (session) =>
        session.bridgeHost === target.bridgeHost &&
        session.bridgePort === target.bridgePort &&
        session.sessionName === resolvedSessionName,
    ) || null;
  }, [state.sessions]);

  useEffect(() => {
    if (restoredRouteHandledRef.current || sessions.length === 0) {
      return;
    }

    restoredRouteHandledRef.current = true;
    const persistedPage = readPersistedPageState();
    if (persistedPage.kind === 'terminal') {
      const requestedSessionId = persistedPage.focusSessionId;
      const targetSessionId =
        (requestedSessionId && sessions.some((session) => session.id === requestedSessionId) ? requestedSessionId : null)
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
    if (pageState.kind !== 'terminal') {
      return;
    }
    const currentFocusId = activeSession?.id || pageState.focusSessionId;
    if (!currentFocusId || pageState.focusSessionId === currentFocusId) {
      return;
    }
    setPageState(openTerminalPage(currentFocusId));
  }, [activeSession?.id, pageState]);

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
    const notifyResume = (reason: string, options?: { force?: boolean }) => {
      if (sessions.length === 0) {
        runtimeDebug('app.resume.skip', { reason, force: Boolean(options?.force), why: 'no-sessions' });
        return;
      }
      const hasRecoverableSessions = sessions.some((session) => session.state !== 'connected');
      if (!options?.force && !hasRecoverableSessions) {
        runtimeDebug('app.resume.skip', {
          reason,
          force: Boolean(options?.force),
          why: 'all-healthy',
          sessions: summarizeResumeSessions(sessions),
        });
        return;
      }
      const now = Date.now();
      if (now - lastResumeAtRef.current < 800) {
        runtimeDebug('app.resume.skip', {
          reason,
          force: Boolean(options?.force),
          why: 'debounced',
          deltaMs: now - lastResumeAtRef.current,
          sessions: summarizeResumeSessions(sessions),
        });
        return;
      }
      lastResumeAtRef.current = now;
      runtimeDebug('app.resume.fire', {
        reason,
        force: Boolean(options?.force),
        sessions: summarizeResumeSessions(sessions),
      });
      const activeSessionId = activeSession?.id || state.activeSessionId;
      const reconnectTargets: string[] = [];
      let didTailRefresh = false;

      if (activeSessionId) {
        const currentActiveSession = sessions.find((session) => session.id === activeSessionId) || null;
        if (currentActiveSession?.state === 'connected') {
          didTailRefresh = refreshSessionTail(activeSessionId);
          if (!didTailRefresh) {
            reconnectTargets.push(activeSessionId);
          }
        } else {
          reconnectTargets.push(activeSessionId);
        }
      }

      reconnectTargets.push(
        ...sessions
          .filter((session) => session.id !== activeSessionId && session.state !== 'connected')
          .map((session) => session.id),
      );

      const uniqueTargets = Array.from(new Set(reconnectTargets));
      if (uniqueTargets.length > 0) {
        console.debug('[App] foreground resume actions ->', {
          reason,
          didTailRefresh,
          reconnectTargets: uniqueTargets,
        });
        uniqueTargets.forEach((sessionId) => reconnectSession(sessionId));
      } else if (!didTailRefresh) {
        console.debug('[App] reconnect all sessions ->', reason);
        reconnectAllSessions();
      }
      window.requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'));
      });
    };

    const markHidden = () => {
      wasHiddenRef.current = true;
      runtimeDebug('app.visibility.hidden', {
        visibilityState: document.visibilityState,
      });
    };

    const onVisibilityChange = () => {
      runtimeDebug('app.visibility.change', {
        visibilityState: document.visibilityState,
        wasHidden: wasHiddenRef.current,
      });
      if (document.visibilityState === 'hidden') {
        markHidden();
        return;
      }

      if (document.visibilityState === 'visible' && wasHiddenRef.current) {
        wasHiddenRef.current = false;
        notifyResume('visibilitychange', { force: true });
      }
    };

    const onFocus = () => {
      const hasConnectedSessions = sessions.some((session) => session.state === 'connected');
      runtimeDebug('app.window.focus', {
        wasHidden: wasHiddenRef.current,
        hasConnectedSessions,
      });
      if (wasHiddenRef.current || hasConnectedSessions) {
        wasHiddenRef.current = false;
        notifyResume('focus', { force: true });
      }
    };

    const onDocumentResume = () => {
      wasHiddenRef.current = false;
      runtimeDebug('app.document.resume', {});
      notifyResume('resume', { force: true });
    };

    const onPageShow = () => {
      const hasConnectedSessions = sessions.some((session) => session.state === 'connected');
      runtimeDebug('app.window.pageshow', {
        hasConnectedSessions,
      });
      if (hasConnectedSessions) {
        notifyResume('pageshow', { force: true });
        return;
      }
      notifyResume('pageshow');
    };

    const onOnline = () => {
      runtimeDebug('app.window.online', {});
      notifyResume('online');
    };

    const appStateListenerHandle = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      runtimeDebug('app.capacitor.appStateChange', {
        isActive,
        wasHidden: wasHiddenRef.current,
      });
      if (!isActive) {
        markHidden();
        return;
      }
      wasHiddenRef.current = false;
      notifyResume('appStateChange', { force: true });
    });

    window.addEventListener('focus', onFocus);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('resume', onDocumentResume as EventListener);
    document.addEventListener('pause', markHidden as EventListener);

    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('online', onOnline);
      void Promise.resolve(appStateListenerHandle)
        .then((listener) => listener?.remove?.())
        .catch(() => undefined);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('resume', onDocumentResume as EventListener);
      document.removeEventListener('pause', markHidden as EventListener);
    };
  }, [activeSession?.id, reconnectAllSessions, reconnectSession, refreshSessionTail, sessions, state.activeSessionId]);

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
    options?: { rememberName?: string; activate?: boolean; navigate?: boolean },
  ) => {
    rememberBridgeTarget(normalizeBridgeTarget(draft), options?.rememberName || draft.name || draft.bridgeHost);
    const persistedHost = rememberConnectionHost(buildTransientHostFromDraft(draft));
    const existingSession = findReusableSession(persistedHost);
    const shouldActivate = options?.activate !== false;

    if (existingSession) {
      if (shouldActivate) {
        switchSession(existingSession.id);
      }
      if (existingSession.state === 'error' || existingSession.state === 'closed') {
        reconnectSession(existingSession.id);
      }
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

    const sessionId = createSession(persistedHost, { activate: shouldActivate });
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
  }, [createSession, findReusableSession, reconnectSession, recordSessionOpen, rememberBridgeTarget, rememberConnectionHost, switchSession]);

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

  const handleConnect = useCallback((host: Host) => {
    openDraftAsSession(host, { rememberName: host.name, activate: true, navigate: true });
  }, [openDraftAsSession]);

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

  const handleResumeSession = useCallback((sessionId: string) => {
    switchSession(sessionId);
    setPageState(openTerminalPage(sessionId));
  }, [switchSession]);

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
    let focusSessionId: string | null = null;

    tabs.forEach((tab, index) => {
      const existingHost = hosts.find((host) => host.id === tab.hostId) || null;
      const host: Host = existingHost
        ? {
            ...existingHost,
            name: existingHost.name || tab.connectionName,
            bridgeHost: existingHost.bridgeHost || tab.bridgeHost,
            bridgePort: existingHost.bridgePort || tab.bridgePort,
            sessionName: existingHost.sessionName || tab.sessionName,
            authToken: existingHost.authToken || tab.authToken,
            autoCommand: existingHost.autoCommand || tab.autoCommand,
          }
        : {
            id: tab.hostId || `saved:${tab.bridgeHost}:${tab.bridgePort}:${tab.sessionName}`,
            createdAt: tab.createdAt,
            name: tab.connectionName,
            bridgeHost: tab.bridgeHost,
            bridgePort: tab.bridgePort,
            sessionName: tab.sessionName,
            authToken: tab.authToken,
            autoCommand: tab.autoCommand,
            authType: 'password',
            password: undefined,
            privateKey: undefined,
            tags: [],
            pinned: false,
            lastConnected: Date.now(),
          };

      const opened = openDraftAsSession(host, {
        rememberName: host.name,
        activate: false,
        navigate: false,
      });

      if (tab.customName?.trim()) {
        renameSession(opened.sessionId, tab.customName.trim());
      }

      if (requestedActiveSessionId === tab.sessionId) {
        focusSessionId = opened.sessionId;
      } else if (!focusSessionId && index === 0) {
        focusSessionId = opened.sessionId;
      }
    });

    if (focusSessionId) {
      switchSession(focusSessionId);
      setPageState(openTerminalPage(focusSessionId));
    }
  }, [hosts, openDraftAsSession, renameSession, switchSession]);

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

  const handleTerminalInput = useCallback((sessionId: string, data: string) => {
    sendInput(sessionId, data);
  }, [sendInput]);

  const handleSendSessionDraft = useCallback((sessionId: string, value: string) => {
    if (!value) {
      return;
    }
    const normalized = value.replace(/\r?\n/g, '\r');
    const payload = /[\r\n]$/.test(normalized) ? normalized : `${normalized}\r`;
    if (activeSession?.id !== sessionId) {
      switchSession(sessionId);
    }
    handleTerminalInput(sessionId, payload);
    clearSessionDraft(sessionId);
  }, [activeSession?.id, clearSessionDraft, handleTerminalInput, switchSession]);

  const handleSelectHistoryHost = useCallback((host: Host) => {
    setPickerMode(null);
    if (pickerMode === 'quick-tab') {
      handleConnect(host);
      return;
    }
    if (pickerMode === 'edit-group') {
      setPickerMode('edit-group');
      setPickerTarget(normalizeBridgeTarget(host));
      setPickerInitialSessions([host.sessionName]);
      return;
    }
    rememberBridgeTarget(normalizeBridgeTarget(host), host.name);
    setPageState(openConnectionPropertiesPage({ draft: host }));
  }, [handleConnect, pickerMode, rememberBridgeTarget]);

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
              setBridgeSettings(next);
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
            onSwitchSession={switchSession}
            onMoveSession={moveSession}
            onRenameSession={renameSession}
            onCloseSession={(sessionId) => {
              clearSessionDraft(sessionId);
              closeSession(sessionId);
              if (sessions.length === 1) {
                setPageState(openConnectionsPage());
              }
            }}
            onOpenConnections={() => setPageState(openConnectionsPage())}
            onOpenQuickTabPicker={() => openSessionPicker('quick-tab')}
            onResize={handleResize}
            onTerminalInput={handleTerminalInput}
            onTerminalViewportChange={(sessionId, viewState) => {
              updateSessionViewport(sessionId, viewState);
            }}
            onTerminalViewportPrefetch={(sessionId, viewState) => {
              requestViewportPrefetch(sessionId, viewState);
            }}
            onImagePaste={sendImagePaste}
            quickActions={quickActions}
            shortcutActions={shortcutActions}
            onQuickActionInput={(sequence) => {
              if (!activeSession?.id) {
                return;
              }
              handleTerminalInput(activeSession.id, sequence);
            }}
            onQuickActionsChange={setQuickActions}
            onShortcutActionsChange={setShortcutActions}
            sessionDraft={activeSession ? (sessionDrafts[activeSession.id] || '') : ''}
            onSessionDraftChange={(value) => {
              if (!activeSession?.id) {
                return;
              }
              setSessionDraft(activeSession.id, value);
            }}
            onSessionDraftSend={(value) => {
              if (!activeSession?.id) {
                return;
              }
              handleSendSessionDraft(activeSession.id, value);
            }}
            onLoadSavedTabList={handleLoadSavedTabList}
            scheduleState={activeSession ? scheduleStates[activeSession.id] || null : null}
            onRequestScheduleList={requestScheduleList}
            onUpsertScheduleJob={upsertScheduleJob}
            onDeleteScheduleJob={deleteScheduleJob}
            onToggleScheduleJob={toggleScheduleJob}
            onRunScheduleJobNow={runScheduleJobNow}
            terminalThemeId={bridgeSettings.terminalThemeId}
          />
        )}
      </div>

      <TmuxSessionPickerSheet
        mode={pickerMode === 'quick-tab' ? 'quick-tab' : pickerMode === 'edit-group' ? 'edit-group' : 'new-connection'}
        open={pickerMode !== null}
        hosts={sortedHosts}
        servers={bridgeSettings.servers}
        initialTarget={pickerTarget}
        initialSelectedSessions={pickerInitialSessions}
        onClose={() => setPickerMode(null)}
        onSelectHistoryHost={handleSelectHistoryHost}
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

  return (
    <SessionProvider terminalCacheLines={bridgeSettings.terminalCacheLines}>
      <AppContent bridgeSettings={bridgeSettings} setBridgeSettings={setBridgeSettings} />
    </SessionProvider>
  );
}
