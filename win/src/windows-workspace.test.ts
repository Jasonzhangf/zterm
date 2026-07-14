import { describe, expect, it } from 'vitest';
import {
  activateWindowsWorkspaceTab,
  closeWindowsWorkspaceTab,
  closeWindowsWorkspaceTarget,
  createWindowsWorkspaceState,
  listWindowsWorkspaceRuntimeTabs,
  openWindowsWorkspaceTab,
  resizeWindowsWorkspacePanes,
  splitWindowsWorkspace,
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
});
