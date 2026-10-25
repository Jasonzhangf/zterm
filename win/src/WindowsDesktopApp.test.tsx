// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createSessionBufferState } from '@zterm/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WindowsDesktopApp } from './WindowsDesktopApp';
import { WindowsConnectionStateIndicator } from './WindowsStatusBar';
import { createWindowsWorkspaceState, openWindowsWorkspaceTab } from './windows-workspace';

const ensureMock = vi.fn();
const retainMock = vi.fn();
const disposeMock = vi.fn();
const getMock = vi.fn(() => null);
type ControlSnapshot = { status: 'idle' | 'loading' | 'error'; error: string; sessions: string[] };
const createControlSnapshot = (): ControlSnapshot => ({ status: 'idle', error: '', sessions: ['alpha', 'beta'] });
let controlSnapshot: ControlSnapshot = createControlSnapshot();
const controlListeners = new Set<() => void>();
function publishControlSnapshot(next: Partial<ControlSnapshot>) {
  controlSnapshot = { ...controlSnapshot, ...next };
  controlListeners.forEach((listener) => listener());
}
const refreshMock = vi.fn(async () => controlSnapshot.sessions);
const createMock = vi.fn(async () => controlSnapshot.sessions);
const closeMock = vi.fn(async () => controlSnapshot.sessions);

vi.mock('./windows-terminal-registry', () => ({
  createWindowsTerminalRegistry: () => ({
    ensure: ensureMock,
    get: getMock,
    release: vi.fn(),
    retain: retainMock,
    dispose: disposeMock,
  }),
}));

vi.mock('./windows-terminal-session', async () => {
  const actual = await vi.importActual<typeof import('./windows-terminal-session')>('./windows-terminal-session');
  return {
    ...actual,
    createWindowsSessionControl: () => ({
      getSnapshot: () => controlSnapshot,
      subscribe: (listener: () => void) => {
        controlListeners.add(listener);
        return () => controlListeners.delete(listener);
      },
      refresh: refreshMock,
      create: createMock,
      close: closeMock,
    }),
  };
});

beforeEach(() => {
  window.localStorage.clear();
  (window as any).ztermWindows = { platform: 'test' };
  ensureMock.mockClear();
  retainMock.mockClear();
  disposeMock.mockClear();
  getMock.mockReset();
  getMock.mockReturnValue(null);
  controlSnapshot = createControlSnapshot();
  controlListeners.clear();
  refreshMock.mockReset();
  refreshMock.mockImplementation(async () => controlSnapshot.sessions);
  createMock.mockReset();
  createMock.mockImplementation(async () => controlSnapshot.sessions);
  closeMock.mockReset();
  closeMock.mockImplementation(async () => controlSnapshot.sessions);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete (window as any).ztermWindows;
});

type WindowsSessionStatus = 'idle' | 'connecting' | 'connected' | 'error';

function sessionStub(initialStatus: WindowsSessionStatus) {
  const listeners = new Set<() => void>();
  const buildSnapshot = (status: WindowsSessionStatus) => ({
    status,
    error: status === 'error' ? 'boom' : '',
    sessionId: 'stub-session',
    buffer: createSessionBufferState({ lines: [], cols: 80, rows: 24, cacheLines: 3000, revision: 1 }),
  });
  let snapshot = buildSnapshot(initialStatus);
  const session = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
    sendInput: vi.fn(() => true),
    requestVisibleRange: vi.fn(() => true),
    dispose: vi.fn(),
  };
  return {
    session,
    setStatus(next: WindowsSessionStatus) {
      snapshot = buildSnapshot(next);
      listeners.forEach((listener) => listener());
    },
  };
}

