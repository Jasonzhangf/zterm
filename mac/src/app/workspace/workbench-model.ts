/**
 * Mac workbench state owner.
 *
 * This is the transitional UI-facing wrapper over the Mac workspace owner.
 * It keeps launcher state near the current renderer shell while pane/tab identity
 * and pane operations live under `mac/src/app/workspace/*`.
 */

import {
  addPaneToWorkspace,
  cloneWorkspaceState,
  createWorkspacePane,
  removePaneFromWorkspace,
  resolveActiveTab as resolveActiveWorkspaceTab,
  setActivePane,
  updateWorkspacePane,
  type WorkspacePane,
  type WorkspaceState,
  type WorkspaceTab,
} from '@zterm/shared';
import type { EditableHost, Host } from '@zterm/shared';
import {
  buildLocalTmuxMacRuntimeKey,
  buildRemoteMacRuntimeKey,
  createEmptyMacTab,
  createLocalTmuxMacTab,
  createMacWorkspacePane,
  createRemoteMacTab,
  parseMacWorkspaceRecord,
  type MacPaneRecord,
  type MacRuntimeKey,
  type MacTabRecord,
  type MacWorkspaceRecord,
} from './workspace-store';

export interface MacWorkbenchTab extends WorkspaceTab {
  id: string;
  kind: 'empty' | 'connection' | 'local-tmux';
  title: string;
  runtimeKey?: MacRuntimeKey;
  persistedHostId?: string;
  draftTarget?: EditableHost;
  localSessionName?: string;
}

export interface MacWorkbenchState {
  workspace: WorkspaceState<MacWorkbenchTab>;
  launcherOpen: boolean;
  pendingSessionReplacement?: {
    paneId: string;
    tabId: string;
  };
}

function createId(prefix: string) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildConnectionTitle(target: EditableHost) {
  return target.sessionName.trim() || target.name.trim() || target.bridgeHost.trim() || 'Connection';
}

function buildConnectionRuntimeKey(target: EditableHost, persistedHostId?: string): MacRuntimeKey {
  const serverId = persistedHostId?.trim()
    || `${target.bridgeHost.trim()}:${Math.max(1, Math.floor(target.bridgePort || 3333))}`;
  const sessionName = target.sessionName.trim();
  return buildRemoteMacRuntimeKey(serverId, sessionName);
}

export function createEmptyTab(): MacWorkbenchTab {
  return {
    id: createId('tab'),
    kind: 'empty',
    title: 'New tab',
  };
}

export function createConnectionTab(target: EditableHost, persistedHostId?: string): MacWorkbenchTab {
  return {
    id: createId('tab'),
    kind: 'connection',
    title: buildConnectionTitle(target),
    runtimeKey: buildConnectionRuntimeKey(target, persistedHostId),
    persistedHostId,
    draftTarget: { ...target },
  };
}

export function createLocalTmuxTab(sessionName: string): MacWorkbenchTab {
  return {
    id: createId('tab'),
    kind: 'local-tmux',
    title: sessionName.trim() || 'Local tmux',
    localSessionName: sessionName.trim(),
    runtimeKey: buildLocalTmuxMacRuntimeKey(sessionName.trim()),
  };
}

function createPaneWith(initialTab: MacWorkbenchTab): WorkspacePane<MacWorkbenchTab> {
  return createWorkspacePane<MacWorkbenchTab>(initialTab, 1);
}

export function createInitialWorkbenchState(): MacWorkbenchState {
  const empty = createEmptyTab();
  const pane = createPaneWith(empty);
  return {
    workspace: { panes: [pane], activePaneId: pane.id },
    launcherOpen: false,
  };
}

export function setLauncherOpen(state: MacWorkbenchState, launcherOpen: boolean): MacWorkbenchState {
  return {
    ...state,
    launcherOpen,
    ...(launcherOpen ? {} : { pendingSessionReplacement: undefined }),
  };
}

