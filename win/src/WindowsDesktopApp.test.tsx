// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WindowsDesktopApp } from './WindowsDesktopApp';

const ensureMock = vi.fn();
const retainMock = vi.fn();
const disposeMock = vi.fn();
const controlSnapshot = {
  status: 'idle' as const,
  error: '',
  sessions: ['alpha', 'beta'],
};

vi.mock('./windows-terminal-registry', () => ({
  createWindowsTerminalRegistry: () => ({
    ensure: ensureMock,
    get: vi.fn(() => null),
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
      subscribe: () => () => undefined,
      refresh: vi.fn(async () => controlSnapshot.sessions),
      create: vi.fn(async () => controlSnapshot.sessions),
      close: vi.fn(async () => controlSnapshot.sessions),
    }),
  };
});

beforeEach(() => {
  window.localStorage.clear();
  (window as any).ztermWindows = { platform: 'test' };
  ensureMock.mockClear();
  retainMock.mockClear();
  disposeMock.mockClear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete (window as any).ztermWindows;
});

describe('WindowsDesktopApp pane/session UX', () => {
  it('opens a session-list row directly into the active pane', async () => {
    render(<WindowsDesktopApp />);

    fireEvent.click(screen.getByRole('button', { name: 'beta' }));

    await waitFor(() => expect(screen.getAllByText('beta').length).toBeGreaterThan(0));
    await waitFor(() => expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'beta' })));
  });

  it('lets an empty split pane choose a session from the session list', async () => {
    const { container } = render(<WindowsDesktopApp />);

    fireEvent.click(screen.getByRole('button', { name: '空分屏' }));
    expect(container.querySelectorAll('[data-testid="pane-stage-frame"]')).toHaveLength(2);
    const emptyPaneButton = container.querySelector('[data-testid^="windows-empty-pane-select-"]') as HTMLButtonElement;
    expect(emptyPaneButton).toBeTruthy();
    fireEvent.click(emptyPaneButton);
    fireEvent.click(screen.getByRole('button', { name: 'alpha' }));

    await waitFor(() => expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'alpha' })));
    expect(container.querySelectorAll('[data-testid="pane-stage-frame"]')).toHaveLength(2);
  });

  it('shows tab context menu actions for changing and moving sessions to numbered panes', async () => {
    const { container } = render(<WindowsDesktopApp />);
    fireEvent.click(screen.getByRole('button', { name: 'alpha' }));
    fireEvent.click(screen.getByRole('button', { name: '连接设置' }));
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
    expect(screen.queryByText('alpha')).not.toBeInTheDocument();
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
    expect(screen.queryByText('alpha')).not.toBeInTheDocument();
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
    expect(screen.queryByRole('complementary', { name: '连接设置' })).not.toBeInTheDocument();
  });
});
