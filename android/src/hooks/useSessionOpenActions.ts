import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { OpenTabAuditReason } from './useOpenTabLifecycleEffects';
import { upsertBridgeServer, type BridgeSettings } from '../lib/bridge-settings';
import type { OpenTabRuntimeRefs } from './useOpenTabRuntime';
import { runtimeDebug } from '../lib/runtime-debug';
import {
  buildPersistedOpenTabFromHostSession,
  buildPersistedOpenTabReuseKey,
  clearClosedTabReuseKeysForOwner,
  persistClosedTabReuseKeys,
  resolveHostForPersistedOpenTab,
} from '../lib/open-tab-persistence';
import { resolveRemoteRestorableOpenTabState } from '../lib/open-tab-restore';
import {
  upsertOpenTabIntentSession,
} from '../lib/open-tab-intent';
import {
  buildCleanDraft,
  buildDraftFromTmuxSession,
  buildPreferredTarget,
  buildTransientHostFromDraft,
  normalizeBridgeTarget,
  type BridgeTarget,
  type HostDraft,
} from '../lib/session-picker';
import { openConnectionPropertiesPage, openConnectionsPage, type AppPageState } from '../lib/page-state';
import { normalizeRemoteTmuxSessionNames } from '../lib/tmux-session-list';
import type { Host, PersistedOpenTab } from '../lib/types';

type PickerMode = 'new-connection' | 'quick-tab' | 'edit-group' | null;

interface UseSessionOpenActionsOptions {
  bridgeSettings: BridgeSettings;
  setBridgeSettings: Dispatch<SetStateAction<BridgeSettings>>;
  hosts: Host[];
  deleteSessionGroup: (group: { bridgeHost: string; bridgePort: number; daemonHostId?: string }) => void;
  pruneSessionGroupSelectionToRemoteTruth: (target: { bridgeHost: string; bridgePort: number; daemonHostId?: string }, remoteSessionNames: string[]) => void;
  setSessionGroupSelection: (group: {
    name: string;
    bridgeHost: string;
    bridgePort: number;
    daemonHostId?: string;
    authToken?: string;
    sessionNames: string[];
  }) => void;
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
  runtimeActiveSessionId: string | null;
  runtimeRefs: OpenTabRuntimeRefs;
  ensureTerminalPageVisible: () => void;
  applyOpenTabState: (
    nextState: { tabs: PersistedOpenTab[]; activeSessionId: string | null },
    options?: { fallbackActiveSessionId?: string | null; switchRuntime?: boolean },
  ) => { tabs: PersistedOpenTab[]; activeSessionId: string | null };
  onSessionsOpenedInPane?: (sessionIds: string[], paneId: string) => void;
  setPageState: Dispatch<SetStateAction<AppPageState>>;
  auditOpenTabsAgainstRemoteSessions: (reason: OpenTabAuditReason) => Promise<void>;
}

export interface SessionOpenActionsResult {
  pickerMode: PickerMode;
  pickerTarget: BridgeTarget | null;
  pickerInitialSessions: string[];
  pickerScopePaneId: string | null;
  handleLoadSavedTabList: (tabs: PersistedOpenTab[], requestedActiveSessionId?: string, options?: { clearMatchingTombstones?: boolean }) => Promise<void>;
  handleAddNew: () => void;
  handleOpenQuickTabPicker: (paneId?: string) => void;
  handleOpenSingleTmuxSession: (target: BridgeTarget, sessionName: string) => void;
  handleOpenMultipleTmuxSessions: (target: BridgeTarget, sessionNames: string[]) => void;
  handleOpenGroupSession: (group: { bridgeHost: string; bridgePort: number; daemonHostId?: string; authToken?: string }, sessionName: string) => void;
  handleOpenServerGroups: (groups: Array<{
    name: string;
    bridgeHost: string;
    bridgePort: number;
    daemonHostId?: string;
    authToken?: string;
    sessionNames: string[];
  }>) => void;
  handleEditServerGroup: (group: {
    bridgeHost: string;
    bridgePort: number;
    daemonHostId?: string;
    authToken?: string;
  }, sessionNames: string[]) => void;
  handleSaveServerGroupSelection: (group: {
    bridgeHost: string;
    bridgePort: number;
    daemonHostId?: string;
    authToken?: string;
  }, sessionNames: string[]) => void;
  handleDeleteServerGroup: (group: {
    bridgeHost: string;
    bridgePort: number;
    daemonHostId?: string;
  }) => void;
  handleSelectCleanSession: (target: BridgeTarget) => void;
  handleRemoteSessionsRefreshed: (target: BridgeTarget, sessionNames: string[]) => void;
  closePicker: () => void;
}