export function activateTab(state: MacWorkbenchState, tabId: string): MacWorkbenchState {
  for (const pane of state.workspace.panes) {
    if (pane.tabs.some((tab) => tab.id === tabId)) {
      const next = updateWorkspacePane(state.workspace, pane.id, (currentPane) => ({
        ...currentPane,
        activeTabId: tabId,
      }));
      return { ...state, workspace: setActivePane(next, pane.id) };
    }
  }
  return state;
}

export function appendEmptyTab(state: MacWorkbenchState): MacWorkbenchState {
  const empty = createEmptyTab();
  const activePane = state.workspace.panes.find((pane) => pane.id === state.workspace.activePaneId)
    ?? state.workspace.panes[0];
  if (!activePane) {
    return state;
  }
  const next = updateWorkspacePane(state.workspace, activePane.id, (pane) => ({
    ...pane,
    tabs: [...pane.tabs, empty],
    activeTabId: empty.id,
  }));
  return { ...state, workspace: next, launcherOpen: true, pendingSessionReplacement: undefined };
}

function replacePendingSessionTab(
  state: MacWorkbenchState,
  newTab: MacWorkbenchTab,
): MacWorkbenchState | null {
  const pending = state.pendingSessionReplacement;
  if (!pending) {
    return null;
  }
  const pendingPane = state.workspace.panes.find((pane) => pane.id === pending.paneId);
  if (!pendingPane?.tabs.some((tab) => tab.id === pending.tabId)) {
    return { ...state, launcherOpen: false, pendingSessionReplacement: undefined };
  }
  const next = updateWorkspacePane(state.workspace, pending.paneId, (pane) => ({
    ...pane,
    tabs: pane.tabs.map((tab) => (tab.id === pending.tabId ? newTab : tab)),
    activeTabId: newTab.id,
  }));
  return {
    ...state,
    workspace: setActivePane(next, pending.paneId),
    launcherOpen: false,
    pendingSessionReplacement: undefined,
  };
}

export function closeTab(state: MacWorkbenchState, tabId: string): MacWorkbenchState {
  for (const pane of state.workspace.panes) {
    if (!pane.tabs.some((tab) => tab.id === tabId)) {
      continue;
    }
    const remaining = pane.tabs.filter((tab) => tab.id !== tabId);
    if (pane.tabs.length === 1) {
      if (state.workspace.panes.length === 1) {
        const replacement = createPaneWith(createEmptyTab());
        return {
          ...state,
          workspace: { panes: [replacement], activePaneId: replacement.id },
        };
      }
      return { ...state, workspace: removePaneFromWorkspace(state.workspace, pane.id) };
    }
    const nextActive = pane.activeTabId === tabId
      ? (remaining[Math.max(0, remaining.length - 1)]?.id ?? remaining[0].id)
      : pane.activeTabId;
    const updated = updateWorkspacePane(state.workspace, pane.id, (currentPane) => ({
      ...currentPane,
      tabs: remaining,
      activeTabId: nextActive,
    }));
    return { ...state, workspace: updated };
  }
  return state;
}

export function openConnectionInWorkbench(
  state: MacWorkbenchState,
  target: EditableHost,
  options?: { persistedHostId?: string; append?: boolean; paneId?: string },
): MacWorkbenchState {
  const newTab = createConnectionTab(target, options?.persistedHostId);
  if (!options?.append) {
    const replaced = replacePendingSessionTab(state, newTab);
    if (replaced) {
      return replaced;
    }
  }
  const activePane = state.workspace.panes.find((pane) => pane.id === (options?.paneId ?? state.workspace.activePaneId))
    ?? state.workspace.panes[0];
  if (!activePane) {
    return state;
  }

  const activeTab = activePane.tabs.find((tab) => tab.id === activePane.activeTabId);
  if (!options?.append && activeTab?.kind === 'empty') {
    const next = updateWorkspacePane(state.workspace, activePane.id, (pane) => ({
      ...pane,
      tabs: pane.tabs.map((tab) => (tab.id === activeTab.id ? newTab : tab)),
      activeTabId: newTab.id,
    }));
    return { ...state, workspace: next, launcherOpen: false, pendingSessionReplacement: undefined };
  }

  const next = updateWorkspacePane(state.workspace, activePane.id, (pane) => ({
    ...pane,
    tabs: [...pane.tabs, newTab],
    activeTabId: newTab.id,
  }));
  return { ...state, workspace: next, launcherOpen: false, pendingSessionReplacement: undefined };
}

