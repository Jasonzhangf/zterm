/**
 * App - 主应用入口
 * 只负责页面级切换与跨页 orchestration。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { TmuxSessionPickerSheet } from './components/tmux/TmuxSessionPickerSheet';
import { SessionProvider, useSession } from './contexts/SessionContext';
import { useAppUpdate } from './hooks/useAppUpdate';
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
import { openTerminalPage } from './lib/page-state';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { ConnectionPropertiesPage } from './pages/ConnectionPropertiesPage';
import { SettingsPage } from './pages/SettingsPage';
import { TerminalPage } from './pages/TerminalPage';

interface AppContentProps {
  bridgeSettings: ReturnType<typeof useBridgeSettingsStorage>['settings'];
  setBridgeSettings: ReturnType<typeof useBridgeSettingsStorage>['setSettings'];
  onForegroundActiveChange?: (active: boolean) => void;
}


export function AppContent({ bridgeSettings, setBridgeSettings, onForegroundActiveChange }: AppContentProps) {
  const [pendingPaneAttachIntent, setPendingPaneAttachIntent] = useState<{ sessionIds: string[]; paneId: string; nonce: number } | null>(null);
  const relayDeviceSocketRef = useRef<WebSocket | null>(null);
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
  });

  useEffect(() => {
    const account = readTraversalRelayAccountState();
    if (!bridgeSettings.traversalRelay?.accessToken || !account?.accessToken || !account.relayBaseUrl) {
      relayDeviceSocketRef.current?.close(1000, 'relay disabled');
      relayDeviceSocketRef.current = null;
      return;
    }

    const socket = connectTraversalRelayDevicesStream({
      account,
      onDevices: () => {},
      onError: (message) => {
        runtimeDebug('relay.device-stream.error', { message });
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

    return () => {
      try {
        socket.close(1000, 'app relay runtime disposed');
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
    handleAddNew,
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
            hosts={hosts}
            sessions={terminalSessions}
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
            activeSession={terminalActiveSession}
            getSessionDebugMetrics={getSessionDebugMetrics}
            sessionBufferStore={sessionRenderBufferStore}
            onSwitchSession={handleSwitchSession}
            onMoveSession={handleMoveSession}
            onRenameSession={handleRenameSession}
            onCloseSession={handleCloseSession}
            onOpenConnections={handleOpenConnectionsPageWithAudit}
            onOpenQuickTabPicker={handleOpenQuickTabPicker}
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
        openTabs={openTabState.tabs.map((tab) => ({
          id: tab.sessionId,
          sessionName: tab.sessionName,
          customName: tab.customName,
          bridgeHost: tab.bridgeHost,
          bridgePort: tab.bridgePort,
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
