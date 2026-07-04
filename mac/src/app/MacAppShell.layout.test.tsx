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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MacAppShell } from './MacAppShell';
import { openConnectionInWorkbench, splitActivePaneRight, createInitialWorkbenchState, type MacWorkbenchState } from './workbench';
import { buildBridgeServerPresetIdentityId } from '@zterm/shared';
import {
  LEGACY_SHELL_WORKSPACE_STORAGE_KEY,
  MAC_WORKSPACE_STORAGE_PREFIX,
} from './workspace/workspace-store';

const ensureRuntimeMock = vi.fn();
const setActiveRuntimeKeyMock = vi.fn();
const releaseRuntimeMock = vi.fn();
const disposeRegistryMock = vi.fn();
const { fetchLiveSnapshotMock } = vi.hoisted(() => ({
  fetchLiveSnapshotMock: vi.fn(),
}));

vi.mock('./runtime/MacRuntimeRegistry', () => ({
  createMacRuntimeRegistry: () => ({
    ensureRuntime: ensureRuntimeMock,
    getRuntime: vi.fn(() => null),
    getRuntimeState: vi.fn(() => ({
      connection: { status: 'idle', error: '', connectedSessionId: '', title: '', activeTarget: null } as any,
      buffer: { canonicalBuffer: {} as any, renderBuffer: { lines: [], cols: 80, rows: 24 } as any },
      render: { lines: [], cols: 80, rows: 24 } as any,
      schedule: { jobs: [], loading: false } as any,
      head: null,
    })),
    subscribeRuntime: vi.fn(() => () => {}),
    getActiveRuntimeKey: vi.fn(() => null),
    subscribeActiveRuntimeKey: vi.fn(() => () => {}),
    setActiveRuntimeKey: setActiveRuntimeKeyMock,
    sendInput: vi.fn(() => true),
    updateViewport: vi.fn(() => true),
    resizeTerminal: vi.fn(() => true),
    disposeRuntime: vi.fn(),
    releaseRuntime: releaseRuntimeMock,
    dispose: disposeRegistryMock,
  }),
  useMacRuntimeState: () => ({
    connection: { status: 'idle', error: '', connectedSessionId: '', title: '', activeTarget: null } as any,
    buffer: { canonicalBuffer: {} as any, renderBuffer: { lines: [], cols: 80, rows: 24 } as any },
    render: { lines: [], cols: 80, rows: 24 } as any,
    schedule: { jobs: [], loading: false } as any,
    head: null,
  }),
}));
vi.mock('./server-directory/MacServerDirectory', async () => {
  const actual = await vi.importActual<typeof import('./server-directory/MacServerDirectory')>('./server-directory/MacServerDirectory');
  return {
    ...actual,
    fetchMacServerDirectoryLiveSessionSnapshot: fetchLiveSnapshotMock,
  };
});
import type { EditableHost, Host, BridgeSettings } from '@zterm/shared';

