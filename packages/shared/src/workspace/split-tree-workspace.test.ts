import { describe, expect, it } from 'vitest';
import {
  createSplitTreeWorkspace,
  closeSplitTreePane,
  listSplitTreePaneIds,
  resizeSplitTreeNode,
  splitTreePane,
  type SplitTreeLeafNode,
} from './split-tree-workspace';

function leafTab(id: string) {
  return { id: `tab-${id}` };
}

function findLeaf(tree: ReturnType<typeof createSplitTreeWorkspace<{ id: string }>>['tree'], paneId: string): SplitTreeLeafNode<{ id: string }> | null {
  if (tree.type === 'leaf') return tree.pane.id === paneId ? tree : null;
  return findLeaf(tree.first, paneId) ?? findLeaf(tree.second, paneId);
}

describe('split-tree workspace iTerm2 semantics', () => {
  it('splits active pane to the right as a row split node', () => {
    const initial = createSplitTreeWorkspace(leafTab('a'));
    const next = splitTreePane(initial, initial.activePaneId, 'right', leafTab('b'));
    expect(next.tree.type).toBe('split');
    if (next.tree.type !== 'split') return;
    expect(next.tree.direction).toBe('row');
    expect(next.tree.ratio).toBe(0.5);
    expect(next.activePaneId).not.toBe(initial.activePaneId);
    expect(listSplitTreePaneIds(next.tree)).toHaveLength(2);
  });

  it('splits active pane downward as a column split nested inside existing row', () => {
    let state = createSplitTreeWorkspace(leafTab('a'));
    state = splitTreePane(state, state.activePaneId, 'right', leafTab('b'));
    const leftPaneId = listSplitTreePaneIds(state.tree)[0];
    state = splitTreePane(state, leftPaneId, 'down', leafTab('c'));
    expect(state.tree.type).toBe('split');
    if (state.tree.type !== 'split') return;
    expect(state.tree.direction).toBe('row');
    expect(state.tree.first.type).toBe('split');
    if (state.tree.first.type !== 'split') return;
    expect(state.tree.first.direction).toBe('column');
    expect(listSplitTreePaneIds(state.tree)).toHaveLength(3);
  });

  it('resizes only the targeted split node ratio', () => {
    let state = createSplitTreeWorkspace(leafTab('a'));
    state = splitTreePane(state, state.activePaneId, 'right', leafTab('b'));
    const rootId = state.tree.id;
    const next = resizeSplitTreeNode(state, rootId, 0.72);
    expect(next.tree.type).toBe('split');
    if (next.tree.type !== 'split') return;
    expect(next.tree.ratio).toBe(0.72);
  });

  it('closes a leaf and collapses its parent split', () => {
    let state = createSplitTreeWorkspace(leafTab('a'));
    const firstPaneId = state.activePaneId;
    state = splitTreePane(state, firstPaneId, 'right', leafTab('b'));
    const secondPaneId = state.activePaneId;
    state = closeSplitTreePane(state, secondPaneId);
    expect(state.tree.type).toBe('leaf');
    expect(listSplitTreePaneIds(state.tree)).toEqual([firstPaneId]);
    expect(state.activePaneId).toBe(firstPaneId);
  });

  it('preserves pane tabs inside split tree leaves', () => {
    const initial = createSplitTreeWorkspace(leafTab('a'));
    const next = splitTreePane(initial, initial.activePaneId, 'down', leafTab('b'));
    const panes = listSplitTreePaneIds(next.tree);
    expect(findLeaf(next.tree, panes[0])?.pane.tabs[0]?.id).toBe('tab-a');
    expect(findLeaf(next.tree, panes[1])?.pane.tabs[0]?.id).toBe('tab-b');
  });
});
