import {
  addPaneToWorkspace,
  createDefaultWorkspaceState,
  createWorkspacePane,
  generateWorkspaceId,
  removePaneFromWorkspace,
  resizePaneRatio,
  setActivePane,
  updateWorkspacePane,
  type WorkspaceState,
} from '@zterm/shared';
import type { WindowsTerminalTarget } from './windows-terminal-session';

export interface WindowsWorkspaceTab {
  id: string;
  title: string;
  target: WindowsTerminalTarget | null;
}

export type WindowsWorkspaceState = WorkspaceState<WindowsWorkspaceTab>;

export function createWindowsEmptyTab(): WindowsWorkspaceTab {
  return { id: generateWorkspaceId('win-tab'), title: 'New terminal', target: null };
}

export function createWindowsWorkspaceState(): WindowsWorkspaceState {
  return createDefaultWorkspaceState(createWindowsEmptyTab());
}

export function createWindowsTargetTab(target: WindowsTerminalTarget): WindowsWorkspaceTab {
  return {
    id: generateWorkspaceId('win-tab'),
    title: target.sessionName,
    target: { ...target },
  };
}

export function openWindowsWorkspaceTab(
  workspace: WindowsWorkspaceState,
  target: WindowsTerminalTarget,
): WindowsWorkspaceState {
  const tab = createWindowsTargetTab(target);
  return updateWorkspacePane(workspace, workspace.activePaneId, (pane) => {
    const replaceEmpty = pane.tabs.length === 1 && pane.tabs[0]?.target === null;
    return {
      ...pane,
      tabs: replaceEmpty ? [tab] : [...pane.tabs, tab],
      activeTabId: tab.id,
    };
  });
}

export function splitWindowsWorkspace(
  workspace: WindowsWorkspaceState,
  target: WindowsTerminalTarget,
): WindowsWorkspaceState {
  return addPaneToWorkspace(workspace, createWorkspacePane(createWindowsTargetTab(target)));
}

export function activateWindowsWorkspacePane(workspace: WindowsWorkspaceState, paneId: string) {
  return setActivePane(workspace, paneId);
}

export function activateWindowsWorkspaceTab(
  workspace: WindowsWorkspaceState,
  paneId: string,
  tabId: string,
): WindowsWorkspaceState {
  const pane = workspace.panes.find((candidate) => candidate.id === paneId);
  if (!pane?.tabs.some((tab) => tab.id === tabId)) return workspace;
  return setActivePane(updateWorkspacePane(workspace, paneId, (current) => ({ ...current, activeTabId: tabId })), paneId);
}

export function closeWindowsWorkspaceTab(
  workspace: WindowsWorkspaceState,
  paneId: string,
  tabId: string,
): WindowsWorkspaceState {
  const pane = workspace.panes.find((candidate) => candidate.id === paneId);
  if (!pane?.tabs.some((tab) => tab.id === tabId)) return workspace;
  if (pane.tabs.length === 1) {
    if (workspace.panes.length > 1) return removePaneFromWorkspace(workspace, paneId);
    return updateWorkspacePane(workspace, paneId, (current) => {
      const empty = createWindowsEmptyTab();
      return { ...current, tabs: [empty], activeTabId: empty.id };
    });
  }
  return updateWorkspacePane(workspace, paneId, (current) => {
    const index = current.tabs.findIndex((tab) => tab.id === tabId);
    const tabs = current.tabs.filter((tab) => tab.id !== tabId);
    const activeTabId = current.activeTabId === tabId
      ? tabs[Math.min(index, tabs.length - 1)]!.id
      : current.activeTabId;
    return { ...current, tabs, activeTabId };
  });
}

export function closeWindowsWorkspaceTarget(
  workspace: WindowsWorkspaceState,
  target: WindowsTerminalTarget,
): WindowsWorkspaceState {
  const matchingTabs = workspace.panes.flatMap((pane) => pane.tabs
    .filter((tab) => tab.target
      && tab.target.bridgeHost === target.bridgeHost
      && tab.target.bridgePort === target.bridgePort
      && tab.target.sessionName === target.sessionName
      && (tab.target.authToken ?? '') === (target.authToken ?? ''))
    .map((tab) => ({ paneId: pane.id, tabId: tab.id })));
  return matchingTabs.reduce(
    (current, match) => closeWindowsWorkspaceTab(current, match.paneId, match.tabId),
    workspace,
  );
}

export function resizeWindowsWorkspacePanes(
  workspace: WindowsWorkspaceState,
  sourcePaneId: string,
  targetPaneId: string,
  ratio: number,
) {
  return resizePaneRatio(workspace, sourcePaneId, targetPaneId, ratio);
}

export function listWindowsWorkspaceRuntimeTabs(workspace: WindowsWorkspaceState) {
  return workspace.panes.flatMap((pane) => pane.tabs).filter((tab) => tab.target !== null);
}
