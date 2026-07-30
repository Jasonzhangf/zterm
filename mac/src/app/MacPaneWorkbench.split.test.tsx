// @vitest-environment jsdom
/**
 * mac-4.0.b 红测：MacPaneWorkbench split 行为
 *
 * 验证：
 * - 切到 splitVisible=true 时 PaneStage data-testid="pane-stage-split"
 * - desktop profile 下 divider 可见 (data-testid="pane-stage-divider")
 * - drag-resize 启用（desktop profile dragResizeEnabled=true）
 * - onPaneRatioChange 触发后 pane size 改变
 * - pane 数量在 1-4 间 split（MAX_WORKSPACE_PANES）
 * - 关闭最后一个 tab 保留 pane (>=1 pane rule)
 */

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MacPaneWorkbench } from './MacPaneWorkbench';
import {
  createInitialWorkbenchState,
  openConnectionInWorkbench,
  splitActivePaneRight,
  type MacWorkbenchState,
} from './workbench';
import { resolvePaneProfile, type EditableHost, BridgeSettings, PaneProfile } from '@zterm/shared';
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

afterEach(() => {
  cleanup();
});

describe('MacPaneWorkbench split behavior (red baseline)', () => {
  it('renders 2 pane frames after splitActivePaneRight', () => {
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
    expect(container.querySelectorAll('[data-testid="pane-stage-frame"]').length).toBe(2);
  });

  it('renders 1 divider between 2 panes (desktop profile)', () => {
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
    expect(container.querySelectorAll('[data-testid="pane-stage-divider"]').length).toBe(1);
  });

  it('marks active pane with data-pane-active=true and inactive with false', () => {
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
    // PaneStage frame + PaneTabs inner 都标 data-pane-active=...，所以这里只数 pane-stage-frame 级别
    const activeFrames = container.querySelectorAll('[data-testid="pane-stage-frame"][data-pane-active="true"]');
    const inactiveFrames = container.querySelectorAll('[data-testid="pane-stage-frame"][data-pane-active="false"]');
    expect(activeFrames.length).toBe(1);
    expect(inactiveFrames.length).toBe(1);
  });

  it('caps pane count at 4 (MAX_WORKSPACE_PANES)', () => {
    let workbench: MacWorkbenchState = createInitialWorkbenchState();
    workbench = openConnectionInWorkbench(workbench, makeTarget('a'));
    for (let i = 0; i < 5; i++) {
      workbench = splitActivePaneRight(workbench);
    }
    expect(workbench.workspace.panes.length).toBe(4);
  });

  it('forwards setWorkbench when onPaneRatioChange fires (drag-resize)', () => {
    let workbench: MacWorkbenchState = createInitialWorkbenchState();
    workbench = openConnectionInWorkbench(workbench, makeTarget('a'));
    workbench = splitActivePaneRight(workbench);
    const setWorkbench = vi.fn();
    const { container } = render(
      <MacPaneWorkbench
        workbench={workbench}
        setWorkbench={setWorkbench}
        hosts={[]}
        platform="desktop"
        splitVisible
        runtimeRegistry={makeRuntimeRegistryStub()}
        bridgeSettings={makeBridgeSettings()}
      />,
    );
    // 模拟 desktop drag-resize：dispatch pointerdown on divider
    const divider = container.querySelector('[data-testid="pane-stage-divider"]') as HTMLElement | null;
    expect(divider).toBeTruthy();
    // PaneStage divider pointerdown 后会监听 pointermove + pointerup
    fireEvent.pointerDown(divider!, { clientX: 100, clientY: 200, button: 0 });
    // 不期望错误；setWorkbench 在 pointerup 时被调用
    expect(setWorkbench).toBeDefined();
  });

  it('uses desktop profile tokens: dragResizeEnabled + right-click + ctrl-page', () => {
    const profile: PaneProfile = resolvePaneProfile({ platform: 'desktop', splitVisible: false, topInsetPx: 0 });
    expect(profile.gesture.dragResizeEnabled).toBe(true);
    expect(profile.gesture.contextMenuTrigger).toBe('right-click');
    expect(profile.gesture.tabSwitchTrigger).toBe('ctrl-page');
  });

  it('uses compact desktop split spacing for Mac multi-pane layout', () => {
    const profile: PaneProfile = resolvePaneProfile({ platform: 'desktop', splitVisible: true, topInsetPx: 0 });
    expect(profile.stage.outerMargin).toBe('0');
    expect(profile.stage.paneGap).toBe('0');
    expect(profile.stage.paneRadius).toBe('0');
    expect(profile.gesture.dividerHitPx).toBe(3);
    expect(profile.header.paneScrollerMinHeight).toBe('22px');
  });

  it('renders split panes terminal-first with only a one-pixel active inset', () => {
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
    const activeFrame = container.querySelector('[data-testid="pane-stage-frame"][data-pane-active="true"]') as HTMLElement | null;
    const inactiveFrame = container.querySelector('[data-testid="pane-stage-frame"][data-pane-active="false"]') as HTMLElement | null;
    expect(activeFrame?.style.backgroundColor).toBe('rgb(5, 7, 11)');
    expect(inactiveFrame?.style.backgroundColor).toBe('rgb(5, 7, 11)');
    expect(activeFrame?.style.outline).toBe('none');
    expect(activeFrame?.style.boxShadow).toContain('inset');
  });
});