export function openLocalTmuxInWorkbench(
  state: MacWorkbenchState,
  sessionName: string,
  options?: { append?: boolean; paneId?: string },
): MacWorkbenchState {
  const normalizedSessionName = sessionName.trim();
  if (!normalizedSessionName) {
    return state;
  }
  const newTab = createLocalTmuxTab(normalizedSessionName);
  if (!options?.append) {
    const replaced = replacePendingSessionTab(state, newTab);
    if (replaced) {
      return replaced;
    }
  }
  const activePane = state.workspace.panes.find((pane) => pane.id === (options?.paneId ?? state.workspace.activePaneId))
    ?? state.workspace.panes[0];
  if (!activePane) {
    return state;
  }

  const activeTab = activePane.tabs.find((tab) => tab.id === activePane.activeTabId);
  if (!options?.append && activeTab?.kind === 'empty') {
    const next = updateWorkspacePane(state.workspace, activePane.id, (pane) => ({
      ...pane,
      tabs: pane.tabs.map((tab) => (tab.id === activeTab.id ? newTab : tab)),
      activeTabId: newTab.id,
    }));
    return { ...state, workspace: next, launcherOpen: false, pendingSessionReplacement: undefined };
  }

  const next = updateWorkspacePane(state.workspace, activePane.id, (pane) => ({
    ...pane,
    tabs: [...pane.tabs, newTab],
    activeTabId: newTab.id,
  }));
  return { ...state, workspace: next, launcherOpen: false, pendingSessionReplacement: undefined };
}

export function beginPendingSessionReplacement(
  state: MacWorkbenchState,
  paneId: string,
  tabId: string,
): MacWorkbenchState {
  const pane = state.workspace.panes.find((candidate) => candidate.id === paneId);
  if (!pane?.tabs.some((tab) => tab.id === tabId)) {
    return state;
  }
  return {
    ...state,
    workspace: setActivePane(state.workspace, paneId),
    launcherOpen: true,
    pendingSessionReplacement: { paneId, tabId },
  };
}

export function splitActivePaneRight(state: MacWorkbenchState): MacWorkbenchState {
  const activePaneId = state.workspace.activePaneId;
  const activePane = state.workspace.panes.find((pane) => pane.id === activePaneId);
  if (!activePane) {
    return state;
  }
  const newPane = createPaneWith(createEmptyTab());
  return { ...state, workspace: addPaneToWorkspace(state.workspace, newPane) };
}

export function splitActivePaneDown(state: MacWorkbenchState): MacWorkbenchState {
  return splitActivePaneRight(state);
}

