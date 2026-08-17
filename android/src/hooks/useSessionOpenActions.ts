import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { OpenTabAuditReason } from './useOpenTabLifecycleEffects';
import type { OpenTabRuntimeSwitchReason } from '../lib/open-tab-runtime-switch';
import { upsertBridgeServer, type BridgeSettings } from '../lib/bridge-settings';
import type { OpenTabRuntimeRefs } from './useOpenTabRuntime';
import { runtimeDebug } from '../lib/runtime-debug';
import {
  clearClosedTabReuseKeysForOwner,
} from '../lib/open-tab-persistence';
import {
  deriveCloseOpenTabIntent,
  upsertOpenTabIntentSession,
  renameRemoteOpenTabIntentSession,
} from '../lib/open-tab-intent';
import {
  buildCleanDraft,
  buildBridgeTargetFromHost,
  buildDraftFromTmuxSession,
  buildPreferredTarget,
  buildTransientHostFromDraft,
  normalizeBridgeTarget,
  resolveRelayDeviceBridgeTarget,
  resolveRelayWebRtcFirstDeviceBridgeTarget,
  type BridgeTarget,
  type HostDraft,
} from '../lib/session-picker';
import { openConnectionPropertiesPage, type AppPageState } from '../lib/page-state';
import { normalizeRemoteTmuxSessionNames } from '../lib/tmux-session-list';
import { sanitizeTmuxSessionName } from '@zterm/shared/tmux-session-name';
import {
  createTmuxSession,
  fetchTmuxSessions,
  fetchTmuxSessionCatalog,
  killTmuxSession,
  renameTmuxSession,
} from '../lib/tmux-sessions';
import type { TerminalSessionCatalog } from '@zterm/shared/protocol';
import type { Host, PersistedOpenTab, Session, SessionGroupHistory, TraversalRelayDeviceSnapshot } from '../lib/types';
import type { RelayEndpointCandidate } from '@zterm/shared/relay-directory';
import type { TerminalMuxTargetClientMessage } from '@zterm/shared/protocol';
import type { SessionCloseOptions } from '../contexts/session-context-core';
import {
  buildGeneratedSessionName,
  resolveReusableOpenSessionForTarget,
  resolveSessionGroupForTarget,
} from '../lib/session-open-helpers';
import { sessionSemanticReuseMatch } from '../lib/session-semantic-identity';
import { listOnlineTraversalRelayDaemonDevices } from '../lib/traversal-relay-devices';

type PickerMode = 'new-connection' | 'quick-tab' | 'edit-group' | null;

interface QuickTabCreateOptions {
  sessionName?: string;
  cwd?: string;
  terminalBackend?: 'tmux' | 'herdr';
}

interface SessionOpenGroupTarget {
  bridgeHost: string;
  bridgePort: number;
  daemonHostId?: string;
  relayHostId?: string;
  terminalBackend?: 'tmux' | 'herdr';
  authToken?: string;
  relayEndpointCandidates?: RelayEndpointCandidate[];
  transportMode?: Host['transportMode'];
}

interface UseSessionOpenActionsOptions {
  bridgeSettings: BridgeSettings;
  setBridgeSettings: Dispatch<SetStateAction<BridgeSettings>>;
  hosts: Host[];
  sessionGroups?: SessionGroupHistory[];
  relayDevices?: TraversalRelayDeviceSnapshot[];
  deleteSessionGroup: (group: { bridgeHost: string; bridgePort: number; daemonHostId?: string }) => void;
  pruneSessionGroupSelectionToRemoteTruth: (target: {
    bridgeHost: string;
    bridgePort: number;
    daemonHostId?: string;
    terminalBackend?: 'tmux' | 'herdr';
  }, remoteSessionNames: string[]) => void;
  setSessionGroupSelection: (group: {
    name: string;
    bridgeHost: string;
    bridgePort: number;
    daemonHostId?: string;
    terminalBackend?: 'tmux' | 'herdr';
    authToken?: string;
    relayEndpointCandidates?: RelayEndpointCandidate[];
    sessionNames: string[];
    lastOpenedSessionName?: string;
  }) => void;
  markSessionGroupEntered: (group: {
    name?: string;
    bridgeHost: string;
    bridgePort: number;
    daemonHostId?: string;
    terminalBackend?: 'tmux' | 'herdr';
    authToken?: string;
    relayEndpointCandidates?: RelayEndpointCandidate[];
  }, sessionName: string) => void;
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
  closeSession: (sessionId: string, options?: SessionCloseOptions) => void;
  switchSession: (sessionId: string) => void;
  renameRemoteSession: (sessionId: string, name: string) => void;
  manageTmuxSessionsOnOpenTransport?: (
    sessionId: string,
    message: TerminalMuxTargetClientMessage,
  ) => Promise<string[] | null>;
  queryTerminalSessionCatalogOnOpenTransport?: (
    sessionId: string,
    message: TerminalMuxTargetClientMessage,
  ) => Promise<TerminalSessionCatalog | null>;
  runtimeActiveSessionId: string | null;
  runtimeRefs: OpenTabRuntimeRefs;
  ensureTerminalPageVisible: () => void;
  applyOpenTabState: (
    nextState: { tabs: PersistedOpenTab[]; activeSessionId: string | null },
    options?: { preserveActiveSessionId?: string | null; switchRuntime?: OpenTabRuntimeSwitchReason },
  ) => { tabs: PersistedOpenTab[]; activeSessionId: string | null };
  onSessionsOpenedInPane?: (sessionIds: string[], paneId: string) => void;
  onError?: (message: string) => void;
  setPageState: Dispatch<SetStateAction<AppPageState>>;
  auditOpenTabsAgainstRemoteSessions: (reason: OpenTabAuditReason) => Promise<void>;
}

