/**
 * App - 主应用入口
 * 只负责页面级切换与跨页 orchestration。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { parseConnectionConfigShareLink } from '@zterm/shared';
import { TmuxSessionPickerSheet } from './components/tmux/TmuxSessionPickerSheet';
import { SessionProvider, useSession } from './contexts/SessionContext';
import { useAppUpdate } from './hooks/useAppUpdate';
import { useScreenOrientationLock } from './hooks/useScreenOrientationLock';
import { useConfigExport } from './hooks/useConfigExport';
import { useBridgeSettingsStorage } from './hooks/useBridgeSettingsStorage';
import { buildBridgeTargetFromHost } from './lib/session-picker';
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
import type { Host, TerminalWidthMode } from './lib/types';
import { useBackgroundLiveSessionHandoff } from './hooks/useOpenTabLifecycleEffects';
import { useAttachmentNotifications } from './hooks/useAttachmentNotifications';
import { createNetworkIdentityRuntime } from './lib/network-identity';
import { readNativeNetworkIdentitySnapshot } from './plugins/NetworkIdentityPlugin';
import type { NetworkIdentityRuntime } from './lib/network-identity';
import { createPluginHost } from './lib/plugin-host/plugin-host-runtime';
import { NetworkIdentityCapabilityPlugin } from './lib/plugin-host/network-identity-capability-plugin';
import { DebugConsoleUiPlugin } from './lib/plugin-host/debug-console-ui-plugin';
import { SessionDrawerUiPlugin } from './lib/plugin-host/session-drawer-ui-plugin';
import { FileBrowserUiPlugin } from './lib/plugin-host/file-browser-ui-plugin';
import { SettingsUpdateUiPlugin } from './lib/plugin-host/settings-update-ui-plugin';
import { RemoteWindowUiPlugin } from './lib/plugin-host/remote-window-ui-plugin';
import { QuickBarUiPlugin } from './lib/plugin-host/quickbar-ui-plugin';
import { TerminalShellUiPlugin } from './lib/plugin-host/terminal-shell-ui-plugin';
import type { PluginHost } from './lib/plugin-host/plugin-host-runtime';
import { ClientCompositionRoot } from './lib/composition-root/client-composition-root';
import { createControlCommand } from '@zterm/shared/terminal/control-contract';
import { ClientControlCenter } from './lib/control-center/client-control-center';
import { PluginHostControlNode } from './lib/plugin-host/plugin-host-control-node';
import {
  DEBUG_CONSOLE_UI_SLOT_ID,
  type TerminalDebugOverlayProps,
  type TerminalDebugOverlaySlot,
} from './lib/plugin-debug-console/debug-console-contract';
import {
  SESSION_DRAWER_UI_SLOT_ID,
  type SessionDrawerUiProps,
  type TerminalSessionDrawerSlot,
} from './lib/plugin-session-drawer/session-drawer-contract';
import {
  FILE_BROWSER_UI_SLOT_ID,
  type FileBrowserUiProps,
  type TerminalFileBrowserSlot,
} from './lib/plugin-file-browser/file-browser-contract';
import {
  SETTINGS_UPDATE_UI_SLOT_ID,
  type SettingsUpdateUiProps,
  type SettingsUpdateUiSlot,
} from './lib/plugin-settings-update/settings-update-contract';
import {
  REMOTE_WINDOW_UI_SLOT_ID,
  type RemoteWindowUiProps,
  type TerminalRemoteWindowSlot,
} from './lib/plugin-remote-window/remote-window-contract';
import {
  QUICKBAR_UI_SLOT_ID,
  type QuickBarUiProps,
  type TerminalQuickBarSlot,
} from './lib/plugin-quickbar/quickbar-contract';
import {
  TERMINAL_SHELL_UI_SLOT_ID,
  type TerminalShellUiProps,
  type TerminalShellUiSlot,
} from './lib/plugin-terminal-shell/terminal-shell-contract';

interface AppContentProps {
  bridgeSettings: ReturnType<typeof useBridgeSettingsStorage>['settings'];
  setBridgeSettings: ReturnType<typeof useBridgeSettingsStorage>['setSettings'];
  appForegroundActive?: boolean;
  onForegroundActiveChange?: (active: boolean) => void;
  onForegroundResume?: (reason: 'visibilitychange' | 'resume' | 'appStateChange') => void;
  latestSessionHostsRef?: MutableRefObject<Host[] | undefined>;
  networkIdentity?: NetworkIdentityRuntime;
  renderDebugConsole?: TerminalDebugOverlaySlot['render'];
  renderSessionDrawer?: TerminalSessionDrawerSlot['render'];
  renderFileBrowser?: TerminalFileBrowserSlot['render'];
  renderSettingsUpdate?: SettingsUpdateUiSlot['render'];
  renderRemoteWindow?: TerminalRemoteWindowSlot['render'];
  renderQuickBar?: TerminalQuickBarSlot['render'];
  renderTerminalShell?: TerminalShellUiSlot['render'];
}


export function AppContent({
  bridgeSettings,
  setBridgeSettings,
  appForegroundActive = true,
  onForegroundActiveChange,
  onForegroundResume,
  latestSessionHostsRef,
  networkIdentity,
  renderDebugConsole,
  renderSessionDrawer,
  renderFileBrowser,
  renderSettingsUpdate,
  renderRemoteWindow,
  renderQuickBar,
  renderTerminalShell,
}: AppContentProps) {
  const [pendingPaneAttachIntent, setPendingPaneAttachIntent] = useState<{ sessionIds: string[]; paneId: string; nonce: number } | null>(null);
  useEffect(() => {
    if (!networkIdentity) {
      return;
    }
    void networkIdentity.resample().catch((error) => {
      console.warn('[App] initial network identity resample failed:', error);
    });
  }, [networkIdentity]);
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
    renameRemoteSession,
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
    updateRemoteWindowFocus,
    stopRemoteWindowStream,
    sendRemoteWindowInput,
    resizeRemoteWindowTarget,
    sendMessageRaw,
    sendTargetHeartbeat,
    manageTmuxSessionsOnOpenTransport,
    queryTerminalSessionCatalogOnOpenTransport,
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
    getPendingAttachments,
    recordBackgroundEnteredAt,
  } = useSession();
  useAttachmentNotifications({ getPendingAttachments });
  const screenOrientationLock = useScreenOrientationLock();
  void sendMessageRaw;
  void onFileTransferMessage;
  const { hosts, isLoaded: hostsLoaded, addHost, upsertHost, updateHost, deleteHost } = useHostStorage();
  const homeSavedConnections = useMemo(
    () => projectHomeSavedConnections(hosts, bridgeSettings, relayDevices),
    [bridgeSettings, hosts, relayDevices],
  );
  // Publish the freshest projection to the session reconnect layer so a
  // network change that rotated the daemon's direct endpoints can refresh the
  // cached host before probing (see mergeHostWithLatestProjection).
  if (latestSessionHostsRef) {
    latestSessionHostsRef.current = homeSavedConnections;
  }
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

  // Notification tap: open the attachment drawer when the user taps an
  // attachment notification. The drawer lives in TerminalPage, so bridge via
  // a window event (same pattern as SESSION_STATUS_EVENT). Tapping a
  // session-stopped notification jumps straight into that tmux session.
  const handleStoppedSessionNotificationRef = useRef<((sessionName: string) => void) | null>(null);
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      return;
    }
    let handle: { remove: () => Promise<void> } | null = null;
    let disposed = false;
    void LocalNotifications.addListener('localNotificationActionPerformed', (data: { actionId: string; notification?: { title?: string | null; extra?: Record<string, unknown> | null } }) => {
      const { notification } = data;
      const title = notification?.title;
      const extra = notification?.extra as { kind?: string; sessionName?: string; attachmentId?: string } | undefined;
      const isAttachmentNotification = extra?.kind === 'attachment'
        || (typeof title === 'string' && title.includes('附件'));
      if (isAttachmentNotification) {
        window.dispatchEvent(new CustomEvent('zterm:open-attachment-drawer'));
        if (extra?.kind === 'attachment' && typeof extra.attachmentId === 'string') {
          window.dispatchEvent(new CustomEvent('zterm:preview-attachment', {
            detail: { attachmentId: extra.attachmentId },
          }));
        }
        return;
      }
      if (extra?.kind === 'session-stopped'
        && typeof extra.sessionName === 'string'
        && extra.sessionName.trim()) {
        handleStoppedSessionNotificationRef.current?.(extra.sessionName.trim());
      }
    }).then((listener) => {
      if (disposed) {
        void listener.remove();
        return;
      }
      handle = listener;
    });
    return () => {
      disposed = true;
      if (handle) {
        void handle.remove();
      }
    };
  }, []);

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
    networkIdentity,
    sendBackgroundHeartbeat: sendTargetHeartbeat,
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
    handleRenameRemoteSession,
    handleCloseGroupSession,
    handleSaveServerGroupSelection,
    handleSelectCleanSession,
    handleRemoteSessionsRefreshed,
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
    renameRemoteSession,
    manageTmuxSessionsOnOpenTransport,
    queryTerminalSessionCatalogOnOpenTransport,
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

  // Wire the session-stopped notification tap handler to the latest
  // session-open actions (avoid stale closures from the mount-only listener).
  handleStoppedSessionNotificationRef.current = (sessionName) => {
    const recentHost = [...hosts]
      .sort((left, right) => (right.lastConnected ?? 0) - (left.lastConnected ?? 0))
      .find((host) => (host.lastConnected ?? 0) > 0)
      || hosts[0];
    if (recentHost) {
      handleOpenSingleTmuxSession(buildBridgeTargetFromHost(recentHost), sessionName);
    }
  };

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
            renderSettingsUpdate={renderSettingsUpdate}
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
            onRenameRemoteSession={handleRenameRemoteSession}
            onCloseDrawerRemoteSession={handleCloseGroupSession}
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
            onUpdateRemoteWindowFocus={updateRemoteWindowFocus}
            onStopRemoteWindowStream={stopRemoteWindowStream}
            onSendRemoteWindowInput={sendRemoteWindowInput}
            onResizeRemoteWindowTarget={resizeRemoteWindowTarget}
            quickActions={quickActions}
            shortcutActions={shortcutActions}
            onQuickActionInput={handleQuickActionInput}
            onQuickActionsChange={setQuickActions}
            onShortcutActionsChange={setShortcutActions}
            renderDebugConsole={renderDebugConsole}
            renderSessionDrawer={renderSessionDrawer}
            renderFileBrowser={renderFileBrowser}
            renderRemoteWindow={renderRemoteWindow}
            renderQuickBar={renderQuickBar}
            renderTerminalShell={renderTerminalShell}
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

      {/* 屏幕方向转换按钮（视频播放器式）：默认锁定方向不随手机姿势自动切换；
          物理姿态与锁定方向不一致时在此角落弹出小按钮，点击锁定姿态方向。
          垂直居中右侧——不覆盖顶部/底部浮动标签（quickbar 固定簇等） */}
      {screenOrientationLock.showSwitchButton &&
        screenOrientationLock.pendingTarget && (
          <button
            type="button"
            data-testid="screen-orientation-switch-button"
            aria-label={`切换到${screenOrientationLock.pendingTarget === 'landscape' ? '横屏' : '竖屏'}`}
            onClick={() => {
              screenOrientationLock.requestOrientationSwitch();
            }}
            style={{
              position: 'fixed',
              right: 14,
              top: '50%',
              transform: 'translateY(-50%)',
              width: 40,
              height: 40,
              borderRadius: 20,
              border: 'none',
              backgroundColor: 'rgba(18, 20, 24, 0.72)',
              color: '#ffffff',
              fontSize: 18,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 2px 10px rgba(0, 0, 0, 0.35)',
              zIndex: 2147483000,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            ↻
          </button>
        )}

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
  const latestSessionHostsRef = useRef<Host[] | undefined>(undefined);
  const pluginHostRef = useRef<PluginHost | null>(null);
  const controlCenterRef = useRef<ClientControlCenter | null>(null);
  const pluginStartRequestedRef = useRef(false);
  const [pluginRuntimeReady, setPluginRuntimeReady] = useState(false);
  const [pluginRuntimeError, setPluginRuntimeError] = useState<Error | null>(null);
  if (
    !pluginHostRef.current
    || pluginHostRef.current.isDisposed()
    || !controlCenterRef.current
  ) {
    const runtimeRoot = new ClientCompositionRoot();
    const nextPluginHost = createAppPluginHost();
    const nextControlCenter = new ClientControlCenter();
    runtimeRoot.bind({ portId: 'plugin-host', value: nextPluginHost });
    runtimeRoot.bind({ portId: 'control-center', value: nextControlCenter });
    runtimeRoot.require(['plugin-host', 'control-center']);
    const pluginHost = runtimeRoot.resolve<PluginHost>('plugin-host');
    const controlCenter = runtimeRoot.resolve<ClientControlCenter>('control-center');
    controlCenter.register(
      'plugin-host.dispose',
      new PluginHostControlNode(pluginHost),
      'plugin-host:dispose',
    );
    pluginHostRef.current = pluginHost;
    controlCenterRef.current = controlCenter;
  }
  const pluginHost = pluginHostRef.current;
  const controlCenter = controlCenterRef.current;
  useEffect(() => () => {
    if (!controlCenter) {
      return;
    }
    void controlCenter.execute({
      command: createControlCommand(
        'plugin-host.dispose',
        'app-unmount-1',
        'app-unmount',
        { reason: 'app-unmount' },
      ),
      subject: 'app-shell',
      capabilities: ['plugin-host:dispose'],
      idempotencyKey: 'plugin-host.dispose:app-unmount',
    }).then((result) => {
      if (!result.ok) {
        console.error('[zterm:control-center] plugin-host dispose failed', result.error);
      }
    }).catch((error) => {
      console.error('[zterm:control-center] plugin-host dispose failed', error);
    });
  }, [controlCenter]);
  useEffect(() => {
    if (pluginStartRequestedRef.current) {
      return;
    }
    pluginStartRequestedRef.current = true;
    void pluginHost.startAll().then(() => {
      setPluginRuntimeReady(true);
    }).catch((error: unknown) => {
      setPluginRuntimeError(error instanceof Error ? error : new Error(String(error)));
    });
  }, [pluginHost]);
  const networkIdentityRuntime = useMemo(() => createNetworkIdentityRuntime({
    sampleInterfaces: pluginRuntimeReady
      ? pluginHost.readCapability<typeof readNativeNetworkIdentitySnapshot>('network:sample-interfaces')
      : undefined,
  }), [pluginHost, pluginRuntimeReady]);
  const debugConsoleRender = pluginRuntimeReady
    ? pluginHost
      .readUiSlot<TerminalDebugOverlayProps>(DEBUG_CONSOLE_UI_SLOT_ID)
      .render
    : undefined;
  const sessionDrawerRender = pluginRuntimeReady
    ? pluginHost
      .readUiSlot<SessionDrawerUiProps>(SESSION_DRAWER_UI_SLOT_ID)
      .render
    : undefined;
  const fileBrowserRender = pluginRuntimeReady
    ? pluginHost
      .readUiSlot<FileBrowserUiProps>(FILE_BROWSER_UI_SLOT_ID)
      .render
    : undefined;
  const settingsUpdateRender = pluginRuntimeReady
    ? pluginHost
      .readUiSlot<SettingsUpdateUiProps>(SETTINGS_UPDATE_UI_SLOT_ID)
      .render
    : undefined;
  const remoteWindowRender = pluginRuntimeReady
    ? pluginHost
      .readUiSlot<RemoteWindowUiProps>(REMOTE_WINDOW_UI_SLOT_ID)
      .render
    : undefined;
  const quickBarRender = pluginRuntimeReady
    ? pluginHost
      .readUiSlot<QuickBarUiProps>(QUICKBAR_UI_SLOT_ID)
      .render
    : undefined;
  const terminalShellRender = pluginRuntimeReady
    ? pluginHost
      .readUiSlot<TerminalShellUiProps>(TERMINAL_SHELL_UI_SLOT_ID)
      .render
    : undefined;
  if (pluginRuntimeError) {
    throw pluginRuntimeError;
  }

  return (
    <SessionProvider
      terminalCacheLines={bridgeSettings.terminalCacheLines}
      bridgeSettings={bridgeSettings}
      appForegroundActive={appForegroundActive}
      foregroundResumeEpoch={foregroundResumeEpoch}
      latestSessionHostsRef={latestSessionHostsRef}
      networkIdentity={networkIdentityRuntime}
    >
      <AppContent
        bridgeSettings={bridgeSettings}
        setBridgeSettings={setBridgeSettings}
        appForegroundActive={appForegroundActive}
        onForegroundActiveChange={setAppForegroundActive}
        onForegroundResume={handleForegroundResume}
        latestSessionHostsRef={latestSessionHostsRef}
        networkIdentity={networkIdentityRuntime}
        renderDebugConsole={debugConsoleRender}
        renderSessionDrawer={sessionDrawerRender}
        renderFileBrowser={fileBrowserRender}
        renderSettingsUpdate={settingsUpdateRender}
        renderRemoteWindow={remoteWindowRender}
        renderQuickBar={quickBarRender}
        renderTerminalShell={terminalShellRender}
      />
    </SessionProvider>
  );
}

function createAppPluginHost(): PluginHost {
  const host = createPluginHost();
  host.provideCapability('network:native-snapshot', readNativeNetworkIdentitySnapshot);
  host.install(
    {
      pluginId: 'network-identity',
      version: '1.0.0',
      requires: ['network:native-snapshot'],
      provides: ['network:sample-interfaces'],
    },
    { create: () => new NetworkIdentityCapabilityPlugin() },
  );
  host.install(
    {
      pluginId: 'debug-console',
      version: '1.0.0',
      requires: [],
      provides: [],
      providesUiSlots: [DEBUG_CONSOLE_UI_SLOT_ID],
    },
    { create: () => new DebugConsoleUiPlugin() },
  );
  host.install(
    {
      pluginId: 'session-drawer',
      version: '1.0.0',
      requires: [],
      provides: [],
      providesUiSlots: [SESSION_DRAWER_UI_SLOT_ID],
    },
    { create: () => new SessionDrawerUiPlugin() },
  );
  host.install(
    {
      pluginId: 'file-browser',
      version: '1.0.0',
      requires: [],
      provides: [],
      providesUiSlots: [FILE_BROWSER_UI_SLOT_ID],
    },
    { create: () => new FileBrowserUiPlugin() },
  );
  host.install(
    {
      pluginId: 'settings-update',
      version: '1.0.0',
      requires: [],
      provides: [],
      providesUiSlots: [SETTINGS_UPDATE_UI_SLOT_ID],
    },
    { create: () => new SettingsUpdateUiPlugin() },
  );
  host.install(
    {
      pluginId: 'remote-window',
      version: '1.0.0',
      requires: [],
      provides: [],
      providesUiSlots: [REMOTE_WINDOW_UI_SLOT_ID],
    },
    { create: () => new RemoteWindowUiPlugin() },
  );
  host.install(
    {
      pluginId: 'quickbar',
      version: '1.0.0',
      requires: [],
      provides: [],
      providesUiSlots: [QUICKBAR_UI_SLOT_ID],
    },
    { create: () => new QuickBarUiPlugin() },
  );
  host.install(
    {
      pluginId: 'terminal-shell',
      version: '1.0.0',
      requires: [],
      provides: [],
      providesUiSlots: [TERMINAL_SHELL_UI_SLOT_ID],
    },
    { create: () => new TerminalShellUiPlugin() },
  );
  return host;
}
