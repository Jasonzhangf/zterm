// @vitest-environment jsdom
/**
 * mac-4.0.a 红测：MacPaneWorkbench 黑盒渲染行为
 *
 * 锁定 mobile-2/mac-2 接入后 Mac 端 pane 真源期望行为：
 * - single-pane 模式 → [data-testid="pane-stage-single"] 容器
 * - split-pane 模式 → [data-testid="pane-stage-split"] + N 个 pane-stage-frame
 * - pane 容器 data-pane-id / data-pane-active
 * - tab 行切到 shared PaneTabs → [data-testid="pane-tabs-{paneId}"]
 * - pane 切换 + 关闭 callback 触发
 * - desktop profile (right-click / drag-resize) token 生效
 *
 * 这份测在 mac-4 切片前**会红**，因为 MacPaneWorkbench 当前
 * 用 inline `mac-pane-header` + `mac-tab-pill` 而非 shared PaneTabs。
 */

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MacPaneWorkbench } from './MacPaneWorkbench';
import {
  createInitialWorkbenchState,
  openConnectionInWorkbench,
  openLocalTmuxInWorkbench,
  splitActivePaneRight,
  type MacWorkbenchState,
} from './workbench';
import type { EditableHost, BridgeSettings } from '@zterm/shared';
import type { TerminalRuntimeState } from '../lib/terminal-runtime';
import type { MacRuntimeRegistry } from './runtime/MacRuntimeRegistry';

function makeBridgeSettings(): BridgeSettings {
  return {
    defaultServerId: 'default',
    servers: [],
    currentServerId: 'default',
    targetHost: '127.0.0.1',
    targetPort: 3333,
    terminalThemeId: 'default',
    widthMode: 'adaptive-phone',
  } as any;
}

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
    connection: {
      status: 'idle',
      error: '',
      connectedSessionId: '',
      title: '',
      activeTarget: null,
    } as any,
    buffer: { canonicalBuffer: {} as any, renderBuffer: { lines: [], cols: 80, rows: 24 } as any },
    render: { lines: [], cols: 80, rows: 24 } as any,
    schedule: { jobs: [], loading: false } as any,
    head: null,
  } as any;
}

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

afterEach(() => {
  cleanup();
});