export interface SessionOpenActionsResult {
  pickerMode: PickerMode;
  pickerTarget: BridgeTarget | null;
  pickerInitialSessions: string[];
  pickerScopePaneId: string | null;
  handleAddNew: () => void;
  handleOpenSavedConnection: (host: Host) => void;
  handleOpenQuickTabPicker: (paneId?: string, hostKey?: string, createOptions?: QuickTabCreateOptions) => void;
  handleOpenSingleTmuxSession: (target: BridgeTarget, sessionName: string) => void;
  handleOpenMultipleTmuxSessions: (target: BridgeTarget, sessionNames: string[]) => void;
  handleOpenGroupSession: (group: SessionOpenGroupTarget, sessionName: string, options?: { activate?: boolean; navigate?: boolean }) => string;
  handleRenameRemoteSession: (sessionId: string, nextSessionName: string) => Promise<void>;
  handleCloseGroupSession: (group: BridgeTarget & { name?: string; sessionNames?: string[] }, sessionName: string) => Promise<void>;
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
  handleRemoteSessionsRefreshed: (target: BridgeTarget, sessionNames: string[], catalog?: TerminalSessionCatalog) => void;
  handleRefreshDrawerHostSessions: (hostKey?: string) => Promise<void>;
  handleForceRelaySession: (sessionId: string) => void;
  handleUseAutoSession: (sessionId: string) => void;
  handleUseWebSocketSession: (sessionId: string) => void;
  closePicker: () => void;
}