describe('WindowsDesktopApp pane/session UX', () => {
  it('opens a session-list row directly into the active pane', async () => {
    render(<WindowsDesktopApp />);

    fireEvent.click(screen.getByRole('button', { name: 'beta' }));

    await waitFor(() => expect(screen.getAllByText('beta').length).toBeGreaterThan(0));
    await waitFor(() => expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'beta' })));
  });

  it('lets an empty split pane choose a session from the session list', async () => {
    const { container } = render(<WindowsDesktopApp />);

    fireEvent.click(screen.getByTitle('连接设置'));
    fireEvent.click(screen.getByRole('button', { name: '空分屏' }));
    expect(container.querySelectorAll('[data-testid="pane-stage-frame"]')).toHaveLength(2);
    const emptyPaneButton = container.querySelector('[data-testid^="windows-empty-pane-select-"]') as HTMLButtonElement;
    expect(emptyPaneButton).toBeTruthy();
    fireEvent.click(emptyPaneButton);
    fireEvent.click(screen.getByRole('button', { name: 'alpha' }));

    await waitFor(() => expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'alpha' })));
    expect(container.querySelectorAll('[data-testid="pane-stage-frame"]')).toHaveLength(2);
  });

  it('exposes an iTerm2-style split control and pane tab add button', async () => {
    const { container } = render(<WindowsDesktopApp />);

    expect(screen.getByTestId('windows-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('windows-split-new-session')).toBeEnabled();
    expect(screen.getByTestId('windows-split-current-tab')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'alpha' }));
    await waitFor(() => expect(screen.getByTestId('windows-split-current-tab')).toBeEnabled());
    expect(container.querySelector('[data-testid^="pane-plus-"]')).toBeTruthy();
    fireEvent.click(container.querySelector('[data-testid^="pane-plus-"]')!);

    expect(container.querySelector('[data-testid^="windows-empty-pane-select-"]')).toBeTruthy();
  });

  it('filters session catalog rows from the sidebar', async () => {
    render(<WindowsDesktopApp />);

    expect(screen.getByRole('button', { name: 'alpha' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'beta' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('搜索 Session'), { target: { value: 'al' } });

    expect(screen.getByRole('button', { name: 'alpha' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'beta' })).not.toBeInTheDocument();
  });

  it('shows tab context menu actions for changing and moving sessions to numbered panes', async () => {
    const { container } = render(<WindowsDesktopApp />);
    fireEvent.click(screen.getByRole('button', { name: 'alpha' }));
    fireEvent.click(screen.getByRole('button', { name: '连接设置' }));
    fireEvent.click(screen.getByTitle('连接设置'));
    fireEvent.click(screen.getByRole('button', { name: '空分屏' }));

    await screen.findAllByTitle('Click: switch · Right-click: pane menu · Double-click: rename');
    const tab = screen.getAllByTitle('Click: switch · Right-click: pane menu · Double-click: rename')[0]!;
    fireEvent.contextMenu(tab, { clientX: 100, clientY: 200 });

    expect(screen.getByTestId('windows-pane-context-menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Change session' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Move to P2' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to P2' }));
    expect(screen.queryByTestId('windows-pane-context-menu')).not.toBeInTheDocument();
    expect(container.querySelectorAll('[data-testid="pane-stage-frame"]')).toHaveLength(2);
  });

  it('dismisses the tab context menu on Escape and outside pointer down', async () => {
    render(<WindowsDesktopApp />);
    fireEvent.click(screen.getByRole('button', { name: 'alpha' }));
    await waitFor(() => expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'alpha' })));
    const tab = screen.getAllByTitle('Click: switch · Right-click: pane menu · Double-click: rename')[0]!;

    fireEvent.contextMenu(tab, { clientX: 100, clientY: 200 });
    expect(screen.getByTestId('windows-pane-context-menu')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('windows-pane-context-menu')).not.toBeInTheDocument();

    fireEvent.contextMenu(tab, { clientX: 100, clientY: 200 });
    expect(screen.getByTestId('windows-pane-context-menu')).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('windows-pane-context-menu')).not.toBeInTheDocument();
  });

  it('dismisses the tab context menu when the referenced tab is closed', async () => {
    const { container } = render(<WindowsDesktopApp />);
    fireEvent.click(screen.getByRole('button', { name: 'alpha' }));
    await waitFor(() => expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'alpha' })));
    const tab = screen.getAllByTitle('Click: switch · Right-click: pane menu · Double-click: rename')[0]!;

    fireEvent.contextMenu(tab, { clientX: 100, clientY: 200 });
    expect(screen.getByTestId('windows-pane-context-menu')).toBeInTheDocument();
    fireEvent.click(container.querySelector('[data-testid^="pane-tab-close-"]')!);

    await waitFor(() => {
      expect(screen.queryByTestId('windows-pane-context-menu')).not.toBeInTheDocument();
    });
  });

  it('opens a scoped chooser before replacing a tab session', async () => {
    render(<WindowsDesktopApp />);
    fireEvent.click(screen.getByRole('button', { name: 'alpha' }));
    await waitFor(() => expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'alpha' })));

    const ensureCallsBeforeChange = ensureMock.mock.calls.length;
    const tab = screen.getAllByTitle('Click: switch · Right-click: pane menu · Double-click: rename')[0]!;
    fireEvent.contextMenu(tab, { clientX: 100, clientY: 200 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change session' }));

    expect(screen.queryByTestId('windows-pane-context-menu')).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: '连接设置' })).toBeInTheDocument();
    expect(ensureMock).toHaveBeenCalledTimes(ensureCallsBeforeChange);

    fireEvent.click(screen.getByRole('button', { name: 'beta' }));

    await waitFor(() => expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'beta' })));
    expect(screen.queryAllByTitle('Click: switch · Right-click: pane menu · Double-click: rename').map((node) => node.textContent).join('\n')).not.toContain('alpha');
  });

  it('opens the replacement chooser even when the current form target is invalid', async () => {
    render(<WindowsDesktopApp />);
    fireEvent.click(screen.getByRole('button', { name: 'alpha' }));
    await waitFor(() => expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'alpha' })));

    fireEvent.click(screen.getByRole('button', { name: '连接设置' }));
    fireEvent.change(screen.getByLabelText('主机'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    const tab = screen.getAllByTitle('Click: switch · Right-click: pane menu · Double-click: rename')[0]!;
    fireEvent.contextMenu(tab, { clientX: 100, clientY: 200 });
    const changeSession = screen.getByRole('menuitem', { name: 'Change session' });
    expect(changeSession).not.toBeDisabled();
    fireEvent.click(changeSession);

    expect(screen.getByRole('complementary', { name: '连接设置' })).toBeInTheDocument();
  });

  it('applies a scoped replacement from the primary connect button', async () => {
    render(<WindowsDesktopApp />);
    fireEvent.click(screen.getByRole('button', { name: 'alpha' }));
    await waitFor(() => expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'alpha' })));

    const tab = screen.getAllByTitle('Click: switch · Right-click: pane menu · Double-click: rename')[0]!;
    fireEvent.contextMenu(tab, { clientX: 100, clientY: 200 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change session' }));
    fireEvent.change(screen.getByLabelText('Session'), { target: { value: 'beta' } });
    fireEvent.click(screen.getByRole('button', { name: '连接' }));

    await waitFor(() => expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'beta' })));
    expect(screen.queryAllByTitle('Click: switch · Right-click: pane menu · Double-click: rename').map((node) => node.textContent).join('\n')).not.toContain('alpha');
  });

  it('cancels a scoped replacement intent when the chooser is dismissed', async () => {
    render(<WindowsDesktopApp />);
    fireEvent.click(screen.getByRole('button', { name: 'alpha' }));
    await waitFor(() => expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'alpha' })));

    const tab = screen.getAllByTitle('Click: switch · Right-click: pane menu · Double-click: rename')[0]!;
    fireEvent.contextMenu(tab, { clientX: 100, clientY: 200 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change session' }));
    expect(screen.getByRole('complementary', { name: '连接设置' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('complementary', { name: '连接设置' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '连接设置' }));
    fireEvent.click(screen.getByRole('button', { name: 'beta' }));

    await waitFor(() => expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'beta' })));
    expect(screen.getByText('alpha')).toBeInTheDocument();
  });

  it('opens the selected session when a pending replacement tab was closed', async () => {
    const { container } = render(<WindowsDesktopApp />);
    fireEvent.click(screen.getByRole('button', { name: 'alpha' }));
    await waitFor(() => expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'alpha' })));

    const tab = screen.getAllByTitle('Click: switch · Right-click: pane menu · Double-click: rename')[0]!;
    fireEvent.contextMenu(tab, { clientX: 100, clientY: 200 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change session' }));
    fireEvent.click(container.querySelector('[data-testid^="pane-tab-close-"]')!);

    await waitFor(() => expect(screen.getByText('New terminal')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'beta' }));

    await waitFor(() => expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'beta' })));
  });
});

