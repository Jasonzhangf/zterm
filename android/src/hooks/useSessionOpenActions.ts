import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { upsertBridgeServer, type BridgeSettings } from '../lib/bridge-settings';
import type { OpenTabRuntimeRefs } from './useOpenTabRuntime';
import { runtimeDebug } from '../lib/runtime-debug';
import {
  buildPersistedOpenTabFromHostSession,
  buildPersistedOpenTabReuseKey,
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
  sortHostsForPicker,
  type BridgeTarget,
  type HostDraft,
} from '../lib/session-picker';
import { openConnectionPropertiesPage, openConnectionsPage, type AppPageState } from '../lib/page-state';
import type { Host, PersistedOpenTab } from '../lib/types';

type PickerMode = 'new-connection' | 'quick-tab' | 'edit-group' | null;

interface UseSessionOpenActionsOptions {
  bridgeSettings: BridgeSettings;
  setBridgeSettings: Dispatch<SetStateAction<BridgeSettings>>;
  hosts: Host[];
  upsertHost: (host: Omit<Host, 'id' | 'createdAt'>) => Host;
  deleteSessionGroup: (group: { bridgeHost: string; bridgePort: number; daemonHostId?: string }) => void;
  recordSessionOpen: (entry: {
    connectionName: string;
    bridgeHost: string;
    bridgePort: number;
    daemonHostId?: string;
    sessionName: string;
    authToken?: string;
  }) => void;
  recordSessionGroupOpen: (group: {
    name: string;
    bridgeHost: string;
    bridgePort: number;
    daemonHostId?: string;
    authToken?: string;
    sessionNames: string[];
  }) => void;
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
  persistOpenTabIntentState: (
    nextState: { tabs: PersistedOpenTab[]; activeSessionId: string | null },
    options?: { fallbackActiveSessionId?: string | null },
  ) => { tabs: PersistedOpenTab[]; activeSessionId: string | null };
  setPageState: Dispatch<SetStateAction<AppPageState>>;
}

export interface SessionOpenActionsResult {
  pickerMode: PickerMode;
  pickerTarget: BridgeTarget | null;
  pickerInitialSessions: string[];
  sortedHosts: Host[];
  handleLoadSavedTabList: (tabs: PersistedOpenTab[], requestedActiveSessionId?: string) => Promise<void>;
  handleAddNew: () => void;
  handleOpenQuickTabPicker: () => void;
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
  closePicker: () => void;
}