export function useSessionOpenActions(options: UseSessionOpenActionsOptions): SessionOpenActionsResult {
  const {
    bridgeSettings,
    setBridgeSettings,
    hosts,
    sessionGroups = [],
    relayDevices = [],
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
    runtimeActiveSessionId,
    runtimeRefs,
    ensureTerminalPageVisible,
    applyOpenTabState,
    onSessionsOpenedInPane,
    onError,
    setPageState,
    auditOpenTabsAgainstRemoteSessions,
  } = options;

  const {
    sessionsRef,
    bridgeSettingsRef,
    openTabStateRef,
    closedOpenTabSessionIdsRef,
    closedOpenTabReuseKeysRef,
    pendingMaterializedOpenTabSessionIdsRef,
    terminalActiveSessionIdRef,
    runtimeActiveSessionIdRef,
  } = runtimeRefs;

  const [pickerMode, setPickerMode] = useState<PickerMode>(null);
  const [pickerTarget, setPickerTarget] = useState<BridgeTarget | null>(null);
  const [pickerInitialSessions, setPickerInitialSessions] = useState<string[]>([]);
  const [pickerScopePaneId, setPickerScopePaneId] = useState<string | null>(null);
  const sessionGroupsRef = useRef(sessionGroups);
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

  useEffect(() => {
    sessionGroupsRef.current = sessionGroups;
  }, [sessionGroups]);

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
    void deletedAnyReuseKey;
    const openedTab: PersistedOpenTab = {
      sessionId,
      hostId: sessionHost.id,
      connectionName: sessionHost.name,
      bridgeHost: sessionHost.bridgeHost,
      bridgePort: sessionHost.bridgePort,
      daemonHostId: sessionHost.daemonHostId || sessionHost.relayHostId,
      sessionName: sessionHost.sessionName,
      terminalBackend: sessionHost.terminalBackend || 'tmux',
      authToken: sessionHost.authToken,
      autoCommand: sessionHost.autoCommand,
      createdAt: Date.now(),
    };
    const nextOpenTabState = upsertOpenTabIntentSession(
      openTabStateRef.current,
      openedTab,
      {
        activate: shouldActivate,
        preserveActiveSessionId: runtimeActiveSessionId,
      },
    );
    applyOpenTabState(nextOpenTabState, shouldActivate ? {
      switchRuntime: 'explicit-resume',
    } : undefined);
    if (shouldActivate && sessionHost.sessionName.trim()) {
      markSessionGroupEntered({
        name: options?.rememberName || draft.name || draft.bridgeHost,
        bridgeHost: sessionHost.bridgeHost,
        bridgePort: sessionHost.bridgePort,
        daemonHostId: sessionHost.daemonHostId || sessionHost.relayHostId,
        terminalBackend: sessionHost.terminalBackend || 'tmux',
        authToken: sessionHost.authToken,
        relayEndpointCandidates: sessionHost.relayEndpointCandidates || [],
      }, sessionHost.sessionName);
    }
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
    markSessionGroupEntered,
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

  const handleQuickConnectDraft = useCallback((draft: HostDraft, rememberName?: string, options?: { activate?: boolean; navigate?: boolean }) => {
    const opened = openDraftAsSession(draft, {
      rememberName,
      activate: options?.activate !== false,
      navigate: options?.navigate !== false,
    });
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

  const handleOpenGroupSession = useCallback((group: SessionOpenGroupTarget, sessionName: string, options?: { activate?: boolean; navigate?: boolean }) => {
    const terminalBackend = group.terminalBackend || 'tmux';
    return handleQuickConnectDraft(
      {
        name: `${group.bridgeHost} · ${sessionName}`,
        bridgeHost: group.bridgeHost,
        bridgePort: group.bridgePort,
        daemonHostId: group.daemonHostId,
        relayHostId: group.relayHostId || group.daemonHostId,
        terminalBackend,
        sessionName,
        authToken: group.authToken || '',
        relayEndpointCandidates: group.relayEndpointCandidates || [],
        transportMode: group.transportMode || 'auto',
        authType: 'password',
        password: undefined,
        privateKey: undefined,
        autoCommand: '',
        tags: [terminalBackend, sessionName],
        pinned: false,
        lastConnected: Date.now(),
      },
      group.bridgeHost,
      options,
    );
  }, [handleQuickConnectDraft]);

  const handleEditServerGroup = useCallback((group: {
    bridgeHost: string;
    bridgePort: number;
    daemonHostId?: string;
    relayHostId?: string;
    authToken?: string;
    relayEndpointCandidates?: RelayEndpointCandidate[];
    transportMode?: Host['transportMode'];
  }, sessionNames: string[]) => {
    openSessionPicker('edit-group', {
      target: {
        bridgeHost: group.bridgeHost,
        bridgePort: group.bridgePort,
        daemonHostId: group.daemonHostId,
        relayHostId: group.relayHostId || group.daemonHostId,
        authToken: group.authToken,
        relayEndpointCandidates: group.relayEndpointCandidates || [],
        transportMode: group.transportMode,
      },
      initialSelectedSessions: sessionNames,
    });
  }, [openSessionPicker]);

  const handleSaveServerGroupSelection = useCallback((group: {
    bridgeHost: string;
    bridgePort: number;
    daemonHostId?: string;
    terminalBackend?: 'tmux' | 'herdr';
    authToken?: string;
    relayEndpointCandidates?: RelayEndpointCandidate[];
  }, sessionNames: string[]) => {
    setSessionGroupSelection({
      name: `${group.bridgeHost} · ${sessionNames.length} sessions`,
      bridgeHost: group.bridgeHost,
      bridgePort: group.bridgePort,
      daemonHostId: group.daemonHostId,
      terminalBackend: group.terminalBackend,
      authToken: group.authToken,
      ...(group.relayEndpointCandidates?.length
        ? { relayEndpointCandidates: group.relayEndpointCandidates }
        : {}),
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
    terminalBackend?: 'tmux' | 'herdr';
    relayHostId?: string;
    authToken?: string;
    relayEndpointCandidates?: RelayEndpointCandidate[];
    transportMode?: Host['transportMode'];
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
            relayHostId: group.relayHostId || group.daemonHostId,
            terminalBackend: group.terminalBackend,
            authToken: group.authToken,
            relayEndpointCandidates: group.relayEndpointCandidates || [],
            transportMode: group.transportMode,
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

  const handleRemoteSessionsRefreshed = useCallback((
    target: BridgeTarget,
    sessionNames: string[],
    catalog?: TerminalSessionCatalog,
  ) => {
    const normalizedSessionNames = normalizeRemoteTmuxSessionNames(sessionNames);
    const baseGroup = {
      name: target.daemonHostId || target.relayHostId || target.bridgeHost,
      bridgeHost: target.bridgeHost,
      bridgePort: target.bridgePort,
      daemonHostId: target.daemonHostId || target.relayHostId,
      authToken: target.authToken,
      ...(target.relayEndpointCandidates?.length
        ? { relayEndpointCandidates: target.relayEndpointCandidates }
        : {}),
    };
    if (catalog?.sessionCatalog.length) {
      const entriesByBackend = new Map<'tmux' | 'herdr', TerminalSessionCatalog['sessionCatalog']>();
      for (const entry of catalog.sessionCatalog) {
        if (entry.backend !== 'tmux' && entry.backend !== 'herdr') {
          continue;
        }
        const entries = entriesByBackend.get(entry.backend) || [];
        entries.push(entry);
        entriesByBackend.set(entry.backend, entries);
      }
      for (const backend of ['tmux', 'herdr'] as const) {
        const backendNames = normalizeRemoteTmuxSessionNames(
          (entriesByBackend.get(backend) || []).map((entry) => entry.name),
        );
        if (backendNames.length > 0) {
          setSessionGroupSelection({
            ...baseGroup,
            terminalBackend: backend,
            sessionNames: backendNames,
          });
        }
        pruneSessionGroupSelectionToRemoteTruth({
          bridgeHost: target.bridgeHost,
          bridgePort: target.bridgePort,
          daemonHostId: target.daemonHostId || target.relayHostId,
          terminalBackend: backend,
        }, backendNames);
      }
    } else {
      if (normalizedSessionNames.length > 0) {
        setSessionGroupSelection({
          ...baseGroup,
          ...(target.terminalBackend === 'herdr' ? { terminalBackend: 'herdr' as const } : {}),
          sessionNames: normalizedSessionNames,
        });
      }
      pruneSessionGroupSelectionToRemoteTruth({
        bridgeHost: target.bridgeHost,
        bridgePort: target.bridgePort,
        daemonHostId: target.daemonHostId || target.relayHostId,
        ...(target.terminalBackend === 'herdr' ? { terminalBackend: 'herdr' as const } : {}),
      }, normalizedSessionNames);
    }
    void auditOpenTabsAgainstRemoteSessions('session-picker-refresh').catch((error) => {
      console.error('[App] Failed to audit remote session truth after session picker refresh:', error);
    });
  }, [auditOpenTabsAgainstRemoteSessions, pruneSessionGroupSelectionToRemoteTruth, setSessionGroupSelection]);

  const manageTmuxSessionsForTarget = useCallback(async (
    target: BridgeTarget,
    message: TerminalMuxTargetClientMessage,
    fallbackOptions?: { includeEmptyCreateOptions?: boolean },
    excludedSessionIds: string[] = [],
  ) => {
    const routedMessage: TerminalMuxTargetClientMessage = message;
    const excludedSessionIdSet = new Set(
      excludedSessionIds.map((sessionId) => sessionId.trim()).filter(Boolean),
    );
    const reusableSessions = sessionsRef.current.filter(
      (session) => !excludedSessionIdSet.has(session.id),
    );
    const reusableSession = resolveReusableOpenSessionForTarget(
      reusableSessions,
      target,
      '',
      [terminalActiveSessionIdRef.current, runtimeActiveSessionId],
      false,
    );
    if (reusableSession && manageTmuxSessionsOnOpenTransport) {
      const result = await manageTmuxSessionsOnOpenTransport(reusableSession.id, routedMessage);
      if (result === null) {
        throw new Error('Existing terminal transport is unavailable for tmux management');
      }
      return result;
    }

    const settings = bridgeSettingsRef.current;
    switch (routedMessage.type) {
      case 'list-sessions':
        return fetchTmuxSessions(target, settings);
      case 'tmux-create-session':
        if (routedMessage.payload.cwd) {
          return createTmuxSession(target, settings, routedMessage.payload.sessionName, { cwd: routedMessage.payload.cwd });
        }
        return fallbackOptions?.includeEmptyCreateOptions
          ? createTmuxSession(target, settings, routedMessage.payload.sessionName, undefined)
          : createTmuxSession(target, settings, routedMessage.payload.sessionName);
      case 'tmux-rename-session':
        return renameTmuxSession(
          target,
          settings,
          routedMessage.payload.sessionName,
          routedMessage.payload.nextSessionName,
        );
      case 'tmux-kill-session':
        return killTmuxSession(target, settings, routedMessage.payload.sessionName);
      default:
        return Promise.resolve([]);
    }
  }, [
    bridgeSettingsRef,
    manageTmuxSessionsOnOpenTransport,
    runtimeActiveSessionId,
    sessionsRef,
    terminalActiveSessionIdRef,
  ]);

  const queryRemoteSessionCatalogForTarget = useCallback(async (target: BridgeTarget) => {
    const reusableSession = resolveReusableOpenSessionForTarget(
      sessionsRef.current,
      target,
      '',
      [terminalActiveSessionIdRef.current, runtimeActiveSessionId],
      false,
    );
    if (reusableSession && queryTerminalSessionCatalogOnOpenTransport) {
      const catalog = await queryTerminalSessionCatalogOnOpenTransport(reusableSession.id, { type: 'list-sessions' });
      if (catalog === null) {
        throw new Error('Existing terminal transport is unavailable for session catalog refresh');
      }
      return catalog;
    }
    return fetchTmuxSessionCatalog(target, bridgeSettingsRef.current);
  }, [
    bridgeSettingsRef,
    queryTerminalSessionCatalogOnOpenTransport,
    runtimeActiveSessionId,
    sessionsRef,
    terminalActiveSessionIdRef,
  ]);

  const handleRenameRemoteSession = useCallback(async (
    sessionId: string,
    nextSessionName: string,
  ) => {
    const session = sessionsRef.current.find((candidate) => candidate.id === sessionId);
    if (!session) {
      throw new Error('Terminal session is unavailable');
    }
    const currentSessionName = session.sessionName.trim();
    const requestedNextSessionName = nextSessionName.trim();
    if (!requestedNextSessionName) {
      return;
    }
    const normalizedNextSessionName = sanitizeTmuxSessionName(requestedNextSessionName);
    if (normalizedNextSessionName === currentSessionName) {
      return;
    }

    const target = normalizeBridgeTarget({
      bridgeHost: session.bridgeHost,
      bridgePort: session.bridgePort,
      daemonHostId: session.daemonHostId,
      relayHostId: session.daemonHostId,
      authToken: session.authToken,
      terminalBackend: session.terminalBackend || 'tmux',
    });
    if (!manageTmuxSessionsOnOpenTransport) {
      throw new Error('Existing terminal transport is unavailable for tmux management');
    }
    const sessionNames = await manageTmuxSessionsOnOpenTransport(sessionId, {
      type: 'tmux-rename-session',
      payload: {
        sessionName: currentSessionName,
        nextSessionName: normalizedNextSessionName,
      },
    });
    if (sessionNames === null) {
      throw new Error('Existing terminal transport is unavailable for tmux management');
    }

    renameRemoteSession(sessionId, normalizedNextSessionName);
    applyOpenTabState(renameRemoteOpenTabIntentSession(
      openTabStateRef.current,
      sessionId,
      normalizedNextSessionName,
    ));
    handleRemoteSessionsRefreshed(target, sessionNames ?? []);
  }, [
    applyOpenTabState,
    handleRemoteSessionsRefreshed,
    manageTmuxSessionsOnOpenTransport,
    openTabStateRef,
    renameRemoteSession,
    sessionsRef,
  ]);

  const handleCloseGroupSession = useCallback(async (
    group: BridgeTarget & { name?: string; sessionNames?: string[] },
    sessionName: string,
  ) => {
    const target = normalizeBridgeTarget(group);
    const stoppedSessionIds: string[] = [];
    for (const session of sessionsRef.current) {
      if (session.state === 'closed') {
        continue;
      }
      if (sessionSemanticReuseMatch(session, {
        daemonHostId: target.daemonHostId || target.relayHostId,
        bridgeHost: target.bridgeHost,
        bridgePort: target.bridgePort,
        sessionName,
        terminalBackend: target.terminalBackend || 'tmux',
      })) {
        stoppedSessionIds.push(session.id);
        closeSession(session.id, { preserveTargetTransport: true });
      }
    }
    const sessionNames = await manageTmuxSessionsForTarget(
      target,
      {
        type: 'tmux-kill-session',
        payload: {
          sessionName,
        },
      },
      undefined,
    );
    for (const sessionId of stoppedSessionIds) {
      closeSession(sessionId);
      const closeResult = deriveCloseOpenTabIntent(openTabStateRef.current, sessionId, {
        runtimeActiveSessionId: runtimeActiveSessionIdRef.current,
        nextActiveCandidateSessionIds: sessionsRef.current
          .filter((candidate) => candidate.id !== sessionId)
          .map((candidate) => candidate.id),
        runtimeSessions: sessionsRef.current,
      });
      if (closeResult.closedReuseKeyVariants.length > 0) {
        for (const key of closeResult.closedReuseKeyVariants) {
          closedOpenTabReuseKeysRef.current.add(key);
        }
      }
      closedOpenTabSessionIdsRef.current.add(sessionId);
      applyOpenTabState(closeResult.nextState);
    }
    handleRemoteSessionsRefreshed(target, sessionNames ?? []);
  }, [
    applyOpenTabState,
    closeSession,
    closedOpenTabReuseKeysRef,
    closedOpenTabSessionIdsRef,
    handleRemoteSessionsRefreshed,
    manageTmuxSessionsForTarget,
    openTabStateRef,
    runtimeActiveSessionIdRef,
    sessionsRef,
  ]);

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
      initialSelectedSessions: [],
      paneId: null,
    });
  }, [openSessionPicker]);

  const handleOpenSavedConnection = useCallback((host: Host) => {
    const target = buildBridgeTargetFromHost(host);
    const existingSessionName = host.sessionName.trim();
    const historyGroup = resolveSessionGroupForTarget(sessionGroupsRef.current, target);
    const historySessionName = historyGroup?.lastOpenedSessionName?.trim() || '';
    const preferredExistingSessionName = existingSessionName || historySessionName;
    setPickerMode(null);
    setPickerScopePaneId(null);

    const activateReusableSession = (reusableSession: Session) => {
      const routeDraft = buildDraftFromTmuxSession(
        hosts,
        bridgeSettingsRef.current.servers,
        target,
        reusableSession.sessionName,
      );
      const routeHost = buildTransientHostFromDraft({
        ...routeDraft,
        lastConnected: Date.now(),
      });
      const reboundSessionId = createSession(routeHost, {
        activate: false,
        sessionId: reusableSession.id,
        createdAt: reusableSession.createdAt,
        customName: reusableSession.customName,
      });
      pendingMaterializedOpenTabSessionIdsRef.current.add(reboundSessionId);
      closedOpenTabSessionIdsRef.current.delete(reboundSessionId);
      const deletedAnyReuseKey = clearClosedTabReuseKeysForOwner(closedOpenTabReuseKeysRef.current, {
        daemonHostId: routeHost.daemonHostId || routeHost.relayHostId,
        bridgeHost: routeHost.bridgeHost,
        bridgePort: routeHost.bridgePort,
        sessionName: routeHost.sessionName,
      });
      void deletedAnyReuseKey;
      const nextOpenTabState = upsertOpenTabIntentSession(
        openTabStateRef.current,
        {
          sessionId: reusableSession.id,
          hostId: routeHost.id,
          connectionName: routeHost.name,
          bridgeHost: routeHost.bridgeHost,
          bridgePort: routeHost.bridgePort,
          daemonHostId: routeHost.daemonHostId || routeHost.relayHostId,
          sessionName: routeHost.sessionName,
          terminalBackend: routeHost.terminalBackend || 'tmux',
          authToken: routeHost.authToken,
          autoCommand: routeHost.autoCommand,
          customName: reusableSession.customName,
          createdAt: reusableSession.createdAt || Date.now(),
        },
        {
          activate: true,
          preserveActiveSessionId: runtimeActiveSessionId,
        },
      );
      applyOpenTabState(nextOpenTabState, {
        switchRuntime: 'explicit-resume',
      });
      markSessionGroupEntered({
        name: host.name || target.bridgeHost || target.daemonHostId || target.relayHostId,
        bridgeHost: target.bridgeHost,
        bridgePort: target.bridgePort,
        daemonHostId: target.daemonHostId || target.relayHostId,
        terminalBackend: target.terminalBackend || 'tmux',
        authToken: target.authToken,
        relayEndpointCandidates: target.relayEndpointCandidates || [],
      }, reusableSession.sessionName);
      ensureTerminalPageVisible();
    };

    if (preferredExistingSessionName) {
      const reusableSession = resolveReusableOpenSessionForTarget(
        sessionsRef.current,
        target,
        preferredExistingSessionName,
        [terminalActiveSessionIdRef.current, runtimeActiveSessionId],
      );
      if (reusableSession) {
        activateReusableSession(reusableSession);
        return;
      }
    }

    if (existingSessionName) {
      void (async () => {
        try {
          const draft = buildDraftFromTmuxSession(hosts, bridgeSettingsRef.current.servers, target, existingSessionName);
          handleQuickConnectDraft(draft, host.name || target.bridgeHost || target.daemonHostId || target.relayHostId);
        } catch (error) {
          onError?.(error instanceof Error ? error.message : String(error));
        }
      })();
      return;
    }

    void (async () => {
      try {
        const remoteSessionNames = normalizeRemoteTmuxSessionNames(
          await manageTmuxSessionsForTarget(target, { type: 'list-sessions' }),
        );
        handleRemoteSessionsRefreshed(target, remoteSessionNames ?? []);
        const remoteSessionNameSet = new Set(remoteSessionNames);
        let sessionName = historySessionName && remoteSessionNameSet.has(historySessionName)
          ? historySessionName
          : remoteSessionNames[0] || '';
        if (!sessionName) {
          sessionName = buildGeneratedSessionName();
          await manageTmuxSessionsForTarget(target, {
            type: 'tmux-create-session',
            payload: { sessionName },
          });
        }
        const reusableSession = resolveReusableOpenSessionForTarget(
          sessionsRef.current,
          target,
          sessionName,
          [terminalActiveSessionIdRef.current, runtimeActiveSessionId],
        );
        if (reusableSession) {
          activateReusableSession(reusableSession);
          return;
        }
        const draft = buildDraftFromTmuxSession(hosts, bridgeSettingsRef.current.servers, target, sessionName);
        handleQuickConnectDraft(draft, host.name || target.bridgeHost || target.daemonHostId || target.relayHostId);
      } catch (error) {
        onError?.(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [applyOpenTabState, bridgeSettingsRef, closedOpenTabReuseKeysRef, closedOpenTabSessionIdsRef, createSession, ensureTerminalPageVisible, handleQuickConnectDraft, handleRemoteSessionsRefreshed, hosts, manageTmuxSessionsForTarget, markSessionGroupEntered, openTabStateRef, pendingMaterializedOpenTabSessionIdsRef, runtimeActiveSessionId, sessionsRef, terminalActiveSessionIdRef]);

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
    const matchedDevice = listOnlineTraversalRelayDaemonDevices(relayDevices).find((device) => (
      device.daemon.hostId.trim() === normalizedHostKey
      || device.deviceId.trim() === normalizedHostKey
      || device.deviceName.trim() === normalizedHostKey
    ));
    if (matchedDevice) {
      return enrichTargetFromSavedHosts(
        resolveRelayWebRtcFirstDeviceBridgeTarget(bridgeSettings.servers, matchedDevice)
          || resolveRelayDeviceBridgeTarget(bridgeSettings.servers, matchedDevice),
      );
    }
    const matchedHost = hosts
      .filter((host) => (
        host.id.trim() === normalizedHostKey
        || host.name.trim() === normalizedHostKey
        || host.daemonHostId?.trim() === normalizedHostKey
        || host.relayHostId?.trim() === normalizedHostKey
        || host.bridgeHost.trim() === normalizedHostKey
        || `${host.bridgeHost.trim()}:${host.bridgePort}` === normalizedHostKey
      ))
      .sort((left, right) => Math.max(right.lastConnected || 0, right.createdAt) - Math.max(left.lastConnected || 0, left.createdAt))[0];
    if (matchedHost) {
      return buildBridgeTargetFromHost(matchedHost);
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
  }, [bridgeSettings.servers, enrichTargetFromSavedHosts, hosts, relayDevices, sessionsRef]);

  const buildBlankSessionName = useCallback(() => {
    return buildGeneratedSessionName();
  }, []);

  const handleOpenQuickTabPicker = useCallback((paneId?: string, hostKey?: string, createOptions?: QuickTabCreateOptions) => {
    const target = resolveTargetByHostKey(hostKey);
    if (target) {
      if (createOptions?.terminalBackend === 'herdr') {
        openSessionPicker('quick-tab', {
          target: { ...target, terminalBackend: 'herdr' },
          paneId: paneId || null,
        });
        return;
      }
      const sessionName = createOptions?.sessionName?.trim() || buildBlankSessionName();
      const cwd = createOptions?.cwd?.trim();
      void (async () => {
        try {
          await manageTmuxSessionsForTarget(target, {
            type: 'tmux-create-session',
            payload: {
              sessionName,
              ...(cwd ? { cwd } : {}),
            },
          }, { includeEmptyCreateOptions: true });
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
          onError?.(error instanceof Error ? error.message : String(error));
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
    manageTmuxSessionsForTarget,
    resolveTargetByHostKey,
  ]);

  const handleRefreshDrawerHostSessions = useCallback(async (hostKey?: string) => {
    const target = resolveTargetByHostKey(hostKey);
    if (!target) {
      return;
    }
    const discoveryTarget = normalizeBridgeTarget({ ...target, terminalBackend: undefined });
    const catalog = await queryRemoteSessionCatalogForTarget(discoveryTarget);
    handleRemoteSessionsRefreshed(discoveryTarget, catalog?.sessionNames ?? [], catalog ?? undefined);
  }, [
    handleRemoteSessionsRefreshed,
    queryRemoteSessionCatalogForTarget,
    resolveTargetByHostKey,
  ]);

  const resolveCanonicalRelayHostId = useCallback((tab: PersistedOpenTab) => {
    const currentBridgeSettings = bridgeSettingsRef.current;
    return (
      currentBridgeSettings.servers.find((server) => (
        server.id === currentBridgeSettings.defaultServerId
        && server.targetHost === tab.bridgeHost
        && server.targetPort === tab.bridgePort
        && server.relayHostId?.trim()
      ))?.relayHostId?.trim()
      || currentBridgeSettings.servers.find((server) => (
        server.targetHost === tab.bridgeHost
        && server.targetPort === tab.bridgePort
        && server.relayHostId?.trim()
        && server.relayDeviceId?.trim()
      ))?.relayHostId?.trim()
      || ''
    );
  }, [bridgeSettingsRef]);

  const reconnectOpenTabWithHost = useCallback((sessionId: string, host: Host, tab: PersistedOpenTab, eventName: string, payload: Record<string, unknown>) => {
    runtimeDebug(eventName, payload);
    closeSession(sessionId);
    createSession(host, {
      sessionId,
      createdAt: tab.createdAt,
      customName: tab.customName,
    });
    switchSession(sessionId);
    ensureTerminalPageVisible();
  }, [closeSession, createSession, ensureTerminalPageVisible, switchSession]);

  const handleForceRelaySession = useCallback((sessionId: string) => {
    const normalizedSessionId = sessionId.trim();
    const tab = openTabStateRef.current.tabs.find((item) => item.sessionId === normalizedSessionId);
    const liveSession = sessionsRef.current.find((item) => item.id === normalizedSessionId) || null;
    const relayAccessToken = bridgeSettingsRef.current.traversalRelay?.accessToken?.trim();
    if (!relayAccessToken) {
      onError?.('请先在 Settings 登录 Relay 控制面。');
      return;
    }
    if (!tab) {
      onError?.('当前 tab 缺少连接信息，无法强制 Relay。请从 Relay Daemon 设备重新打开。');
      return;
    }
    const relayHostId = resolveCanonicalRelayHostId(tab) || tab.daemonHostId?.trim() || liveSession?.daemonHostId?.trim() || '';
    if (!relayHostId) {
      onError?.('当前 tab 缺少 daemonHostId，无法强制 Relay。请从 Relay Daemon 设备重新打开。');
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
    reconnectOpenTabWithHost(normalizedSessionId, relayHost, tab, 'app.session.force-relay', {
      sessionId: normalizedSessionId,
      relayHostId,
      sessionName: relayHost.sessionName,
      bridgeHost: relayHost.bridgeHost,
      bridgePort: relayHost.bridgePort,
    });
  }, [
    bridgeSettingsRef,
    openTabStateRef,
    reconnectOpenTabWithHost,
    resolveCanonicalRelayHostId,
    sessionsRef,
  ]);

  const handleUseAutoSession = useCallback((sessionId: string) => {
    const normalizedSessionId = sessionId.trim();
    const tab = openTabStateRef.current.tabs.find((item) => item.sessionId === normalizedSessionId);
    const liveSession = sessionsRef.current.find((item) => item.id === normalizedSessionId) || null;
    if (!tab) {
      onError?.('当前 tab 缺少连接信息，无法切回 Auto。请从连接列表重新打开。');
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
    reconnectOpenTabWithHost(normalizedSessionId, autoHost, tab, 'app.session.use-auto', {
      sessionId: normalizedSessionId,
      relayHostId: relayHostId || null,
      sessionName: autoHost.sessionName,
      bridgeHost: autoHost.bridgeHost,
      bridgePort: autoHost.bridgePort,
    });
  }, [openTabStateRef, reconnectOpenTabWithHost, sessionsRef]);

  const handleUseWebSocketSession = useCallback((sessionId: string) => {
    const normalizedSessionId = sessionId.trim();
    const tab = openTabStateRef.current.tabs.find((item) => item.sessionId === normalizedSessionId);
    const liveSession = sessionsRef.current.find((item) => item.id === normalizedSessionId) || null;
    if (!tab) {
      onError?.('当前 tab 缺少连接信息，无法切到直连。请从连接列表重新打开。');
      return;
    }
    const relayHostId = tab.daemonHostId?.trim() || liveSession?.daemonHostId?.trim() || '';
    const directHost: Host = {
      id: tab.hostId || `websocket:${tab.bridgeHost}:${tab.bridgePort}:${tab.sessionName}`,
      createdAt: tab.createdAt || Date.now(),
      name: tab.connectionName || tab.sessionName,
      bridgeHost: tab.bridgeHost,
      bridgePort: tab.bridgePort,
      daemonHostId: relayHostId || undefined,
      relayHostId: relayHostId || undefined,
      sessionName: tab.sessionName,
      authToken: tab.authToken,
      autoCommand: tab.autoCommand,
      transportMode: 'websocket',
      authType: 'password',
      tags: [],
      pinned: false,
      lastConnected: Date.now(),
    };
    reconnectOpenTabWithHost(normalizedSessionId, directHost, tab, 'app.session.use-websocket', {
      sessionId: normalizedSessionId,
      relayHostId: relayHostId || null,
      sessionName: directHost.sessionName,
      bridgeHost: directHost.bridgeHost,
      bridgePort: directHost.bridgePort,
    });
  }, [openTabStateRef, reconnectOpenTabWithHost, sessionsRef]);

  const closePicker = useCallback(() => {
    setPickerMode(null);
    setPickerScopePaneId(null);
  }, []);

  return {
    pickerMode,
    pickerTarget,
    pickerInitialSessions,
    pickerScopePaneId,
    handleAddNew,
    handleOpenSavedConnection,
    handleOpenQuickTabPicker,
    handleOpenSingleTmuxSession,
    handleOpenMultipleTmuxSessions,
    handleOpenGroupSession,
    handleRenameRemoteSession,
    handleCloseGroupSession,
    handleOpenServerGroups,
    handleEditServerGroup,
    handleSaveServerGroupSelection,
    handleDeleteServerGroup,
    handleSelectCleanSession,
    handleRemoteSessionsRefreshed,
    handleRefreshDrawerHostSessions,
    handleForceRelaySession,
    handleUseAutoSession,
    handleUseWebSocketSession,
    closePicker,
  };
}
