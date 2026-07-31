import { MIN_PANE_RATIO } from './workspace-model';

export type SplitTreeDirection = 'row' | 'column';
export type SplitTreePlacement = 'right' | 'left' | 'down' | 'up';

export interface SplitTreeTab {
  id: string;
}

export interface SplitTreePane<TTab extends SplitTreeTab = SplitTreeTab> {
  id: string;
  tabs: TTab[];
  activeTabId: string;
}

export interface SplitTreeLeafNode<TTab extends SplitTreeTab = SplitTreeTab> {
  id: string;
  type: 'leaf';
  pane: SplitTreePane<TTab>;
}

export interface SplitTreeSplitNode<TTab extends SplitTreeTab = SplitTreeTab> {
  id: string;
  type: 'split';
  direction: SplitTreeDirection;
  ratio: number;
  first: SplitTreeNode<TTab>;
  second: SplitTreeNode<TTab>;
}

export type SplitTreeNode<TTab extends SplitTreeTab = SplitTreeTab> =
  | SplitTreeLeafNode<TTab>
  | SplitTreeSplitNode<TTab>;

export interface SplitTreeWorkspace<TTab extends SplitTreeTab = SplitTreeTab> {
  tree: SplitTreeNode<TTab>;
  activePaneId: string;
}

function generateSplitTreeId(prefix: string) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export function createSplitTreeLeaf<TTab extends SplitTreeTab>(
  tab: TTab,
  paneId = generateSplitTreeId('pane'),
): SplitTreeLeafNode<TTab> {
  return {
    id: generateSplitTreeId('leaf'),
    type: 'leaf',
    pane: {
      id: paneId,
      tabs: [tab],
      activeTabId: tab.id,
    },
  };
}

function cloneNode<TTab extends SplitTreeTab>(node: SplitTreeNode<TTab>): SplitTreeNode<TTab> {
  return JSON.parse(JSON.stringify(node)) as SplitTreeNode<TTab>;
}

function clampRatio(ratio: number) {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.max(MIN_PANE_RATIO, Math.min(1 - MIN_PANE_RATIO, ratio));
}

export function createSplitTreeWorkspace<TTab extends SplitTreeTab>(tab: TTab): SplitTreeWorkspace<TTab> {
  const leaf = createSplitTreeLeaf(tab);
  return { tree: leaf, activePaneId: leaf.pane.id };
}

export function listSplitTreeLeaves<TTab extends SplitTreeTab>(
  node: SplitTreeNode<TTab>,
): SplitTreeLeafNode<TTab>[] {
  if (node.type === 'leaf') return [node];
  return [...listSplitTreeLeaves(node.first), ...listSplitTreeLeaves(node.second)];
}

export function listSplitTreePaneIds<TTab extends SplitTreeTab>(node: SplitTreeNode<TTab>): string[] {
  if (node.type === 'leaf') return [node.pane.id];
  return [...listSplitTreePaneIds(node.first), ...listSplitTreePaneIds(node.second)];
}

export function findSplitTreeLeaf<TTab extends SplitTreeTab>(node: SplitTreeNode<TTab>, paneId: string): SplitTreeLeafNode<TTab> | null {
  if (node.type === 'leaf') return node.pane.id === paneId ? node : null;
  return findSplitTreeLeaf(node.first, paneId) ?? findSplitTreeLeaf(node.second, paneId);
}

function splitNode<TTab extends SplitTreeTab>(
  node: SplitTreeNode<TTab>,
  paneId: string,
  placement: SplitTreePlacement,
  newTab: TTab,
  newPaneId?: string,
): { node: SplitTreeNode<TTab>; newPaneId: string | null; changed: boolean } {
  if (node.type === 'leaf') {
    if (node.pane.id !== paneId) return { node, newPaneId: null, changed: false };
    const newLeaf = createSplitTreeLeaf(newTab, newPaneId);
    const direction: SplitTreeDirection = placement === 'right' || placement === 'left' ? 'row' : 'column';
    const first = placement === 'left' || placement === 'up' ? newLeaf : node;
    const second = first === newLeaf ? node : newLeaf;
    return {
      node: {
        id: generateSplitTreeId('split'),
        type: 'split',
        direction,
        ratio: 0.5,
        first,
        second,
      },
      newPaneId: newLeaf.pane.id,
      changed: true,
    };
  }
  const first = splitNode(node.first, paneId, placement, newTab, newPaneId);
  if (first.changed) return { node: { ...node, first: first.node }, newPaneId: first.newPaneId, changed: true };
  const second = splitNode(node.second, paneId, placement, newTab, newPaneId);
  if (second.changed) return { node: { ...node, second: second.node }, newPaneId: second.newPaneId, changed: true };
  return { node, newPaneId: null, changed: false };
}