describe('WindowsDesktopApp remote session close', () => {
  it('asks for one inline confirmation and cancels without a control close', () => {
    render(<WindowsDesktopApp />);

    fireEvent.click(screen.getByRole('button', { name: '关闭 alpha' }));

    expect(screen.getByTestId('windows-session-close-confirm-alpha')).toBeInTheDocument();
    expect(closeMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '取消关闭 alpha' }));

    expect(screen.queryByTestId('windows-session-close-confirm-alpha')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('windows-sidebar')).getByRole('button', { name: 'alpha' })).toBeInTheDocument();
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('confirms one exact remote close and closes every matching tab', async () => {
    render(<WindowsDesktopApp />);
    const sidebar = screen.getByTestId('windows-sidebar');
    fireEvent.click(within(sidebar).getByRole('button', { name: 'alpha' }));
    fireEvent.click(within(sidebar).getByRole('button', { name: 'alpha' }));
    await waitFor(() => expect(
      screen.getAllByTitle('Click: switch · Right-click: pane menu · Double-click: rename'),
    ).toHaveLength(2));

    fireEvent.click(within(sidebar).getByRole('button', { name: '关闭 alpha' }));
    fireEvent.click(screen.getByRole('button', { name: '确认关闭 alpha' }));

    await waitFor(() => expect(closeMock).toHaveBeenCalledTimes(1));
    expect(closeMock).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeHost: '127.0.0.1', bridgePort: 3333 }),
      'alpha',
    );
    await waitFor(() => expect(
      screen.getAllByTitle('Click: switch · Right-click: pane menu · Double-click: rename').map((node) => node.textContent).join('\n'),
    ).not.toContain('alpha'));
    expect(screen.getByText('New terminal')).toBeInTheDocument();
  });

  it('consumes a controller close rejection and renders the control error once in the sidebar', async () => {
    closeMock.mockImplementationOnce(async () => {
      publishControlSnapshot({ status: 'error', error: 'kill failed' });
      throw new Error('kill failed');
    });
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      render(<WindowsDesktopApp />);
      fireEvent.click(screen.getByRole('button', { name: '关闭 alpha' }));
      fireEvent.click(screen.getByRole('button', { name: '确认关闭 alpha' }));

      await waitFor(() => expect(screen.getByText('kill failed')).toBeInTheDocument());
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).toHaveLength(0);
      const errors = screen.getAllByText('kill failed');
      expect(errors).toHaveLength(1);
      expect(errors[0]!.closest('.windows-sidebar')).not.toBeNull();
      expect(screen.getByTestId('windows-statusbar').textContent).not.toContain('kill failed');
      expect(closeMock).toHaveBeenCalledTimes(1);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('renders session-control errors once in the sidebar, never in the status bar', async () => {
    render(<WindowsDesktopApp />);

    act(() => publishControlSnapshot({ status: 'error', error: 'refresh failed' }));

    await waitFor(() => expect(screen.getAllByText('refresh failed')).toHaveLength(1));
    expect(screen.getByText('refresh failed').closest('.windows-sidebar')).not.toBeNull();
    expect(screen.getByTestId('windows-statusbar').textContent).not.toContain('refresh failed');
  });

  it('clears a pending confirmation when the profile or session catalog changes', async () => {
    window.localStorage.setItem('zterm:windows:profiles.v1', JSON.stringify([
      { id: 'a', name: 'Alpha host', bridgeHost: '127.0.0.1', bridgePort: 3333, sessionName: 'zterm' },
      { id: 'b', name: 'Beta host', bridgeHost: '10.0.0.2', bridgePort: 4444, sessionName: 'zterm' },
    ]));
    window.localStorage.setItem('zterm:windows:active-profile.v1', 'a');
    render(<WindowsDesktopApp />);

    fireEvent.click(screen.getByRole('button', { name: '关闭 alpha' }));
    expect(screen.getByTestId('windows-session-close-confirm-alpha')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('radio')[1]!);
    await waitFor(() => expect(screen.queryByTestId('windows-session-close-confirm-alpha')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '关闭 alpha' }));
    expect(screen.getByTestId('windows-session-close-confirm-alpha')).toBeInTheDocument();
    act(() => publishControlSnapshot({ sessions: ['beta'] }));
    await waitFor(() => expect(screen.queryByTestId('windows-session-close-confirm-alpha')).not.toBeInTheDocument());
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('closes a local tab without a remote confirmation or control close', async () => {
    const { container } = render(<WindowsDesktopApp />);
    fireEvent.click(screen.getByRole('button', { name: 'alpha' }));
    await waitFor(() => expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'alpha' })));

    fireEvent.click(container.querySelector('[data-testid^="pane-tab-close-"]')!);

    await waitFor(() => expect(screen.getByText('New terminal')).toBeInTheDocument());
    expect(screen.queryByTestId('windows-session-close-confirm-alpha')).not.toBeInTheDocument();
    expect(closeMock).not.toHaveBeenCalled();
  });
});