export function useSessionOpenActions(options: UseSessionOpenActionsOptions): SessionOpenActionsResult {
  const {
    bridgeSettings,
    setBridgeSettings,
    hosts,
    deleteSessionGroup,
    pruneSessionGroupSelectionToRemoteTruth,
    setSessionGroupSelection,
    createSession,
    runtimeActiveSessionId,
    runtimeRefs,
    ensureTerminalPageVisible,
    applyOpenTabState,
    onSessionsOpenedInPane,
    setPageState,
    auditOpenTabsAgainstRemoteSessions,
  } = options;

  const {
    sessionsRef,
    hostsRef,
    bridgeSettingsRef,
    openTabStateRef,
    closedOpenTabSessionIdsRef,
    closedOpenTabReuseKeysRef,
    terminalActiveSessionIdRef,
    ensureTerminalPageVisibleRef,
    renameSessionRef,
  } = runtimeRefs;

  const [pickerMode, setPickerMode] = useState<PickerMode>(null);
  const [pickerTarget, setPickerTarget] = useState<BridgeTarget | null>(null);
  const [pickerInitialSessions, setPickerInitialSessions] = useState<string[]>([]);
  const [pickerScopePaneId, setPickerScopePaneId] = useState<string | null>(null);
  const openDraftAsSessionRef = useRef<((host: HostDraft, options?: {
    rememberName?: string;
    activate?: boolean;
    navigate?: boolean;
    sessionId?: string;
  }) => { sessionId: string; host: Host }) | null>(null);


  const rememberBridgeTarget = useCallback((target: BridgeTarget, name?: string) => {
    setBridgeSettings((current) =>
      upsertBridgeServer(current, {
        name: name || target.bridgeHost,
        targetHost: target.bridgeHost,
        targetPort: target.bridgePort,
        authToken: target.authToken,
        relayHostId: target.relayHostId,
        relayDeviceId: target.relayDeviceId,
      }),
    );
  }, [setBridgeSettings]);

  const openDraftAsSession = useCallback((
    draft: HostDraft,
    options?: { rememberName?: string; activate?: boolean; navigate?: boolean; sessionId?: string },
  ) => {
    rememberBridgeTarget(normalizeBridgeTarget(draft), options?.rememberName || draft.name || draft.bridgeHost);
    const sessionHost = buildTransientHostFromDraft({
      ...draft,
      lastConnected: Date.now(),
    });
    const shouldActivate = options?.activate !== false;
    runtimeDebug('app.session.open-draft', {
      requestedSessionId: options?.sessionId || null,
      bridgeHost: draft.bridgeHost,
      bridgePort: draft.bridgePort,
      sessionName: draft.sessionName,
      activate: shouldActivate,
      navigate: options?.navigate !== false,
    });

    const sessionId = createSession(sessionHost, {
      activate: false,
      ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
    });
    closedOpenTabSessionIdsRef.current.delete(sessionId);
    const deletedAnyReuseKey = clearClosedTabReuseKeysForOwner(closedOpenTabReuseKeysRef.current, {
      daemonHostId: sessionHost.daemonHostId || sessionHost.relayHostId,
      bridgeHost: sessionHost.bridgeHost,
      bridgePort: sessionHost.bridgePort,
      sessionName: sessionHost.sessionName,
    });
    if (deletedAnyReuseKey) {
      persistClosedTabReuseKeys(closedOpenTabReuseKeysRef.current);
    }
    const openedTab: PersistedOpenTab = {
      sessionId,
      hostId: sessionHost.id,
      connectionName: sessionHost.name,
      bridgeHost: sessionHost.bridgeHost,
      bridgePort: sessionHost.bridgePort,
      daemonHostId: sessionHost.daemonHostId || sessionHost.relayHostId,
      sessionName: sessionHost.sessionName,
      authToken: sessionHost.authToken,
      autoCommand: sessionHost.autoCommand,
      createdAt: Date.now(),
    };
    const nextOpenTabState = upsertOpenTabIntentSession(
      openTabStateRef.current,
      openedTab,
      {
        activate: shouldActivate,
        fallbackActiveSessionId: runtimeActiveSessionId,
      },
    );
    applyOpenTabState(nextOpenTabState, shouldActivate ? {
      switchRuntime: true,
    } : undefined);
    if (options?.navigate !== false) {
      ensureTerminalPageVisible();
    }
    return { sessionId, host: sessionHost };
  }, [
    closedOpenTabReuseKeysRef,
    closedOpenTabSessionIdsRef,
    createSession,
    ensureTerminalPageVisible,
    openTabStateRef,
    applyOpenTabState,
    rememberBridgeTarget,
    runtimeActiveSessionId,
  ]);

  useEffect(() => {
    openDraftAsSessionRef.current = openDraftAsSession;
  }, [openDraftAsSession]);

  const openSessionPicker = useCallback((mode: Exclude<PickerMode, null>, pickerOptions?: {
    target?: BridgeTarget | null;
    initialSelectedSessions?: string[];
    paneId?: string | null;
  }) => {
    setPickerMode(mode);
    setPickerInitialSessions(pickerOptions?.initialSelectedSessions || []);
    setPickerScopePaneId(pickerOptions?.paneId || null);
    const currentBridgeSettings = bridgeSettingsRef.current;
    setPickerTarget(
      pickerOptions?.target || buildPreferredTarget(
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
  }, [bridgeSettingsRef, sessionsRef, terminalActiveSessionIdRef]);

  const handleQuickConnectDraft = useCallback((draft: HostDraft, rememberName?: string) => {
    const opened = openDraftAsSession(draft, { rememberName, activate: true, navigate: true });
    if (pickerScopePaneId) {
      onSessionsOpenedInPane?.([opened.sessionId], pickerScopePaneId);
    }
    return opened.sessionId;
  }, [onSessionsOpenedInPane, openDraftAsSession, pickerScopePaneId]);

  const handleOpenMultipleTmuxSessions = useCallback((target: BridgeTarget, sessionNames: string[]) => {
    const uniqueSessionNames = [...new Set(sessionNames.map((name) => name.trim()).filter(Boolean))];
    if (uniqueSessionNames.length === 0) {
      return;
    }
    const openedSessionIds: string[] = [];
    uniqueSessionNames.forEach((sessionName, index) => {
      const draft = buildDraftFromTmuxSession(hosts, bridgeSettings.servers, target, sessionName);
      const sessionId = openDraftAsSession(draft, {
        rememberName: target.bridgeHost,
        activate: index === 0,
        navigate: false,
      }).sessionId;
      openedSessionIds.push(sessionId);
    });
    if (pickerScopePaneId && openedSessionIds.length > 0) {
      onSessionsOpenedInPane?.(openedSessionIds, pickerScopePaneId);
    }
    setPickerMode(null);
    setPickerScopePaneId(null);
    ensureTerminalPageVisible();
  }, [bridgeSettings.servers, ensureTerminalPageVisible, hosts, onSessionsOpenedInPane, openDraftAsSession, pickerScopePaneId]);

  const handleOpenSingleTmuxSession = useCallback((target: BridgeTarget, sessionName: string) => {
    const draft = buildDraftFromTmuxSession(hosts, bridgeSettings.servers, target, sessionName);
    setPickerMode(null);
    handleQuickConnectDraft(draft, target.bridgeHost);
  }, [bridgeSettings.servers, handleQuickConnectDraft, hosts]);

  const handleOpenGroupSession = useCallback((group: { bridgeHost: string; bridgePort: number; daemonHostId?: string; authToken?: string }, sessionName: string) => {
    handleQuickConnectDraft(
      {
        name: `${group.bridgeHost} · ${sessionName}`,
        bridgeHost: group.bridgeHost,
        bridgePort: group.bridgePort,
        daemonHostId: group.daemonHostId,
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
    daemonHostId?: string;
    authToken?: string;
  }, sessionNames: string[]) => {
    openSessionPicker('edit-group', {
      target: {
        bridgeHost: group.bridgeHost,
        bridgePort: group.bridgePort,
        daemonHostId: group.daemonHostId,
        authToken: group.authToken,
      },
      initialSelectedSessions: sessionNames,
    });
  }, [openSessionPicker]);

  const handleSaveServerGroupSelection = useCallback((group: {
    bridgeHost: string;
    bridgePort: number;
    daemonHostId?: string;
    authToken?: string;
  }, sessionNames: string[]) => {
    setSessionGroupSelection({
      name: `${group.bridgeHost} · ${sessionNames.length} sessions`,
      bridgeHost: group.bridgeHost,
      bridgePort: group.bridgePort,
      daemonHostId: group.daemonHostId,
      authToken: group.authToken,
      sessionNames,
    });
  }, [setSessionGroupSelection]);

  const handleDeleteServerGroup = useCallback((group: {
    bridgeHost: string;
    bridgePort: number;
    daemonHostId?: string;
  }) => {
    deleteSessionGroup(group);
  }, [deleteSessionGroup]);

  const handleOpenServerGroups = useCallback((groups: Array<{
    name: string;
    bridgeHost: string;
    bridgePort: number;
    daemonHostId?: string;
    authToken?: string;
    sessionNames: string[];
  }>) => {
    let activeSessionId: string | null = null;
    const openedSessionIds: string[] = [];

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
            daemonHostId: group.daemonHostId,
            authToken: group.authToken,
          },
          sessionName,
        );
        const sessionId = openDraftAsSession(draft, {
          rememberName: group.bridgeHost,
          activate: !activeSessionId && index === 0,
          navigate: false,
        }).sessionId;
        openedSessionIds.push(sessionId);
        if (!activeSessionId) {
          activeSessionId = sessionId;
        }
      });

    });

    if (pickerScopePaneId && openedSessionIds.length > 0) {
      onSessionsOpenedInPane?.(openedSessionIds, pickerScopePaneId);
    }
    if (activeSessionId) {
      ensureTerminalPageVisible();
    }
  }, [bridgeSettings.servers, ensureTerminalPageVisible, hosts, onSessionsOpenedInPane, openDraftAsSession, pickerScopePaneId]);

  const handleLoadSavedTabList = useCallback(async (tabs: PersistedOpenTab[], requestedActiveSessionId?: string, options?: { clearMatchingTombstones?: boolean }) => {
    const importPlan = await resolveRemoteRestorableOpenTabState({
      tabs,
      activeSessionId: requestedActiveSessionId?.trim() || null,
      bridgeSettings: bridgeSettingsRef.current,
      hosts: hostsRef.current,
    });
    if (importPlan.droppedTabs.length > 0) {
      runtimeDebug('app.saved-tab-list.drop-missing-remote-sessions', {
        droppedSessionIds: importPlan.droppedTabs.map((tab) => tab.sessionId),
        droppedTargets: importPlan.droppedTabs.map((tab) => `${tab.bridgeHost}:${tab.bridgePort}:${tab.sessionName}`),
      });
    }
    // Handle tabs whose reuse keys were explicitly closed by the user
    // - Cold start (clearMatchingTombstones=false): filter them out (don't auto-restore closed tabs)
    // - Explicit import (clearMatchingTombstones=true): clear tombstones and allow restore
    const filteredTabs = options?.clearMatchingTombstones
      ? importPlan.tabs.map((tab) => {
          const reuseKey = buildPersistedOpenTabReuseKey(tab);
          if (closedOpenTabReuseKeysRef.current.has(reuseKey)) {
            closedOpenTabReuseKeysRef.current.delete(reuseKey);
            persistClosedTabReuseKeys(closedOpenTabReuseKeysRef.current);
            runtimeDebug('app.saved-tab-list.clear-tombstone', {
              sessionId: tab.sessionId,
              sessionName: tab.sessionName,
            });
          }
          return tab;
        })
      : importPlan.tabs.filter((tab) => {
          const reuseKey = buildPersistedOpenTabReuseKey(tab);
          if (closedOpenTabReuseKeysRef.current.has(reuseKey)) {
            runtimeDebug('app.saved-tab-list.skip-closed', {
              sessionId: tab.sessionId,
              sessionName: tab.sessionName,
            });
            return false;
          }
          return true;
        });
    if (filteredTabs.length === 0) {
      applyOpenTabState({
        tabs: [],
        activeSessionId: null,
      });
      setPageState(openConnectionsPage());
      return;
    }
    const openedTabs: PersistedOpenTab[] = [];
    runtimeDebug('app.saved-tab-list.load', {
      requestedActiveSessionId: requestedActiveSessionId || null,
      sessionIds: filteredTabs.map((tab) => tab.sessionId),
      bridgeTargets: filteredTabs.map((tab) => `${tab.bridgeHost}:${tab.bridgePort}:${tab.sessionName}`),
    });

    filteredTabs.forEach((tab) => {
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

    const activeSessionId = importPlan.activeSessionId
      ? (openedTabs.find((tab) => tab.sessionId === importPlan.activeSessionId)?.sessionId || openedTabs[0]?.sessionId || null)
      : null;

    if (activeSessionId) {
      applyOpenTabState({
        tabs: openedTabs,
        activeSessionId,
      }, {
        switchRuntime: true,
      });
      ensureTerminalPageVisibleRef.current();
    }
  }, [applyOpenTabState, bridgeSettingsRef, ensureTerminalPageVisibleRef, hostsRef, renameSessionRef]);

  const handleRemoteSessionsRefreshed = useCallback((target: BridgeTarget, sessionNames: string[]) => {
    pruneSessionGroupSelectionToRemoteTruth({
      bridgeHost: target.bridgeHost,
      bridgePort: target.bridgePort,
      daemonHostId: target.daemonHostId || target.relayHostId,
    }, normalizeRemoteTmuxSessionNames(sessionNames));
    void auditOpenTabsAgainstRemoteSessions('session-picker-refresh').catch((error) => {
      console.error('[App] Failed to audit remote session truth after session picker refresh:', error);
    });
  }, [auditOpenTabsAgainstRemoteSessions, pruneSessionGroupSelectionToRemoteTruth]);

  const handleSelectCleanSession = useCallback((target: BridgeTarget) => {
    rememberBridgeTarget(target, target.bridgeHost);
    const draft = buildCleanDraft(target);
    setPickerMode(null);
    if (pickerMode === 'quick-tab') {
      handleQuickConnectDraft(draft, target.bridgeHost);
      setPickerScopePaneId(null);
      return;
    }
    if (pickerMode === 'edit-group') {
      setPickerMode('edit-group');
      setPickerTarget(target);
      setPickerInitialSessions([]);
      return;
    }
    setPageState(openConnectionPropertiesPage({ draft }));
  }, [handleQuickConnectDraft, pickerMode, rememberBridgeTarget, setPageState]);

  const handleAddNew = useCallback(() => {
    openSessionPicker('new-connection');
  }, [openSessionPicker]);

  const handleOpenQuickTabPicker = useCallback((paneId?: string) => {
    openSessionPicker('quick-tab', {
      paneId: paneId || null,
    });
  }, [openSessionPicker]);

  const closePicker = useCallback(() => {
    setPickerMode(null);
    setPickerScopePaneId(null);
  }, []);

  return {
    pickerMode,
    pickerTarget,
    pickerInitialSessions,
    pickerScopePaneId,
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
  };
}