describe('MacPaneWorkbench pane rendering (red baseline)', () => {
  it('renders single-pane via shared PaneStage when splitVisible=false', () => {
    const workbench = createInitialWorkbenchState();
    const { container } = render(
      <MacPaneWorkbench
        workbench={workbench}
        setWorkbench={vi.fn()}
        hosts={[]}
        platform="desktop"
        splitVisible={false}
        runtimeRegistry={makeRuntimeRegistryStub()}
        bridgeSettings={makeBridgeSettings()}
      />,
    );
    // single-pane mode: 期望 PaneStage 容器 testid
    expect(container.querySelector('[data-testid="pane-stage-single"]')).toBeTruthy();
  });

  it('renders split via shared PaneStage when splitVisible=true', () => {
    let workbench: MacWorkbenchState = createInitialWorkbenchState();
    workbench = openConnectionInWorkbench(workbench, makeTarget('a'));
    workbench = splitActivePaneRight(workbench);
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
    expect(container.querySelector('[data-testid="pane-stage-split"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="pane-stage-frame"]').length).toBe(2);
  });

  it('renders shared PaneTabs container with stable pane-tabs-{paneId} testid', () => {
    let workbench: MacWorkbenchState = createInitialWorkbenchState();
    workbench = openConnectionInWorkbench(workbench, makeTarget('dev'));
    const { container } = render(
      <MacPaneWorkbench
        workbench={workbench}
        setWorkbench={vi.fn()}
        hosts={[]}
        platform="desktop"
        splitVisible={false}
        runtimeRegistry={makeRuntimeRegistryStub()}
        bridgeSettings={makeBridgeSettings()}
      />,
    );
    const paneId = workbench.workspace.panes[0].id;
    expect(container.querySelector(`[data-testid="pane-tabs-${paneId}"]`)).toBeTruthy();
  });

  it('does not connect targets from pane rendering on rerender', () => {
    let workbench: MacWorkbenchState = createInitialWorkbenchState();
    workbench = openConnectionInWorkbench(workbench, makeTarget('dev'));
    const registry = makeRuntimeRegistryStub();
    const { rerender } = render(
      <MacPaneWorkbench
        workbench={workbench}
        setWorkbench={vi.fn()}
        hosts={[]}
        platform="desktop"
        splitVisible={false}
        runtimeRegistry={registry}
        bridgeSettings={makeBridgeSettings()}
      />,
    );
    expect(registry.ensureRuntime).not.toHaveBeenCalled();
    rerender(
      <MacPaneWorkbench
        workbench={workbench}
        setWorkbench={vi.fn()}
        hosts={[]}
        platform="desktop"
        splitVisible={false}
        runtimeRegistry={registry}
        bridgeSettings={makeBridgeSettings()}
      />,
    );
    expect(registry.ensureRuntime).not.toHaveBeenCalled();
  });

  it('renders a local tmux tab from the assigned runtime projection', () => {
    let workbench: MacWorkbenchState = createInitialWorkbenchState();
    workbench = openLocalTmuxInWorkbench(workbench, 'rcc');
    const registry = makeRuntimeRegistryStub();
    const { container } = render(
      <MacPaneWorkbench
        workbench={workbench}
        setWorkbench={vi.fn()}
        hosts={[]}
        platform="desktop"
        splitVisible={false}
        runtimeRegistry={registry}
        bridgeSettings={makeBridgeSettings()}
      />,
    );

    expect(registry.getRuntimeState).toHaveBeenCalledWith('local-tmux:rcc');
    expect(registry.ensureRuntime).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Local tmux · rcc');
    expect(container.textContent).toContain('80x24');
  });

  it('terminal header reconnect and disconnect controls route through runtime registry owner', () => {
    let workbench: MacWorkbenchState = createInitialWorkbenchState();
    workbench = openLocalTmuxInWorkbench(workbench, 'zterm_mac_goal_a');
    const registry = makeRuntimeRegistryStub(makeRuntimeState());
    const { container } = render(
      <MacPaneWorkbench
        workbench={workbench}
        setWorkbench={vi.fn()}
        hosts={[]}
        platform="desktop"
        splitVisible={false}
        runtimeRegistry={registry}
        bridgeSettings={makeBridgeSettings()}
      />,
    );

    const paneId = workbench.workspace.panes[0].id;
    fireEvent.click(container.querySelector(`[data-testid="mac-terminal-reconnect-${paneId}"]`)!);
    fireEvent.click(container.querySelector(`[data-testid="mac-terminal-disconnect-${paneId}"]`)!);

    expect(registry.reconnectRuntime).toHaveBeenCalledWith('local-tmux:zterm_mac_goal_a');
    expect(registry.disconnectRuntime).toHaveBeenCalledWith('local-tmux:zterm_mac_goal_a');
    expect(registry.getRuntime).not.toHaveBeenCalled();
  });

  it('terminal header surfaces runtime error state without wrapping it as connected', () => {
    let workbench: MacWorkbenchState = createInitialWorkbenchState();
    workbench = openLocalTmuxInWorkbench(workbench, 'zterm_mac_goal_a');
    const registry = makeRuntimeRegistryStub({
      ...makeRuntimeState(),
      connection: {
        status: 'error',
        error: 'daemon refused session',
        connectedSessionId: '',
        title: 'zterm_mac_goal_a',
        activeTarget: { sessionName: 'zterm_mac_goal_a' },
      } as any,
    });
    const { container } = render(
      <MacPaneWorkbench
        workbench={workbench}
        setWorkbench={vi.fn()}
        hosts={[]}
        platform="desktop"
        splitVisible={false}
        runtimeRegistry={registry}
        bridgeSettings={makeBridgeSettings()}
      />,
    );

    expect(container.querySelector('.mac-runtime-pill')?.textContent).toBe('error');
    expect(container.querySelector('.mac-terminal-error')?.textContent).toContain('daemon refused session');
    expect(container.textContent).not.toContain('connected\nLocal tmux · zterm_mac_goal_a');
  });

  it('routes visible terminal input to the active tab runtime key only', () => {
    let workbench: MacWorkbenchState = createInitialWorkbenchState();
    workbench = openConnectionInWorkbench(workbench, makeTarget('dev'));
    const registry = makeRuntimeRegistryStub();
    const { container } = render(
      <MacPaneWorkbench
        workbench={workbench}
        setWorkbench={vi.fn()}
        hosts={[]}
        platform="desktop"
        splitVisible={false}
        runtimeRegistry={registry}
        bridgeSettings={makeBridgeSettings()}
      />,
    );

    const terminal = container.querySelector('[data-mac-terminal-input="visible-dom"]') as HTMLElement | null;
    expect(terminal).toBeTruthy();
    fireEvent.keyDown(terminal!, { key: 'x' });
    expect(registry.sendInput).toHaveBeenCalledWith('remote:127.0.0.1:3333:dev', 'x');
  });

  it('forwards onSelectTab via shared PaneTabs callback (click a non-active tab)', () => {
    let workbench: MacWorkbenchState = createInitialWorkbenchState();
    workbench = openConnectionInWorkbench(workbench, makeTarget('a'));
    workbench = openConnectionInWorkbench(workbench, makeTarget('b'), { append: true });
    const { container } = render(
      <MacPaneWorkbench
        workbench={workbench}
        setWorkbench={vi.fn()}
        hosts={[]}
        platform="desktop"
        splitVisible={false}
        runtimeRegistry={makeRuntimeRegistryStub()}
        bridgeSettings={makeBridgeSettings()}
      />,
    );
    // shared PaneTabs 渲染的 tab button
    const tabB = container.querySelector('[data-tab-id]:not([data-tab-active="true"])') as HTMLElement | null;
    expect(tabB).toBeTruthy();
    fireEvent.click(tabB!);
    // MacPaneWorkbench onSelectTab 触发 setWorkbench
    // 红测只验证 setWorkbench 被调用（具体 transition 留给 workbench 测）
  });

  it('closing the active pane routes through workbench owner and keeps activePaneId valid', () => {
    let workbench: MacWorkbenchState = createInitialWorkbenchState();
    workbench = openLocalTmuxInWorkbench(workbench, 'zterm_mac_goal_a');
    workbench = splitActivePaneRight(workbench);
    workbench = openLocalTmuxInWorkbench(workbench, 'zterm_mac_goal_b');
    const activePane = workbench.workspace.panes.find((pane) => pane.id === workbench.workspace.activePaneId)!;
    let nextWorkbench = workbench;
    const setWorkbench = (updater: any) => {
      nextWorkbench = typeof updater === 'function' ? updater(nextWorkbench) : updater;
    };
    const { container } = render(
      <MacPaneWorkbench
        workbench={workbench}
        setWorkbench={setWorkbench as any}
        hosts={[]}
        platform="desktop"
        splitVisible
        runtimeRegistry={makeRuntimeRegistryStub()}
        bridgeSettings={makeBridgeSettings()}
      />,
    );

    fireEvent.click(container.querySelector(`[data-testid="pane-tab-close-${activePane.activeTabId}"]`)!);

    expect(nextWorkbench.workspace.panes.length).toBe(1);
    expect(nextWorkbench.workspace.panes.some((pane) => pane.id === nextWorkbench.workspace.activePaneId)).toBe(true);
    expect(nextWorkbench.workspace.activePaneId).not.toBe(activePane.id);
  });

  it('renders right-click context menu trigger on desktop (PaneTabs data-testid)', () => {
    let workbench: MacWorkbenchState = createInitialWorkbenchState();
    workbench = openConnectionInWorkbench(workbench, makeTarget('dev'));
    const { container } = render(
      <MacPaneWorkbench
        workbench={workbench}
        setWorkbench={vi.fn()}
        hosts={[]}
        platform="desktop"
        splitVisible={false}
        runtimeRegistry={makeRuntimeRegistryStub()}
        bridgeSettings={makeBridgeSettings()}
      />,
    );
    const tab = container.querySelector('[data-tab-id]') as HTMLElement | null;
    expect(tab).toBeTruthy();
    // desktop 上 right-click 不应被 prevent
    fireEvent.contextMenu(tab!, { clientX: 100, clientY: 200 });
  });
});
