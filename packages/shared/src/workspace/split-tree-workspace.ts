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

function createLeaf<TTab extends SplitTreeTab>(tab: TTab, paneId = generateSplitTreeId('pane')): SplitTreeLeafNode<TTab> {
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
  const leaf = createLeaf(tab);
  return { tree: leaf, activePaneId: leaf.pane.id };
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
    const newLeaf = createLeaf(newTab, newPaneId);
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

export function closeSplitTreePane<TTab extends SplitTreeTab>(current: SplitTreeWorkspace<TTab>, paneId: string): SplitTreeWorkspace<TTab> {
  const paneIds = listSplitTreePaneIds(current.tree);
  if (paneIds.length <= 1 || !paneIds.includes(paneId)) return current;
  const result = closeNode(cloneNode(current.tree), paneId);
  if (!result.removed || !result.node) return current;
  const nextPaneIds = listSplitTreePaneIds(result.node);
  return {
    tree: result.node,
    activePaneId: current.activePaneId === paneId ? nextPaneIds[0] : current.activePaneId,
  };
}
