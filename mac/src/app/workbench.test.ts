/**
 * Mac workbench pane state 真源测试。
 *
 * 跑法：临时复制到 packages/shared/src/_mac_workbench.test.ts，shared vitest 跑。
 * mac workspace 暂未装 vitest devDep，所以测试 fixture 集中在 shared 内跑。
 * 验证 pane 状态机接入 shared workspace-model 后行为正确。
 */

import { describe, expect, it } from 'vitest';
import {
  activateTab,
  appendEmptyTab,
  closeTab,
  createInitialWorkbenchState,
  openConnectionInWorkbench,
  setLauncherOpen,
  splitActivePaneRight,
  resolveActiveTab,
  moveTabToPane,
  type MacWorkbenchState,
} from './workbench';
import type { EditableHost } from '@zterm/shared';

function makeTarget(name: string): EditableHost {
  return {
    name,
    bridgeHost: '127.0.0.1',
    bridgePort: 3333,
    sessionName: name,
    authType: 'password',
    tags: [],
    pinned: false,
  };
}

describe('Mac workbench pane state', () => {
  it('initial state has one pane with one empty tab', () => {
    const state = createInitialWorkbenchState();
    expect(state.workspace.panes.length).toBe(1);
    expect(state.workspace.panes[0].tabs.length).toBe(1);
    expect(state.workspace.panes[0].tabs[0].kind).toBe('empty');
  });

  it('openConnectionInWorkbench replaces empty active tab', () => {
    let state: MacWorkbenchState = createInitialWorkbenchState();
    state = openConnectionInWorkbench(state, makeTarget('dev'));
    expect(state.workspace.panes.length).toBe(1);
    expect(state.workspace.panes[0].tabs[0].kind).toBe('connection');
    expect(state.workspace.panes[0].tabs[0].title).toBe('dev');
  });

  it('openConnectionInWorkbench appends when active pane has live tab', () => {
    let state: MacWorkbenchState = createInitialWorkbenchState();
    state = openConnectionInWorkbench(state, makeTarget('a'));
    state = openConnectionInWorkbench(state, makeTarget('b'), { append: true });
    expect(state.workspace.panes[0].tabs.length).toBe(2);
  });

  it('splitActivePaneRight adds an empty pane', () => {
    let state: MacWorkbenchState = createInitialWorkbenchState();
    state = openConnectionInWorkbench(state, makeTarget('dev'));
    state = splitActivePaneRight(state);
    expect(state.workspace.panes.length).toBe(2);
    expect(state.workspace.panes[1].tabs[0].kind).toBe('empty');
  });

  it('splitActivePaneRight caps at 4 panes (MAX_WORKSPACE_PANES)', () => {
    let state: MacWorkbenchState = createInitialWorkbenchState();
    state = openConnectionInWorkbench(state, makeTarget('a'));
    state = splitActivePaneRight(state);
    state = splitActivePaneRight(state);
    state = splitActivePaneRight(state);
    state = splitActivePaneRight(state);
    expect(state.workspace.panes.length).toBe(4);
  });

  it('closeTab on last tab keeps the pane alive (>=1 pane rule)', () => {
    let state: MacWorkbenchState = createInitialWorkbenchState();
    const onlyTab = state.workspace.panes[0].tabs[0];
    state = closeTab(state, onlyTab.id);
    expect(state.workspace.panes.length).toBe(1);
  });

  it('closeTab drops the pane when removing last tab and other panes exist', () => {
    let state: MacWorkbenchState = createInitialWorkbenchState();
    state = openConnectionInWorkbench(state, makeTarget('a'));
    state = splitActivePaneRight(state);
    const lastPane = state.workspace.panes[1];
    const lastTab = lastPane.tabs[0];
    state = closeTab(state, lastTab.id);
    expect(state.workspace.panes.length).toBe(1);
  });

  it('moveTabToPane moves connection tab between panes', () => {
    let state: MacWorkbenchState = createInitialWorkbenchState();
    state = openConnectionInWorkbench(state, makeTarget('a'));
    state = openConnectionInWorkbench(state, makeTarget('b'), { append: true });
    state = splitActivePaneRight(state);
    const paneA = state.workspace.panes[0];
    const paneB = state.workspace.panes[1];
    state = moveTabToPane(state, paneA.id, paneA.tabs[1].id, paneB.id);
    expect(state.workspace.panes[0].tabs.length).toBe(1);
    expect(state.workspace.panes[0].tabs[0].title).toBe('a');
    expect(state.workspace.panes[1].tabs.length).toBe(2);
    expect(state.workspace.panes[1].tabs.some((t) => t.title === 'b')).toBe(true);
  });

  it('resolveActiveTab returns connection tab when active', () => {
    let state: MacWorkbenchState = createInitialWorkbenchState();
    state = openConnectionInWorkbench(state, makeTarget('dev'));
    const active = resolveActiveTab(state);
    expect(active).not.toBeNull();
    expect(active?.title).toBe('dev');
  });

  it('appendEmptyTab adds a tab to active pane', () => {
    let state: MacWorkbenchState = createInitialWorkbenchState();
    state = openConnectionInWorkbench(state, makeTarget('a'));
    state = appendEmptyTab(state);
    const pane = state.workspace.panes[0];
    expect(pane.tabs.length).toBe(2);
    expect(pane.tabs[1].kind).toBe('empty');
  });

  it('activateTab switches active tab inside its pane', () => {
    let state: MacWorkbenchState = createInitialWorkbenchState();
    state = openConnectionInWorkbench(state, makeTarget('a'));
    state = appendEmptyTab(state);
    state = openConnectionInWorkbench(state, makeTarget('b'), { append: true });
    const pane = state.workspace.panes[0];
    state = activateTab(state, pane.tabs[0].id);
    expect(state.workspace.panes[0].activeTabId).toBe(pane.tabs[0].id);
  });

  it('setLauncherOpen toggles launcher state without touching panes', () => {
    let state: MacWorkbenchState = createInitialWorkbenchState();
    state = setLauncherOpen(state, true);
    expect(state.launcherOpen).toBe(true);
    const paneCount = state.workspace.panes.length;
    state = setLauncherOpen(state, false);
    expect(state.workspace.panes.length).toBe(paneCount);
  });
});
