// @vitest-environment jsdom
/**
 * mac-4.0.c 红测：MacAppShell layout 组合 (header + PaneWorkbench)
 *
 * 验证：
 * - MacAppShell 渲染 header + PaneWorkbench
 * - 单 pane mode → [data-testid="pane-stage-single"]
 * - split mode → [data-testid="pane-stage-split"]
 * - 顶栏 Split 按钮在 pane 数 >= 4 时禁用
 * - 顶栏 + Tab 按钮触发 setWorkbench appendEmptyTab
 * - active pane state 在 split mode 下从 workbench.workspace.activePaneId 读取
 *
 * mac-2 接入 shared 后会转绿。
 */

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MacAppShell } from './MacAppShell';
import { openConnectionInWorkbench, splitActivePaneRight, createInitialWorkbenchState, type MacWorkbenchState } from './workbench';

vi.mock('../lib/terminal-runtime', () => ({
  createTerminalRuntime: () => ({
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
  }),
  useTerminalRuntimeState: () => ({
    connection: { status: 'idle', error: '', connectedSessionId: '', title: '', activeTarget: null } as any,
    buffer: { canonicalBuffer: {} as any, renderBuffer: { lines: [], cols: 80, rows: 24 } as any },
    render: { lines: [], cols: 80, rows: 24 } as any,
    schedule: { jobs: [], loading: false } as any,
    head: null,
  }),
}));
import type { EditableHost, Host, BridgeSettings } from '@zterm/shared';

vi.mock('./MacPaneWorkbench', () => ({
  MacPaneWorkbench: ({ workbench, splitVisible, platform }: { workbench: MacWorkbenchState; splitVisible: boolean; platform: string }) => {
    const frames = workbench.workspace.panes.map((p, i) => (
      <div
        key={p.id}
        data-testid="pane-stage-frame"
        data-pane-id={p.id}
        data-pane-active={p.id === workbench.workspace.activePaneId ? 'true' : 'false'}
        data-pane-index={i}
      />
    ));
    return (
      <main data-testid={splitVisible ? 'pane-stage-split' : 'pane-stage-single'} data-platform={platform}>
        {frames}
      </main>
    );
  },
}));

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

function renderShell(initialState: MacWorkbenchState) {
  const setWorkbench = vi.fn();
  return {
    setWorkbench,
    ...render(
      // @ts-expect-error partial props
      <MacAppShell
        hosts={[makeHost('h1', 'host-a')]}
        isLoaded={true}
        bridgeSettings={makeBridgeSettings()}
        setBridgeSettings={vi.fn() as any}
        addHost={vi.fn() as any}
        updateHost={vi.fn()}
        __initialWorkbench={initialState}
        __workbenchSetter={setWorkbench}
      />,
    ),
  };
}

describe('MacAppShell layout (red baseline)', () => {
  it('renders header + single-pane stage when only one pane', () => {
    const { container } = renderShell(createInitialWorkbenchState());
    expect(container.querySelector('.mac-shell-header')).toBeTruthy();
    expect(container.querySelector('[data-testid="pane-stage-single"]')).toBeTruthy();
  });

  it('renders split stage after splitActivePaneRight', () => {
    let state = createInitialWorkbenchState();
    state = openConnectionInWorkbench(state, makeTarget('a'));
    state = splitActivePaneRight(state);
    const { container } = renderShell(state);
    expect(container.querySelector('[data-testid="pane-stage-split"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="pane-stage-frame"]').length).toBe(2);
  });

  it('Split 按钮在 4 panes 时禁用', () => {
    let state = createInitialWorkbenchState();
    state = openConnectionInWorkbench(state, makeTarget('a'));
    state = splitActivePaneRight(state);
    state = splitActivePaneRight(state);
    state = splitActivePaneRight(state);
    // 此时 panes=4
    const { container } = renderShell(state);
    const splitBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent && b.textContent.includes('Split'),
    ) as HTMLButtonElement | undefined;
    expect(splitBtn).toBeTruthy();
    expect(splitBtn!.disabled).toBe(true);
  });

  it('Split 按钮在 <4 panes 时启用', () => {
    let state = createInitialWorkbenchState();
    state = openConnectionInWorkbench(state, makeTarget('a'));
    state = splitActivePaneRight(state);
    // 此时 panes=2
    const { container } = renderShell(state);
    const splitBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent && b.textContent.includes('Split'),
    ) as HTMLButtonElement | undefined;
    expect(splitBtn).toBeTruthy();
    expect(splitBtn!.disabled).toBe(false);
  });

  it('active pane data-pane-active=true 在 pane-stage-frame 级别唯一', () => {
    let state = createInitialWorkbenchState();
    state = openConnectionInWorkbench(state, makeTarget('a'));
    state = splitActivePaneRight(state);
    state = openConnectionInWorkbench(state, makeTarget('b'));
    const { container } = renderShell(state);
    const active = container.querySelectorAll('[data-testid="pane-stage-frame"][data-pane-active="true"]');
    expect(active.length).toBe(1);
  });
});