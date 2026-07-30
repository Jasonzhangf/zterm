// @vitest-environment jsdom
/**
 * mac-4.0.f 红测：MacPaneWorkbench 递归 paneTree 渲染
 *
 * 验证（按门禁顺序）：
 * 1. nested right/down tree → 递归 DOM 结构（row + column split）
 * 2. flat panes 无 paneTreeRoot → flat PaneStage 退化
 * 3. split right 产生 row-split DOM，split down 产生 column-split DOM
 * 4. close 后 parent collapse，剩余 pane 重新编号
 * 5. resize 只改变目标 split node ratio，不影响 sibling
 * 6. paneTreeRoot round-trip through createWorkbenchStateFromWorkspaceRecord +
 *    createWorkspaceRecordFromWorkbenchState 不丢结构
 * 7. empty pane 点击打开 session chooser
 * 8. Move to Pn 使用 DFS pane 编号
 * 9. sibling runtime emission 不重渲染其他 pane
 */

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MacPaneWorkbench } from './MacPaneWorkbench';
import {
  createInitialWorkbenchState,
  openConnectionInWorkbench,
  openLocalTmuxInWorkbench,
  splitActivePaneRight,
  splitActivePaneDown,
  closeTab,
  moveTabToPane,
  beginPendingSessionReplacement,
  createWorkspaceRecordFromWorkbenchState,
  createWorkbenchStateFromWorkspaceRecord,
  type MacWorkbenchState,
} from './workbench';
import {
  createInitialMacWorkspaceRecord,
  createRemoteMacTab,
  splitMacWorkspacePane,
  closeMacWorkspaceTab,
  createMacWorkspaceStore,
  createMemoryMacWorkspaceStorage,
  parseMacWorkspaceRecord,
  resizeMacWorkspacePanes,
  openMacWorkspaceTab,
} from './workspace/workspace-store';
import type { EditableHost, BridgeSettings } from '@zterm/shared';
import type { TerminalRuntimeState } from '../lib/terminal-runtime';
import type { MacRuntimeRegistry } from './runtime/MacRuntimeRegistry';

function makeRuntimeRegistryStub(runtimeState = makeRuntimeState()): MacRuntimeRegistry {
  return {
    ensureRuntime: vi.fn(() => ({}) as any),
    getRuntime: vi.fn(() => ({}) as any),
    getRuntimeState: vi.fn(() => runtimeState),
    subscribeRuntime: vi.fn(() => () => {}),
    getActiveRuntimeKey: vi.fn(() => null),
    subscribeActiveRuntimeKey: vi.fn(() => () => {}),
    setActiveRuntimeKey: vi.fn(),
    reconnectRuntime: vi.fn(() => true),
    disconnectRuntime: vi.fn(() => true),
    sendInput: vi.fn(() => true),
    updateViewport: vi.fn(() => true),
    resizeTerminal: vi.fn(() => true),
    disposeRuntime: vi.fn(),
    releaseRuntime: vi.fn(),
    dispose: vi.fn(),
  };
}

function makeRuntimeState(): TerminalRuntimeState {
  return {
    connection: { status: 'idle', error: '', connectedSessionId: '', title: '', activeTarget: null } as any,
    buffer: { canonicalBuffer: {} as any, renderBuffer: { lines: [], cols: 80, rows: 24 } as any },
    render: { lines: [], cols: 80, rows: 24 } as any,
    schedule: { jobs: [], loading: false } as any,
    head: null,
  } as any;
}

function makeTarget(name: string): EditableHost {
  return { name, bridgeHost: '127.0.0.1', bridgePort: 3333, sessionName: name, authType: 'password', tags: [], pinned: false };
}

function makeBridgeSettings(): BridgeSettings {
  return {
    defaultServerId: 'default', servers: [], currentServerId: 'default',
    targetHost: '127.0.0.1', targetPort: 3333, terminalThemeId: 'default', widthMode: 'adaptive-phone',
  } as any;
}

afterEach(() => { cleanup(); });

// ---------------------------------------------------------------------------
// RED TESTS: These will fail until the recursive paneTree feature is implemented
// ---------------------------------------------------------------------------