describe('WindowsDesktopApp profile/statusbar', () => {
  it('shows an iTerm2-style profile/session sidebar and statusbar projection', async () => {
    render(<WindowsDesktopApp />);

    expect(screen.getByTestId('windows-sidebar')).toBeInTheDocument();
    expect(screen.getByText('Hosts')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('local', { selector: '.profile-row span' })).toBeInTheDocument();
    expect(screen.getByText('127.0.0.1:3333', { selector: '.profile-row span:last-child' })).toBeInTheDocument();
    expect(screen.getByTestId('windows-statusbar')).toBeInTheDocument();
    expect(screen.getByTestId('windows-statusbar').textContent).toContain('local');
    expect(screen.getByTestId('windows-statusbar').textContent).toContain('idle');
  });

  it('shows profile edits in the gear panel draft', async () => {
    render(<WindowsDesktopApp />);

    fireEvent.click(screen.getByTitle('连接设置'));
    fireEvent.change(screen.getByDisplayValue('local'), { target: { value: 'dev' } });
    fireEvent.change(screen.getByDisplayValue('127.0.0.1'), { target: { value: '10.0.0.2' } });
    fireEvent.change(screen.getByDisplayValue('3333'), { target: { value: '4444' } });
    fireEvent.change(screen.getByDisplayValue('zterm'), { target: { value: 'dev-shell' } });
    expect(screen.getByDisplayValue('dev')).toBeInTheDocument();
    expect(screen.getByDisplayValue('10.0.0.2')).toBeInTheDocument();
    expect(screen.getByDisplayValue('4444')).toBeInTheDocument();
    expect(screen.getByDisplayValue('dev-shell')).toBeInTheDocument();
  });

  it('persists the edited draft profile before connecting so projection matches the real target', async () => {
    render(<WindowsDesktopApp />);

    fireEvent.click(screen.getByTitle('连接设置'));
    fireEvent.change(screen.getByLabelText('主机'), { target: { value: '10.1.2.3' } });
    fireEvent.change(screen.getByLabelText('Session'), { target: { value: 'alpha' } });
    fireEvent.click(screen.getByRole('button', { name: '连接' }));

    await waitFor(() => expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'alpha',
      target: expect.objectContaining({ bridgeHost: '10.1.2.3', bridgePort: 3333, sessionName: 'alpha' }),
    })));
    expect(screen.queryByRole('complementary', { name: '连接设置' })).not.toBeInTheDocument();
    expect(screen.getByText('10.1.2.3:3333', { selector: '.profile-row span:last-child' })).toBeInTheDocument();
    expect(screen.getByTestId('windows-statusbar').textContent).toContain('10.1.2.3:3333');
  });

  it('blocks saving or connecting an invalid profile draft', () => {
    render(<WindowsDesktopApp />);

    fireEvent.click(screen.getByTitle('连接设置'));
    fireEvent.change(screen.getByLabelText('主机'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '连接' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '分屏连接' })).toBeDisabled();
    expect(screen.getByText('主机不能为空')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('主机'), { target: { value: '127.0.0.1' } });
    fireEvent.change(screen.getByLabelText('端口'), { target: { value: '70000' } });
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    expect(screen.getByText('端口必须是 1-65535 的整数')).toBeInTheDocument();
  });

  it('drives the titlebar connection state from the active tab session, not the profile', async () => {
    const target = { bridgeHost: '10.0.0.9', bridgePort: 3333, sessionName: 'alpha' };
    const workspace = openWindowsWorkspaceTab(createWindowsWorkspaceState(), target);
    const stub = sessionStub('connecting');
    const registry = {
      ensure: vi.fn(),
      get: vi.fn(() => stub.session),
      release: vi.fn(),
      retain: vi.fn(),
      dispose: vi.fn(),
    } as unknown as ReturnType<typeof import('./windows-terminal-registry').createWindowsTerminalRegistry>;

    render(<WindowsConnectionStateIndicator registry={registry} workspace={workspace} />);
    const indicator = screen.getByTestId('windows-connection-state');
    expect(indicator.getAttribute('data-status')).toBe('connecting');
    expect(indicator.className).toContain('connection-state--connecting');
    expect(indicator.textContent).toContain('alpha');

    stub.setStatus('connected');
    await waitFor(() => expect(screen.getByTestId('windows-connection-state').getAttribute('data-status')).toBe('connected'));
    expect(screen.getByTestId('windows-connection-state').className).toContain('connection-state--connected');
  });
});