export function moveTabToPane(
  state: MacWorkbenchState,
  sourcePaneId: string,
  tabId: string,
  targetPaneId: string,
): MacWorkbenchState {
  if (sourcePaneId === targetPaneId) {
    return state;
  }
  const sourcePane = state.workspace.panes.find((candidate) => candidate.id === sourcePaneId);
  const targetPane = state.workspace.panes.find((candidate) => candidate.id === targetPaneId);
  const tab = sourcePane?.tabs.find((candidate) => candidate.id === tabId);
  if (!sourcePane || !targetPane || !tab || tab.kind === 'empty') {
    return state;
  }
  let next = updateWorkspacePane(state.workspace, sourcePaneId, (currentPane) => {
    const remaining = currentPane.tabs.filter((candidate) => candidate.id !== tabId);
    if (remaining.length === 0) {
      const empty = createEmptyTab();
      return { ...currentPane, tabs: [empty], activeTabId: empty.id };
    }
    return {
      ...currentPane,
      tabs: remaining,
      activeTabId: currentPane.activeTabId === tabId ? remaining[0].id : currentPane.activeTabId,
    };
  });
  next = updateWorkspacePane(next, targetPaneId, (currentPane) => {
    const replacementIndex = currentPane.tabs.length === 1 && currentPane.tabs[0].kind === 'empty'
      ? 0
      : -1;
    const tabs = replacementIndex >= 0
      ? currentPane.tabs.map((candidate, index) => (index === replacementIndex ? tab : candidate))
      : [...currentPane.tabs, tab];
    return { ...currentPane, tabs, activeTabId: tab.id };
  });
  return {
    ...state,
    workspace: setActivePane(next, targetPaneId),
  };
}

export function resolveActiveTab(state: MacWorkbenchState): MacWorkbenchTab | null {
  return resolveActiveWorkspaceTab(state.workspace);
}

export function resolveTabTarget(tab: MacWorkbenchTab | null | undefined, hosts: Host[]) {
  if (!tab || tab.kind !== 'connection') {
    return null;
  }
  if (tab.persistedHostId) {
    const persisted = hosts.find((host) => host.id === tab.persistedHostId);
    if (persisted) {
      return {
        name: persisted.name,
        bridgeHost: persisted.bridgeHost,
        bridgePort: persisted.bridgePort,
        sessionName: persisted.sessionName,
        authToken: persisted.authToken,
        authType: persisted.authType,
        password: persisted.password,
        privateKey: persisted.privateKey,
        tags: persisted.tags,
        pinned: persisted.pinned,
        lastConnected: persisted.lastConnected,
        autoCommand: persisted.autoCommand,
      } satisfies EditableHost;
    }
  }
  return tab.draftTarget ? { ...tab.draftTarget } : null;
}

export function resolveLocalTmuxSessionName(tab: MacWorkbenchTab | null | undefined) {
  return tab?.kind === 'local-tmux' ? tab.localSessionName?.trim() || '' : '';
}

export function resolveTabRuntimeKey(tab: MacWorkbenchTab | null | undefined, hosts: Host[]): MacRuntimeKey | null {
  if (!tab || tab.kind === 'empty') {
    return null;
  }
  if (tab.runtimeKey) {
    return tab.runtimeKey;
  }
  if (tab.kind === 'local-tmux') {
    const sessionName = resolveLocalTmuxSessionName(tab);
    return sessionName ? buildLocalTmuxMacRuntimeKey(sessionName) : null;
  }
  const target = resolveTabTarget(tab, hosts);
  if (!target) {
    return null;
  }
  return buildConnectionRuntimeKey(target, tab.persistedHostId);
}

export function listWorkbenchRuntimeKeys(state: MacWorkbenchState, hosts: Host[]): MacRuntimeKey[] {
  const runtimeKeys = new Set<MacRuntimeKey>();
  state.workspace.panes.forEach((pane) => {
    pane.tabs.forEach((tab) => {
      const runtimeKey = resolveTabRuntimeKey(tab, hosts);
      if (runtimeKey) {
        runtimeKeys.add(runtimeKey);
      }
    });
  });
  return Array.from(runtimeKeys);
}

export function cloneWorkbenchState(state: MacWorkbenchState): MacWorkbenchState {
  return {
    ...state,
    workspace: cloneWorkspaceState(state.workspace),
    pendingSessionReplacement: state.pendingSessionReplacement ? { ...state.pendingSessionReplacement } : undefined,
  };
}

function endpointServerId(target: EditableHost) {
  return `${target.bridgeHost.trim()}:${Math.max(1, Math.floor(target.bridgePort || 3333))}`;
}

