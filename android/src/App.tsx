/**
 * App - 主应用入口
 * 只负责页面级切换与跨页 orchestration。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { TmuxSessionPickerSheet } from './components/tmux/TmuxSessionPickerSheet';
import { SessionProvider, useSession } from './contexts/SessionContext';
import { useAppUpdate } from './hooks/useAppUpdate';
import { useConfigExport } from './hooks/useConfigExport';
import { useBridgeSettingsStorage } from './hooks/useBridgeSettingsStorage';
import { useHostStorage } from './hooks/useHostStorage';
import { useQuickActionStorage } from './hooks/useQuickActionStorage';
import { useShortcutActionStorage } from './hooks/useShortcutActionStorage';
import { useShortcutFrequencyStorage } from './hooks/useShortcutFrequencyStorage';
import { useSessionDraftStorage } from './hooks/useSessionDraftStorage';
import { useSessionHistoryStorage } from './hooks/useSessionHistoryStorage';
import { useOpenTabRuntime } from './hooks/useOpenTabRuntime';
import { useSessionOpenActions } from './hooks/useSessionOpenActions';
import { useAppPageState } from './hooks/useAppPageState';
import { useTerminalShellActions } from './hooks/useTerminalShellActions';
import { updateBridgeSettingsTerminalWidthMode } from './lib/terminal-width-mode-manager';
import { upsertBridgeServer } from './lib/bridge-settings';
import { applyTraversalRelaySettings } from './lib/traversal-relay-client';
import { APP_VERSION, APP_VERSION_CODE } from './lib/app-version';
import {
  connectTraversalRelayDevicesStream,
  readTraversalRelayAccountState,
  sendTraversalRelayClientDebugSnapshot,
  sendTraversalRelayClientDebugLogs,
} from './lib/traversal-relay-client';
import { collectClientDebugSnapshot, registerClientDebugSnapshotSource } from './lib/client-debug-snapshot';
import { runtimeDebug } from './lib/runtime-debug';
import { projectRelayDirectoryDeviceSnapshots } from './lib/relay-account-directory';
import { openTerminalPage } from './lib/page-state';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { ConnectionPropertiesPage } from './pages/ConnectionPropertiesPage';
import { SettingsPage } from './pages/SettingsPage';
import { TerminalPage } from './pages/TerminalPage';
import type { Host, TraversalRelayDeviceSnapshot } from './lib/types';

const RELAY_DEVICE_STREAM_RECONNECT_BASE_DELAY_MS = 300;
const RELAY_DEVICE_STREAM_RECONNECT_MAX_DELAY_MS = 5000;

function computeRelayDeviceStreamReconnectDelay(attempt: number) {
  return Math.min(
    RELAY_DEVICE_STREAM_RECONNECT_MAX_DELAY_MS,
    RELAY_DEVICE_STREAM_RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt),
  );
}

function projectRelayDevicesFromAccountState(account: ReturnType<typeof readTraversalRelayAccountState>) {
  if (!account) {
    return [];
  }
  const directoryDevices = projectRelayDirectoryDeviceSnapshots(account.directory);
  return directoryDevices.length > 0 ? directoryDevices : account.devices || [];
}

interface AppContentProps {
  bridgeSettings: ReturnType<typeof useBridgeSettingsStorage>['settings'];
  setBridgeSettings: ReturnType<typeof useBridgeSettingsStorage>['setSettings'];
  onForegroundActiveChange?: (active: boolean) => void;
}


export function AppContent({ bridgeSettings, setBridgeSettings, onForegroundActiveChange }: AppContentProps) {
  const [pendingPaneAttachIntent, setPendingPaneAttachIntent] = useState<{ sessionIds: string[]; paneId: string; nonce: number } | null>(null);
  const [relayDevices, setRelayDevices] = useState<TraversalRelayDeviceSnapshot[]>(() => projectRelayDevicesFromAccountState(readTraversalRelayAccountState()));
  const relayDeviceSocketRef = useRef<WebSocket | null>(null);
  const relayDeviceReconnectTimerRef = useRef<number | null>(null);
  const relayDeviceStreamGenerationRef = useRef(0);
  const {
    preferences: appUpdatePreferences,
    latestManifest,
    availableManifest,
    checking: updateChecking,
    installing: updateInstalling,
    lastError: updateError,
    updateStage,
    runtimeVersionCode,
    hasNewVersion,
    hasUpdateIgnorePolicy,
    setPreferences: setAppUpdatePreferences,
    checkForUpdates,
    dismissAvailableManifest,
    skipCurrentVersion,
    ignoreUntilManualCheck,
    resetIgnorePolicy,
    startUpdate,
    rollbackBackup,
    isRollingBack,
    rollbackToPreviousVersion,
  } = useAppUpdate();

  const {
    exporting: configExporting,
    importing: configImporting,
    lastError: _configExportError,
    exportConfig,
    importConfig,
  } = useConfigExport();

  // 同步 Relay 账号 store 变化（login/register/refresh）到 React state；
  // 设备流推送会继续通过 onDevices 覆盖，账号 store 仅作为登录即时快照。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => {
      const next = readTraversalRelayAccountState();
      setRelayDevices(projectRelayDevicesFromAccountState(next));
      const nextRelay = next?.relaySettings;
      if (!nextRelay) {
        return;
      }
      setBridgeSettings((current) => {
        const currentRelay = current.traversalRelay;
        if (
          currentRelay
          && currentRelay.accessToken === nextRelay.accessToken
          && currentRelay.relayBaseUrl === nextRelay.relayBaseUrl
          && currentRelay.wsDevicesUrl === nextRelay.wsDevicesUrl
        ) {
          return current;
        }
        return applyTraversalRelaySettings(current, nextRelay);
      });
    };
    window.addEventListener('traversal-relay-account-change', handler);
    return () => window.removeEventListener('traversal-relay-account-change', handler);
  }, [setBridgeSettings]);

  // relay-derived manifest injection is handled by app-update runtime only.
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
    setLiveSessionIds,
    resumeActiveSessionTransport,
    sendTerminalResize,
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
    getSessionScheduleState,
    getSessionRenderBufferStore,
  } = useSession();
  void sendMessageRaw;
  void onFileTransferMessage;
  const { hosts, isLoaded: hostsLoaded, addHost, updateHost, deleteHost } = useHostStorage();
  const { quickActions, setQuickActions } = useQuickActionStorage();
  const { shortcutActions, setShortcutActions } = useShortcutActionStorage();
  const shortcutFrequencyStorage = useShortcutFrequencyStorage();
  const { drafts: sessionDrafts, setDraft: setSessionDraft, clearDraft: clearSessionDraft, pruneDrafts } = useSessionDraftStorage();
  const { sessionGroups, setSessionGroupSelection, deleteSessionGroup, pruneSessionGroupSelectionToRemoteTruth } = useSessionHistoryStorage();
  const sessions = state.sessions;

  const ensureTerminalPageVisible = useCallback(() => {
    setPageState((current) => (
      current.kind === 'terminal'
        ? current
        : openTerminalPage()
    ));
  }, []);


  const {
    pageState,
    setPageState,
    editingHost,
    editingDraft,
    handleEdit,
    handleSaveHost,
    handleCancelHostForm,
    handleDelete,
    handleOpenConnectionsPage,
    handleOpenSettingsPage,
  } = useAppPageState({
    hosts,
    sessions,
    runtimeActiveSessionId: state.activeSessionId,
    addHost,
    updateHost,
    deleteHost,
    ensureTerminalPageVisible,
    syncSavedHostToServerPreset: (hostData) => {
      setBridgeSettings((current) => upsertBridgeServer(current, {
        name: hostData.name,
        targetHost: hostData.bridgeHost,
        targetPort: hostData.bridgePort,
        authToken: hostData.authToken,
        relayHostId: hostData.daemonHostId || hostData.relayHostId,
        relayDeviceId: hostData.relayDeviceId,
        relayDeviceName: hostData.name,
      }));
    },
  });

  useEffect(() => {
    const generation = relayDeviceStreamGenerationRef.current + 1;
    relayDeviceStreamGenerationRef.current = generation;
    let disposed = false;
    let reconnectAttempt = 0;

    const clearReconnectTimer = () => {
      if (relayDeviceReconnectTimerRef.current === null) {
        return;
      }
      window.clearTimeout(relayDeviceReconnectTimerRef.current);
      relayDeviceReconnectTimerRef.current = null;
    };

    const account = readTraversalRelayAccountState();
    if (!bridgeSettings.traversalRelay?.accessToken || !account?.accessToken || !account.relayBaseUrl) {
      clearReconnectTimer();
      relayDeviceSocketRef.current?.close(1000, 'relay disabled');
      relayDeviceSocketRef.current = null;
      setRelayDevices([]);
      return;
    }
    setRelayDevices(projectRelayDevicesFromAccountState(account));

    const scheduleReconnect = (reason: string) => {
      if (disposed || relayDeviceStreamGenerationRef.current !== generation || relayDeviceReconnectTimerRef.current !== null) {
        return;
      }
      const delayMs = computeRelayDeviceStreamReconnectDelay(reconnectAttempt);
      reconnectAttempt += 1;
      runtimeDebug('relay.device-stream.reconnect.scheduled', { reason, delayMs, attempt: reconnectAttempt });
      relayDeviceReconnectTimerRef.current = window.setTimeout(() => {
        relayDeviceReconnectTimerRef.current = null;
        openDeviceStream();
      }, delayMs);
    };

    const openDeviceStream = () => {
      if (disposed || relayDeviceStreamGenerationRef.current !== generation) {
        return;
      }
      const socket = connectTraversalRelayDevicesStream({
        account,
        onOpen: () => {
          reconnectAttempt = 0;
          runtimeDebug('relay.device-stream.open', { deviceId: account.deviceId });
        },
        onDevices: (devices) => {
          setRelayDevices(devices);
        },
        onDirectory: (directory) => {
          const directoryDevices = projectRelayDirectoryDeviceSnapshots(directory);
          if (directoryDevices.length > 0) {
            setRelayDevices(directoryDevices);
          }
        },
        onError: (message) => {
          runtimeDebug('relay.device-stream.error', { message });
        },
        onClose: (event) => {
          if (relayDeviceSocketRef.current === socket) {
            relayDeviceSocketRef.current = null;
          }
          const reason = event.reason || `relay device stream closed: ${event.code}`;
          runtimeDebug('relay.device-stream.close', { code: event.code, reason });
          scheduleReconnect(reason);
        },
        onDebugRequest: (payload, liveSocket) => {
          runtimeDebug('relay.device-stream.debug-request', {
            requestId: payload.requestId || null,
            reason: payload.reason || null,
            includeSnapshot: payload.includeSnapshot !== false,
            includeLogs: payload.includeLogs !== false,
            logLimit: payload.logLimit || null,
          });
          if (payload.includeSnapshot !== false) {
            sendTraversalRelayClientDebugSnapshot({
              socket: liveSocket,
              account,
              requestId: payload.requestId,
              reason: payload.reason || 'remote-request',
              snapshot: collectClientDebugSnapshot({
                requestId: payload.requestId || null,
                reason: payload.reason || null,
              }),
            });
          }
          if (payload.includeLogs !== false) {
            sendTraversalRelayClientDebugLogs({
              socket: liveSocket,
              account,
              limit: payload.logLimit || 120,
            });
          }
        },
      });
      relayDeviceSocketRef.current = socket;
    };

    openDeviceStream();

    return () => {
      disposed = true;
      clearReconnectTimer();
      const socket = relayDeviceSocketRef.current;
      try {
        socket?.close(1000, 'app relay runtime disposed');
      } catch (error) {
        console.error('[App] Failed to close relay device stream:', error);
      }
      if (relayDeviceSocketRef.current === socket) {
        relayDeviceSocketRef.current = null;
      }
    };
  }, [bridgeSettings.traversalRelay?.accessToken, bridgeSettings.traversalRelay?.relayBaseUrl]);

  const {
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
  } = useOpenTabRuntime({
    bridgeSettings,
    hosts,
    hostsLoaded,
    restoreSwitchReason: pageState.kind === 'terminal' ? 'explicit-resume' : 'restore-sync',
    sessions,
    sessionGroups,
    runtimeActiveSessionId: state.activeSessionId,
    createSession,
    closeSession,
    switchSession,
    moveSession,
    renameSession,
    reconnectSession,
    resumeActiveSessionTransport,
    clearSessionDraft,
    ensureTerminalPageVisible,
    setPageState,
    pruneSessionGroupSelectionToRemoteTruth,
    onForegroundActiveChange,
  });

  useEffect(() => registerClientDebugSnapshotSource('app-shell', () => ({
    page: pageState.kind,
    activeRuntimeSessionId: state.activeSessionId,
    runtimeSessionIds: state.sessions.map((session) => session.id),
    terminalSessionIds: sessionIds,
    terminalActiveSessionId: terminalActiveSession?.id || null,
    relayConfigured: Boolean(bridgeSettings.traversalRelay?.accessToken),
    runtimeVersionCode,
    appUpdateStage: appUpdatePreferences.manifestUrl.trim() ? updateStage : 'idle',
    updateChecking,
    updateInstalling,
    updateError,
    updateManifestUrlConfigured: Boolean(appUpdatePreferences.manifestUrl.trim()),
    updateAutoCheckOnLaunch: Boolean(appUpdatePreferences.autoCheckOnLaunch),
    latestManifestVersionCode: latestManifest?.versionCode || null,
    latestManifestVersionName: latestManifest?.versionName || null,
    availableManifestVersionCode: availableManifest?.versionCode || null,
    availableManifestVersionName: availableManifest?.versionName || null,
  })), [
    appUpdatePreferences.autoCheckOnLaunch,
    appUpdatePreferences.manifestUrl,
    availableManifest?.versionCode,
    availableManifest?.versionName,
    bridgeSettings.traversalRelay?.accessToken,
    latestManifest?.versionCode,
    latestManifest?.versionName,
    pageState.kind,
    runtimeVersionCode,
    sessionIds,
    state.activeSessionId,
    state.sessions,
    terminalActiveSession?.id,
    updateChecking,
    updateError,
    updateInstalling,
    updateStage,
  ]);

  const handleOpenConnectionsPageWithAudit = useCallback(() => {
    handleOpenConnectionsPage();
    void auditOpenTabsAgainstRemoteSessions('connections-page-open').catch((error) => {
      console.error('[App] Failed to audit remote session truth on connections page open:', error);
    });
  }, [auditOpenTabsAgainstRemoteSessions, handleOpenConnectionsPage]);


  const {
    inputResetEpochBySession,
    handleTerminalInput,
    handleTerminalViewportChange,
    handleTerminalResize,
    handleTerminalWidthModeChange,
    handleQuickActionInput,
    handleSessionDraftChange,
    handleSessionDraftSend,
    sessionRenderBufferStore,
    shortcutFrequencyMap,
    handleShortcutUse,
  } = useTerminalShellActions({
    sendInput,
    updateSessionViewport,
    sendTerminalResize,
    getSessionRenderBufferStore,
    setSessionDraft,
    clearSessionDraft,
    pruneDrafts,
    sessionIds,
    runtimeRefs,
    handleSwitchSession,
    bridgeSettings,
    shortcutFrequencyStorage,
  });
  const {
    pickerMode,
    pickerTarget,
    pickerInitialSessions,
    handleLoadSavedTabList,
    handleOpenQuickTabPicker,
    handleOpenSingleTmuxSession,
    handleOpenMultipleTmuxSessions,
    handleOpenGroupSession,
    handleOpenServerGroups,
    handleEditServerGroup,
    handleSaveServerGroupSelection,
    handleDeleteServerGroup,
    handleSelectCleanSession,
    handleRemoteSessionsRefreshed,
    closePicker,
  } = useSessionOpenActions({
    bridgeSettings,
    setBridgeSettings,
    hosts,
    relayDevices,
    deleteSessionGroup,
    pruneSessionGroupSelectionToRemoteTruth,
    setSessionGroupSelection,
    createSession,
    runtimeActiveSessionId: state.activeSessionId,
    runtimeRefs,
    ensureTerminalPageVisible,
    applyOpenTabState,
    onSessionsOpenedInPane: (sessionIds, paneId) => {
      const normalizedSessionIds = [...new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean))];
      const normalizedPaneId = paneId.trim();
      if (normalizedSessionIds.length === 0 || !normalizedPaneId) {
        console.error('[App] Refused to queue pane-attach intent without explicit sessionIds/paneId.', {
          sessionIds,
          paneId,
        });
        return;
      }
      setPendingPaneAttachIntent({
        sessionIds: normalizedSessionIds,
        paneId: normalizedPaneId,
        nonce: Date.now(),
      });
    },
    setPageState,
    auditOpenTabsAgainstRemoteSessions,
  });

  const handleForceRelaySession = useCallback((sessionId: string) => {
    const tab = openTabState.tabs.find((item) => item.sessionId === sessionId);
    const liveSession = sessions.find((item) => item.id === sessionId) || null;
    const canonicalRelayHostId = tab
      ? (
        bridgeSettings.servers.find((server) => (
          server.id === bridgeSettings.defaultServerId
          && server.targetHost === tab.bridgeHost
          && server.targetPort === tab.bridgePort
          && server.relayHostId?.trim()
        ))?.relayHostId?.trim()
        || bridgeSettings.servers.find((server) => (
          server.targetHost === tab.bridgeHost
          && server.targetPort === tab.bridgePort
          && server.relayHostId?.trim()
          && server.relayDeviceId?.trim()
        ))?.relayHostId?.trim()
        || ''
      )
      : '';
    const relayHostId = canonicalRelayHostId || tab?.daemonHostId?.trim() || liveSession?.daemonHostId?.trim() || '';
    if (!bridgeSettings.traversalRelay?.accessToken) {
      window.alert?.('请先在 Settings 登录 Relay 控制面。');
      return;
    }
    if (!tab || !relayHostId) {
      window.alert?.('当前 tab 缺少 daemonHostId，无法强制 Relay。请从 Relay Daemon 设备重新打开。');
      return;
    }

    const relayHost: Host = {
      id: tab.hostId || `force-relay:${tab.bridgeHost}:${tab.bridgePort}:${tab.sessionName}`,
      createdAt: tab.createdAt || Date.now(),
      name: tab.connectionName || tab.sessionName,
      bridgeHost: tab.bridgeHost,
      bridgePort: tab.bridgePort,
      daemonHostId: relayHostId,
      relayHostId,
      sessionName: tab.sessionName,
      authToken: tab.authToken,
      autoCommand: tab.autoCommand,
      transportMode: 'webrtc',
      authType: 'password',
      tags: [],
      pinned: false,
      lastConnected: Date.now(),
    };
    runtimeDebug('app.session.force-relay', {
      sessionId,
      relayHostId,
      sessionName: relayHost.sessionName,
      bridgeHost: relayHost.bridgeHost,
      bridgePort: relayHost.bridgePort,
    });
    closeSession(sessionId);
    window.setTimeout(() => {
      createSession(relayHost, {
        sessionId,
        createdAt: tab.createdAt,
        customName: tab.customName,
      });
      switchSession(sessionId);
      ensureTerminalPageVisible();
    }, 0);
  }, [bridgeSettings.traversalRelay?.accessToken, closeSession, createSession, ensureTerminalPageVisible, openTabState.tabs, sessions, switchSession]);

  const handleUseAutoSession = useCallback((sessionId: string) => {
    const tab = openTabState.tabs.find((item) => item.sessionId === sessionId);
    const liveSession = sessions.find((item) => item.id === sessionId) || null;
    if (!tab) {
      window.alert?.('当前 tab 缺少连接信息，无法切回 Auto。请从连接列表重新打开。');
      return;
    }
    const relayHostId = tab.daemonHostId?.trim() || liveSession?.daemonHostId?.trim() || '';
    const autoHost: Host = {
      id: tab.hostId || `auto:${tab.bridgeHost}:${tab.bridgePort}:${tab.sessionName}`,
      createdAt: tab.createdAt || Date.now(),
      name: tab.connectionName || tab.sessionName,
      bridgeHost: tab.bridgeHost,
      bridgePort: tab.bridgePort,
      daemonHostId: relayHostId || undefined,
      relayHostId: relayHostId || undefined,
      sessionName: tab.sessionName,
      authToken: tab.authToken,
      autoCommand: tab.autoCommand,
      transportMode: 'auto',
      authType: 'password',
      tags: [],
      pinned: false,
      lastConnected: Date.now(),
    };
    runtimeDebug('app.session.use-auto', {
      sessionId,
      relayHostId: relayHostId || null,
      sessionName: autoHost.sessionName,
      bridgeHost: autoHost.bridgeHost,
      bridgePort: autoHost.bridgePort,
    });
    closeSession(sessionId);
    window.setTimeout(() => {
      createSession(autoHost, {
        sessionId,
        createdAt: tab.createdAt,
        customName: tab.customName,
      });
      switchSession(sessionId);
      ensureTerminalPageVisible();
    }, 0);
  }, [closeSession, createSession, ensureTerminalPageVisible, openTabState.tabs, sessions, switchSession]);


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
            bridgeSettings={bridgeSettings}
            hosts={hosts}
            sessions={terminalSessions}
            sessionGroups={sessionGroups}
            relayDevices={relayDevices}
            onResumeSession={handleResumeSession}
            onCloseSession={handleCloseSession}
            onOpenGroupSession={handleOpenGroupSession}
            onOpenServerGroups={handleOpenServerGroups}
            onEditServerGroup={handleEditServerGroup}
            onSaveServerGroupSelection={handleSaveServerGroupSelection}
            onDeleteServerGroup={handleDeleteServerGroup}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onOpenSettings={handleOpenSettingsPage}
            onOpenVaults={handleOpenSettingsPage}
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
            currentVersionName={APP_VERSION}
            currentVersionCode={APP_VERSION_CODE}
            updatePreferences={appUpdatePreferences}
            latestManifest={latestManifest}
            updateChecking={updateChecking}
            updateInstalling={updateInstalling}
            updateError={updateError}
            hasNewVersion={hasNewVersion}
            hasUpdateIgnorePolicy={hasUpdateIgnorePolicy}
            onSave={(next) => {
              setBridgeSettings((current) => ({
                ...applyTraversalRelaySettings(next, next.traversalRelay),
                signalUrl: '',
                turnServerUrl: '',
                turnUsername: '',
                turnCredential: '',
                terminalWidthMode: updateBridgeSettingsTerminalWidthMode(current, next.terminalWidthMode).terminalWidthMode,
              }));
              handleOpenConnectionsPageWithAudit();
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
            onExportConfig={() => { void exportConfig(); }}
            onImportConfig={() => { void importConfig(); }}
            configExporting={configExporting}
            configImporting={configImporting}
            rollbackBackup={rollbackBackup}
            isRollingBack={isRollingBack}
            onRollback={() => {
              void rollbackToPreviousVersion();
            }}
            onTerminalThemeChange={(themeId) => {
              setBridgeSettings((current) => ({
                ...current,
                terminalThemeId: themeId,
              }));
            }}
            onBack={handleOpenConnectionsPageWithAudit}
          />
        )}

        {pageState.kind === 'terminal' && (
          <TerminalPage
            sessions={terminalSessions}
            sessionGroups={sessionGroups}
            activeSession={terminalActiveSession}
            getSessionDebugMetrics={getSessionDebugMetrics}
            sessionBufferStore={sessionRenderBufferStore}
            onSwitchSession={handleSwitchSession}
            onMoveSession={handleMoveSession}
            onRenameSession={handleRenameSession}
            onCloseSession={handleCloseSession}
            onForceRelaySession={handleForceRelaySession}
            onUseAutoSession={handleUseAutoSession}
            onOpenConnections={handleOpenConnectionsPageWithAudit}
            onOpenQuickTabPicker={handleOpenQuickTabPicker}
            relayDevices={relayDevices}
            sessionPickerDebugMode={pickerMode}
            pendingPaneAttachIntent={pendingPaneAttachIntent}
            onPaneAttachIntentApplied={(intent) => {
              setPendingPaneAttachIntent((current) => (
                current
                && current.nonce === intent.nonce
                && current.paneId === intent.paneId
                && current.sessionIds.join('||') === intent.sessionIds.join('||')
                  ? null
                  : current
              ));
            }}
            onResize={handleTerminalResize}
            onTerminalInput={handleTerminalInput}
            onTerminalViewportChange={handleTerminalViewportChange}
            onTerminalWidthModeChange={handleTerminalWidthModeChange}
            onLiveSessionIdsChange={setLiveSessionIds}
            inputResetEpochBySession={inputResetEpochBySession}
            followResetEpoch={followResetEpoch}
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
            getScheduleState={getSessionScheduleState}
            onRequestScheduleList={requestScheduleList}
            onUpsertScheduleJob={upsertScheduleJob}
            onDeleteScheduleJob={deleteScheduleJob}
            onToggleScheduleJob={toggleScheduleJob}
            onRunScheduleJobNow={runScheduleJobNow}
            terminalThemeId={bridgeSettings.terminalThemeId}
            terminalWidthMode={bridgeSettings.terminalWidthMode}
            terminalSessionGroupLayoutMode={bridgeSettings.terminalSessionGroupLayoutMode}
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
        openTabs={openTabState.tabs.map((tab) => ({
          id: tab.sessionId,
          sessionName: tab.sessionName,
          customName: tab.customName,
          bridgeHost: tab.bridgeHost,
          bridgePort: tab.bridgePort,
          daemonHostId: tab.daemonHostId,
        }))}
        activeTabId={openTabState.activeSessionId}
        initialTarget={pickerTarget}
        initialSelectedSessions={pickerInitialSessions}
        onClose={closePicker}
        onSwitchOpenTab={handleSwitchSession}
        onRenameOpenTab={handleRenameSession}
        onCloseOpenTab={handleCloseSession}
        onOpenTmuxSession={handleOpenSingleTmuxSession}
        onOpenMultipleTmuxSessions={handleOpenMultipleTmuxSessions}
        onSelectCleanSession={handleSelectCleanSession}
        onSaveGroupSelection={(target, sessionNames) => {
          handleSaveServerGroupSelection(target, sessionNames);
          closePicker();
        }}
        onRemoteSessionsRefreshed={(target, sessionNames) => {
          handleRemoteSessionsRefreshed(target, sessionNames);
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