export function splitTreePane<TTab extends SplitTreeTab>(
  current: SplitTreeWorkspace<TTab>,
  paneId: string,
  placement: SplitTreePlacement,
  newTab: TTab,
  newPaneId?: string,
): SplitTreeWorkspace<TTab> {
  const tree = cloneNode(current.tree);
  const result = splitNode(tree, paneId, placement, newTab, newPaneId);
  if (!result.changed || !result.newPaneId) return current;
  return { tree: result.node, activePaneId: result.newPaneId };
}

function resizeNode<TTab extends SplitTreeTab>(node: SplitTreeNode<TTab>, splitNodeId: string, ratio: number): SplitTreeNode<TTab> {
  if (node.type === 'leaf') return node;
  if (node.id === splitNodeId) return { ...node, ratio: clampRatio(ratio) };
  return { ...node, first: resizeNode(node.first, splitNodeId, ratio), second: resizeNode(node.second, splitNodeId, ratio) };
}

export function findSplitTreeSplit<TTab extends SplitTreeTab>(
  node: SplitTreeNode<TTab>,
  splitNodeId: string,
): SplitTreeSplitNode<TTab> | null {
  if (node.type === 'leaf') return null;
  if (node.id === splitNodeId) return node;
  return findSplitTreeSplit(node.first, splitNodeId) ?? findSplitTreeSplit(node.second, splitNodeId);
}

export function resizeSplitTreeNode<TTab extends SplitTreeTab>(
  current: SplitTreeWorkspace<TTab>,
  splitNodeId: string,
  ratio: number,
): SplitTreeWorkspace<TTab> {
  return { ...current, tree: resizeNode(cloneNode(current.tree), splitNodeId, ratio) };
}

function closeNode<TTab extends SplitTreeTab>(node: SplitTreeNode<TTab>, paneId: string): { node: SplitTreeNode<TTab> | null; removed: boolean } {
  if (node.type === 'leaf') return node.pane.id === paneId ? { node: null, removed: true } : { node, removed: false };
  const first = closeNode(node.first, paneId);
  if (first.removed) {
    if (!first.node) return { node: node.second, removed: true };
    return { node: { ...node, first: first.node }, removed: true };
  }
  const second = closeNode(node.second, paneId);
  if (second.removed) {
    if (!second.node) return { node: node.first, removed: true };
    return { node: { ...node, second: second.node }, removed: true };
  }
  return { node, removed: false };
}

/**
 * Move a tab between two panes inside a split tree. The source pane becomes
 * empty if the moved tab was its only tab; the target pane replaces an empty
 * tab if present.
 */
export function moveTabBetweenTreePanes<TTab extends SplitTreeTab>(
  current: SplitTreeWorkspace<TTab>,
  sourcePaneId: string,
  tabId: string,
  targetPaneId: string,
  emptyTabIdFactory: () => string,
): SplitTreeWorkspace<TTab> {
  if (sourcePaneId === targetPaneId) return current;
  const sourceLeaf = findSplitTreeLeaf(current.tree, sourcePaneId);
  const targetLeaf = findSplitTreeLeaf(current.tree, targetPaneId);
  const tab = sourceLeaf?.pane.tabs.find((candidate) => candidate.id === tabId);
  if (!sourceLeaf || !targetLeaf || !tab) return current;
  const tree = cloneNode(current.tree);
  const sourceClone = findSplitTreeLeaf(tree, sourcePaneId);
  const targetClone = findSplitTreeLeaf(tree, targetPaneId);
  if (!sourceClone || !targetClone) return current;
  const sourceAfter = sourceClone.pane.tabs.filter((candidate) => candidate.id !== tabId);
  const nextTabs = sourceAfter.length === 0
    ? [{ id: emptyTabIdFactory() } as TTab]
    : sourceAfter;
  sourceClone.pane = {
    ...sourceClone.pane,
    tabs: nextTabs,
    activeTabId: sourceClone.pane.activeTabId === tabId
      ? (nextTabs[0]?.id ?? sourceClone.pane.activeTabId)
      : sourceClone.pane.activeTabId,
  };
  const targetTabs = targetClone.pane.tabs.length === 1 && targetClone.pane.tabs[0].id === (nextTabs[0]?.id ?? null)
    ? [tab as TTab]
    : [...targetClone.pane.tabs, tab as TTab];
  targetClone.pane = { ...targetClone.pane, tabs: targetTabs, activeTabId: tab.id };
  return { tree, activePaneId: targetPaneId };
}

