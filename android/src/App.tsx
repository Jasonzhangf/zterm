/**
 * App - 主应用入口
 * 只负责页面级切换与跨页 orchestration。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { parseConnectionConfigShareLink } from '@zterm/shared';
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
import { useRelayDeviceStream } from './hooks/useRelayDeviceStream';
import { updateBridgeSettingsTerminalWidthMode } from './lib/terminal-width-mode-manager';
import { upsertBridgeServer } from './lib/bridge-settings';
import { applyTraversalRelaySettings } from './lib/traversal-relay-client';
import { APP_VERSION, APP_VERSION_CODE } from './lib/app-version';
import { registerClientDebugSnapshotSource } from './lib/client-debug-snapshot';
import { openConnectionsPage, openTerminalPage } from './lib/page-state';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { ConnectionPropertiesPage } from './pages/ConnectionPropertiesPage';
import { SettingsPage } from './pages/SettingsPage';
import { TerminalPage } from './pages/TerminalPage';
import { projectHomeSavedConnections } from './lib/home-connection-projection';
import type { TerminalWidthMode } from './lib/types';
import { useBackgroundLiveSessionHandoff } from './hooks/useOpenTabLifecycleEffects';

interface AppContentProps {
  bridgeSettings: ReturnType<typeof useBridgeSettingsStorage>['settings'];
  setBridgeSettings: ReturnType<typeof useBridgeSettingsStorage>['setSettings'];
  appForegroundActive?: boolean;
  onForegroundActiveChange?: (active: boolean) => void;
  onForegroundResume?: (reason: 'visibilitychange' | 'resume' | 'appStateChange') => void;
}


export function AppContent({
  bridgeSettings,
  setBridgeSettings,
  appForegroundActive = true,
  onForegroundActiveChange,
  onForegroundResume,
}: AppContentProps) {
  const [pendingPaneAttachIntent, setPendingPaneAttachIntent] = useState<{ sessionIds: string[]; paneId: string; nonce: number } | null>(null);
  const { relayDevices, refreshControlDirectory } = useRelayDeviceStream({
    bridgeSettings,
    setBridgeSettings,
  });
  const handleForegroundResumeAfterControlRefresh = useCallback((reason: 'visibilitychange' | 'resume' | 'appStateChange') => {
    void refreshControlDirectory('foreground-resume');
    onForegroundResume?.(reason);
  }, [onForegroundResume, refreshControlDirectory]);
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
    applyRelayManifestSource,
    rollbackBackup,
    isRollingBack,
    rollbackToPreviousVersion,
    rollbackToPreviousEntry,
  } = useAppUpdate();

  const {
    exporting: configExporting,
    importing: configImporting,
    lastError: _configExportError,
    exportConfig,
    importConfig,
  } = useConfigExport();

  useEffect(() => {
    const wsHostUrl = bridgeSettings.traversalRelay?.wsHostUrl?.trim() || '';
    if (!wsHostUrl) {
      return;
    }
    applyRelayManifestSource(wsHostUrl);
  }, [applyRelayManifestSource, bridgeSettings.traversalRelay?.wsHostUrl]);

  // relay-derived manifest URL parsing is handled by app-update runtime only.
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
    setActiveBodySubscriptionSuppressed,
    resumeActiveSessionTransport,
    notifyTargetNetworkSignal,
    sendTerminalResize,
    sendInput,
    sendImagePaste,
    sendFileAttach,
    requestRemoteScreenshot,
    requestRemoteWindowTargets,
    requestRemoteWindowStreamStart,
    updateRemoteWindowStreamQuality,
    stopRemoteWindowStream,
    sendRemoteWindowInput,
    resizeRemoteWindowTarget,
    sendMessageRaw,
    manageTmuxSessionsOnOpenTransport,
    onFileTransferMessage,
    onRemoteWindowMessage,
    updateSessionViewport,
    requestScheduleList,
    upsertScheduleJob,
    deleteScheduleJob,
    toggleScheduleJob,
    runScheduleJobNow,
    getSessionScheduleState,
    getSessionRenderBufferStore,
    recordBackgroundEnteredAt,
  } = useSession();
  void sendMessageRaw;
  void onFileTransferMessage;
  const { hosts, isLoaded: hostsLoaded, addHost, upsertHost, updateHost, deleteHost } = useHostStorage();
  const homeSavedConnections = useMemo(
    () => projectHomeSavedConnections(hosts, bridgeSettings, relayDevices),
    [bridgeSettings, hosts, relayDevices],
  );
  const { quickActions, setQuickActions } = useQuickActionStorage();
  const { shortcutActions, setShortcutActions } = useShortcutActionStorage();
  const shortcutFrequencyStorage = useShortcutFrequencyStorage();
  const { drafts: sessionDrafts, setDraft: setSessionDraft, clearDraft: clearSessionDraft, pruneDrafts } = useSessionDraftStorage();
  const { sessionGroups, setSessionGroupSelection, markSessionGroupEntered, deleteSessionGroup, pruneSessionGroupSelectionToRemoteTruth } = useSessionHistoryStorage();
  const sessions = state.sessions;

  useBackgroundLiveSessionHandoff({
    appForegroundActive,
    liveSessionIds: state.liveSessionIds || [],
    setActiveBodySubscriptionSuppressed,
    setLiveSessionIds,
  });

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
    handleSaveHost,
    handleCancelHostForm,
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

  const handleImportConnectionShareLink = useCallback((input: string) => {
    const parsed = parseConnectionConfigShareLink(input);
    if (!parsed.ok) {
      return parsed;
    }
    const importedHosts = parsed.hosts.map((host) => upsertHost(host));
    if (parsed.quickActions.length > 0) {
      setQuickActions(parsed.quickActions);
    }
    if (parsed.shortcutActions.length > 0) {
      setShortcutActions(parsed.shortcutActions);
    }
    setBridgeSettings((current) => importedHosts.reduce((settings, importedHost) => upsertBridgeServer(settings, {
        name: importedHost.name,
        targetHost: importedHost.bridgeHost,
        targetPort: importedHost.bridgePort,
        authToken: importedHost.authToken,
        relayHostId: importedHost.daemonHostId || importedHost.relayHostId,
        relayDeviceId: importedHost.relayDeviceId,
        relayDeviceName: importedHost.name,
      }), current));
    setPageState(openConnectionsPage());
    return {
      ok: true as const,
      name: [
        importedHosts.length === 1 ? importedHosts[0]!.name : `${importedHosts.length} 个连接`,
        parsed.quickActions.length > 0 ? `${parsed.quickActions.length} 个文本快捷指令` : '',
        parsed.shortcutActions.length > 0 ? `${parsed.shortcutActions.length} 个终端快捷键` : '',
      ].filter(Boolean).join('，'),
    };
  }, [setBridgeSettings, setPageState, setQuickActions, setShortcutActions, upsertHost]);

  useEffect(() => {
    let disposed = false;
    let listenerHandle: { remove: () => Promise<void> | void } | null = null;
    const listenerResult = CapacitorApp.addListener('appUrlOpen', (event) => {
        const url = typeof event.url === 'string' ? event.url : '';
        if (!url.startsWith('zterm://connection/import') && !url.startsWith('https://zterm.app/connection/import')) {
          return;
        }
        const result = handleImportConnectionShareLink(url);
        if (!result.ok) {
          alert(`Connection import failed: ${result.error}`);
          return;
        }
        alert(`Imported connection: ${result.name}`);
      });
    void Promise.resolve(listenerResult).then((handle) => {
        if (!handle) {
          return;
        }
        if (disposed) {
          void handle.remove();
          return;
        }
        listenerHandle = handle;
      }).catch((error) => {
      alert(`Connection deep link listener failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return () => {
      disposed = true;
      if (listenerHandle) {
        void listenerHandle.remove();
      }
    };
  }, [handleImportConnectionShareLink]);

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
    auditOpenTabsAgainstRemoteSessions,
  } = useOpenTabRuntime({
    bridgeSettings,
    hosts: homeSavedConnections,
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
    notifyTargetNetworkSignal,
    manageTmuxSessionsOnOpenTransport,
    clearSessionDraft,
    ensureTerminalPageVisible,
    setPageState,
    pruneSessionGroupSelectionToRemoteTruth,
    onForegroundActiveChange,
    onForegroundResume: handleForegroundResumeAfterControlRefresh,
    recordBackgroundEnteredAt,
    sendBackgroundHeartbeat: () => {
      for (const session of sessions) {
        if (session.state !== 'closed') {
          sendMessageRaw(session.id, { type: 'ping' });
        }
      }
    },
  });

  const markRuntimeSessionEntered = useCallback((sessionId: string) => {
    const session = runtimeRefs.sessionsRef.current.find((candidate) => candidate.id === sessionId) || null;
    if (!session || session.state === 'closed' || !session.sessionName.trim()) {
      return;
    }
    markSessionGroupEntered({
      name: session.connectionName || session.bridgeHost || session.daemonHostId || session.sessionName,
      bridgeHost: session.bridgeHost,
      bridgePort: session.bridgePort,
      daemonHostId: session.daemonHostId,
      authToken: session.authToken,
    }, session.sessionName);
  }, [markSessionGroupEntered, runtimeRefs.sessionsRef]);

  const handleSwitchSessionWithHistory = useCallback((sessionId: string) => {
    markRuntimeSessionEntered(sessionId);
    handleSwitchSession(sessionId);
  }, [handleSwitchSession, markRuntimeSessionEntered]);

  useEffect(() => registerClientDebugSnapshotSource('app-shell', () => ({
    page: pageState.kind,
    activeRuntimeSessionId: state.activeSessionId,
    runtimeSessionIds: state.sessions.map((session) => session.id),
    terminalSessionIds: sessionIds,
    terminalActiveSessionId: terminalActiveSession?.id || null,
    terminalActiveSessionRoute: {
      resolvedPath: terminalActiveSession?.resolvedPath || null,
      resolvedRelayTransport: terminalActiveSession?.resolvedRelayTransport || null,
      resolvedEndpoint: terminalActiveSession?.resolvedEndpoint || null,
      selectedIcePair: terminalActiveSession?.selectedIcePair || null,
      lastConnectStage: terminalActiveSession?.lastConnectStage || null,
      lastError: terminalActiveSession?.lastError || null,
    },
    relayConfigured: Boolean(bridgeSettings.traversalRelay?.accessToken),
    runtimeVersionCode,
    appUpdateStage: appUpdatePreferences.manifestUrl.trim() ? updateStage : 'idle',
    updateChecking,
    updateInstalling,
    updateError,
    updateManifestUrlConfigured: Boolean(appUpdatePreferences.manifestUrl.trim()),
    updateManifestSource: appUpdatePreferences.manifestSource || 'none',
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
    handleTerminalWidthModeChange: sendTerminalWidthModeChange,
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
    handleSwitchSession: handleSwitchSessionWithHistory,
    bridgeSettings,
    shortcutFrequencyStorage,
  });
  const handleTerminalWidthModeChange = useCallback((sessionId: string, mode: TerminalWidthMode, cols?: number | null) => {
    setBridgeSettings((current) => updateBridgeSettingsTerminalWidthMode(current, mode));
    sendTerminalWidthModeChange(sessionId, mode, cols);
  }, [sendTerminalWidthModeChange, setBridgeSettings]);
  const {
    pickerMode,
    pickerTarget,
    pickerInitialSessions,
    handleOpenSavedConnection,
    handleOpenQuickTabPicker,
    handleOpenSingleTmuxSession,
    handleOpenMultipleTmuxSessions,
    handleOpenGroupSession,
    handleCloseGroupSession,
    handleSaveServerGroupSelection,
    handleSelectCleanSession,
    handleRemoteSessionsRefreshed,
    handleRefreshDrawerHostSessions,
    handleForceRelaySession,
    handleUseAutoSession,
    handleUseWebSocketSession,
    closePicker,
  } = useSessionOpenActions({
    bridgeSettings,
    setBridgeSettings,
    hosts,
    sessionGroups,
    relayDevices,
    deleteSessionGroup,
    pruneSessionGroupSelectionToRemoteTruth,
    setSessionGroupSelection,
    markSessionGroupEntered,
    createSession,
    closeSession,
    switchSession,
    manageTmuxSessionsOnOpenTransport,
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

  const handleResumeHomeSession = useCallback((sessionId: string) => {
    handleSwitchSessionWithHistory(sessionId);
    ensureTerminalPageVisible();
  }, [ensureTerminalPageVisible, handleSwitchSessionWithHistory]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: '#edf2f6',
        display: 'flex',
        justifyContent: 'center',
        overflow: 'hidden',
        overscrollBehavior: 'none',
      }}
    >
      <div style={{ width: '100%', height: '100%', overflow: 'hidden' }}>
        {pageState.kind === 'connections' && (
          <ConnectionsPage
            savedConnections={homeSavedConnections}
            activeSessions={terminalSessions}
            activeSessionId={terminalActiveSession?.id || null}
            onResumeSession={handleResumeHomeSession}
            onOpenSavedConnection={handleOpenSavedConnection}
            onOpenSettings={handleOpenSettingsPage}
          />
        )}

        {pageState.kind === 'connection-properties' && (
          <ConnectionPropertiesPage
            host={editingHost}
            draft={editingDraft}
            shareableHosts={hosts}
            quickActions={quickActions}
            shortcutActions={shortcutActions}
            bridgeSettings={bridgeSettings}
            onImportConnectionLink={handleImportConnectionShareLink}
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
              setBridgeSettings(() => ({
                ...applyTraversalRelaySettings(next, next.traversalRelay),
                signalUrl: '',
                turnServerUrl: '',
                turnUsername: '',
                turnCredential: '',
                terminalWidthMode: updateBridgeSettingsTerminalWidthMode(next, next.terminalWidthMode).terminalWidthMode,
              }));
              handleOpenConnectionsPageWithAudit();
            }}
            onRelaySettingsChange={(relaySettings) => {
              setBridgeSettings((current) => applyTraversalRelaySettings(current, relaySettings));
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
            onExportConfig={() => {
              void exportConfig().then((result) => {
                if (result.ok) {
                  alert(`配置已导出：${result.uri || result.path}`);
                  return;
                }
                alert(`配置导出失败：${result.error}`);
              });
            }}
            onImportConfig={() => {
              void importConfig().then((result) => {
                if (result.ok) {
                  alert(`配置已导入：${result.path}`);
                  globalThis.location?.reload();
                  return;
                }
                alert(`配置导入失败：${result.error}`);
              });
            }}
            configExporting={configExporting}
            configImporting={configImporting}
            rollbackBackup={rollbackBackup}
            isRollingBack={isRollingBack}
            onRollback={() => {
              void rollbackToPreviousVersion();
            }}
            rollbackToPreviousEntry={rollbackToPreviousEntry}
            onRollbackToPrevious={() => {
              void rollbackToPreviousVersion();
            }}
            onTerminalThemeChange={(themeId) => {
              setBridgeSettings((current) => ({
                ...current,
                terminalThemeId: themeId,
              }));
            }}
            onTerminalShellSkinChange={(skin) => {
              setBridgeSettings((current) => ({
                ...current,
                terminalShellSkin: skin,
              }));
            }}
            onBack={handleOpenConnectionsPageWithAudit}
          />
        )}

        {pageState.kind === 'terminal' && (
          <TerminalPage
            appForegroundActive={appForegroundActive}
            sessions={terminalSessions}
            sessionGroups={sessionGroups}
            activeSession={terminalActiveSession}
            getSessionDebugMetrics={getSessionDebugMetrics}
            sessionBufferStore={sessionRenderBufferStore}
            onSwitchSession={handleSwitchSessionWithHistory}
            onMoveSession={handleMoveSession}
            onRenameSession={handleRenameSession}
            onCloseSession={handleCloseSession}
            onForceRelaySession={handleForceRelaySession}
            onUseAutoSession={handleUseAutoSession}
            onUseWebSocketSession={handleUseWebSocketSession}
            onOpenConnections={handleOpenConnectionsPageWithAudit}
            onOpenQuickTabPicker={handleOpenQuickTabPicker}
            onOpenDrawerRemoteSession={handleOpenGroupSession}
            onCloseDrawerRemoteSession={handleCloseGroupSession}
            onRefreshDrawerHostSessions={handleRefreshDrawerHostSessions}
            onAuditOpenTabsAgainstRemoteSessions={auditOpenTabsAgainstRemoteSessions}
            relayDevices={relayDevices}
            serverIdentityAliasInputs={homeSavedConnections}
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
            onActiveBodySubscriptionSuppressedChange={setActiveBodySubscriptionSuppressed}
            inputResetEpochBySession={inputResetEpochBySession}
            followResetEpoch={followResetEpoch}
            onImagePaste={sendImagePaste}
            onFileAttach={sendFileAttach}
            onOpenSettings={handleOpenSettingsPage}
            onRequestRemoteScreenshot={requestRemoteScreenshot}
            onRequestRemoteWindowTargets={requestRemoteWindowTargets}
            onRequestRemoteWindowStreamStart={requestRemoteWindowStreamStart}
            onUpdateRemoteWindowStreamQuality={updateRemoteWindowStreamQuality}
            onStopRemoteWindowStream={stopRemoteWindowStream}
            onSendRemoteWindowInput={sendRemoteWindowInput}
            onResizeRemoteWindowTarget={resizeRemoteWindowTarget}
            quickActions={quickActions}
            shortcutActions={shortcutActions}
            onQuickActionInput={handleQuickActionInput}
            onQuickActionsChange={setQuickActions}
            onShortcutActionsChange={setShortcutActions}
            sessionDraft={terminalActiveSession ? (sessionDrafts[terminalActiveSession.id] || '') : ''}
            sessionDrafts={sessionDrafts}
            onSessionDraftChange={handleSessionDraftChange}
            onSessionDraftSend={handleSessionDraftSend}
            scheduleState={terminalActiveSession ? scheduleStates[terminalActiveSession.id] || null : null}
            getScheduleState={getSessionScheduleState}
            onRequestScheduleList={requestScheduleList}
            onUpsertScheduleJob={upsertScheduleJob}
            onDeleteScheduleJob={deleteScheduleJob}
            onToggleScheduleJob={toggleScheduleJob}
            onRunScheduleJobNow={runScheduleJobNow}
            terminalThemeId={bridgeSettings.terminalThemeId}
            terminalShellSkin={bridgeSettings.terminalShellSkin}
            terminalWidthMode={bridgeSettings.terminalWidthMode}
            terminalSessionGroupLayoutMode={bridgeSettings.terminalSessionGroupLayoutMode}
            onSendMessage={sendMessageRaw}
            onFileTransferMessage={onFileTransferMessage}
            onRemoteWindowMessage={onRemoteWindowMessage}
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
        onSwitchOpenTab={handleSwitchSessionWithHistory}
        onRenameOpenTab={handleRenameSession}
        onCloseOpenTab={handleCloseSession}
        onOpenTmuxSession={handleOpenSingleTmuxSession}
            onOpenMultipleTmuxSessions={handleOpenMultipleTmuxSessions}
            onSelectCleanSession={handleSelectCleanSession}
            shareableHosts={hosts}
            quickActions={quickActions}
            shortcutActions={shortcutActions}
            onImportConnectionLink={handleImportConnectionShareLink}
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
  const [foregroundResumeEpoch, setForegroundResumeEpoch] = useState(0);
  const handleForegroundResume = useCallback(() => {
    setForegroundResumeEpoch((current) => current + 1);
  }, []);

  return (
    <SessionProvider
      terminalCacheLines={bridgeSettings.terminalCacheLines}
      bridgeSettings={bridgeSettings}
      appForegroundActive={appForegroundActive}
      foregroundResumeEpoch={foregroundResumeEpoch}
    >
      <AppContent
        bridgeSettings={bridgeSettings}
        setBridgeSettings={setBridgeSettings}
        appForegroundActive={appForegroundActive}
        onForegroundActiveChange={setAppForegroundActive}
        onForegroundResume={handleForegroundResume}
      />
    </SessionProvider>
  );
}
