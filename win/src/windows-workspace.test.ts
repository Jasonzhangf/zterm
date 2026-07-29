import { describe, expect, it } from 'vitest';
import {
  activateWindowsWorkspaceTab,
  changeWindowsWorkspaceTabSession,
  closeWindowsWorkspaceTab,
  closeWindowsWorkspaceTarget,
  createWindowsWorkspaceState,
  listWindowsWorkspaceRuntimeTabs,
  moveWindowsWorkspaceTab,
  openWindowsWorkspaceTab,
  openWindowsWorkspaceTabInPane,
  resizeWindowsWorkspacePanes,
  splitWindowsWorkspace,
  splitWindowsWorkspaceEmpty,
} from './windows-workspace';

const target = (sessionName: string) => ({ bridgeHost: '127.0.0.1', bridgePort: 3333, sessionName });

describe('windows workspace shared composition', () => {
  it('opens tabs, splits panes, activates and resizes through shared workspace identity', () => {
    let workspace = openWindowsWorkspaceTab(createWindowsWorkspaceState(), target('alpha'));
    workspace = openWindowsWorkspaceTab(workspace, target('beta'));
    const firstPane = workspace.panes[0]!;
    expect(firstPane.tabs.map((tab) => tab.title)).toEqual(['alpha', 'beta']);

    workspace = splitWindowsWorkspace(workspace, target('gamma'));
    expect(workspace.panes).toHaveLength(2);
    expect(listWindowsWorkspaceRuntimeTabs(workspace).map((tab) => tab.title)).toEqual(['alpha', 'beta', 'gamma']);

    workspace = activateWindowsWorkspaceTab(workspace, firstPane.id, firstPane.tabs[0]!.id);
    expect(workspace.activePaneId).toBe(firstPane.id);
    expect(workspace.panes[0]!.activeTabId).toBe(firstPane.tabs[0]!.id);

    const secondPane = workspace.panes[1]!;
    workspace = resizeWindowsWorkspacePanes(workspace, firstPane.id, secondPane.id, 0.7);
    expect(workspace.panes[0]!.size).toBeCloseTo(0.7);
    expect(workspace.panes[1]!.size).toBeCloseTo(0.3);
  });

  it('rejects unknown activation and preserves one empty pane after the last runtime closes', () => {
    const initial = createWindowsWorkspaceState();
    expect(activateWindowsWorkspaceTab(initial, 'missing', 'missing')).toBe(initial);
    const opened = openWindowsWorkspaceTab(initial, target('alpha'));
    const pane = opened.panes[0]!;
    const closed = closeWindowsWorkspaceTab(opened, pane.id, pane.activeTabId);
    expect(closed.panes).toHaveLength(1);
    expect(closed.panes[0]!.tabs).toHaveLength(1);
    expect(closed.panes[0]!.tabs[0]!.target).toBeNull();
    expect(listWindowsWorkspaceRuntimeTabs(closed)).toEqual([]);
  });

  it('removes only tabs bound to the explicitly closed daemon target', () => {
    let workspace = openWindowsWorkspaceTab(createWindowsWorkspaceState(), target('alpha'));
    workspace = openWindowsWorkspaceTab(workspace, target('beta'));
    workspace = splitWindowsWorkspace(workspace, target('alpha'));

    const closed = closeWindowsWorkspaceTarget(workspace, target('alpha'));
    expect(listWindowsWorkspaceRuntimeTabs(closed).map((tab) => tab.title)).toEqual(['beta']);
    expect(closed.panes).toHaveLength(1);
  });

  it('opens a selected session directly into an empty numbered pane', () => {
    let workspace = openWindowsWorkspaceTab(createWindowsWorkspaceState(), target('alpha'));
    workspace = splitWindowsWorkspaceEmpty(workspace);
    const emptyPane = workspace.panes[1]!;

    workspace = openWindowsWorkspaceTabInPane(workspace, emptyPane.id, target('beta'));

    expect(workspace.activePaneId).toBe(emptyPane.id);
    expect(workspace.panes[1]!.tabs).toHaveLength(1);
    expect(workspace.panes[1]!.tabs[0]!.title).toBe('beta');
    expect(listWindowsWorkspaceRuntimeTabs(workspace).map((tab) => tab.title)).toEqual(['alpha', 'beta']);
  });

  it('changes one pane tab session without mutating sibling pane identity', () => {
    let workspace = openWindowsWorkspaceTab(createWindowsWorkspaceState(), target('alpha'));
    workspace = splitWindowsWorkspace(workspace, target('beta'));
    const firstPane = workspace.panes[0]!;
    const secondPane = workspace.panes[1]!;

    workspace = changeWindowsWorkspaceTabSession(workspace, firstPane.id, firstPane.activeTabId, target('gamma'));

    expect(workspace.activePaneId).toBe(firstPane.id);
    expect(workspace.panes[0]!.tabs.map((tab) => tab.title)).toEqual(['gamma']);
    expect(workspace.panes[1]!.id).toBe(secondPane.id);
    expect(workspace.panes[1]!.tabs.map((tab) => tab.title)).toEqual(['beta']);
  });

  it('moves a runtime tab to an explicitly selected pane', () => {
    let workspace = openWindowsWorkspaceTab(createWindowsWorkspaceState(), target('alpha'));
    workspace = openWindowsWorkspaceTab(workspace, target('beta'));
    workspace = splitWindowsWorkspaceEmpty(workspace);
    const firstPane = workspace.panes[0]!;
    const secondPane = workspace.panes[1]!;

    workspace = moveWindowsWorkspaceTab(workspace, firstPane.id, firstPane.tabs[1]!.id, secondPane.id);

    expect(workspace.panes[0]!.tabs.map((tab) => tab.title)).toEqual(['alpha']);
    expect(workspace.panes[1]!.tabs.map((tab) => tab.title)).toContain('beta');
  });

  it('does not move empty placeholder tabs between panes', () => {
    let workspace = openWindowsWorkspaceTab(createWindowsWorkspaceState(), target('alpha'));
    workspace = splitWindowsWorkspaceEmpty(workspace);
    const emptyPane = workspace.panes[1]!;
    const firstPane = workspace.panes[0]!;

    const moved = moveWindowsWorkspaceTab(workspace, emptyPane.id, emptyPane.activeTabId, firstPane.id);

    expect(moved).toBe(workspace);
    expect(listWindowsWorkspaceRuntimeTabs(moved).map((tab) => tab.title)).toEqual(['alpha']);
    expect(moved.panes[1]!.tabs[0]!.target).toBeNull();
  });
});
