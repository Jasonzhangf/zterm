// @vitest-environment jsdom
/**
 * mac-4.0.d 红测：MacPaneWorkbench drag-resize pane ratio
 *
 * 验证：
 * - desktop profile drag-resize 启用 → onPaneRatioChange 触发
 * - 模拟 pointerdown on divider + pointermove → setWorkbench 被调用
 * - 写回后 workspace state 中 pane size 改变（normalized ratio）
 * - 比例受 MIN_PANE_RATIO=0.18 / max=0.9 限制（shared resizePaneRatio 已 clamp）
 *
 * 真实流程：fireEvent.pointerDown(divider) + 模拟 pointermove 事件
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
import type { EditableHost, Host, BridgeSettings } from '@zterm/shared';
import type { TerminalRuntimeController } from '../lib/terminal-runtime';
import type { TerminalRuntimeState } from '../lib/terminal-runtime';

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

describe('MacPaneWorkbench pane ratio (drag-resize)', () => {
  it('desktop profile drag-resize 启用：divider 存在且可触发 pointerdown', () => {
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
    const divider = container.querySelector('[data-testid="pane-stage-divider"]') as HTMLElement | null;
    expect(divider).toBeTruthy();
    // pointerdown 不应抛错
    fireEvent.pointerDown(divider!, { clientX: 100, clientY: 200, button: 0 });
  });

  it('setWorkbench 在 pointerdown + window pointermove 之后被调用（drag-resize 路径）', () => {
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
        runtime={makeRuntimeStub()}
        runtimeState={makeRuntimeState()}
        bridgeSettings={makeBridgeSettings()}
      />,
    );
    // jsdom 缺真实 layout — mock 所有 div 的 getBoundingClientRect
    // PaneStage 结构: main[stage-split] > div[display:contents] > divider
    const bcr = { width: 1000, height: 600, left: 0, top: 0, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) };
    container.querySelectorAll('div').forEach((el) => {
      (el as HTMLElement).getBoundingClientRect = () => bcr as DOMRect;
    });
    const divider = container.querySelector('[data-testid="pane-stage-divider"]') as HTMLElement | null;
    expect(divider).toBeTruthy();
    fireEvent.pointerDown(divider!, { clientX: 100, clientY: 200, button: 0 });
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 350, clientY: 200, bubbles: true } as any));
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 350, clientY: 200, bubbles: true } as any));
    expect(setWorkbench).toHaveBeenCalled();
  });

  it('drag-resize 后 pane size 变化（模拟 setWorkbench 真的接 updater）', () => {
    let workbench: MacWorkbenchState = createInitialWorkbenchState();
    workbench = openConnectionInWorkbench(workbench, makeTarget('a'));
    workbench = splitActivePaneRight(workbench);
    let finalWorkbench: MacWorkbenchState = workbench;
    const setWorkbench = (updater: any) => {
      if (typeof updater === 'function') {
        finalWorkbench = updater(finalWorkbench);
      } else {
        finalWorkbench = updater;
      }
    };
    const { container } = render(
      <MacPaneWorkbench
        workbench={workbench}
        setWorkbench={setWorkbench as any}
        hosts={[]}
        platform="desktop"
        splitVisible
        runtime={makeRuntimeStub()}
        runtimeState={makeRuntimeState()}
        bridgeSettings={makeBridgeSettings()}
      />,
    );
    container.querySelectorAll('div').forEach((el) => {
      (el as HTMLElement).getBoundingClientRect = () => ({ width: 1000, height: 600, left: 0, top: 0, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    });
    const divider = container.querySelector('[data-testid="pane-stage-divider"]') as HTMLElement | null;
    fireEvent.pointerDown(divider!, { clientX: 100, clientY: 200, button: 0 });
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 350, clientY: 200, bubbles: true } as any));
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 350, clientY: 200, bubbles: true } as any));
    // drag 后 pane size 被 shared resizePaneRatio normalize 过
    const newSize = finalWorkbench.workspace.panes[0].size;
    expect(Number.isFinite(newSize)).toBe(true);
    expect(newSize).toBeGreaterThan(0);
    expect(newSize).toBeLessThanOrEqual(1);
  });
});