export function useSessionOpenActions(options: UseSessionOpenActionsOptions): SessionOpenActionsResult {
  const {
    bridgeSettings,
    setBridgeSettings,
    hosts,
    upsertHost,
    deleteSessionGroup,
    recordSessionOpen,
    recordSessionGroupOpen,
    setSessionGroupSelection,
    createSession,
    runtimeActiveSessionId,
    runtimeRefs,
    ensureTerminalPageVisible,
    persistOpenTabIntentState,
    setPageState,
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
    persistAndSwitchExplicitOpenTabsRef,
    renameSessionRef,
  } = runtimeRefs;

  const [pickerMode, setPickerMode] = useState<PickerMode>(null);
  const [pickerTarget, setPickerTarget] = useState<BridgeTarget | null>(null);
  const [pickerInitialSessions, setPickerInitialSessions] = useState<string[]>([]);
  const openDraftAsSessionRef = useRef<((host: HostDraft, options?: {
    rememberName?: string;
    activate?: boolean;
    navigate?: boolean;
    sessionId?: string;
  }) => { sessionId: string; host: Host }) | null>(null);

  const sortedHosts = useMemo(() => sortHostsForPicker(hosts, pickerTarget), [hosts, pickerTarget]);

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

  const rememberConnectionHost = useCallback((host: Omit<Host, 'id' | 'createdAt'>) => {
    return upsertHost({
      ...host,
      lastConnected: Date.now(),
    });
  }, [upsertHost]);

  const openDraftAsSession = useCallback((
    draft: HostDraft,
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
      daemonHostId: persistedHost.daemonHostId || persistedHost.relayHostId,
      bridgeHost: persistedHost.bridgeHost,
      bridgePort: persistedHost.bridgePort,
      sessionName: persistedHost.sessionName,
    }));
    const openedTab: PersistedOpenTab = {
      sessionId,
      hostId: persistedHost.id,
      connectionName: persistedHost.name,
      bridgeHost: persistedHost.bridgeHost,
      bridgePort: persistedHost.bridgePort,
      daemonHostId: persistedHost.daemonHostId || persistedHost.relayHostId,
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
        fallbackActiveSessionId: runtimeActiveSessionId,
      },
    );
    persistOpenTabIntentState(nextOpenTabState);
    recordSessionOpen({
      connectionName: persistedHost.name,
      bridgeHost: persistedHost.bridgeHost,
      bridgePort: persistedHost.bridgePort,
      daemonHostId: persistedHost.daemonHostId || persistedHost.relayHostId,
      sessionName: persistedHost.sessionName,
      authToken: persistedHost.authToken,
    });
    if (options?.navigate !== false) {
      ensureTerminalPageVisible();
    }
    return { sessionId, host: persistedHost };
  }, [
    closedOpenTabReuseKeysRef,
    closedOpenTabSessionIdsRef,
    createSession,
    ensureTerminalPageVisible,
    openTabStateRef,
    persistOpenTabIntentState,
    recordSessionOpen,
    rememberBridgeTarget,
    rememberConnectionHost,
    runtimeActiveSessionId,
  ]);

  useEffect(() => {
    openDraftAsSessionRef.current = openDraftAsSession;
  }, [openDraftAsSession]);

  const openSessionPicker = useCallback((mode: Exclude<PickerMode, null>, pickerOptions?: {
    target?: BridgeTarget | null;
    initialSelectedSessions?: string[];
  }) => {
    setPickerMode(mode);
    setPickerInitialSessions(pickerOptions?.initialSelectedSessions || []);
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
    return openDraftAsSession(draft, { rememberName, activate: true, navigate: true }).sessionId;
  }, [openDraftAsSession]);

  const handleOpenMultipleTmuxSessions = useCallback((target: BridgeTarget, sessionNames: string[]) => {
    const uniqueSessionNames = [...new Set(sessionNames.map((name) => name.trim()).filter(Boolean))];
    if (uniqueSessionNames.length === 0) {
      return;
    }
    let activeSessionId: string | null = null;
    uniqueSessionNames.forEach((sessionName, index) => {
      const draft = buildDraftFromTmuxSession(hosts, bridgeSettings.servers, target, sessionName);
      const sessionId = openDraftAsSession(draft, {
        rememberName: target.bridgeHost,
        activate: index === 0,
        navigate: false,
      }).sessionId;
      if (!activeSessionId) {
        activeSessionId = sessionId;
      }
    });
    recordSessionGroupOpen({
      name: `${target.bridgeHost} · ${sessionNames.length} tabs`,
      bridgeHost: target.bridgeHost,
      bridgePort: target.bridgePort,
      daemonHostId: target.daemonHostId || target.relayHostId,
      authToken: target.authToken,
      sessionNames: uniqueSessionNames,
    });
    setPickerMode(null);
    ensureTerminalPageVisible();
  }, [bridgeSettings.servers, ensureTerminalPageVisible, hosts, openDraftAsSession, recordSessionGroupOpen]);

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
      name: `${group.bridgeHost} · ${sessionNames.length} tabs`,
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
        if (!activeSessionId) {
          activeSessionId = sessionId;
        }
      });

      recordSessionGroupOpen({
        name: group.name,
        bridgeHost: group.bridgeHost,
        bridgePort: group.bridgePort,
        daemonHostId: group.daemonHostId,
        authToken: group.authToken,
        sessionNames: uniqueSessionNames,
      });
    });

    if (activeSessionId) {
      ensureTerminalPageVisible();
    }
  }, [bridgeSettings.servers, ensureTerminalPageVisible, hosts, openDraftAsSession, recordSessionGroupOpen]);

  const handleLoadSavedTabList = useCallback(async (tabs: PersistedOpenTab[], requestedActiveSessionId?: string) => {
    const importPlan = await resolveRemoteRestorableOpenTabState({
      tabs,
      activeSessionId: requestedActiveSessionId?.trim() || null,
      bridgeSettings: bridgeSettingsRef.current,
    });
    if (importPlan.droppedTabs.length > 0) {
      runtimeDebug('app.saved-tab-list.drop-missing-remote-sessions', {
        droppedSessionIds: importPlan.droppedTabs.map((tab) => tab.sessionId),
        droppedTargets: importPlan.droppedTabs.map((tab) => `${tab.bridgeHost}:${tab.bridgePort}:${tab.sessionName}`),
      });
    }
    if (importPlan.tabs.length === 0) {
      persistOpenTabIntentState({
        tabs: [],
        activeSessionId: null,
      });
      setPageState(openConnectionsPage());
      return;
    }
    const openedTabs: PersistedOpenTab[] = [];
    runtimeDebug('app.saved-tab-list.load', {
      requestedActiveSessionId: requestedActiveSessionId || null,
      sessionIds: importPlan.tabs.map((tab) => tab.sessionId),
      bridgeTargets: importPlan.tabs.map((tab) => `${tab.bridgeHost}:${tab.bridgePort}:${tab.sessionName}`),
    });

    importPlan.tabs.forEach((tab) => {
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
      const persistAndSwitch = persistAndSwitchExplicitOpenTabsRef.current;
      if (!persistAndSwitch) {
        throw new Error('persistAndSwitchExplicitOpenTabs ref unavailable while loading saved tab list');
      }
      persistAndSwitch(openedTabs, activeSessionId);
      ensureTerminalPageVisibleRef.current();
    }
  }, [bridgeSettingsRef, ensureTerminalPageVisibleRef, hostsRef, persistAndSwitchExplicitOpenTabsRef, renameSessionRef]);

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
  }, [handleQuickConnectDraft, pickerMode, rememberBridgeTarget, setPageState]);

  const handleAddNew = useCallback(() => {
    openSessionPicker('new-connection');
  }, [openSessionPicker]);

  const handleOpenQuickTabPicker = useCallback(() => {
    openSessionPicker('quick-tab');
  }, [openSessionPicker]);

  const closePicker = useCallback(() => {
    setPickerMode(null);
  }, []);

  return {
    pickerMode,
    pickerTarget,
    pickerInitialSessions,
    sortedHosts,
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
    closePicker,
  };
}
