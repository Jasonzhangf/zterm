 import { describe, expect, it } from 'vitest';
 import { findSplitTreeSplit } from '@zterm/shared';
import {
  LEGACY_SHELL_WORKSPACE_STORAGE_KEY,
  MAC_WORKSPACE_STORAGE_PREFIX,
  MacWorkspaceStoreInvalidRecordError,
  activateMacWorkspacePane,
  activateMacWorkspaceTab,
  assertMacWorkspaceRecordBoundary,
  closeMacWorkspaceTab,
  createInitialMacWorkspaceRecord,
  createLocalTmuxMacTab,
  createMacWorkspaceStore,
  createMemoryMacWorkspaceStorage,
  createRemoteMacTab,
  moveMacWorkspaceTab,
  openMacWorkspaceTab,
  parseMacWorkspaceRecord,
  resizeMacWorkspacePanes,
  splitMacWorkspacePane,
} from './workspace-store';

function sumPaneSizes(record: ReturnType<typeof createInitialMacWorkspaceRecord>) {
  return record.panes.reduce((sum, pane) => sum + pane.size, 0);
}

describe('MacWorkspaceStore pure owner', () => {
  it('creates one workspace with one pane and one empty tab', () => {
    const record = createInitialMacWorkspaceRecord({
      windowId: 'window-1',
      workspaceId: 'workspace-1',
      updatedAt: 10,
    });

    expect(record.windowId).toBe('window-1');
    expect(record.workspaceId).toBe('workspace-1');
    expect(record.panes).toHaveLength(1);
    expect(record.panes[0].tabs).toHaveLength(1);
    expect(record.panes[0].tabs[0]).toMatchObject({ kind: 'empty', title: 'New tab' });
    expect(record.activePaneId).toBe(record.panes[0].id);
    expect(record.paneTree.paneIds).toEqual([record.panes[0].id]);
  });

  it('loads and saves workspaces by windowId without touching legacy shell-workspace storage', () => {
    const storage = createMemoryMacWorkspaceStorage();
    const store = createMacWorkspaceStore(storage, { clock: { now: () => 20 } });
    const initial = store.load('window-a');
    const withTab = openMacWorkspaceTab(
      initial,
      createRemoteMacTab({ id: 'tab-a', serverId: 'server-a', sessionName: 'main' }),
      { updatedAt: 21 },
    );

    store.save(withTab);

    const dump = storage.dump();
    expect(Object.keys(dump)).toEqual([`${MAC_WORKSPACE_STORAGE_PREFIX}window-a`]);
    expect(dump[LEGACY_SHELL_WORKSPACE_STORAGE_KEY]).toBeUndefined();
    expect(store.load('window-a').panes[0].tabs[0]).toMatchObject({
      id: 'tab-a',
      kind: 'remote',
      runtimeKey: 'remote:server-a:main',
    });
  });

  it('splits right and down as pane-tree updates only', () => {
    let record = createInitialMacWorkspaceRecord({ windowId: 'window-1', workspaceId: 'workspace-1', updatedAt: 1 });
    record = openMacWorkspaceTab(
      record,
      createRemoteMacTab({ id: 'tab-a', serverId: 'server-a', sessionName: 'main' }),
      { updatedAt: 2 },
    );
    const sourcePaneId = record.activePaneId;

    record = splitMacWorkspacePane(record, { direction: 'right', updatedAt: 3 });
    expect(record.panes).toHaveLength(2);
    expect(record.paneTree.lastSplit).toMatchObject({
      sourcePaneId,
      newPaneId: record.activePaneId,
      direction: 'right',
    });

    const secondSourcePaneId = record.activePaneId;
    record = splitMacWorkspacePane(record, { direction: 'down', updatedAt: 4 });
    expect(record.panes).toHaveLength(3);
    expect(record.paneTree.lastSplit).toMatchObject({
      sourcePaneId: secondSourcePaneId,
      newPaneId: record.activePaneId,
      direction: 'down',
    });
    expect(record.panes.every((pane) => pane.tabs[0].kind === 'empty' || pane.tabs[0].kind === 'remote')).toBe(true);
  });

  it('resizes pane ratios while preserving normalized total size', () => {
    let record = createInitialMacWorkspaceRecord({ windowId: 'window-1', workspaceId: 'workspace-1', updatedAt: 1 });
    record = splitMacWorkspacePane(record, { direction: 'right', updatedAt: 2 });
    const [source] = record.panes;
    const split = findSplitTreeSplit(record.paneTreeRoot, record.paneTreeRoot.id);
    expect(split).not.toBeNull();

    record = resizeMacWorkspacePanes(record, split!.id, 0.8, 3);

    expect(record.paneTreeRoot).toMatchObject({ type: 'split', ratio: 0.8 });
    expect(record.panes.find((pane) => pane.id === source.id)?.size).toBeCloseTo(0.5);
  });

  it('moves a tab across panes and preserves tab identity', () => {
    let record = createInitialMacWorkspaceRecord({ windowId: 'window-1', workspaceId: 'workspace-1', updatedAt: 1 });
    record = openMacWorkspaceTab(record, createRemoteMacTab({ id: 'tab-a', serverId: 'server-a', sessionName: 'main' }), { updatedAt: 2 });
    record = openMacWorkspaceTab(record, createLocalTmuxMacTab({ id: 'tab-b', sessionName: 'zterm_mac_goal_a' }), { append: true, updatedAt: 3 });
    record = splitMacWorkspacePane(record, { direction: 'right', updatedAt: 4 });
    const [sourcePane, targetPane] = record.panes;

    record = moveMacWorkspaceTab(record, sourcePane.id, 'tab-b', targetPane.id, 5);

    expect(record.panes.find((pane) => pane.id === sourcePane.id)?.tabs.map((tab) => tab.id)).toEqual(['tab-a']);
    expect(record.panes.find((pane) => pane.id === targetPane.id)?.tabs.map((tab) => tab.id)).toContain('tab-b');
    expect(record.activePaneId).toBe(targetPane.id);
  });

  it('activates pane and tab without changing runtime identity fields', () => {
    let record = createInitialMacWorkspaceRecord({ windowId: 'window-1', workspaceId: 'workspace-1', updatedAt: 1 });
    record = openMacWorkspaceTab(record, createRemoteMacTab({ id: 'tab-a', serverId: 'server-a', sessionName: 'main' }), { updatedAt: 2 });
    record = openMacWorkspaceTab(record, createRemoteMacTab({ id: 'tab-b', serverId: 'server-b', sessionName: 'main' }), { append: true, updatedAt: 3 });

    record = activateMacWorkspaceTab(record, 'tab-a', 4);
    expect(record.panes[0].activeTabId).toBe('tab-a');
    expect(record.panes[0].tabs.find((tab) => tab.id === 'tab-a')?.runtimeKey).toBe('remote:server-a:main');

    record = splitMacWorkspacePane(record, { direction: 'right', updatedAt: 5 });
    const firstPaneId = record.panes[0].id;
    record = activateMacWorkspacePane(record, firstPaneId, 6);
    expect(record.activePaneId).toBe(firstPaneId);
  });

  it('closes tab and pane while keeping at least one pane alive', () => {
    let record = createInitialMacWorkspaceRecord({ windowId: 'window-1', workspaceId: 'workspace-1', updatedAt: 1 });
    const onlyTabId = record.panes[0].tabs[0].id;
    record = closeMacWorkspaceTab(record, onlyTabId, 2);
    expect(record.panes).toHaveLength(1);
    expect(record.panes[0].tabs[0].kind).toBe('empty');

    record = openMacWorkspaceTab(record, createRemoteMacTab({ id: 'tab-a', serverId: 'server-a', sessionName: 'main' }), { updatedAt: 3 });
    record = splitMacWorkspacePane(record, { direction: 'right', updatedAt: 4 });
    const removablePane = record.panes[1];
    record = closeMacWorkspaceTab(record, removablePane.tabs[0].id, 5);
    expect(record.panes).toHaveLength(1);
  });

  it('rejects invalid persisted workspace records explicitly', () => {
    const storage = createMemoryMacWorkspaceStorage({
      [`${MAC_WORKSPACE_STORAGE_PREFIX}window-a`]: JSON.stringify({ workspaceId: '', panes: [] }),
    });
    const store = createMacWorkspaceStore(storage);

    expect(() => store.load('window-a')).toThrow(MacWorkspaceStoreInvalidRecordError);
    expect(() => parseMacWorkspaceRecord({ workspaceId: 'workspace-1' })).toThrow(MacWorkspaceStoreInvalidRecordError);
  });

  it('allows runtimeKey identity but rejects runtime-owned state fields', () => {
    const record = createInitialMacWorkspaceRecord({ windowId: 'window-1', workspaceId: 'workspace-1', updatedAt: 1 });
    const withRuntimeKey = openMacWorkspaceTab(
      record,
      createRemoteMacTab({ id: 'tab-a', serverId: 'server-a', sessionName: 'main' }),
      { updatedAt: 2 },
    );
    expect(() => assertMacWorkspaceRecordBoundary(withRuntimeKey)).not.toThrow();

    expect(() => assertMacWorkspaceRecordBoundary({
      ...withRuntimeKey,
      panes: [{
        ...withRuntimeKey.panes[0],
        tabs: [{
          ...withRuntimeKey.panes[0].tabs[0],
          buffer: { lines: [] },
        } as any],
      }],
    })).toThrow(MacWorkspaceStoreInvalidRecordError);
  });
});
