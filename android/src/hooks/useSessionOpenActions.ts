import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { OpenTabAuditReason } from './useOpenTabLifecycleEffects';
import type { OpenTabRuntimeSwitchReason } from '../lib/open-tab-runtime-switch';
import { upsertBridgeServer, type BridgeSettings } from '../lib/bridge-settings';
import type { OpenTabRuntimeRefs } from './useOpenTabRuntime';
import { runtimeDebug } from '../lib/runtime-debug';
import {
  clearClosedTabReuseKeysForOwner,
  persistClosedTabReuseKeys,
} from '../lib/open-tab-persistence';
import {
  upsertOpenTabIntentSession,
} from '../lib/open-tab-intent';
import {
  buildCleanDraft,
  buildDraftFromTmuxSession,
  buildPreferredTarget,
  buildTransientHostFromDraft,
  normalizeBridgeTarget,
  resolveRelayDeviceBridgeTarget,
  type BridgeTarget,
  type HostDraft,
} from '../lib/session-picker';
import { openConnectionPropertiesPage, type AppPageState } from '../lib/page-state';
import { normalizeRemoteTmuxSessionNames } from '../lib/tmux-session-list';
import { createTmuxSession } from '../lib/tmux-sessions';
import type { Host, PersistedOpenTab, TraversalRelayDeviceSnapshot } from '../lib/types';
import { loadSavedTabList } from '../lib/saved-tab-loader';
import type { RelayEndpointCandidate } from '@zterm/shared/relay-directory';

type PickerMode = 'new-connection' | 'quick-tab' | 'edit-group' | null;

interface QuickTabCreateOptions {
  sessionName?: string;
  cwd?: string;
}

interface SessionOpenGroupTarget {
  bridgeHost: string;
  bridgePort: number;
  daemonHostId?: string;
  authToken?: string;
  relayEndpointCandidates?: RelayEndpointCandidate[];
}

