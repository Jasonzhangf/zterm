/**
 * Mac workbench state — upgraded to shared WorkspaceState.
 *
 * 设计原则：
 * - Mac pane 列表使用 shared workspace-model 的 WorkspaceState<MacWorkbenchTab>
 * - pane 状态机（split / close / activate / move tab）走 shared actions
 * - Mac 端只持有 pane 内 tab 的本地结构 + launcherOpen 这类 UI 标志
 *
 * 与 android/docs/decisions/0001-cross-platform-layout-profile.md 一致：
 * - pane 第一等，tab 是 pane 的子级
 * - 每个 pane 维护自己的 tab 列表和 activeTabId
 * - workspace 维护 panes 列表和 activePaneId
 */

import {
  addPaneToWorkspace,
  cloneWorkspaceState,
  createDefaultWorkspaceState,
  createWorkspacePane,
  moveTabBetweenPanes,
  removePaneFromWorkspace,
  resolveActiveTab as resolveActiveWorkspaceTab,
  setActivePane,
  updateWorkspacePane,
  type WorkspacePane,
  type WorkspaceState,
  type WorkspaceTab,
} from '@zterm/shared';
import type { EditableHost, Host } from '@zterm/shared';

export interface MacWorkbenchTab extends WorkspaceTab {
  id: string;
  kind: 'empty' | 'connection' | 'local-tmux';
  title: string;
  persistedHostId?: string;
  draftTarget?: EditableHost;
  localSessionName?: string;
}

export interface MacWorkbenchState {
  workspace: WorkspaceState<MacWorkbenchTab>;
  launcherOpen: boolean;
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
  return { ...state, launcherOpen };
}

export function activateTab(state: MacWorkbenchState, tabId: string): MacWorkbenchState {
  // find pane containing tab, switch both
  for (const pane of state.workspace.panes) {
    if (pane.tabs.some((t) => t.id === tabId)) {
      const next = updateWorkspacePane(state.workspace, pane.id, (p) => ({
        ...p,
        activeTabId: tabId,
      }));
      const nextWithActive = setActivePane(next, pane.id);
      return { ...state, workspace: nextWithActive };
    }
  }
  return state;
}

export function appendEmptyTab(state: MacWorkbenchState): MacWorkbenchState {
  const empty = createEmptyTab();
  const activePane = state.workspace.panes.find((p) => p.id === state.workspace.activePaneId)
    ?? state.workspace.panes[0];
  if (!activePane) {
    return state;
  }
  const next = updateWorkspacePane(state.workspace, activePane.id, (p) => ({
    ...p,
    tabs: [...p.tabs, empty],
    activeTabId: empty.id,
  }));
  return { ...state, workspace: next, launcherOpen: true };
}

export function closeTab(state: MacWorkbenchState, tabId: string): MacWorkbenchState {
  for (let i = 0; i < state.workspace.panes.length; i++) {
    const pane = state.workspace.panes[i];
    if (!pane.tabs.some((t) => t.id === tabId)) {
      continue;
    }
    const remaining = pane.tabs.filter((t) => t.id !== tabId);
    if (pane.tabs.length === 1) {
      // last tab in pane — drop the pane itself
      if (state.workspace.panes.length === 1) {
        // always keep at least one pane
        const replacement = createPaneWith(createEmptyTab());
        return {
          ...state,
          workspace: { panes: [replacement], activePaneId: replacement.id },
        };
      }
      const next = removePaneFromWorkspace(state.workspace, pane.id);
      return { ...state, workspace: next };
    }
    const nextActive = pane.activeTabId === tabId
      ? (remaining[Math.max(0, remaining.length - 1)]?.id ?? remaining[0].id)
      : pane.activeTabId;
    const updated = updateWorkspacePane(state.workspace, pane.id, (p) => ({
      ...p,
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
  options?: { persistedHostId?: string; append?: boolean },
): MacWorkbenchState {
  const newTab = createConnectionTab(target, options?.persistedHostId);
  const activePane = state.workspace.panes.find((p) => p.id === state.workspace.activePaneId)
    ?? state.workspace.panes[0];
  if (!activePane) {
    return state;
  }

  // replace active tab if it's an empty slot
  if (!options?.append && activePane.tabs.length === 1 && activePane.tabs[0].kind === 'empty') {
    const next = updateWorkspacePane(state.workspace, activePane.id, (p) => ({
      ...p,
      tabs: [newTab],
      activeTabId: newTab.id,
    }));
    return { ...state, workspace: next, launcherOpen: false };
  }

  // otherwise append to active pane
  const next = updateWorkspacePane(state.workspace, activePane.id, (p) => ({
    ...p,
    tabs: [...p.tabs, newTab],
    activeTabId: newTab.id,
  }));
  return { ...state, workspace: next, launcherOpen: false };
}

export function splitActivePaneRight(state: MacWorkbenchState): MacWorkbenchState {
  const activePaneId = state.workspace.activePaneId;
  const activePane = state.workspace.panes.find((p) => p.id === activePaneId);
  if (!activePane) {
    return state;
  }
  const empty = createEmptyTab();
  const newPane = createPaneWith(empty);
  const next = addPaneToWorkspace(state.workspace, newPane);
  return { ...state, workspace: next };
}

export function splitActivePaneDown(_state: MacWorkbenchState): MacWorkbenchState {
  // Phase 1: only horizontal split; vertical split is a future slice
  return _state;
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
  const next = moveTabBetweenPanes(state.workspace, sourcePaneId, tabId, targetPaneId);
  return { ...state, workspace: next };
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

export function cloneWorkbenchState(state: MacWorkbenchState): MacWorkbenchState {
  return { ...state, workspace: cloneWorkspaceState(state.workspace) };
}
