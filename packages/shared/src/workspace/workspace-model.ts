/**
 * 平台无关的 terminal workspace 真源模型。
 *
 * 设计原则：
 * - pane 是第一等公民，tab 是 pane 的子级
 * - 每个 pane 维护自己的 tab 列表和 activeTabId
 * - workspace 维护 panes 列表和 activePaneId
 * - tab 的具体内容由平台侧通过泛型扩展
 */

export interface WorkspaceTab {
  id: string;
}

export interface WorkspacePane<TTab extends WorkspaceTab = WorkspaceTab> {
  id: string;
  size: number;
  tabs: TTab[];
  activeTabId: string;
}

export interface WorkspaceState<TTab extends WorkspaceTab = WorkspaceTab> {
  panes: WorkspacePane<TTab>[];
  activePaneId: string;
}

export const MAX_WORKSPACE_PANES = 4;
export const MIN_PANE_RATIO = 0.18;
export const DEFAULT_MAX_SPLIT_COUNT = 2;

export function generateWorkspaceId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export function createWorkspacePane<TTab extends WorkspaceTab>(
  initialTab: TTab,
  size = 1,
): WorkspacePane<TTab> {
  return {
    id: generateWorkspaceId('pane'),
    size,
    tabs: [initialTab],
    activeTabId: initialTab.id,
  };
}

export function createDefaultWorkspaceState<TTab extends WorkspaceTab>(
  initialTab: TTab,
): WorkspaceState<TTab> {
  const pane = createWorkspacePane(initialTab, 1);
  return {
    panes: [pane],
    activePaneId: pane.id,
  };
}

export function cloneWorkspaceState<TTab extends WorkspaceTab>(
  state: WorkspaceState<TTab>,
): WorkspaceState<TTab> {
  return JSON.parse(JSON.stringify(state)) as WorkspaceState<TTab>;
}

export function normalizePaneSizes<TTab extends WorkspaceTab>(
  panes: WorkspacePane<TTab>[],
): WorkspacePane<TTab>[] {
  const safe = panes.map((pane) => ({
    ...pane,
    size: Number.isFinite(pane.size) && pane.size > 0 ? pane.size : 1,
  }));
  const total = safe.reduce((sum, pane) => sum + pane.size, 0) || safe.length || 1;
  return safe.map((pane) => ({ ...pane, size: pane.size / total }));
}

export function distributeEvenPaneSizes<TTab extends WorkspaceTab>(
  panes: WorkspacePane<TTab>[],
): WorkspacePane<TTab>[] {
  if (panes.length === 0) {
    return [];
  }
  const size = 1 / panes.length;
  return panes.map((pane) => ({
    ...pane,
    size,
  }));
}

export function resolveActivePane<TTab extends WorkspaceTab>(
  workspace: WorkspaceState<TTab>,
): WorkspacePane<TTab> | null {
  return (
    workspace.panes.find((pane) => pane.id === workspace.activePaneId)
    ?? workspace.panes[0]
    ?? null
  );
}

export function resolveActiveTab<TTab extends WorkspaceTab>(
  workspace: WorkspaceState<TTab>,
): TTab | null {
  const pane = resolveActivePane(workspace);
  if (!pane) {
    return null;
  }
  return pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0] ?? null;
}

export function findPaneContainingTab<TTab extends WorkspaceTab>(
  workspace: WorkspaceState<TTab>,
  tabId: string,
): WorkspacePane<TTab> | null {
  return workspace.panes.find((pane) => pane.tabs.some((tab) => tab.id === tabId)) ?? null;
}

export function updateWorkspacePane<TTab extends WorkspaceTab>(
  current: WorkspaceState<TTab>,
  paneId: string,
  updater: (pane: WorkspacePane<TTab>) => WorkspacePane<TTab>,
): WorkspaceState<TTab> {
  const next = cloneWorkspaceState(current);
  const index = next.panes.findIndex((pane) => pane.id === paneId);
  if (index === -1) {
    return current;
  }
  next.panes[index] = updater(next.panes[index]);
  return next;
}

export function addPaneToWorkspace<TTab extends WorkspaceTab>(
  current: WorkspaceState<TTab>,
  newPane: WorkspacePane<TTab>,
): WorkspaceState<TTab> {
  if (current.panes.length >= MAX_WORKSPACE_PANES) {
    return current;
  }
  const next = cloneWorkspaceState(current);
  const index = Math.max(0, next.panes.findIndex((pane) => pane.id === next.activePaneId));
  next.panes.splice(index + 1, 0, newPane);
  next.panes = normalizePaneSizes(next.panes);
  next.activePaneId = newPane.id;
  return next;
}

export function removePaneFromWorkspace<TTab extends WorkspaceTab>(
  current: WorkspaceState<TTab>,
  paneId: string,
): WorkspaceState<TTab> {
  if (current.panes.length <= 1) {
    return current;
  }
  const next = cloneWorkspaceState(current);
  const index = next.panes.findIndex((pane) => pane.id === paneId);
  if (index === -1) {
    return current;
  }
  next.panes.splice(index, 1);
  next.panes = normalizePaneSizes(next.panes);
  if (next.activePaneId === paneId) {
    next.activePaneId = next.panes[Math.max(0, index - 1)]?.id || next.panes[0].id;
  }
  return next;
}

export function moveTabBetweenPanes<TTab extends WorkspaceTab>(
  current: WorkspaceState<TTab>,
  sourcePaneId: string,
  tabId: string,
  targetPaneId: string,
): WorkspaceState<TTab> {
  if (sourcePaneId === targetPaneId) {
    return current;
  }
  const sourcePane = current.panes.find((pane) => pane.id === sourcePaneId);
  if (!sourcePane) {
    return current;
  }
  const tab = sourcePane.tabs.find((item) => item.id === tabId);
  if (!tab) {
    return current;
  }

  const next = cloneWorkspaceState(current);
  const srcIndex = next.panes.findIndex((pane) => pane.id === sourcePaneId);
  next.panes[srcIndex] = {
    ...next.panes[srcIndex],
    tabs: next.panes[srcIndex].tabs.filter((item) => item.id !== tabId),
    activeTabId:
      next.panes[srcIndex].activeTabId === tabId
        ? (next.panes[srcIndex].tabs.find((item) => item.id !== tabId)?.id ?? '')
        : next.panes[srcIndex].activeTabId,
  };
  const tgtIndex = next.panes.findIndex((pane) => pane.id === targetPaneId);
  next.panes[tgtIndex] = {
    ...next.panes[tgtIndex],
    tabs: [...next.panes[tgtIndex].tabs, tab],
    activeTabId: tab.id,
  };
  next.activePaneId = targetPaneId;
  return next;
}

export function resolveMaxSplitCount(
  availableWidth: number,
  availableHeight: number,
  minAspect = 0.6,
  hardCap = MAX_WORKSPACE_PANES,
): number {
  const safeWidth = Math.max(0, Number.isFinite(availableWidth) ? availableWidth : 0);
  const safeHeight = Math.max(1, Number.isFinite(availableHeight) ? availableHeight : 1);
  const computed = Math.floor(safeWidth / (safeHeight * minAspect));
  return Math.max(1, Math.min(hardCap, computed));
}
