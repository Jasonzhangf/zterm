// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalSessionDrawer } from './TerminalSessionDrawer';
import {
  TERMINAL_SESSION_DRAWER_ROW_MIN_HEIGHT_PX,
  TERMINAL_SESSION_DRAWER_ROW_SUBTITLE_FONT_SIZE_PX,
  TERMINAL_SESSION_DRAWER_ROW_TITLE_FONT_SIZE_PX,
  terminalSessionDrawerHiddenRestoreTestId,
} from './TerminalSessionDrawerContent';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('TerminalSessionDrawer', () => {
  const sessions = [
    {
      id: 's1',
      stableKey: 'stable-s1',
      title: 'demo',
      subtitle: '100.127.23.27:3333 · demo',
      status: 'connected' as const,
      paneLabel: 'P1',
      active: true,
    },
    {
      id: 's2',
      stableKey: 'stable-s2',
      title: 'android',
      subtitle: '100.66.1.82:3333 · android',
      status: 'connecting' as const,
      paneLabel: 'P2',
      active: false,
    },
  ];

  function confirmNewSession(sessionName = 'work-api', cwd = '~/code/api') {
    fireEvent.change(screen.getByLabelText('新 session 名称'), {
      target: { value: sessionName },
    });
    fireEvent.change(screen.getByLabelText('新 session 启动路径'), {
      target: { value: cwd },
    });
    fireEvent.click(screen.getByText('创建'));
  }

  it('uses the readable Operate-mode drawer width', () => {
    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    expect(screen.getByTestId('terminal-session-drawer').style.width).toBe('78vw');
    expect(screen.getByTestId('terminal-session-drawer').style.maxWidth).toBe('312px');
    expect(Number(screen.getByTestId('terminal-session-drawer').style.zIndex)).toBeGreaterThan(140);
    expect(Number(screen.getByTestId('terminal-session-drawer-overlay').style.zIndex)).toBeGreaterThan(140);
  });

  it('uses a full-surface overlay without inherited compact button height', () => {
    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    const overlay = screen.getByTestId('terminal-session-drawer-overlay');
    expect(overlay.tagName).toBe('BUTTON');
    expect(overlay.style.position).toBe('absolute');
    expect(overlay.style.inset).toBe('0px');
    expect(overlay.style.height).toBe('auto');
  });

  it.each(['light', 'blue', 'black'] as const)('projects the %s shell skin onto the drawer surface', (skin) => {
    render(
      <TerminalSessionDrawer
        open
        terminalShellSkin={skin}
        sessions={sessions}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    const drawer = screen.getByTestId('terminal-session-drawer');
    expect(drawer.getAttribute('data-terminal-shell-skin')).toBe(skin);
    expect(drawer.classList.contains('zterm-neo-drawer')).toBe(true);
  });

  it('uses one compact header row without tutorial copy', () => {
    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    expect(screen.getByTestId('terminal-session-drawer-header').style.display).toBe('flex');
    expect(screen.getByText('会话')).toBeTruthy();
    expect(screen.queryByText('快速切换')).toBeNull();
    expect(screen.queryByText('左滑收起，点击进入，上下滑动浏览。')).toBeNull();
  });

  it('keeps the narrow drawer header and session rows dense without text overflow', () => {
    render(
      <TerminalSessionDrawer
        open
        topInsetPx={24}
        sessions={sessions}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    const header = screen.getByTestId('terminal-session-drawer-header');
    expect(header.style.paddingTop).toBe('28px');
    expect(header.style.paddingBottom).toBe('6px');
    expect(screen.getByTestId('terminal-session-drawer-close').style.width).toBe('40px');
    expect(screen.getByTestId('terminal-session-drawer-close').style.height).toBe('40px');
    expect(screen.getByTestId('terminal-session-drawer-close').style.borderStyle).toBe('none');
    expect(screen.getByTestId('terminal-session-drawer-close').querySelector('svg')).toBeTruthy();

    const row = screen.getByTestId('terminal-session-drawer-row-s1');
    const select = within(row).getByTestId('terminal-session-drawer-select-s1');
    expect(row.style.minHeight).toBe(`${TERMINAL_SESSION_DRAWER_ROW_MIN_HEIGHT_PX}px`);
    expect(select.style.minHeight).toBe(`${TERMINAL_SESSION_DRAWER_ROW_MIN_HEIGHT_PX}px`);
    expect(select.style.paddingRight).toBe('4px');

    const title = within(select).getByText('demo');
    const subtitle = within(select).getByText('100.127.23.27:3333 · demo');
    expect(title.style.fontSize).toBe(`${TERMINAL_SESSION_DRAWER_ROW_TITLE_FONT_SIZE_PX}px`);
    expect(title.style.whiteSpace).toBe('nowrap');
    expect(title.style.overflow).toBe('hidden');
    expect(title.style.textOverflow).toBe('ellipsis');
    expect(subtitle.style.fontSize).toBe(`${TERMINAL_SESSION_DRAWER_ROW_SUBTITLE_FONT_SIZE_PX}px`);
    expect(subtitle.style.whiteSpace).toBe('nowrap');
    expect(subtitle.style.overflow).toBe('hidden');
    expect(subtitle.style.textOverflow).toBe('ellipsis');
    expect(screen.getByTestId('terminal-session-drawer-close-s1').style.borderStyle).toBe('none');
    expect(screen.getByTestId('terminal-session-drawer-close-s1').querySelector('svg')).toBeTruthy();
  });

  it('renders a single-column session list and routes select/plus actions', () => {
    const onSelectSession = vi.fn();
    const onOpenQuickTabPicker = vi.fn();

    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        onClose={vi.fn()}
        onSelectSession={onSelectSession}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={onOpenQuickTabPicker}
      />,
    );

    fireEvent.click(screen.getByTestId('terminal-session-drawer-select-s2'));
    expect(onSelectSession).toHaveBeenCalledWith('s2');
    expect(onSelectSession).toHaveBeenCalledTimes(1);

    fireEvent.touchEnd(screen.getByTestId('terminal-session-drawer-add'), {
      changedTouches: [{ clientX: 180, clientY: 560 }],
    });
    expect(screen.getByTestId('terminal-session-drawer-new-session-dialog')).toBeTruthy();
    expect(onOpenQuickTabPicker).not.toHaveBeenCalled();
  });

  it('renders sessions under an active folder and lets other folders expand on demand', () => {
    const folderSessions = [
      { ...sessions[0], cwd: '/Users/jason/projects/active' },
      { ...sessions[1], cwd: '/Users/jason/projects/other' },
    ];
    render(
      <TerminalSessionDrawer
        open
        sessions={folderSessions}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    expect(screen.getByTestId('terminal-session-drawer-folder-button-/Users/jason/projects/active').textContent)
      .toContain('active');
    expect(screen.getByTestId('terminal-session-drawer-tree').getAttribute('role')).toBe('tree');
    expect(screen.getByTestId('terminal-session-drawer-folder-button-/Users/jason/projects/active').getAttribute('data-tree-level')).toBe('2');
    expect(screen.getByTestId('terminal-session-drawer-row-s1').getAttribute('data-tree-level')).toBe('3');
    expect(screen.getByTestId('terminal-session-drawer-row-s1')).toBeTruthy();
    expect(screen.queryByTestId('terminal-session-drawer-row-s2')).toBeNull();

    fireEvent.click(screen.getByTestId('terminal-session-drawer-folder-button-/Users/jason/projects/other'));
    expect(screen.getByTestId('terminal-session-drawer-row-s2')).toBeTruthy();
    expect(screen.queryByTestId('terminal-session-drawer-row-s1')).toBeNull();
  });

  it('closes the folder menu from the scrim or Escape without a preview action', () => {
    render(
      <TerminalSessionDrawer
        open
        sessions={[{ ...sessions[0], cwd: '/Users/jason/projects/zterm' }]}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    const folderButton = screen.getByTestId('terminal-session-drawer-folder-button-/Users/jason/projects/zterm');
    fireEvent.contextMenu(folderButton, { clientX: 80, clientY: 160 });
    expect(screen.getByTestId('terminal-session-drawer-folder-menu')).toBeTruthy();
    fireEvent.click(screen.getByTestId('terminal-session-drawer-folder-menu-scrim'));
    expect(screen.queryByTestId('terminal-session-drawer-folder-menu')).toBeNull();

    fireEvent.contextMenu(folderButton, { clientX: 80, clientY: 160 });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('terminal-session-drawer-folder-menu')).toBeNull();

    expect(screen.queryByTestId('terminal-session-drawer-folder-menu')).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '预览' })).toBeNull();
  });

  it('does not route folder long press into preview mode', async () => {
    vi.useFakeTimers();
    render(
      <TerminalSessionDrawer
        open
        sessions={[{ ...sessions[0], cwd: '/Users/jason/projects/zterm' }]}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    const folderButton = screen.getByTestId('terminal-session-drawer-folder-button-/Users/jason/projects/zterm');
    fireEvent.pointerDown(folderButton, { pointerId: 1, pointerType: 'touch' });
    await act(async () => {
      vi.advanceTimersByTime(420);
    });

    expect(screen.queryByTestId('terminal-session-drawer-folder-menu')).toBeNull();
    fireEvent.pointerUp(folderButton, { pointerId: 1, pointerType: 'touch' });
    vi.useRealTimers();
  });

  it('keeps folder long-press inert even when the pointer moves before the threshold', async () => {
    vi.useFakeTimers();
    render(
      <TerminalSessionDrawer
        open
        sessions={[{ ...sessions[0], cwd: '/Users/jason/projects/zterm' }]}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    const folderButton = screen.getByTestId('terminal-session-drawer-folder-button-/Users/jason/projects/zterm');
    fireEvent.pointerDown(folderButton, { pointerId: 1, pointerType: 'touch' });
    fireEvent.pointerMove(folderButton, { pointerId: 1, pointerType: 'touch' });
    await act(async () => {
      vi.advanceTimersByTime(420);
    });

    expect(screen.queryByTestId('terminal-session-drawer-folder-menu')).toBeNull();
    vi.useRealTimers();
  });

  it('closes the session slot menu from the scrim or Escape', () => {
    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onAssignSessionGroupSlot={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    const row = screen.getByTestId('terminal-session-drawer-row-s2');
    fireEvent.contextMenu(row, { clientX: 120, clientY: 220 });
    fireEvent.click(screen.getByTestId('terminal-session-drawer-slot-menu-scrim'));
    expect(screen.queryByTestId('terminal-session-drawer-slot-menu')).toBeNull();

    fireEvent.contextMenu(row, { clientX: 120, clientY: 220 });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('terminal-session-drawer-slot-menu')).toBeNull();
  });

  it('keeps the session list content-sized so the drawer does not leave a large blank gap above the footer', () => {
    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    const tree = screen.getByTestId('terminal-session-drawer-tree');
    expect(tree.style.flex).toBe('0 1 auto');
    expect(tree.style.minHeight).toBe('0px');
    expect(tree.style.overflowY).toBe('auto');
    expect(tree.style.touchAction).toBe('pan-y');
    expect(screen.getByTestId('terminal-session-drawer-add')).toBeTruthy();
  });

  it('does not render preview multi-select controls', () => {
    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('terminal-session-drawer-preview-mode')).toBeNull();
    expect(screen.queryByTestId('terminal-session-drawer-preview-check-s1')).toBeNull();
    expect(screen.queryByTestId('terminal-session-drawer-preview-footer')).toBeNull();
  });


  it('does not turn the drawer-opening gesture release into a session selection', () => {
    const onSelectSession = vi.fn();

    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        onClose={vi.fn()}
        onSelectSession={onSelectSession}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    const target = screen.getByTestId('terminal-session-drawer-select-s2');
    fireEvent.click(target, { detail: 1 });

    expect(onSelectSession).not.toHaveBeenCalled();

    fireEvent.touchStart(target, {
      touches: [{ clientX: 120, clientY: 180 }],
    });
    fireEvent.touchEnd(target, {
      changedTouches: [{ clientX: 120, clientY: 180 }],
    });
    fireEvent.click(target, { detail: 1 });

    expect(onSelectSession).toHaveBeenCalledWith('s2');
    expect(onSelectSession).toHaveBeenCalledTimes(1);
  });

  it('does not let a press on one drawer row authorize another row', () => {
    const onSelectSession = vi.fn();

    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        onClose={vi.fn()}
        onSelectSession={onSelectSession}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    fireEvent.touchStart(screen.getByTestId('terminal-session-drawer-select-s1'), {
      touches: [{ clientX: 120, clientY: 100 }],
    });
    fireEvent.click(screen.getByTestId('terminal-session-drawer-select-s2'), { detail: 1 });

    expect(onSelectSession).not.toHaveBeenCalled();
  });


  it('routes row close button to close only without selecting the session', () => {
    const onSelectSession = vi.fn();
    const onCloseSession = vi.fn();

    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        onClose={vi.fn()}
        onSelectSession={onSelectSession}
        onCloseSession={onCloseSession}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('terminal-session-drawer-close-s1'));
    expect(onCloseSession).toHaveBeenCalledWith('s1');
    expect(onSelectSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('terminal-session-drawer-select-s2'));
    expect(onSelectSession).toHaveBeenCalledWith('s2');
    expect(onCloseSession).toHaveBeenCalledTimes(1);
  });

  it('routes row close button through touch activation without selecting the session', () => {
    const onSelectSession = vi.fn();
    const onCloseSession = vi.fn();

    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        onClose={vi.fn()}
        onSelectSession={onSelectSession}
        onCloseSession={onCloseSession}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    const closeButton = screen.getByTestId('terminal-session-drawer-close-s1');
    fireEvent.touchStart(closeButton, {
      touches: [{ clientX: 240, clientY: 120 }],
    });
    fireEvent.touchEnd(closeButton, {
      changedTouches: [{ clientX: 240, clientY: 120 }],
    });

    expect(onCloseSession).toHaveBeenCalledWith('s1');
    expect(onCloseSession).toHaveBeenCalledTimes(1);
    expect(onSelectSession).not.toHaveBeenCalled();

    fireEvent.click(closeButton);
    expect(onCloseSession).toHaveBeenCalledTimes(1);
  });

  it('opens the new session form before creating from the drawer add button touch activation', () => {
    const onOpenQuickTabPicker = vi.fn();

    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={onOpenQuickTabPicker}
      />,
    );

    const addButton = screen.getByTestId('terminal-session-drawer-add');
    fireEvent.touchEnd(addButton, {
      changedTouches: [{ clientX: 180, clientY: 560 }],
    });
    expect(screen.getByTestId('terminal-session-drawer-new-session-dialog')).toBeTruthy();
    expect(onOpenQuickTabPicker).not.toHaveBeenCalled();

    confirmNewSession();
    expect(onOpenQuickTabPicker).toHaveBeenCalledWith(undefined, {
      sessionName: 'work-api',
      cwd: '~/code/api',
      terminalBackend: 'tmux',
    });
  });

  it('passes Herdr backend from the real drawer new-session form', () => {
    const onOpenQuickTabPicker = vi.fn();

    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={onOpenQuickTabPicker}
      />,
    );

    fireEvent.click(screen.getByTestId('terminal-session-drawer-add'));
    fireEvent.change(screen.getByLabelText('新 session 名称'), { target: { value: 'hd-codex' } });
    fireEvent.click(screen.getByRole('button', { name: 'Herdr' }));
    fireEvent.click(screen.getByText('创建'));

    expect(onOpenQuickTabPicker).toHaveBeenCalledWith(undefined, expect.objectContaining({
      sessionName: 'hd-codex',
      terminalBackend: 'herdr',
    }));
  });

  it('does not invent a host identity when caller omits hostKey', () => {
    const onOpenQuickTabPicker = vi.fn();

    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={onOpenQuickTabPicker}
      />,
    );

    fireEvent.touchEnd(screen.getByTestId('terminal-session-drawer-add'), {
      changedTouches: [{ clientX: 180, clientY: 560 }],
    });
    confirmNewSession('unscoped-work', '~/code/unscoped');

    expect(onOpenQuickTabPicker).toHaveBeenCalledWith(undefined, {
      sessionName: 'unscoped-work',
      cwd: '~/code/unscoped',
      terminalBackend: 'tmux',
    });
    expect(onOpenQuickTabPicker).not.toHaveBeenCalledWith('default', expect.anything());
  });

  it('keeps the add button above the IME inset', () => {
    render(
      <TerminalSessionDrawer
        open
        bottomInsetPx={297}
        sessions={sessions}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    expect(screen.getByTestId('terminal-session-drawer-add').style.paddingBottom).toBe('309px');
  });

  it('logs the add hit target before opening quick tab picker', () => {
    const onOpenQuickTabPicker = vi.fn();
    const onDebugAddEvent = vi.fn();

    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={onOpenQuickTabPicker}
        onDebugAddEvent={onDebugAddEvent}
      />,
    );

    fireEvent.touchStart(screen.getByTestId('terminal-session-drawer-add'), {
      touches: [{ clientX: 180, clientY: 560 }],
    });
    fireEvent.touchEnd(screen.getByTestId('terminal-session-drawer-add'), {
      changedTouches: [{ clientX: 180, clientY: 560 }],
    });

    expect(onDebugAddEvent.mock.calls.map(([eventName]) => eventName)).toEqual([
      'cap:start:terminal-session-drawer-add',
      'drawer:touchstart',
      'add:capstart:terminal-session-drawer-add',
      'add:touchstart',
      'cap:end:terminal-session-drawer-add',
      'drawer:touchend',
      'add:capend:terminal-session-drawer-add',
      'add:touchend',
      'add:callback',
    ]);
    expect(onOpenQuickTabPicker).not.toHaveBeenCalled();
    expect(screen.getByTestId('terminal-session-drawer-new-session-dialog')).toBeTruthy();
  });

  it('closes on overlay click and left swipe gesture', () => {
    const onClose = vi.fn();

    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        onClose={onClose}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('terminal-session-drawer-overlay'));
    expect(onClose).toHaveBeenCalledTimes(1);

    const drawer = screen.getByTestId('terminal-session-drawer');
    fireEvent.touchStart(drawer, { touches: [{ clientX: 220, clientY: 120 }] });
    fireEvent.touchEnd(drawer, { changedTouches: [{ clientX: 120, clientY: 126 }] });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('closes from a horizontal left swipe that starts inside the scrollable list', () => {
    const onClose = vi.fn();

    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        onClose={onClose}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    const tree = screen.getByTestId('terminal-session-drawer-tree');
    fireEvent.touchStart(tree, { touches: [{ clientX: 170, clientY: 220 }] });
    fireEvent.touchMove(tree, { touches: [{ clientX: 100, clientY: 224 }] });
    fireEvent.touchEnd(tree, { changedTouches: [{ clientX: 100, clientY: 224 }] });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on vertical list scrolling', () => {
    const onClose = vi.fn();

    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        onClose={onClose}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    const tree = screen.getByTestId('terminal-session-drawer-tree');
    fireEvent.touchStart(tree, { touches: [{ clientX: 160, clientY: 180 }] });
    fireEvent.touchMove(tree, { touches: [{ clientX: 145, clientY: 280 }] });
    fireEvent.touchEnd(tree, { changedTouches: [{ clientX: 145, clientY: 280 }] });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows host rail and filters sessions when multiple hostKeys present', () => {
    const onSelectSession = vi.fn();
    const sessionsWithHosts = [
      {
        id: 's1',
      stableKey: `stable-s1`,
        title: 'demo',
        subtitle: '100.127.23.27:3333 · demo',
        status: 'connected' as const,
        paneLabel: 'P1',
        active: true,
        hostKey: '100.127.23.27:3333',
        hostLabel: 'demo-machine',
      },
      {
        id: 's2',
      stableKey: `stable-s2`,
        title: 'android',
        subtitle: '100.66.1.82:3333 · android',
        status: 'connecting' as const,
        paneLabel: 'P2',
        active: false,
        hostKey: '100.127.23.27:3333',
        hostLabel: 'demo-machine',
      },
      {
        id: 's3',
      stableKey: `stable-s3`,
        title: 'macbook',
        subtitle: '100.66.1.82:3333 · macbook',
        status: 'connected' as const,
        paneLabel: 'P3',
        active: false,
        hostKey: '100.66.1.82:3333',
        hostLabel: 'mac-dev',
      },
    ];

    const { rerender } = render(
      <TerminalSessionDrawer
        open
        sessions={sessionsWithHosts}
        onClose={vi.fn()}
        onSelectSession={onSelectSession}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    expect(screen.getByTestId('terminal-session-drawer-host-rail')).toBeTruthy();
    expect(screen.getByTestId('terminal-session-drawer-host-rail').style.flexDirection).toBe('row');
    expect(screen.getByTestId('terminal-session-drawer-host-100.127.23.27:3333')).toBeTruthy();
    expect(screen.getByTestId('terminal-session-drawer-host-100.66.1.82:3333')).toBeTruthy();
    expect(screen.getByTestId('terminal-session-drawer-host-100.127.23.27:3333').getAttribute('data-tree-level')).toBe('1');

    // 默认选中 active session 所在 host，显示 s1、s2，不显示 s3
    expect(screen.getByTestId('terminal-session-drawer-row-s1')).toBeTruthy();
    expect(screen.getByTestId('terminal-session-drawer-row-s2')).toBeTruthy();
    expect(() => screen.getByTestId('terminal-session-drawer-row-s3')).toThrow();

    // 切到 mac-dev host → 显示 s3
    fireEvent.click(screen.getByTestId('terminal-session-drawer-host-100.66.1.82:3333'));
    rerender(
      <TerminalSessionDrawer
        open
        sessions={sessionsWithHosts}
        onClose={vi.fn()}
        onSelectSession={onSelectSession}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );
    expect(() => screen.getByTestId('terminal-session-drawer-row-s1')).toThrow();
    expect(() => screen.getByTestId('terminal-session-drawer-row-s2')).toThrow();
    expect(screen.getByTestId('terminal-session-drawer-row-s3')).toBeTruthy();
  });

  it('lists account hosts without sessions and asks for name/path before creating a new session', () => {
    const onOpenQuickTabPicker = vi.fn();

    render(
      <TerminalSessionDrawer
        open
        hosts={[
          { hostKey: 'daemon-a', hostLabel: 'Mac Studio', connected: true },
          { hostKey: 'daemon-b', hostLabel: 'Windows PC', connected: true },
        ]}
        sessions={[
          {
            id: 's1',
      stableKey: `stable-s1`,
            title: 'demo',
            subtitle: 'Mac Studio · demo',
            active: true,
            hostKey: 'daemon-a',
            hostLabel: 'Mac Studio',
          },
        ]}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={onOpenQuickTabPicker}
      />,
    );

    fireEvent.click(screen.getByTestId('terminal-session-drawer-host-daemon-b'));
    expect(screen.getByTestId('terminal-session-drawer-empty-host').textContent).toContain('没有活跃 session');

    fireEvent.touchEnd(screen.getByTestId('terminal-session-drawer-add'), {
      changedTouches: [{ clientX: 180, clientY: 560 }],
    });
    expect(onOpenQuickTabPicker).not.toHaveBeenCalled();
    expect(screen.getByTestId('terminal-session-drawer-new-session-dialog')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('新 session 名称'), {
      target: { value: 'work-api' },
    });
    fireEvent.change(screen.getByLabelText('新 session 启动路径'), {
      target: { value: '~/code/api' },
    });
    fireEvent.click(screen.getByText('创建'));

    expect(onOpenQuickTabPicker).toHaveBeenCalledWith('daemon-b', {
      sessionName: 'work-api',
      cwd: '~/code/api',
      terminalBackend: 'tmux',
    });
  });

  it('defaults to an online daemon host instead of an active stale connecting host', () => {
    render(
      <TerminalSessionDrawer
        open
        hosts={[
          { hostKey: 'mac-studio', hostLabel: 'Mac Studio', connected: true },
          { hostKey: 'daemon-old', hostLabel: 'daemon-Macstudio-old', connected: false },
        ]}
        sessions={[
          {
            id: 'stale-active',
      stableKey: `stable-stale-active`,
            title: 'freehand',
            subtitle: 'daemon-Macstudio-old · freehand',
            active: true,
            hostKey: 'daemon-old',
            hostLabel: 'daemon-Macstudio-old',
          },
          {
            id: 'healthy-rcc',
      stableKey: `stable-healthy-rcc`,
            title: 'rcc',
            subtitle: 'Mac Studio · rcc',
            active: false,
            hostKey: 'mac-studio',
            hostLabel: 'Mac Studio',
          },
        ]}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    expect(screen.getByTestId('terminal-session-drawer-row-healthy-rcc')).toBeTruthy();
    expect(screen.queryByTestId('terminal-session-drawer-row-stale-active')).toBeNull();
  });

  it('keeps the daemon selector visible when all sessions share one hostKey', () => {
    const singleHostSessions = [
      {
        id: 's1',
      stableKey: `stable-s1`,
        title: 'demo',
        subtitle: '100.127.23.27:3333 · demo',
        status: 'connected' as const,
        paneLabel: 'P1',
        active: true,
        hostKey: '100.127.23.27:3333',
      },
      {
        id: 's2',
      stableKey: `stable-s2`,
        title: 'android',
        subtitle: '100.127.23.27:3333 · android',
        status: 'connecting' as const,
        paneLabel: 'P2',
        active: false,
        hostKey: '100.127.23.27:3333',
      },
    ];

    render(
      <TerminalSessionDrawer
        open
        sessions={singleHostSessions}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    expect(screen.getByTestId('terminal-session-drawer-host-rail')).toBeTruthy();
    expect(screen.getByTestId('terminal-session-drawer-host-100.127.23.27:3333')).toBeTruthy();
    expect(screen.getByTestId('terminal-session-drawer-row-s1')).toBeTruthy();
    expect(screen.getByTestId('terminal-session-drawer-row-s2')).toBeTruthy();
  });

  it('preserves caller-provided order (opened before unopened)', () => {
    // 排序由 TerminalPage 负责；drawer 只保持传入顺序
    const orderedSessions = [
      { id: 'o-bravo',
      stableKey: `stable-o-bravo`, title: 'bravo', subtitle: 'host · bravo', status: 'connected' as const, paneLabel: 'P1', active: true, hostKey: 'host:3333' },
      { id: 'u-alpha',
      stableKey: `stable-u-alpha`, title: 'alpha', subtitle: 'host · alpha', status: 'idle' as const, hostKey: 'host:3333' },
      { id: 'u-zeta',
      stableKey: `stable-u-zeta`, title: 'zeta', subtitle: 'host · zeta', status: 'idle' as const, hostKey: 'host:3333' },
    ];
    render(
      <TerminalSessionDrawer
        open
        sessions={orderedSessions}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );
    const oNode = screen.getByTestId('terminal-session-drawer-row-o-bravo');
    const aNode = screen.getByTestId('terminal-session-drawer-row-u-alpha');
    const zNode = screen.getByTestId('terminal-session-drawer-row-u-zeta');
    expect(oNode.compareDocumentPosition(aNode) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(aNode.compareDocumentPosition(zNode) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });


  it('shows explicit session-group slot labels and opens the slot menu on long press without selecting the row', async () => {
    vi.useFakeTimers();
    const onSelectSession = vi.fn();
    const onAssignSessionGroupSlot = vi.fn();

    render(
      <TerminalSessionDrawer
        open
        sessions={[
          {
            ...sessions[0],
            sessionGroupSlot: 'top',
          },
          {
            ...sessions[1],
            sessionGroupSlot: 'bottom',
          },
        ]}
        onClose={vi.fn()}
        onSelectSession={onSelectSession}
        onCloseSession={vi.fn()}
        onAssignSessionGroupSlot={onAssignSessionGroupSlot}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    expect(screen.getByTestId('terminal-session-drawer-slot-s1').textContent).toContain('上方');
    expect(screen.getByTestId('terminal-session-drawer-slot-s2').textContent).toContain('下方');

    fireEvent.touchStart(screen.getByTestId('terminal-session-drawer-row-s1'), {
      touches: [{ clientX: 120, clientY: 220 }],
    });
    await act(async () => {
      vi.advanceTimersByTime(420);
    });

    expect(screen.getByTestId('terminal-session-drawer-slot-menu')).toBeTruthy();
    expect(onSelectSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('terminal-session-drawer-slot-menu-center'));
    expect(onAssignSessionGroupSlot).toHaveBeenCalledWith('s1', 'center');
    expect(onSelectSession).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('hides a session from the long-press menu without selecting it', async () => {
    vi.useFakeTimers();
    const onSelectSession = vi.fn();
    const onHideSession = vi.fn();

    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        onClose={vi.fn()}
        onSelectSession={onSelectSession}
        onCloseSession={vi.fn()}
        onAssignSessionGroupSlot={vi.fn()}
        onHideSession={onHideSession}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    fireEvent.touchStart(screen.getByTestId('terminal-session-drawer-row-s1'), {
      touches: [{ clientX: 120, clientY: 220 }],
    });
    await act(async () => {
      vi.advanceTimersByTime(420);
    });
    fireEvent.click(screen.getByTestId('terminal-session-drawer-slot-menu-hide'));

    expect(onHideSession).toHaveBeenCalledWith('s1');
    expect(onSelectSession).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('assigns a session to a slot from the context menu', () => {
    const onAssignSessionGroupSlot = vi.fn();

    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onAssignSessionGroupSlot={onAssignSessionGroupSlot}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    fireEvent.contextMenu(screen.getByTestId('terminal-session-drawer-row-s2'), {
      clientX: 180,
      clientY: 280,
    });

    expect(screen.getByTestId('terminal-session-drawer-slot-menu')).toBeTruthy();
    fireEvent.click(screen.getByTestId('terminal-session-drawer-slot-menu-top'));
    expect(onAssignSessionGroupSlot).toHaveBeenCalledWith('s2', 'top');
  });

  it('cancels the slot menu without changing workspace assignment', () => {
    const onAssignSessionGroupSlot = vi.fn();

    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onAssignSessionGroupSlot={onAssignSessionGroupSlot}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    fireEvent.contextMenu(screen.getByTestId('terminal-session-drawer-row-s2'), {
      clientX: 180,
      clientY: 280,
    });
    fireEvent.click(screen.getByTestId('terminal-session-drawer-slot-menu-cancel'));

    expect(screen.queryByTestId('terminal-session-drawer-slot-menu')).toBeNull();
    expect(onAssignSessionGroupSlot).not.toHaveBeenCalled();
  });

  it('uses left and right slot labels in horizontal session-group mode', () => {
    const onAssignSessionGroupSlot = vi.fn();

    render(
      <TerminalSessionDrawer
        open
        sessionGroupLayoutAxis="horizontal"
        sessions={[
          {
            ...sessions[0],
            sessionGroupSlot: 'top',
          },
          {
            ...sessions[1],
            sessionGroupSlot: 'bottom',
          },
        ]}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onAssignSessionGroupSlot={onAssignSessionGroupSlot}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    expect(screen.getByTestId('terminal-session-drawer-slot-s1').textContent).toContain('左侧');
    expect(screen.getByTestId('terminal-session-drawer-slot-s2').textContent).toContain('右侧');

    fireEvent.contextMenu(screen.getByTestId('terminal-session-drawer-row-s2'), {
      clientX: 180,
      clientY: 280,
    });

    expect(screen.getByTestId('terminal-session-drawer-slot-menu-top').textContent).toContain('放到左侧');
    expect(screen.getByTestId('terminal-session-drawer-slot-menu-bottom').textContent).toContain('放到右侧');
  });

  it('does not rebuild drawer list DOM when identical session content arrives with new array references', () => {
    const base = {
      open: true,
      topInsetPx: 0,
      bottomInsetPx: 0,
      sessions: sessions.map((s) => ({ ...s })),
      hosts: [{ hostKey: 'h1', hostLabel: 'Host 1' }],
      onClose: vi.fn(),
      onSelectSession: vi.fn(),
      onCloseSession: vi.fn(),
      onOpenQuickTabPicker: vi.fn(),
      onDebugAddEvent: vi.fn(),
    };
    const { rerender } = render(<TerminalSessionDrawer {...base} />);
    const list = screen.getByTestId('terminal-session-drawer-list');
    const rows = Array.from(list.children);
    rows.forEach((row, index) => {
      (row as HTMLElement).dataset.marker = `M${index}`;
    });

    // 相同内容、全新引用（模拟 TerminalPage re-render 导致的 drawerSessions 重算）
    rerender(
      <TerminalSessionDrawer
        {...base}
        sessions={sessions.map((s) => ({ ...s }))}
        hosts={[{ hostKey: 'h1', hostLabel: 'Host 1' }]}
      />,
    );

    const after = Array.from(list.children);
    expect(after.length).toBe(rows.length);
    for (let i = 0; i < after.length; i += 1) {
      expect((after[i] as HTMLElement).dataset.marker).toBe(`M${i}`);
    }
  });

  it('does not use backdrop-filter or open-dependent boxShadow on the drawer surface (Android WebView compositing flicker)', () => {
    const { rerender } = render(
      <TerminalSessionDrawer
        open={false}
        topInsetPx={0}
        bottomInsetPx={0}
        sessions={sessions.map((s) => ({ ...s }))}
        hosts={[{ hostKey: 'h1', hostLabel: 'Host 1' }]}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );
    const aside = screen.getByTestId('terminal-session-drawer');
    const closedStyle = aside.style as unknown as Record<string, string>;
    expect(closedStyle.backdropFilter ?? '').toBe('');
    expect(closedStyle.backdropFilter).not.toContain('blur');
    expect(closedStyle.boxShadow ?? '').toBe('none');

    // 打开后：backdropFilter 仍不允许出现；boxShadow 不得随 open 切换
    rerender(
      <TerminalSessionDrawer
        open
        topInsetPx={0}
        bottomInsetPx={0}
        sessions={sessions.map((s) => ({ ...s }))}
        hosts={[{ hostKey: 'h1', hostLabel: 'Host 1' }]}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );
    const openStyle = aside.style as unknown as Record<string, string>;
    expect(openStyle.backdropFilter ?? '').toBe('');
    expect(openStyle.backdropFilter).not.toContain('blur');
    expect(openStyle.boxShadow ?? '').toBe('none');
  });

  it('draws the active row with an accent edge and keeps close/badges in row flow', () => {
    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    const activeRow = screen.getByTestId(`terminal-session-drawer-row-${sessions[0]!.id}`) as HTMLElement;
    expect(activeRow.getAttribute('data-active')).toBe('true');
    expect(activeRow.style.border).toBe('1px solid transparent');
    expect(activeRow.style.boxShadow).toContain('inset 3px 0 0');

    const closeTarget = screen.getByTestId(`terminal-session-drawer-close-${sessions[0]!.id}`) as HTMLElement;
    expect(closeTarget.style.position).not.toBe('absolute');
    expect(closeTarget.style.borderStyle).toBe('none');
    const chip = closeTarget.parentElement as HTMLElement | null;
    expect(chip).not.toBeNull();
    expect(chip?.style.borderRadius).toBe('0px');
    expect(chip?.style.background).toBe('transparent');
  });

  it('keeps pane, slot, and close controls in row flow so grouped rows are not clipped', () => {
    render(
      <TerminalSessionDrawer
        open
        sessions={[
          {
            ...sessions[0],
            paneLabel: 'P1',
            sessionGroupSlot: 'top',
          },
        ]}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onAssignSessionGroupSlot={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    const row = screen.getByTestId(`terminal-session-drawer-row-${sessions[0]!.id}`) as HTMLElement;
    expect(row.style.gridTemplateColumns).toBe('minmax(0, 1fr) auto');
    expect(row.style.overflow).toBe('visible');

    const chip = screen.getByTestId(`terminal-session-drawer-row-chip-${sessions[0]!.id}`) as HTMLElement;
    expect(chip.style.position).not.toBe('absolute');
    expect(chip.style.flexDirection).toBe('row');
    expect(chip.style.flexWrap).toBe('wrap');
    expect(screen.getByText('P1')).toBeTruthy();
    expect(screen.getByTestId(`terminal-session-drawer-slot-${sessions[0]!.id}`).textContent).toContain('上方');
    expect(screen.getByTestId(`terminal-session-drawer-close-${sessions[0]!.id}`)).toBeTruthy();
  });

  it('shows Collab role badges with exact MASTER/WORKER labels', () => {
    render(
      <TerminalSessionDrawer
        open
        sessions={[
          { ...sessions[0], collab: { role: 'master', displayName: 'Jenny' } },
          { ...sessions[1], collab: { role: 'worker', displayName: 'Alice', agentState: 'idle' } },
        ]}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    const masterBadge = screen.getByTestId('terminal-session-drawer-collab-s1');
    expect(masterBadge.textContent).toBe('MASTER');
    expect(masterBadge.style.color).toBe('var(--zterm-settings-success)');
    const workerBadge = screen.getByTestId('terminal-session-drawer-collab-s2');
    expect(workerBadge.textContent).toBe('WORKER');
    expect(screen.queryByTestId('terminal-session-drawer-collab-s3')).toBeNull();
  });

  it('reports a truthful showing N / M count line from the unfiltered total', () => {
    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        unfilteredSessionCount={7}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    const count = screen.getByTestId('terminal-session-drawer-count');
    expect(count.textContent).toBe('显示 2 / 7 个会话');
    expect(Number(count.style.fontSize.replace('px', ''))).toBeGreaterThanOrEqual(11);
  });

  it('states no matching session for an active filter that empties the list', () => {
    const onFilterModeChange = vi.fn();
    render(
      <TerminalSessionDrawer
        open
        sessions={[]}
        unfilteredSessionCount={2}
        filterMode="only-master"
        onFilterModeChange={onFilterModeChange}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('terminal-session-drawer-empty-host')).toBeNull();
    expect(screen.getByTestId('terminal-session-drawer-empty-filter')).toBeTruthy();
    expect(screen.getByTestId('terminal-session-drawer-empty-filter').textContent)
      .toContain('当前筛选没有匹配的 session');
    fireEvent.click(screen.getByTestId('terminal-session-drawer-empty-filter-reset'));
    expect(onFilterModeChange).toHaveBeenCalledWith('all');
  });

  it('states all sessions hidden and restores them from the empty state', () => {
    const onRestoreAllHiddenSessions = vi.fn();
    render(
      <TerminalSessionDrawer
        open
        sessions={[]}
        hiddenSessionNames={['tmux-master']}
        hiddenSessionCount={1}
        unfilteredSessionCount={1}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onRestoreAllHiddenSessions={onRestoreAllHiddenSessions}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('terminal-session-drawer-empty-host')).toBeNull();
    expect(screen.getByTestId('terminal-session-drawer-empty-hidden')).toBeTruthy();
    expect(screen.getByTestId('terminal-session-drawer-empty-hidden').textContent)
      .toContain('所有 session 已隐藏');
    fireEvent.click(screen.getByTestId('terminal-session-drawer-empty-hidden-restore'));
    expect(onRestoreAllHiddenSessions).toHaveBeenCalled();
  });

  it('keeps the genuinely empty host copy when there are no sessions at all', () => {
    render(
      <TerminalSessionDrawer
        open
        hosts={[{ hostKey: 'daemon-a', hostLabel: 'Mac Studio', connected: true }]}
        sessions={[]}
        unfilteredSessionCount={0}
        hostSummaries={[{
          hostKey: 'daemon-a',
          unfilteredSessionCount: 0,
          hiddenSessionCount: 0,
          roleFilteredSessionCount: 0,
        }]}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    const empty = screen.getByTestId('terminal-session-drawer-empty-host');
    expect(empty.textContent).toContain('没有活跃 session');
    expect(screen.queryByTestId('terminal-session-drawer-empty-filter')).toBeNull();
    expect(screen.queryByTestId('terminal-session-drawer-empty-hidden')).toBeNull();
  });

  it('shows the empty host state when a stale hidden name belongs to another host', () => {
    render(
      <TerminalSessionDrawer
        open
        hosts={[
          { hostKey: 'daemon-empty', hostLabel: 'Empty Host', connected: true },
          { hostKey: 'daemon-full', hostLabel: 'Full Host', connected: true },
        ]}
        sessions={[]}
        hiddenSessionNames={['stale-session']}
        hiddenSessionCount={1}
        hostSummaries={[
          {
            hostKey: 'daemon-empty',
            unfilteredSessionCount: 0,
            hiddenSessionCount: 0,
            roleFilteredSessionCount: 0,
          },
          {
            hostKey: 'daemon-full',
            unfilteredSessionCount: 2,
            hiddenSessionCount: 1,
            roleFilteredSessionCount: 0,
          },
        ]}
        unfilteredSessionCount={2}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onRestoreAllHiddenSessions={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    // The first/selected host is genuinely empty; the stale hidden name on the
    // full host must not make it report all sessions as hidden.
    fireEvent.click(screen.getByTestId('terminal-session-drawer-host-daemon-empty'));
    expect(screen.getByTestId('terminal-session-drawer-empty-host').textContent)
      .toContain('没有活跃 session');
    expect(screen.queryByTestId('terminal-session-drawer-empty-hidden')).toBeNull();
  });

  it('shows the role-filter empty state from the selected host, not global membership', () => {
    render(
      <TerminalSessionDrawer
        open
        hosts={[
          { hostKey: 'daemon-master', hostLabel: 'Master Host', connected: true },
          { hostKey: 'daemon-workers', hostLabel: 'Workers Host', connected: true },
        ]}
        sessions={[]}
        filterMode="only-master"
        hostSummaries={[
          {
            hostKey: 'daemon-master',
            unfilteredSessionCount: 1,
            hiddenSessionCount: 0,
            roleFilteredSessionCount: 0,
          },
          {
            hostKey: 'daemon-workers',
            unfilteredSessionCount: 3,
            hiddenSessionCount: 0,
            roleFilteredSessionCount: 3,
          },
        ]}
        unfilteredSessionCount={4}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onFilterModeChange={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('terminal-session-drawer-host-daemon-workers'));
    expect(screen.getByTestId('terminal-session-drawer-empty-filter').textContent)
      .toContain('当前筛选没有匹配的 session');
    expect(screen.queryByTestId('terminal-session-drawer-empty-host')).toBeNull();
    expect(screen.queryByTestId('terminal-session-drawer-empty-hidden')).toBeNull();
  });

  it('reports all-hidden only when the selected host actually has hidden sessions', () => {
    render(
      <TerminalSessionDrawer
        open
        hosts={[{ hostKey: 'daemon-a', hostLabel: 'Daemon A', connected: true }]}
        sessions={[]}
        hiddenSessionNames={['shared']}
        hiddenSessionCount={1}
        hostSummaries={[{
          hostKey: 'daemon-a',
          unfilteredSessionCount: 1,
          hiddenSessionCount: 1,
          roleFilteredSessionCount: 0,
        }]}
        unfilteredSessionCount={1}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onRestoreAllHiddenSessions={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    expect(screen.getByTestId('terminal-session-drawer-empty-hidden').textContent)
      .toContain('所有 session 已隐藏');
    expect(screen.queryByTestId('terminal-session-drawer-empty-host')).toBeNull();
  });

  it('uses at least 40px filter segments at 11px label', () => {
    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        filterMode="all"
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    for (const mode of ['all', 'only-master', 'hide-worker'] as const) {
      const segment = screen.getByTestId(`terminal-session-drawer-filter-${mode}`);
      expect(Number(segment.style.minHeight.replace('px', ''))).toBeGreaterThanOrEqual(40);
      expect(Number(segment.style.fontSize.replace('px', ''))).toBeGreaterThanOrEqual(11);
    }
  });

  it('uses at least 40px row hide and close hit areas', () => {
    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        onHideSession={vi.fn()}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    for (const id of ['s1', 's2']) {
      const hide = screen.getByTestId(`terminal-session-drawer-hide-${id}`);
      const close = screen.getByTestId(`terminal-session-drawer-close-${id}`);
      for (const control of [hide, close]) {
        expect(Number(control.style.minWidth.replace('px', ''))).toBeGreaterThanOrEqual(40);
        expect(Number(control.style.minHeight.replace('px', ''))).toBeGreaterThanOrEqual(40);
      }
    }
  });

  it('uses at least 40px hidden tray restore controls at 11px label', () => {
    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        hiddenSessionNames={['tmux-master']}
        hiddenSessionCount={1}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onRestoreHiddenSession={vi.fn()}
        onRestoreAllHiddenSessions={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    const bulk = screen.getByTestId('terminal-session-drawer-restore-hidden');
    expect(Number(bulk.style.minHeight.replace('px', ''))).toBeGreaterThanOrEqual(40);
    expect(Number(bulk.style.fontSize.replace('px', ''))).toBeGreaterThanOrEqual(11);
    const single = screen.getByTestId(terminalSessionDrawerHiddenRestoreTestId('tmux-master'));
    expect(Number(single.style.minHeight.replace('px', ''))).toBeGreaterThanOrEqual(40);
    expect(Number(single.style.fontSize.replace('px', ''))).toBeGreaterThanOrEqual(11);
  });

  it('renders legible 11px theme-adaptive Collab chips', () => {
    render(
      <TerminalSessionDrawer
        open
        sessions={[
          { ...sessions[0], collab: { role: 'master', displayName: 'Jenny' } },
          { ...sessions[1], collab: { role: 'worker', displayName: 'Alice' } },
        ]}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    const masterBadge = screen.getByTestId('terminal-session-drawer-collab-s1');
    expect(masterBadge.style.fontSize).toBe('11px');
    expect(masterBadge.style.background).toBe('var(--zterm-settings-success-soft)');
    expect(masterBadge.style.color).toBe('var(--zterm-settings-success)');
    expect(masterBadge.style.border).toContain('var(--zterm-settings-success)');
    const workerBadge = screen.getByTestId('terminal-session-drawer-collab-s2');
    expect(workerBadge.style.fontSize).toBe('11px');
    expect(workerBadge.style.background).toBe('var(--zterm-settings-warning-soft)');
    expect(workerBadge.style.color).toBe('var(--zterm-settings-warning)');
  });

  it('hides a row from the row chip action and keeps long titles truncating', () => {
    const onHideSession = vi.fn();
    render(
      <TerminalSessionDrawer
        open
        sessions={[
          { ...sessions[0], title: 'a-very-long-session-title-that-must-never-reach-the-badge' },
        ]}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onHideSession={onHideSession}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('terminal-session-drawer-hide-s1'));
    expect(onHideSession).toHaveBeenCalledWith('s1');
    expect(screen.getByTestId('terminal-session-drawer-hide-s1').getAttribute('aria-label'))
      .toBe('隐藏 a-very-long-session-title-that-must-never-reach-the-badge');
    const row = screen.getByTestId('terminal-session-drawer-row-s1');
    expect((row.firstElementChild as HTMLElement).style.minWidth).toBe('0px');
  });

  it('shows the hidden tray with individual and bulk restore', () => {
    const onRestoreHiddenSession = vi.fn();
    const onRestoreAllHiddenSessions = vi.fn();
    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        hiddenSessionNames={['tmux-master', 'OneStop/1']}
        hiddenSessionCount={2}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onRestoreHiddenSession={onRestoreHiddenSession}
        onRestoreAllHiddenSessions={onRestoreAllHiddenSessions}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    expect(screen.getByTestId('terminal-session-drawer-hidden-tray')).toBeTruthy();
    expect(screen.getByText('已隐藏 2')).toBeTruthy();
    fireEvent.click(screen.getByTestId('terminal-session-drawer-restore-hidden-tmux-master'));
    expect(onRestoreHiddenSession).toHaveBeenCalledWith('tmux-master');
    fireEvent.click(screen.getByTestId(terminalSessionDrawerHiddenRestoreTestId('OneStop/1')));
    expect(onRestoreHiddenSession).toHaveBeenCalledWith('OneStop/1');
    fireEvent.click(screen.getByTestId('terminal-session-drawer-restore-hidden'));
    expect(onRestoreAllHiddenSessions).toHaveBeenCalled();
  });

  it('renders segmented drawer filter controls and routes mode changes', () => {
    const onFilterModeChange = vi.fn();
    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        filterMode="all"
        onFilterModeChange={onFilterModeChange}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    expect(screen.getByTestId('terminal-session-drawer-filter-all').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('terminal-session-drawer-filter-only-master'));
    expect(onFilterModeChange).toHaveBeenCalledWith('only-master');
    expect(screen.getByTestId('terminal-session-drawer-filter-only-master').textContent).toBe('仅 master');
  });

  it('moves focus outside before a session close can hide the drawer', () => {
    let activeElementAtClose: Element | null = null;
    const onCloseSession = vi.fn(() => {
      activeElementAtClose = document.activeElement;
    });
    const renderDrawer = (open: boolean) => (
      <>
        <button type="button" data-testid="drawer-focus-return-target">
          Open sessions
        </button>
        <TerminalSessionDrawer
          open={open}
          sessions={sessions}
          onClose={vi.fn()}
          onSelectSession={vi.fn()}
          onCloseSession={onCloseSession}
          onOpenQuickTabPicker={vi.fn()}
        />
      </>
    );
    const { rerender } = render(renderDrawer(false));
    const returnTarget = screen.getByTestId('drawer-focus-return-target');
    returnTarget.focus();

    rerender(renderDrawer(true));
    expect(document.activeElement).toBe(screen.getByTestId('terminal-session-drawer-close'));

    const sessionClose = screen.getByTestId('terminal-session-drawer-close-s1');
    fireEvent.touchStart(sessionClose, {
      touches: [{ clientX: 240, clientY: 120 }],
    });
    fireEvent.touchEnd(sessionClose, {
      changedTouches: [{ clientX: 240, clientY: 120 }],
    });

    expect(onCloseSession).toHaveBeenCalledTimes(1);
    expect(activeElementAtClose).toBe(returnTarget);
    expect(activeElementAtClose).not.toBe(sessionClose);
  });

  it('keeps the scrim mounted for exit fading and uses 44px session close targets', () => {
    const { rerender } = render(
      <TerminalSessionDrawer
        open={false}
        topInsetPx={0}
        bottomInsetPx={0}
        sessions={sessions.map((s) => ({ ...s }))}
        hosts={[{ hostKey: 'h1', hostLabel: 'Host 1' }]}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );
    const overlay = screen.getByTestId('terminal-session-drawer-overlay') as HTMLButtonElement;
    const drawer = screen.getByTestId('terminal-session-drawer');
    expect(overlay.hasAttribute('inert')).toBe(true);
    expect(drawer.hasAttribute('inert')).toBe(true);
    expect(overlay.style.opacity).toBe('0');
    expect(overlay.style.pointerEvents).toBe('none');

    rerender(
      <TerminalSessionDrawer
        open
        topInsetPx={0}
        bottomInsetPx={0}
        sessions={sessions.map((s) => ({ ...s }))}
        hosts={[{ hostKey: 'h1', hostLabel: 'Host 1' }]}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );
    expect(overlay.style.opacity).toBe('1');
    expect(overlay.hasAttribute('inert')).toBe(false);
    expect(drawer.hasAttribute('inert')).toBe(false);
    expect(overlay.style.pointerEvents).toBe('auto');
    expect(overlay.style.transition).toContain('opacity 150ms ease');

    const closeTarget = screen.getByTestId(`terminal-session-drawer-close-${sessions[0]!.id}`) as HTMLElement;
    expect(Number(closeTarget.style.minWidth.replace('px', ''))).toBeGreaterThanOrEqual(36);
    expect(Number(closeTarget.style.minHeight.replace('px', ''))).toBeGreaterThanOrEqual(36);
    expect(closeTarget.style.position).toBe('');
    expect(closeTarget.style.color).toBe('var(--zterm-panel-danger)');
  });

  it('defaults new session backend to the current host terminal backend (herdr)', () => {
    const onOpenQuickTabPicker = vi.fn();
    const herdrSessions = [
      {
        id: 'h1',
        stableKey: 'stable-h1',
        title: 'hd-codex',
        subtitle: 'Mac Studio · hd-codex · Herdr',
        status: 'connected' as const,
        active: true,
        terminalBackend: 'herdr' as const,
      },
    ];

    render(
      <TerminalSessionDrawer
        open
        sessions={herdrSessions}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={onOpenQuickTabPicker}
      />,
    );

    fireEvent.touchEnd(screen.getByTestId('terminal-session-drawer-add'), {
      changedTouches: [{ clientX: 180, clientY: 560 }],
    });

    expect(screen.getByTestId('terminal-session-drawer-new-session-dialog')).toBeTruthy();
    const herdrToggle = screen.getByRole('button', { name: 'Herdr' });
    expect(herdrToggle.getAttribute('aria-pressed')).toBe('true');

    fireEvent.change(screen.getByLabelText('新 session 名称'), {
      target: { value: 'herdr-fresh' },
    });
    fireEvent.change(screen.getByLabelText('新 session 启动路径'), {
      target: { value: '~/work' },
    });
    fireEvent.click(screen.getByText('创建'));

    expect(onOpenQuickTabPicker).toHaveBeenCalledWith(undefined, {
      sessionName: 'herdr-fresh',
      cwd: '~/work',
      terminalBackend: 'herdr',
    });
  });

  it('keeps new session backend as tmux when the host only has tmux sessions', () => {
    const onOpenQuickTabPicker = vi.fn();
    const tmuxOnly = [
      {
        id: 't1',
        stableKey: 'stable-t1',
        title: 'work',
        subtitle: 'Mac Studio · work',
        status: 'connected' as const,
        active: true,
        terminalBackend: 'tmux' as const,
      },
    ];

    render(
      <TerminalSessionDrawer
        open
        sessions={tmuxOnly}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={onOpenQuickTabPicker}
      />,
    );

    fireEvent.touchEnd(screen.getByTestId('terminal-session-drawer-add'), {
      changedTouches: [{ clientX: 180, clientY: 560 }],
    });

    const tmuxToggle = screen.getByRole('button', { name: 'tmux' });
    expect(tmuxToggle.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByText('创建'));

    expect(onOpenQuickTabPicker).toHaveBeenCalledWith(undefined, {
      sessionName: expect.stringMatching(/^zterm-\d{8}-\d{6}$/),
      cwd: '~/',
      terminalBackend: 'tmux',
    });
  });

  it('lets the user override the new-session backend to a different backend than the host', () => {
    const onOpenQuickTabPicker = vi.fn();
    const tmuxOnly = [
      {
        id: 't1',
        stableKey: 'stable-t1',
        title: 'work',
        subtitle: 'Mac Studio · work',
        status: 'connected' as const,
        active: true,
        terminalBackend: 'tmux' as const,
      },
    ];

    render(
      <TerminalSessionDrawer
        open
        sessions={tmuxOnly}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={onOpenQuickTabPicker}
      />,
    );

    fireEvent.touchEnd(screen.getByTestId('terminal-session-drawer-add'), {
      changedTouches: [{ clientX: 180, clientY: 560 }],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Herdr' }));
    fireEvent.change(screen.getByLabelText('新 session 名称'), {
      target: { value: 'override-herdr' },
    });
    fireEvent.click(screen.getByText('创建'));

    expect(onOpenQuickTabPicker).toHaveBeenCalledWith(undefined, {
      sessionName: 'override-herdr',
      cwd: '~/',
      terminalBackend: 'herdr',
    });
  });

  it('renders the new-session form as a compact footer sheet with panel tokens', () => {
    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    fireEvent.touchEnd(screen.getByTestId('terminal-session-drawer-add'), {
      changedTouches: [{ clientX: 180, clientY: 560 }],
    });

    const dialog = screen.getByTestId('terminal-session-drawer-new-session-dialog');
    const dialogStyle = dialog.getAttribute('style') || '';
    expect(dialogStyle).toContain('var(--zterm-panel-border)');
    expect(dialogStyle).toContain('var(--zterm-panel-bg)');
    expect(dialogStyle).toContain('border-top');
    expect(screen.queryByTestId('terminal-session-drawer-add')).toBeNull();
    expect(dialogStyle).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(dialogStyle).not.toMatch(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/);
  });

  it('shows every project master session by default in only-master mode and expands other windows per project on demand', () => {
    const onSelectSession = vi.fn();
    const ztermMaster = {
      id: 'zterm-m',
      stableKey: 'stable-zterm-m',
      title: 'zterm-master',
      subtitle: 'Mac Studio · zterm-master',
      cwd: '/Users/jason/code/zterm',
      hostKey: 'mac-studio',
      hostLabel: 'Mac Studio',
      collab: { role: 'master' as const, displayName: 'Jenny' },
    };
    const ztermWorker = {
      id: 'zterm-w1',
      stableKey: 'stable-zterm-w1',
      title: 'zterm-worker-1',
      subtitle: 'Mac Studio · zterm-worker-1',
      cwd: '/Users/jason/code/zterm',
      hostKey: 'mac-studio',
      hostLabel: 'Mac Studio',
      collab: { role: 'worker' as const, displayName: 'Alice' },
    };
    const appsdkMaster = {
      id: 'appsdk-m',
      stableKey: 'stable-appsdk-m',
      title: 'appsdk-master',
      subtitle: 'Mac Studio · appsdk-master',
      cwd: '/Users/jason/code/appsdk',
      hostKey: 'mac-studio',
      hostLabel: 'Mac Studio',
      collab: { role: 'master' as const, displayName: 'Bob' },
    };

    render(
      <TerminalSessionDrawer
        open
        filterMode="only-master"
        sessions={[ztermMaster, appsdkMaster]}
        unfilteredSessions={[ztermMaster, ztermWorker, appsdkMaster]}
        unfilteredSessionCount={3}
        onClose={vi.fn()}
        onSelectSession={onSelectSession}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    // Every project with a master session shows its master session by default
    expect(screen.getByTestId('terminal-session-drawer-row-zterm-m')).toBeTruthy();
    expect(screen.getByTestId('terminal-session-drawer-row-appsdk-m')).toBeTruthy();
    // Other windows in zterm are hidden by default in only-master mode
    expect(screen.queryByTestId('terminal-session-drawer-row-zterm-w1')).toBeNull();

    // Expanding other windows for /Users/jason/code/zterm reveals zterm-worker-1
    const expandOthersButton = screen.getByTestId('terminal-session-drawer-folder-expand-others-/Users/jason/code/zterm');
    expect(expandOthersButton.textContent).toContain('+1 窗口');
    fireEvent.click(expandOthersButton);

    expect(screen.getByTestId('terminal-session-drawer-row-zterm-w1')).toBeTruthy();
    expect(expandOthersButton.textContent).toContain('收起 (1)');
  });
});

describe('TerminalSessionDrawer catalog availability', () => {
  const baseSessions = [
    {
      id: 'tmux-usable',
      stableKey: 'tmux-usable',
      title: 'tmux-usable',
      subtitle: 'Mac Studio · tmux-usable',
      status: 'connected' as const,
      active: true,
      hostKey: 'daemon-a',
      hostLabel: 'Mac Studio',
      terminalBackend: 'tmux' as const,
    },
    {
      id: 'herdr-missing',
      stableKey: 'herdr-missing',
      title: 'herdr-missing',
      subtitle: 'Mac Studio · herdr-missing',
      status: 'connected' as const,
      active: false,
      hostKey: 'daemon-a',
      hostLabel: 'Mac Studio',
      terminalBackend: 'herdr' as const,
    },
    {
      id: 'tmux-closed',
      stableKey: 'tmux-closed',
      title: 'tmux-closed',
      subtitle: 'Mac Studio · tmux-closed',
      status: 'closed' as const,
      active: false,
      hostKey: 'daemon-a',
      hostLabel: 'Mac Studio',
      terminalBackend: 'tmux' as const,
    },
  ];

  it('keeps catalog rows selectable regardless of runtime status', () => {
    const onSelectSession = vi.fn();
    render(
      <TerminalSessionDrawer
        open
        sessions={baseSessions}
        onClose={vi.fn()}
        onSelectSession={onSelectSession}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('terminal-session-drawer-select-herdr-missing'));
    fireEvent.click(screen.getByTestId('terminal-session-drawer-select-tmux-closed'));
    expect(onSelectSession).toHaveBeenNthCalledWith(1, 'herdr-missing');
    expect(onSelectSession).toHaveBeenNthCalledWith(2, 'tmux-closed');
  });

  it('renders catalog status without using it for availability', () => {
    render(<TerminalSessionDrawer open sessions={baseSessions} onClose={vi.fn()} onSelectSession={vi.fn()} onCloseSession={vi.fn()} onOpenQuickTabPicker={vi.fn()} />);
    expect(screen.getByTestId('terminal-session-drawer-row-herdr-missing').style.opacity).toBe('1');
    expect(screen.queryByTestId('terminal-session-drawer-retry-herdr-missing')).toBeNull();
  });

  it('pins CEO folder at the top of the drawer and renders CEO badge', () => {
    const sessionsWithCeo = [
      {
        id: 'zterm-1',
        stableKey: 'zterm-1',
        title: 'zterm-1',
        subtitle: 'Mac Studio · zterm-1',
        status: 'connected' as const,
        active: true,
        hostKey: 'daemon-a',
        hostLabel: 'Mac Studio',
        cwd: '/Volumes/extension/code/zterm',
        collab: { role: 'master' as const, displayName: 'Jenny' },
      },
      {
        id: 'workspace-1',
        stableKey: 'workspace-1',
        title: 'workspace-1',
        subtitle: 'Mac Studio · workspace-1',
        status: 'connected' as const,
        active: false,
        hostKey: 'daemon-a',
        hostLabel: 'Mac Studio',
        cwd: '/Users/fanzhang/.collab/workspace',
        collab: { role: 'ceo' as const, displayName: 'Bob' },
      },
    ];
    render(
      <TerminalSessionDrawer
        open
        filterMode="only-master"
        sessions={sessionsWithCeo}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );
    const badge = screen.getByTestId('terminal-session-drawer-collab-workspace-1');
    expect(badge.textContent).toBe('CEO');
    const folders = screen.getAllByTestId(/^terminal-session-drawer-folder-button-/);
    expect(folders[0]?.getAttribute('data-testid')).toBe(
      'terminal-session-drawer-folder-button-/Users/fanzhang/.collab/workspace',
    );
  });
});
