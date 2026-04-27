/**
 * App - 主应用入口
 * 只负责页面级切换与跨页 orchestration。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TmuxSessionPickerSheet } from './components/tmux/TmuxSessionPickerSheet';
import { SessionProvider, useSession } from './contexts/SessionContext';
import { useBridgeSettingsStorage } from './hooks/useBridgeSettingsStorage';
import { useHostStorage } from './hooks/useHostStorage';
import { useQuickActionStorage } from './hooks/useQuickActionStorage';
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
import type { Host } from './lib/types';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { ConnectionPropertiesPage } from './pages/ConnectionPropertiesPage';
import { SettingsPage } from './pages/SettingsPage';
import { TerminalPage } from './pages/TerminalPage';

interface AppContentProps {
  bridgeSettings: ReturnType<typeof useBridgeSettingsStorage>['settings'];
  setBridgeSettings: ReturnType<typeof useBridgeSettingsStorage>['setSettings'];
}

type PickerMode = 'new-connection' | 'quick-tab' | null;

function AppContent({ bridgeSettings, setBridgeSettings }: AppContentProps) {
  const {
    state,
    createSession,
    closeSession,
    switchSession,
    renameSession,
    reconnectSession,
    reconnectAllSessions,
    getActiveSession,
    sendInput,
    sendImagePaste,
    resizeTerminal,
    updateSessionBufferLines,
  } = useSession();
  const { hosts, addHost, upsertHost, updateHost, deleteHost } = useHostStorage();
  const { quickActions, setQuickActions } = useQuickActionStorage();
  const { sessionGroups, recordSessionOpen, recordSessionGroupOpen } = useSessionHistoryStorage();
  const [pageState, setPageState] = useState<AppPageState>(openConnectionsPage());
  const [pickerMode, setPickerMode] = useState<PickerMode>(null);
  const [pickerTarget, setPickerTarget] = useState<BridgeTarget | null>(null);
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
    setPageState(openTerminalPage(activeSession?.id || sessions[0].id));
  }, [activeSession, sessions]);

  useEffect(() => {
    const notifyResume = () => {
      const now = Date.now();
      if (now - lastResumeAtRef.current < 800) {
        return;
      }
      lastResumeAtRef.current = now;
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
        notifyResume();
      }
    };

    const onFocus = () => {
      if (wasHiddenRef.current) {
        wasHiddenRef.current = false;
        notifyResume();
      }
    };

    const onDocumentResume = () => {
      wasHiddenRef.current = false;
      notifyResume();
    };

    window.addEventListener('focus', onFocus);
    window.addEventListener('pageshow', notifyResume);
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('resume', onDocumentResume as EventListener);
    document.addEventListener('pause', markHidden as EventListener);

    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pageshow', notifyResume);
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

  const openSessionPicker = useCallback((mode: Exclude<PickerMode, null>) => {
    setPickerMode(mode);
    setPickerTarget(
      buildPreferredTarget(
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

  const handleRestoreSessionGroup = useCallback((group: { name: string; bridgeHost: string; bridgePort: number; authToken?: string; sessionNames: string[] }) => {
    handleOpenMultipleTmuxSessions(
      {
        bridgeHost: group.bridgeHost,
        bridgePort: group.bridgePort,
        authToken: group.authToken,
      },
      group.sessionNames,
    );
  }, [handleOpenMultipleTmuxSessions]);

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

  const handleSelectHistoryHost = useCallback((host: Host) => {
    setPickerMode(null);
    if (pickerMode === 'quick-tab') {
      handleConnect(host);
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
      <div style={{ width: '100%', maxWidth: '430px', height: '100dvh', overflow: 'hidden' }}>
        {pageState.kind === 'connections' && (
          <ConnectionsPage
            hosts={sortedHosts}
            sessions={sessions}
            sessionGroups={sessionGroups}
            onConnect={handleConnect}
            onResumeSession={handleResumeSession}
            onRestoreSessionGroup={handleRestoreSessionGroup}
            onOpenGroupSession={handleOpenGroupSession}
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
            onSave={(next) => {
              setBridgeSettings(next);
              setPageState(openConnectionsPage());
            }}
            onBack={() => setPageState(openConnectionsPage())}
          />
        )}

        {pageState.kind === 'terminal' && (
          <TerminalPage
            sessions={sessions}
            activeSession={activeSession}
            resumeNonce={resumeNonce}
            onSwitchSession={switchSession}
            onRenameSession={renameSession}
            onCloseSession={(sessionId) => {
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
            onImagePaste={sendImagePaste}
            onBufferLinesChange={updateSessionBufferLines}
            quickActions={quickActions}
            onQuickActionInput={handleTerminalInput}
            onQuickActionsChange={setQuickActions}
            forceScrollToBottomNonce={forceScrollToBottomNonce}
          />
        )}
      </div>

      <TmuxSessionPickerSheet
        mode={pickerMode === 'quick-tab' ? 'quick-tab' : 'new-connection'}
        open={pickerMode !== null}
        hosts={sortedHosts}
        servers={bridgeSettings.servers}
        initialTarget={pickerTarget}
        onClose={() => setPickerMode(null)}
        onSelectHistoryHost={handleSelectHistoryHost}
        onOpenTmuxSession={handleOpenSingleTmuxSession}
        onOpenMultipleTmuxSessions={handleOpenMultipleTmuxSessions}
        onSelectCleanSession={handleSelectCleanSession}
      />
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
