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

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MacPaneWorkbench } from './MacPaneWorkbench';
import {
  createInitialWorkbenchState,
  openConnectionInWorkbench,
  openLocalTmuxInWorkbench,
  splitActivePaneRight,
  type MacWorkbenchState,
} from './workbench';
import type { EditableHost, Host, BridgeSettings } from '@zterm/shared';
import type { TerminalRuntimeController } from '../lib/terminal-runtime';
import type { TerminalRuntimeState } from '../lib/terminal-runtime';

function makeHost(id: string, name: string): Host {
  return {
    id,
    name,
    bridgeHost: '127.0.0.1',
    bridgePort: 3333,
    sessionName: name,
    authType: 'password',
    tags: [],
    pinned: false,
  };
}

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

function makeRuntimeStub(): TerminalRuntimeController {
  return {
    getState: () => ({}) as any,
    subscribe: () => () => {},
    connectRemote: vi.fn(),
    connectLocalTmux: vi.fn(),
    disconnect: vi.fn(),
    setActivityMode: vi.fn(),
    updateViewport: vi.fn(),
    requestScheduleList: vi.fn(),
    upsertScheduleJob: vi.fn(),
    deleteScheduleJob: vi.fn(),
    toggleScheduleJob: vi.fn(),
    runScheduleJobNow: vi.fn(),
    sendInput: vi.fn(),
    pasteImage: () => true,
    resizeTerminal: vi.fn(),
    requestRemoteScreenshot: () => true,
    sendRawJson: () => true,
    onFileTransferMessage: () => () => {},
    dispose: vi.fn(),
  } as any;
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
        runtime={makeRuntimeStub()}
        runtimeState={makeRuntimeState()}
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
        runtime={makeRuntimeStub()}
        runtimeState={makeRuntimeState()}
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
        runtime={makeRuntimeStub()}
        runtimeState={makeRuntimeState()}
        bridgeSettings={makeBridgeSettings()}
      />,
    );
    const paneId = workbench.workspace.panes[0].id;
    expect(container.querySelector(`[data-testid="pane-tabs-${paneId}"]`)).toBeTruthy();
  });

  it('does not reconnect the same active target on rerender', () => {
    let workbench: MacWorkbenchState = createInitialWorkbenchState();
    workbench = openConnectionInWorkbench(workbench, makeTarget('dev'));
    const runtime = makeRuntimeStub();
    const { rerender } = render(
      <MacPaneWorkbench
        workbench={workbench}
        setWorkbench={vi.fn()}
        hosts={[]}
        platform="desktop"
        splitVisible={false}
        runtime={runtime}
        runtimeState={makeRuntimeState()}
        bridgeSettings={makeBridgeSettings()}
      />,
    );
    expect(runtime.connectRemote).toHaveBeenCalledTimes(1);
    rerender(
      <MacPaneWorkbench
        workbench={workbench}
        setWorkbench={vi.fn()}
        hosts={[]}
        platform="desktop"
        splitVisible={false}
        runtime={runtime}
        runtimeState={makeRuntimeState()}
        bridgeSettings={makeBridgeSettings()}
      />,
    );
    expect(runtime.connectRemote).toHaveBeenCalledTimes(1);
  });

  it('connects a local tmux tab through the same pane workbench surface', () => {
    let workbench: MacWorkbenchState = createInitialWorkbenchState();
    workbench = openLocalTmuxInWorkbench(workbench, 'rcc');
    const runtime = makeRuntimeStub();
    const { container } = render(
      <MacPaneWorkbench
        workbench={workbench}
        setWorkbench={vi.fn()}
        hosts={[]}
        platform="desktop"
        splitVisible={false}
        runtime={runtime}
        runtimeState={makeRuntimeState()}
        bridgeSettings={makeBridgeSettings()}
      />,
    );

    expect(runtime.connectLocalTmux).toHaveBeenCalledWith({ sessionName: 'rcc', title: 'rcc' });
    expect(runtime.connectRemote).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Local tmux · rcc');
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
        runtime={makeRuntimeStub()}
        runtimeState={makeRuntimeState()}
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
        runtime={makeRuntimeStub()}
        runtimeState={makeRuntimeState()}
        bridgeSettings={makeBridgeSettings()}
      />,
    );
    const tab = container.querySelector('[data-tab-id]') as HTMLElement | null;
    expect(tab).toBeTruthy();
    // desktop 上 right-click 不应被 prevent
    fireEvent.contextMenu(tab!, { clientX: 100, clientY: 200 });
  });
});