/**
 * Active pane id helpers used by PaneStage recursive renderer and pane context
 * menu number projection. `resolveSplitTreePaneNumbers` returns the visible
 * ordering of every leaf pane id as an explicit index.
 */
export function resolveSplitTreePaneNumbers<TTab extends SplitTreeTab>(
  workspace: SplitTreeWorkspace<TTab>,
): { paneId: string; index: number }[] {
  const ids = listSplitTreePaneIds(workspace.tree);
  return ids.map((paneId, index) => ({ paneId, index: index + 1 }));
}

export function findSplitTreePaneIndex<TTab extends SplitTreeTab>(
  workspace: SplitTreeWorkspace<TTab>,
  paneId: string,
): number {
  const ids = listSplitTreePaneIds(workspace.tree);
  return ids.indexOf(paneId) + 1;
}

/**
 * Derive a split tree from a flat ordered pane list. Used to migrate the
 * legacy `kind:'row' + paneIds` records into the recursive split tree truth
 * without losing pane identity.
 */
export function buildSplitTreeFromPanes<TTab extends SplitTreeTab>(
  panes: TTab[],
  paneIds: string[],
  activeTabIdForPane: (index: number) => string,
  // @ts-expect-error legacy param, never referenced in body but callers supply it
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  createEmptyTab: () => TTab,
): SplitTreeWorkspace<TTab> | null {
  if (panes.length === 0 || paneIds.length === 0) return null;
  const leafLookup = new Map<string, SplitTreeLeafNode<TTab>>();
  const firstTab = panes[0];
  if (!firstTab) return null;
  const leaves: SplitTreeLeafNode<TTab>[] = panes.map((firstTabOfPane, index) => {
    const paneId = paneIds[index];
    if (!paneId) return null as unknown as SplitTreeLeafNode<TTab>;
    const leaf = createSplitTreeLeaf<TTab>(firstTabOfPane, paneId);
    leaf.pane.activeTabId = activeTabIdForPane(index) || firstTabOfPane.id;
    leafLookup.set(paneId, leaf);
    return leaf;
  });
  let current: SplitTreeNode<TTab> = leaves[0]!;
  for (let i = 1; i < leaves.length; i++) {
    const nextLeaf = leaves[i]!;
    current = {
      id: generateSplitTreeId('split'),
      type: 'split',
      direction: 'row',
      ratio: 1 / (i + 1),
      first: current,
      second: nextLeaf,
    };
  }
  return {
    tree: current,
    activePaneId: paneIds[0]!,
  };
}

export function closeSplitTreePane<TTab extends SplitTreeTab>(
  current: SplitTreeWorkspace<TTab>,
  paneId: string,
  options?: { fallbackPaneId?: string },
): SplitTreeWorkspace<TTab> {
  const paneIds = listSplitTreePaneIds(current.tree);
  if (paneIds.length <= 1 || !paneIds.includes(paneId)) return current;
  const result = closeNode(cloneNode(current.tree), paneId);
  if (!result.removed || !result.node) return current;
  const nextPaneIds = listSplitTreePaneIds(result.node);
  const fallbackId = options?.fallbackPaneId ?? nextPaneIds[0];
  const safeFallback = nextPaneIds.includes(fallbackId) ? fallbackId : nextPaneIds[0] ?? '';
  return {
    tree: result.node,
    activePaneId: current.activePaneId === paneId ? safeFallback : current.activePaneId,
  };
}