vi.mock('./MacPaneWorkbench', () => ({
  MacPaneWorkbench: ({ workbench, splitVisible, platform, runtimeRegistry }: { workbench: MacWorkbenchState; splitVisible: boolean; platform: string; runtimeRegistry: unknown }) => {
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
      <main
        data-testid={splitVisible ? 'pane-stage-split' : 'pane-stage-single'}
        data-platform={platform}
        data-has-runtime-registry={runtimeRegistry ? 'true' : 'false'}
      >
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
  const serverId = buildBridgeServerPresetIdentityId('127.0.0.1', 3333);
  return {
    defaultServerId: serverId,
    servers: [
      {
        id: serverId,
        name: 'Local daemon',
        targetHost: '127.0.0.1',
        targetPort: 3333,
        authToken: 'token-a',
      },
    ],
    targetHost: '127.0.0.1',
    targetPort: 3333,
    targetAuthToken: 'token-a',
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

beforeEach(() => {
  (window as any).ztermMac = {
    windowManager: {
      createWindow: vi.fn().mockResolvedValue({ ok: true, windowId: 'window-new' }),
    },
    localTmux: {
      listSessions: vi.fn().mockResolvedValue([]),
    },
  };
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete (window as any).ztermMac;
  ensureRuntimeMock.mockClear();
  setActiveRuntimeKeyMock.mockClear();
  releaseRuntimeMock.mockClear();
  disposeRegistryMock.mockClear();
  fetchLiveSnapshotMock.mockReset();
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
    expect(container.querySelector('[data-testid="mac-server-directory"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="pane-stage-single"]')).toBeTruthy();
    expect(container.querySelector('[data-has-runtime-registry="true"]')).toBeTruthy();
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

  it('ensures runtime registry targets for live tabs and marks the active runtime', () => {
    let state = createInitialWorkbenchState();
    state = openConnectionInWorkbench(state, makeTarget('a'));
    state = openConnectionInWorkbench(state, makeTarget('b'), { append: true });
    renderShell(state);

    expect(ensureRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'remote',
      runtimeKey: 'remote:127.0.0.1:3333:a',
    }));
    expect(ensureRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'remote',
      runtimeKey: 'remote:127.0.0.1:3333:b',
    }));
    expect(setActiveRuntimeKeyMock).toHaveBeenCalledWith('remote:127.0.0.1:3333:b');
  });

  it('renders server directory saved sessions without opening tabs during projection', () => {
    const setBridgeSettings = vi.fn();
    const addHost = vi.fn();
    const { container } = render(
      <MacAppShell
        hosts={[makeHost('h1', 'host-a'), makeHost('h2', 'host-b')]}
        isLoaded={true}
        bridgeSettings={makeBridgeSettings()}
        setBridgeSettings={setBridgeSettings as any}
        addHost={addHost as any}
        updateHost={vi.fn()}
        __initialWorkbench={createInitialWorkbenchState()}
      />,
    );

    expect(container.querySelector('[data-testid="mac-server-directory"]')?.textContent).toContain('host-a');
    expect(container.querySelector('[data-testid="mac-server-directory"]')?.textContent).toContain('host-b');
    expect(ensureRuntimeMock).not.toHaveBeenCalled();
    expect(addHost).not.toHaveBeenCalled();
    expect(setBridgeSettings).not.toHaveBeenCalled();
  });

  it('opens a server directory session only after explicit click', () => {
    const { container } = render(
      <MacAppShell
        hosts={[makeHost('h1', 'host-a')]}
        isLoaded={true}
        bridgeSettings={makeBridgeSettings()}
        setBridgeSettings={vi.fn() as any}
        addHost={vi.fn() as any}
        updateHost={vi.fn()}
        __initialWorkbench={createInitialWorkbenchState()}
      />,
    );

    const sessionButton = Array.from(container.querySelectorAll('.mac-server-session-button')).find((button) =>
      button.textContent?.includes('host-a'),
    ) as HTMLButtonElement | undefined;
    expect(sessionButton).toBeTruthy();
    fireEvent.click(sessionButton!);
    expect(ensureRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'remote',
      runtimeKey: 'remote:h1:host-a',
    }));
  });

  it('persists workbench identity by renderer windowId without writing legacy shell storage', () => {
    let state = createInitialWorkbenchState();
    state = openConnectionInWorkbench(state, makeTarget('a'));
    render(
      <MacAppShell
        windowId="window-a"
        hosts={[makeHost('h1', 'host-a')]}
        isLoaded={true}
        bridgeSettings={makeBridgeSettings()}
        setBridgeSettings={vi.fn() as any}
        addHost={vi.fn() as any}
        updateHost={vi.fn()}
        __initialWorkbench={state}
      />,
    );

    expect(window.localStorage.getItem(`${MAC_WORKSPACE_STORAGE_PREFIX}window-a`)).toBeNull();
    cleanup();

    render(
      <MacAppShell
        windowId="window-a"
        hosts={[makeHost('h1', 'host-a')]}
        isLoaded={true}
        bridgeSettings={makeBridgeSettings()}
        setBridgeSettings={vi.fn() as any}
        addHost={vi.fn() as any}
        updateHost={vi.fn()}
      />,
    );
    fireEvent.click(Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('+ Tab'))!);

    const stored = JSON.parse(window.localStorage.getItem(`${MAC_WORKSPACE_STORAGE_PREFIX}window-a`) || '{}');
    expect(stored.windowId).toBe('window-a');
    expect(stored.panes[0].tabs.length).toBe(2);
    expect(stored.panes[0].tabs.every((tab: { runtimeState?: unknown }) => tab.runtimeState === undefined)).toBe(true);
    expect(window.localStorage.getItem(LEGACY_SHELL_WORKSPACE_STORAGE_KEY)).toBeNull();
  });

  it('routes New Window button through the Mac window owner IPC bridge', () => {
    const { container } = renderShell(createInitialWorkbenchState());
    const newWindowButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('New Window'),
    ) as HTMLButtonElement | undefined;

    expect(newWindowButton).toBeTruthy();
    fireEvent.click(newWindowButton!);

    expect((window as any).ztermMac.windowManager.createWindow).toHaveBeenCalledTimes(1);
  });

  it('opens the local file browser only from an explicit shell command without touching runtime connect', () => {
    const { container } = renderShell(createInitialWorkbenchState());
    const filesButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Files'),
    ) as HTMLButtonElement | undefined;

    expect(filesButton).toBeTruthy();
    fireEvent.click(filesButton!);

    expect(container.querySelector('[data-testid="mac-file-browser-panel"]')).toBeTruthy();
    expect(ensureRuntimeMock).not.toHaveBeenCalled();
  });

  it('refreshes one server directory group into live session projection without opening workspace tabs', async () => {
    const serverId = buildBridgeServerPresetIdentityId('127.0.0.1', 3333);
    fetchLiveSnapshotMock.mockResolvedValue({
      serverId,
      sessionNames: ['remote-live-a', 'remote-live-b'],
    });
    const addHost = vi.fn();
    const setBridgeSettings = vi.fn();
    const { container, findByText } = render(
      <MacAppShell
        hosts={[makeHost('h1', 'host-a')]}
        isLoaded={true}
        bridgeSettings={makeBridgeSettings()}
        setBridgeSettings={setBridgeSettings as any}
        addHost={addHost as any}
        updateHost={vi.fn()}
        __initialWorkbench={createInitialWorkbenchState()}
      />,
    );

    const refreshButton = container.querySelector(`[data-testid="mac-server-refresh-${serverId}"]`) as HTMLButtonElement | null;
    expect(refreshButton).toBeTruthy();
    fireEvent.click(refreshButton!);

    expect(await findByText('remote-live-a')).toBeTruthy();
    expect(container.querySelector('[data-session-name="remote-live-b"]')).toBeTruthy();
    expect(fetchLiveSnapshotMock).toHaveBeenCalledTimes(1);
    expect(addHost).not.toHaveBeenCalled();
    expect(setBridgeSettings).not.toHaveBeenCalled();
    expect(ensureRuntimeMock).not.toHaveBeenCalled();
  });

  it('shows server refresh errors without clearing saved open sessions or converting failure to empty success', async () => {
    const serverId = buildBridgeServerPresetIdentityId('127.0.0.1', 3333);
    fetchLiveSnapshotMock.mockRejectedValue(new Error('daemon refused list-sessions'));
    const state = openConnectionInWorkbench(createInitialWorkbenchState(), makeTarget('host-a'));
    ensureRuntimeMock.mockClear();
    const { container, findByText } = render(
      <MacAppShell
        hosts={[makeHost('h1', 'host-a')]}
        isLoaded={true}
        bridgeSettings={makeBridgeSettings()}
        setBridgeSettings={vi.fn() as any}
        addHost={vi.fn() as any}
        updateHost={vi.fn()}
        __initialWorkbench={state}
      />,
    );
    ensureRuntimeMock.mockClear();

    const refreshButton = container.querySelector(`[data-testid="mac-server-refresh-${serverId}"]`) as HTMLButtonElement | null;
    expect(refreshButton).toBeTruthy();
    fireEvent.click(refreshButton!);

    expect(await findByText('daemon refused list-sessions')).toBeTruthy();
    expect(container.querySelector('[data-session-name="host-a"]')).toBeTruthy();
    expect(container.querySelector('[data-session-name="host-a"]')?.textContent).toContain('open');
    expect(container.querySelector('[data-session-name="remote-live-a"]')).toBeNull();
    expect(ensureRuntimeMock).not.toHaveBeenCalled();
  });
});