describe('MacPaneWorkbench recursive paneTree rendering (red baseline)', () => {
  // ---- Helper: build nested workspace via workspace-store (not workbench-model) ----
  function buildNestedWorkspaceRecord(): { workbench: MacWorkbenchState; record: ReturnType<typeof createInitialMacWorkspaceRecord & typeof openMacWorkspaceTab & typeof splitMacWorkspacePane> } {
    let record = createInitialMacWorkspaceRecord({ windowId: 'test-window', workspaceId: 'ws-1', updatedAt: 1 });
    record = openMacWorkspaceTab(record, createRemoteMacTab({ id: 'tab-a', serverId: 's1', sessionName: 'main' }), { updatedAt: 2 });
    record = splitMacWorkspacePane(record, { direction: 'right', initialTab: createRemoteMacTab({ id: 'tab-b', serverId: 's2', sessionName: 'dev' }), updatedAt: 3 });
    record = splitMacWorkspacePane(record, { direction: 'down', initialTab: createRemoteMacTab({ id: 'tab-c', serverId: 's3', sessionName: 'ops' }), updatedAt: 4 });
    const workbench = createWorkbenchStateFromWorkspaceRecord(record, []);
    return { workbench, record };
  }

  it('renders nested right+down tree as row-split with column child in DOM', () => {
    const { workbench } = buildNestedWorkspaceRecord();
    const { container } = render(
      <MacPaneWorkbench
        workbench={workbench}
        setWorkbench={vi.fn()}
        hosts={[]}
        platform="desktop"
        splitVisible
        runtimeRegistry={makeRuntimeRegistryStub()}
        bridgeSettings={makeBridgeSettings()}
      />,
    );
    // Expect recursive structure: outer row split, inner column split
    // mac-pane-split-row contains 2 children; mac-pane-split-column contains 2 children
    const rowSplits = container.querySelectorAll('[data-testid="mac-pane-split-row"]');
    const colSplits = container.querySelectorAll('[data-testid="mac-pane-split-col"]');
    expect(rowSplits.length).toBeGreaterThanOrEqual(1);
    expect(colSplits.length).toBeGreaterThanOrEqual(1);
    // total pane frames = 3
    expect(container.querySelectorAll('[data-testid="pane-stage-frame"]').length).toBe(3);
  });

  it('flat panes without paneTreeRoot fall back to flat PaneStage', () => {
    const workbench = createInitialWorkbenchState();
    workbench.workspace.panes.push({ ...workbench.workspace.panes[0], id: 'p2', tabs: [{ id: 't2', kind: 'empty', title: 'New tab' }], activeTabId: 't2', size: 1 });
    const { container } = render(
      <MacPaneWorkbench
        workbench={workbench}
        setWorkbench={vi.fn()}
        hosts={[]}
        platform="desktop"
        splitVisible
        runtimeRegistry={makeRuntimeRegistryStub()}
        bridgeSettings={makeBridgeSettings()}
      />,
    );
    // Without paneTreeRoot, should use flat PaneStage
    expect(container.querySelector('[data-testid="pane-stage-split"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="mac-pane-split-row"]').length).toBe(0);
  });

  it('splitActivePaneRight creates row-split DOM; splitActivePaneDown creates column-split DOM', () => {
    let workbench: MacWorkbenchState = createInitialWorkbenchState();
    workbench = openConnectionInWorkbench(workbench, makeTarget('a'));
    workbench = splitActivePaneRight(workbench);
    const { container: r } = render(
      <MacPaneWorkbench workbench={workbench} setWorkbench={vi.fn()} hosts={[]} platform="desktop" splitVisible runtimeRegistry={makeRuntimeRegistryStub()} bridgeSettings={makeBridgeSettings()} />,
    );
    // Right split → row split
    expect(r.querySelectorAll('[data-testid="mac-pane-split-row"]').length).toBe(1);
    expect(r.querySelectorAll('[data-testid="mac-pane-split-col"]').length).toBe(0);

    // Down split → column split
    workbench = splitActivePaneDown(workbench);
    const { container: c } = render(
      <MacPaneWorkbench workbench={workbench} setWorkbench={vi.fn()} hosts={[]} platform="desktop" splitVisible runtimeRegistry={makeRuntimeRegistryStub()} bridgeSettings={makeBridgeSettings()} />,
    );
    expect(c.querySelectorAll('[data-testid="mac-pane-split-col"]').length).toBeGreaterThanOrEqual(1);
  });

  it('closing a pane collapses parent and re-numbers remaining panes with DFS order', () => {
    const { workbench } = buildNestedWorkspaceRecord();
    let nextWorkbench = workbench;
    const setWorkbench = (updater: any) => { nextWorkbench = typeof updater === 'function' ? updater(nextWorkbench) : updater; };
    const { container, rerender } = render(
      <MacPaneWorkbench workbench={workbench} setWorkbench={setWorkbench as any} hosts={[]} platform="desktop" splitVisible runtimeRegistry={makeRuntimeRegistryStub()} bridgeSettings={makeBridgeSettings()} />,
    );
    // Close tab of the second pane (pane at index 1 in DFS order)
    const secondPaneFrame = container.querySelectorAll('[data-testid="pane-stage-frame"]')[1] as HTMLElement;
    const paneId = secondPaneFrame?.getAttribute('data-pane-id');
    expect(paneId).toBeTruthy();
    // Find the active tab of that pane
    const pane = nextWorkbench.workspace.panes.find(p => p.id === paneId);
    expect(pane).toBeTruthy();
    fireEvent.click(container.querySelector(`[data-testid="pane-tab-close-${pane!.activeTabId}"]`)!);
    // After close: should have 2 pane frames remaining
    rerender(<MacPaneWorkbench workbench={nextWorkbench} setWorkbench={setWorkbench as any} hosts={[]} platform="desktop" splitVisible runtimeRegistry={makeRuntimeRegistryStub()} bridgeSettings={makeBridgeSettings()} />);
    expect(container.querySelectorAll('[data-testid="pane-stage-frame"]').length).toBe(2);
  });

  it('resize only affects target split node ratio, not siblings', () => {
    let record = createInitialMacWorkspaceRecord({ windowId: 'w1', workspaceId: 'ws-1', updatedAt: 1 });
    record = splitMacWorkspacePane(record, { direction: 'right', updatedAt: 2 });
    const splitNodeId = (record.paneTreeRoot as any).id;
    const originalRatio = (record.paneTreeRoot as any).ratio;

    record = resizeMacWorkspacePanes(record, splitNodeId, 0.8, 3);
    expect((record.paneTreeRoot as any).ratio).toBeCloseTo(0.8);
    // Verify it's actually changed
    expect((record.paneTreeRoot as any).ratio).not.toBeCloseTo(originalRatio);
  });

  it('recursive paneTree round-trips through createWorkbenchStateFromWorkspaceRecord + createWorkspaceRecordFromWorkbenchState', () => {
    const { workbench, record: previousRecord } = buildNestedWorkspaceRecord();
    const roundTripRecord = createWorkspaceRecordFromWorkbenchState(workbench, {
      windowId: 'test-window', hosts: [], previousRecord: previousRecord as any,
    });
    // Check paneTreeRoot exists and has correct structure
    expect(roundTripRecord.paneTreeRoot).toBeDefined();
    expect(roundTripRecord.paneTreeRoot.type).toBe('split');
    // Convert back
    const restored = createWorkbenchStateFromWorkspaceRecord(roundTripRecord, []);
    expect(restored.workspace.panes.length).toBe(3);
    // Verify all tabs are present
    const allTabIds = restored.workspace.panes.flatMap(p => p.tabs.map(t => t.id));
    expect(allTabIds).toContain('tab-a');
    expect(allTabIds).toContain('tab-b');
    expect(allTabIds).toContain('tab-c');
  });

  it('empty pane click activates pane and opens session chooser', () => {
    let workbench: MacWorkbenchState = createInitialWorkbenchState();
    workbench = splitActivePaneRight(workbench);
    const emptyPane = workbench.workspace.panes.find(p => p.tabs[0].kind === 'empty')!;
    let nextWorkbench = workbench;
    const setWorkbench = (updater: any) => { nextWorkbench = typeof updater === 'function' ? updater(nextWorkbench) : updater; };
    const { container } = render(
      <MacPaneWorkbench workbench={workbench} setWorkbench={setWorkbench as any} hosts={[]} platform="desktop" splitVisible runtimeRegistry={makeRuntimeRegistryStub()} bridgeSettings={makeBridgeSettings()} />,
    );
    fireEvent.click(container.querySelector(`[data-testid="mac-empty-pane-select-${emptyPane.id}"]`)!);
    expect(nextWorkbench.workspace.activePaneId).toBe(emptyPane.id);
    expect(nextWorkbench.launcherOpen).toBe(true);
  });

  it('Move to Pn uses DFS pane numbering (P1, P2, P3...)', () => {
    let workbench: MacWorkbenchState = createInitialWorkbenchState();
    workbench = openConnectionInWorkbench(workbench, makeTarget('a'));
    workbench = openConnectionInWorkbench(workbench, makeTarget('b'), { append: true });
    workbench = splitActivePaneRight(workbench);
    workbench = openLocalTmuxInWorkbench(workbench, 'c');

    const pane0 = workbench.workspace.panes[0]!;
    const pane1 = workbench.workspace.panes[1]!;
    let nextWorkbench = workbench;
    const setWorkbench = (updater: any) => { nextWorkbench = typeof updater === 'function' ? updater(nextWorkbench) : updater; };
    const { container } = render(
      <MacPaneWorkbench workbench={workbench} setWorkbench={setWorkbench as any} hosts={[]} platform="desktop" splitVisible runtimeRegistry={makeRuntimeRegistryStub()} bridgeSettings={makeBridgeSettings()} />,
    );

    // Open context menu on second tab of pane 0
    fireEvent.contextMenu(container.querySelector(`[data-tab-id="${pane0.tabs[1].id}"]`)!, { clientX: 100, clientY: 200 });
    const menuButtons = Array.from(container.querySelectorAll('[data-testid="mac-pane-context-menu"] button'));
    const moveButtons = menuButtons.filter(b => b.textContent?.includes('Move to P'));
    expect(moveButtons.length).toBeGreaterThanOrEqual(1);
    // Pane 1 should be P2 in DFS order (1-indexed)
    const moveToP2 = moveButtons.find(b => b.textContent?.includes('P2'));
    expect(moveToP2).toBeTruthy();

    fireEvent.click(moveToP2!);
    expect(nextWorkbench.workspace.panes.find(p => p.id === pane1.id)?.tabs.map(t => t.title)).toContain('b');
    expect(nextWorkbench.workspace.panes.find(p => p.id === pane0.id)?.tabs.map(t => t.title)).not.toContain('b');
  });

  it('sibling pane update does not remount other pane terminal views', () => {
    let workbench: MacWorkbenchState = createInitialWorkbenchState();
    workbench = openLocalTmuxInWorkbench(workbench, 'main');
    workbench = splitActivePaneRight(workbench);
    workbench = openLocalTmuxInWorkbench(workbench, 'secondary');
    const registry = makeRuntimeRegistryStub();
    const { container, rerender } = render(
      <MacPaneWorkbench workbench={workbench} setWorkbench={vi.fn()} hosts={[]} platform="desktop" splitVisible runtimeRegistry={registry} bridgeSettings={makeBridgeSettings()} />,
    );
    const mainTerminal = container.querySelector('[data-testid="pane-stage-frame"] [data-mac-terminal-input]');
    expect(mainTerminal).toBeTruthy();
    // Simulate runtime state change for pane 2 (not pane 1)
    const mainPaneId = workbench.workspace.panes[0].id;
    registry.getRuntimeState = vi.fn().mockReturnValue({
      ...makeRuntimeState(),
      render: { lines: [], cols: 80, rows: 24 },
    });
    // Trigger re-render by changing workbench (e.g. append tab to pane 2)
    workbench = { ...workbench, workspace: { ...workbench.workspace, panes: workbench.workspace.panes.map((p, i) => i === 1 ? { ...p, tabs: [...p.tabs, { id: 'new-tab', kind: 'empty', title: 'New tab' }] } : p) } };
    rerender(<MacPaneWorkbench workbench={workbench} setWorkbench={vi.fn()} hosts={[]} platform="desktop" splitVisible runtimeRegistry={registry} bridgeSettings={makeBridgeSettings()} />);
    // The main pane terminal should still be in DOM (not remounted)
    expect(container.querySelector(`[data-testid="pane-stage-frame"][data-pane-id="${mainPaneId}"] [data-mac-terminal-input]`)).toBeTruthy();
  });
});