function tabRecordToWorkbenchTab(tab: MacTabRecord, hosts: Host[]): MacWorkbenchTab {
  if (tab.kind === 'empty') {
    return {
      id: tab.id,
      kind: 'empty',
      title: tab.title,
    };
  }
  if (tab.kind === 'local-tmux') {
    return {
      id: tab.id,
      kind: 'local-tmux',
      title: tab.title,
      localSessionName: tab.localSessionName || tab.sessionName || tab.title,
      runtimeKey: tab.runtimeKey,
    };
  }
  const persistedHost = tab.serverId ? hosts.find((host) => host.id === tab.serverId) : undefined;
  return {
    id: tab.id,
    kind: 'connection',
    title: tab.title,
    runtimeKey: tab.runtimeKey,
    persistedHostId: tab.serverId,
    draftTarget: persistedHost ? {
      name: persistedHost.name,
      bridgeHost: persistedHost.bridgeHost,
      bridgePort: persistedHost.bridgePort,
      sessionName: persistedHost.sessionName,
      authToken: persistedHost.authToken,
      authType: persistedHost.authType,
      password: persistedHost.password,
      privateKey: persistedHost.privateKey,
      tags: persistedHost.tags,
      pinned: persistedHost.pinned,
      lastConnected: persistedHost.lastConnected,
      autoCommand: persistedHost.autoCommand,
    } : undefined,
  };
}

function workbenchTabToRecord(tab: MacWorkbenchTab, hosts: Host[]): MacTabRecord {
  if (tab.kind === 'empty') {
    return {
      ...createEmptyMacTab(tab.id),
      title: tab.title,
    };
  }
  if (tab.kind === 'local-tmux') {
    return createLocalTmuxMacTab({
      id: tab.id,
      title: tab.title,
      sessionName: resolveLocalTmuxSessionName(tab),
    });
  }
  const target = resolveTabTarget(tab, hosts);
  const serverId = tab.persistedHostId || (target ? endpointServerId(target) : tab.runtimeKey || tab.id);
  const sessionName = target?.sessionName || tab.title;
  return createRemoteMacTab({
    id: tab.id,
    title: tab.title,
    serverId,
    sessionName,
  });
}

export function createWorkbenchStateFromWorkspaceRecord(
  record: MacWorkspaceRecord,
  hosts: Host[],
): MacWorkbenchState {
  return {
    workspace: {
      panes: record.panes.map((pane) => ({
        ...pane,
        tabs: pane.tabs.map((tab) => tabRecordToWorkbenchTab(tab, hosts)),
      })),
      activePaneId: record.activePaneId,
    },
    launcherOpen: false,
    pendingSessionReplacement: undefined,
  };
}

export function createWorkspaceRecordFromWorkbenchState(
  state: MacWorkbenchState,
  options: {
    windowId: string;
    hosts: Host[];
    previousRecord?: MacWorkspaceRecord;
    updatedAt?: number;
  },
): MacWorkspaceRecord {
  const panes = state.workspace.panes.map((pane): MacPaneRecord => {
    const tabs = pane.tabs.map((tab) => workbenchTabToRecord(tab, options.hosts));
    return createMacWorkspacePane(tabs[0], pane.size) as MacPaneRecord;
  }).map((pane, index) => ({
    ...pane,
    id: state.workspace.panes[index].id,
    tabs: state.workspace.panes[index].tabs.map((tab) => workbenchTabToRecord(tab, options.hosts)),
    activeTabId: state.workspace.panes[index].activeTabId,
  }));
  return parseMacWorkspaceRecord({
    workspaceId: options.previousRecord?.workspaceId || `workspace:${options.windowId}`,
    windowId: options.windowId,
    paneTree: {
      kind: 'row',
      paneIds: panes.map((pane) => pane.id),
      lastSplit: options.previousRecord?.paneTree.lastSplit,
    },
    panes,
    activePaneId: state.workspace.activePaneId,
    updatedAt: options.updatedAt ?? Date.now(),
  });
}