interface UseSessionOpenActionsOptions {
  bridgeSettings: BridgeSettings;
  setBridgeSettings: Dispatch<SetStateAction<BridgeSettings>>;
  hosts: Host[];
  relayDevices?: TraversalRelayDeviceSnapshot[];
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
    options?: { fallbackActiveSessionId?: string | null; switchRuntime?: OpenTabRuntimeSwitchReason },
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
  handleOpenQuickTabPicker: (paneId?: string, hostKey?: string, createOptions?: QuickTabCreateOptions) => void;
  handleOpenSingleTmuxSession: (target: BridgeTarget, sessionName: string) => void;
  handleOpenMultipleTmuxSessions: (target: BridgeTarget, sessionNames: string[]) => void;
  handleOpenGroupSession: (group: SessionOpenGroupTarget, sessionName: string) => void;
  handleOpenServerGroups: (groups: Array<{
    name: string;
    bridgeHost: string;
    bridgePort: number;
    daemonHostId?: string;
    authToken?: string;
    relayEndpointCandidates?: RelayEndpointCandidate[];
    sessionNames: string[];
  }>) => void;
  handleEditServerGroup: (group: {
    bridgeHost: string;
    bridgePort: number;
    daemonHostId?: string;
    authToken?: string;
    relayEndpointCandidates?: RelayEndpointCandidate[];
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
    relayDevices = [],
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
    pendingMaterializedOpenTabSessionIdsRef,
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
    pendingMaterializedOpenTabSessionIdsRef.current.add(sessionId);
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
      switchRuntime: 'explicit-resume',
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
    pendingMaterializedOpenTabSessionIdsRef,
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

  const handleOpenGroupSession = useCallback((group: SessionOpenGroupTarget, sessionName: string) => {
    handleQuickConnectDraft(
      {
        name: `${group.bridgeHost} · ${sessionName}`,
        bridgeHost: group.bridgeHost,
        bridgePort: group.bridgePort,
        daemonHostId: group.daemonHostId,
        sessionName,
        authToken: group.authToken || '',
        relayEndpointCandidates: group.relayEndpointCandidates || [],
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
    relayEndpointCandidates?: RelayEndpointCandidate[];
  }, sessionNames: string[]) => {
    openSessionPicker('edit-group', {
      target: {
        bridgeHost: group.bridgeHost,
        bridgePort: group.bridgePort,
        daemonHostId: group.daemonHostId,
        authToken: group.authToken,
        relayEndpointCandidates: group.relayEndpointCandidates || [],
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
    relayEndpointCandidates?: RelayEndpointCandidate[];
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
            relayEndpointCandidates: group.relayEndpointCandidates || [],
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
    await loadSavedTabList(tabs, requestedActiveSessionId, {
      bridgeSettingsRef,
      hostsRef,
      closedOpenTabReuseKeysRef,
      openDraftAsSessionRef,
      renameSessionRef,
      applyOpenTabState,
      setPageState,
      ensureTerminalPageVisibleRef,
    }, options);
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
    openSessionPicker('new-connection', {
      target: normalizeBridgeTarget(null),
      initialSelectedSessions: [],
      paneId: null,
    });
  }, [openSessionPicker]);

  const enrichTargetFromSavedHosts = useCallback((target: BridgeTarget) => {
    const daemonHostId = (target.daemonHostId || target.relayHostId || '').trim();
    if (!daemonHostId) {
      return target;
    }
    const matchedHost = hosts
      .filter((host) => (host.daemonHostId || host.relayHostId || '').trim() === daemonHostId)
      .sort((a, b) => Math.max(b.lastConnected || 0, b.createdAt || 0) - Math.max(a.lastConnected || 0, a.createdAt || 0))[0];
    if (!matchedHost) {
      return target;
    }
    return normalizeBridgeTarget({
      ...target,
      bridgeHost: target.bridgeHost || matchedHost.bridgeHost,
      bridgePort: target.bridgePort || matchedHost.bridgePort,
      daemonHostId,
      relayHostId: target.relayHostId || target.daemonHostId || matchedHost.relayHostId || matchedHost.daemonHostId,
      authToken: target.authToken || matchedHost.authToken,
      relayEndpointCandidates: target.relayEndpointCandidates || matchedHost.relayEndpointCandidates || [],
    });
  }, [hosts]);

  const resolveTargetByHostKey = useCallback((hostKey?: string) => {
    const normalizedHostKey = hostKey?.trim();
    if (!normalizedHostKey) {
      return null;
    }
    const matchedDevice = relayDevices.find((device) => (
      device.daemon.hostId.trim() === normalizedHostKey
      || device.deviceId.trim() === normalizedHostKey
      || device.deviceName.trim() === normalizedHostKey
    ));
    if (matchedDevice) {
      return enrichTargetFromSavedHosts(resolveRelayDeviceBridgeTarget(bridgeSettings.servers, matchedDevice));
    }
    const matchedPreset = bridgeSettings.servers.find((server) => (
      server.id.trim() === normalizedHostKey
      || server.name.trim() === normalizedHostKey
      || server.targetHost.trim() === normalizedHostKey
      || `${server.targetHost.trim()}:${server.targetPort}` === normalizedHostKey
      || server.relayHostId?.trim() === normalizedHostKey
    ));
    if (matchedPreset) {
      return normalizeBridgeTarget({
        bridgeHost: matchedPreset.targetHost,
        bridgePort: matchedPreset.targetPort,
        daemonHostId: matchedPreset.relayHostId,
        relayHostId: matchedPreset.relayHostId,
        authToken: matchedPreset.authToken,
      });
    }
    const matchedSession = sessionsRef.current.find((session) => (
      session.daemonHostId?.trim() === normalizedHostKey
      || session.connectionName?.trim() === normalizedHostKey
      || session.bridgeHost.trim() === normalizedHostKey
      || `${session.bridgeHost.trim()}:${session.bridgePort}` === normalizedHostKey
    ));
    if (matchedSession) {
      return normalizeBridgeTarget({
        bridgeHost: matchedSession.bridgeHost,
        bridgePort: matchedSession.bridgePort,
        daemonHostId: matchedSession.daemonHostId,
        relayHostId: matchedSession.daemonHostId,
        authToken: matchedSession.authToken,
      });
    }
    return null;
  }, [bridgeSettings.servers, enrichTargetFromSavedHosts, relayDevices, sessionsRef]);

  const buildBlankSessionName = useCallback(() => {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+$/, '')
      .replace('T', '-');
    return `zterm-${stamp}`;
  }, []);

  const handleOpenQuickTabPicker = useCallback((paneId?: string, hostKey?: string, createOptions?: QuickTabCreateOptions) => {
    const target = resolveTargetByHostKey(hostKey);
    if (target) {
      const sessionName = createOptions?.sessionName?.trim() || buildBlankSessionName();
      const cwd = createOptions?.cwd?.trim();
      void (async () => {
        try {
          await createTmuxSession(target, bridgeSettings, sessionName, cwd ? { cwd } : undefined);
          const draft = buildDraftFromTmuxSession(hosts, bridgeSettings.servers, target, sessionName);
          const opened = openDraftAsSession(draft, {
            rememberName: target.bridgeHost || target.daemonHostId || target.relayHostId || hostKey,
            activate: true,
            navigate: true,
          });
          if (paneId) {
            onSessionsOpenedInPane?.([opened.sessionId], paneId);
          }
        } catch (error) {
          window.alert?.(error instanceof Error ? error.message : String(error));
        }
      })();
      return;
    }
    openSessionPicker('quick-tab', {
      paneId: paneId || null,
    });
  }, [
    bridgeSettings,
    buildBlankSessionName,
    hosts,
    onSessionsOpenedInPane,
    openDraftAsSession,
    openSessionPicker,
    resolveTargetByHostKey,
  ]);

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
