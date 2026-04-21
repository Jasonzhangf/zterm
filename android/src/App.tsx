/**
 * App - 主应用入口
 * 只负责页面级切换与跨页 orchestration。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { STORAGE_KEYS, type Host } from './lib/types';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { ConnectionPropertiesPage } from './pages/ConnectionPropertiesPage';
import { SettingsPage } from './pages/SettingsPage';
import { TerminalPage } from './pages/TerminalPage';

interface AppContentProps {
  bridgeSettings: ReturnType<typeof useBridgeSettingsStorage>['settings'];
  setBridgeSettings: ReturnType<typeof useBridgeSettingsStorage>['setSettings'];
}

type PickerMode = 'new-connection' | 'quick-tab' | 'edit-group' | null;

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

function AppContent({ bridgeSettings, setBridgeSettings }: AppContentProps) {
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
    createSession,
    closeSession,
    switchSession,
    moveSession,
    renameSession,
    reconnectSession,
    reconnectAllSessions,
    requestBufferRange,
    getActiveSession,
    sendInput,
    sendImagePaste,
    resizeTerminal,
    updateSessionBufferLines,
  } = useSession();
  const { hosts, addHost, upsertHost, updateHost, deleteHost } = useHostStorage();
  const { quickActions, setQuickActions } = useQuickActionStorage();
  const { shortcutActions, setShortcutActions } = useShortcutActionStorage();
  const { drafts: sessionDrafts, setDraft: setSessionDraft, clearDraft: clearSessionDraft, pruneDrafts } = useSessionDraftStorage();
  const { sessionGroups, recordSessionOpen, recordSessionGroupOpen, setSessionGroupSelection, deleteSessionGroup } = useSessionHistoryStorage();
  const [pageState, setPageState] = useState<AppPageState>(() => readPersistedPageState());
  const [pickerMode, setPickerMode] = useState<PickerMode>(null);
  const [pickerTarget, setPickerTarget] = useState<BridgeTarget | null>(null);
  const [pickerInitialSessions, setPickerInitialSessions] = useState<string[]>([]);
  const [resumeNonce, setResumeNonce] = useState(0);
  const [forceScrollToBottomNonce, setForceScrollToBottomNonce] = useState(0);
  const restoredRouteHandledRef = useRef(false);
  const wasHiddenRef = useRef(false);
  const lastResumeAtRef = useRef(0);

  const activeSession = getActiveSession();
  const sessions = state.sessions;

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
    const notifyResume = (reason: string) => {
      const now = Date.now();
      if (now - lastResumeAtRef.current < 800) {
        return;
      }
      lastResumeAtRef.current = now;
      console.debug('[App] reconnect all sessions ->', reason);
      setResumeNonce((current) => current + 1);
      reconnectAllSessions();
      window.requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'));
      });
    };

    const markHidden = () => {
      wasHiddenRef.current = true;
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        markHidden();
        return;
      }

      if (document.visibilityState === 'visible' && wasHiddenRef.current) {
        wasHiddenRef.current = false;
        notifyResume('visibilitychange');
      }
    };

    const onFocus = () => {
      if (wasHiddenRef.current) {
        wasHiddenRef.current = false;
        notifyResume('focus');
      }
    };

    const onDocumentResume = () => {
      wasHiddenRef.current = false;
      notifyResume('resume');
    };

    const onPageShow = () => {
      notifyResume('pageshow');
    };

    const onOnline = () => {
      notifyResume('online');
    };

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
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('resume', onDocumentResume as EventListener);
      document.removeEventListener('pause', markHidden as EventListener);
    };
  }, [reconnectAllSessions]);

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

  const handleTitleChange = useCallback((title: string) => {
    console.log('[App] Terminal title:', title);
  }, []);

  const handleResize = useCallback((cols: number, rows: number) => {
    console.log('[App] Terminal resize:', cols, rows);
    resizeTerminal(cols, rows);
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

  const handleSwipeSession = useCallback((direction: 'prev' | 'next') => {
    if (!activeSession || sessions.length < 2) {
      return;
    }

    const currentIndex = sessions.findIndex((session) => session.id === activeSession.id);
    if (currentIndex < 0) {
      return;
    }

    const nextIndex =
      direction === 'next'
        ? (currentIndex + 1) % sessions.length
        : (currentIndex - 1 + sessions.length) % sessions.length;

    switchSession(sessions[nextIndex].id);
  }, [activeSession, sessions, switchSession]);

  const handleTerminalInput = useCallback((data: string) => {
    setForceScrollToBottomNonce(Date.now());
    sendInput(data);
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
    handleTerminalInput(payload);
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
            onBack={() => setPageState(openConnectionsPage())}
          />
        )}

        {pageState.kind === 'terminal' && (
          <TerminalPage
            sessions={sessions}
            activeSession={activeSession}
            resumeNonce={resumeNonce}
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
            onSwipeSession={handleSwipeSession}
            onTitleChange={handleTitleChange}
            onResize={handleResize}
            onTerminalInput={handleTerminalInput}
            onRequestBufferRange={requestBufferRange}
            onImagePaste={sendImagePaste}
            onBufferLinesChange={updateSessionBufferLines}
            quickActions={quickActions}
            shortcutActions={shortcutActions}
            onQuickActionInput={handleTerminalInput}
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
            forceScrollToBottomNonce={forceScrollToBottomNonce}
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
