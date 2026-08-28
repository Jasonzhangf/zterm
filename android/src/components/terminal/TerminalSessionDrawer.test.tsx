// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalSessionDrawer } from './TerminalSessionDrawer';

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

  it('uses the compact two-thirds drawer width', () => {
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

    expect(screen.getByTestId('terminal-session-drawer').style.width).toBe('48vw');
    expect(screen.getByTestId('terminal-session-drawer').style.maxWidth).toBe('187px');
    expect(Number(screen.getByTestId('terminal-session-drawer').style.zIndex)).toBeGreaterThan(140);
    expect(Number(screen.getByTestId('terminal-session-drawer-overlay').style.zIndex)).toBeGreaterThan(140);
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
        onPreviewSelectionModeChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId('terminal-session-drawer-header').style.display).toBe('flex');
    expect(screen.getByText('Sessions')).toBeTruthy();
    expect(screen.queryByText('快速切换')).toBeNull();
    expect(screen.queryByText('左滑收起，点击进入，上下滑动浏览。')).toBeNull();
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

    const list = screen.getByTestId('terminal-session-drawer-list');
    expect(list.style.flex).toBe('0 1 auto');
    expect(list.style.minHeight).toBe('0px');
    expect(screen.getByTestId('terminal-session-drawer-add')).toBeTruthy();
  });

  it('keeps preview multi-select isolated from normal session switching', () => {
    const onSelectSession = vi.fn();
    const onTogglePreviewSession = vi.fn();
    const onPreviewSelectionModeChange = vi.fn();
    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        previewSelectionMode
        previewSelectedSessionIds={['s1']}
        onClose={vi.fn()}
        onSelectSession={onSelectSession}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onTogglePreviewSession={onTogglePreviewSession}
        onPreviewSelectionModeChange={onPreviewSelectionModeChange}
        onClearPreviewSelection={vi.fn()}
      />,
    );

    fireEvent.mouseDown(screen.getByTestId('terminal-session-drawer-select-s2'));
    fireEvent.click(screen.getByTestId('terminal-session-drawer-select-s2'));
    expect(onTogglePreviewSession).toHaveBeenCalledWith('s2');
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(screen.getByTestId('terminal-session-drawer-preview-check-s1').textContent).toBe('1');
    expect(screen.queryByTestId('terminal-session-drawer-add')).toBeNull();
    fireEvent.click(screen.getByText('完成 1/6'));
    expect(onPreviewSelectionModeChange).toHaveBeenCalledWith(false);
  });

  it('keeps each session close action available while preview multi-select is active', () => {
    const onCloseSession = vi.fn();
    const onSelectSession = vi.fn();
    const onTogglePreviewSession = vi.fn();

    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        previewSelectionMode
        previewSelectedSessionIds={['s1']}
        onClose={vi.fn()}
        onSelectSession={onSelectSession}
        onCloseSession={onCloseSession}
        onOpenQuickTabPicker={vi.fn()}
        onTogglePreviewSession={onTogglePreviewSession}
      />,
    );

    const closeButton = screen.getByTestId('terminal-session-drawer-close-s1');
    expect(closeButton).toBeTruthy();
    fireEvent.click(closeButton);

    expect(onCloseSession).toHaveBeenCalledWith('s1');
    expect(onCloseSession).toHaveBeenCalledTimes(1);
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(onTogglePreviewSession).not.toHaveBeenCalled();
  });

  it('keeps each session close action available while preview multi-select is active for touch activation', () => {
    const onCloseSession = vi.fn();
    const onSelectSession = vi.fn();
    const onTogglePreviewSession = vi.fn();

    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        previewSelectionMode
        previewSelectedSessionIds={['s1']}
        onClose={vi.fn()}
        onSelectSession={onSelectSession}
        onCloseSession={onCloseSession}
        onOpenQuickTabPicker={vi.fn()}
        onTogglePreviewSession={onTogglePreviewSession}
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
    expect(onTogglePreviewSession).not.toHaveBeenCalled();
  });

  it('toggles preview selection from the visible checkbox control', () => {
    const onSelectSession = vi.fn();
    const onTogglePreviewSession = vi.fn();
    render(
      <TerminalSessionDrawer
        open
        sessions={sessions}
        previewSelectionMode
        previewSelectedSessionIds={['s1']}
        onClose={vi.fn()}
        onSelectSession={onSelectSession}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onTogglePreviewSession={onTogglePreviewSession}
      />,
    );

    fireEvent.click(screen.getByTestId('terminal-session-drawer-preview-check-s2'));

    expect(onTogglePreviewSession).toHaveBeenCalledWith('s2');
    expect(onTogglePreviewSession).toHaveBeenCalledTimes(1);
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it('keeps unavailable preview checkbox controls disabled', () => {
    const onTogglePreviewSession = vi.fn();
    render(
      <TerminalSessionDrawer
        open
        sessions={[{ ...sessions[0], status: 'closed' }]}
        previewSelectionMode
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onTogglePreviewSession={onTogglePreviewSession}
      />,
    );

    const checkbox = screen.getByTestId('terminal-session-drawer-preview-check-s1');
    expect(checkbox.hasAttribute('disabled')).toBe(true);
    fireEvent.click(checkbox);
    expect(onTogglePreviewSession).not.toHaveBeenCalled();
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

  it('keeps an unavailable row non-selectable after a matching press', () => {
    const onSelectSession = vi.fn();
    const unavailableSessions = [{
      ...sessions[0],
      remoteMissing: true,
    }];

    render(
      <TerminalSessionDrawer
        open
        sessions={unavailableSessions}
        onClose={vi.fn()}
        onSelectSession={onSelectSession}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    const target = screen.getByTestId('terminal-session-drawer-select-s1');
    fireEvent.touchStart(target, {
      touches: [{ clientX: 120, clientY: 100 }],
    });
    fireEvent.touchEnd(target, {
      changedTouches: [{ clientX: 120, clientY: 100 }],
    });
    fireEvent.click(target, { detail: 1 });

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
      'add:capstart:terminal-session-drawer-add',
      'add:touchstart',
      'drawer:touchstart',
      'cap:end:terminal-session-drawer-add',
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
    expect(screen.getByTestId('terminal-session-drawer-host-rail').style.flexDirection).toBe('column');
    expect(screen.getByTestId('terminal-session-drawer-host-100.127.23.27:3333')).toBeTruthy();
    expect(screen.getByTestId('terminal-session-drawer-host-100.66.1.82:3333')).toBeTruthy();

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
            status: 'connected',
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
            status: 'connecting',
            active: true,
            hostKey: 'daemon-old',
            hostLabel: 'daemon-Macstudio-old',
          },
          {
            id: 'healthy-rcc',
      stableKey: `stable-healthy-rcc`,
            title: 'rcc',
            subtitle: 'Mac Studio · rcc',
            status: 'connected',
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

  it('greys remote-missing sessions and blocks selection', () => {
    const onSelectSession = vi.fn();
    render(
      <TerminalSessionDrawer
        open
        sessions={[
          {
            id: 'ghost',
      stableKey: `stable-ghost`,
            title: 'ghost',
            subtitle: '100.127.23.27:3333 · ghost',
            status: 'connected',
            remoteMissing: true,
            active: false,
            hostKey: '100.127.23.27:3333',
          },
        ]}
        onClose={vi.fn()}
        onSelectSession={onSelectSession}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    const row = screen.getByTestId('terminal-session-drawer-row-ghost');
    expect(row.textContent).toContain('unavailable');
    fireEvent.click(screen.getByTestId('terminal-session-drawer-select-ghost'));
    expect(onSelectSession).not.toHaveBeenCalled();
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
    expect(closeTarget.style.width).toBe('32px');
    expect(closeTarget.style.height).toBe('32px');
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

  it('keeps the new-session dialog styled with the existing --zterm-panel-* tokens (no bespoke colors)', () => {
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
    expect(dialogStyle).toContain('var(--zterm-panel-shadow)');
    expect(dialogStyle).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(dialogStyle).not.toMatch(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/);
  });
});

describe('TerminalSessionDrawer availability retry surface', () => {
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
      remoteMissing: true,
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

  it('does not render a retry button for usable tmux sessions', () => {
    render(
      <TerminalSessionDrawer
        open
        sessions={baseSessions}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onRetrySessionAvailability={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('terminal-session-drawer-retry-tmux-usable')).toBeNull();
    expect(screen.queryByTestId('terminal-session-drawer-retry-herdr-missing')).toBeTruthy();
    expect(screen.queryByTestId('terminal-session-drawer-retry-tmux-closed')).toBeTruthy();
  });

  it('triggers onRetrySessionAvailability for an unavailable Herdr row but not for usable tmux rows', () => {
    const onRetrySessionAvailability = vi.fn();
    render(
      <TerminalSessionDrawer
        open
        sessions={baseSessions}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onRetrySessionAvailability={onRetrySessionAvailability}
      />,
    );
    fireEvent.click(screen.getByTestId('terminal-session-drawer-retry-herdr-missing'));
    expect(onRetrySessionAvailability).toHaveBeenCalledWith('herdr-missing');
    expect(onRetrySessionAvailability).toHaveBeenCalledTimes(1);
  });

  it('disables the retry button while the row is reported as retrying and shows 重试中 label', () => {
    render(
      <TerminalSessionDrawer
        open
        sessions={baseSessions}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onRetrySessionAvailability={vi.fn()}
        retryingSessionIds={['herdr-missing']}
      />,
    );
    const button = screen.getByTestId('terminal-session-drawer-retry-herdr-missing') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('重试中');
  });

  it('keeps retry callback optional: drawer remains available without an explicit retry callback', () => {
    render(
      <TerminalSessionDrawer
        open
        sessions={baseSessions}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('terminal-session-drawer-retry-herdr-missing')).toBeNull();
  });

  it('does not mix tmux host identity with a Herdr row: missing row keeps the typed backend', () => {
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
    const herdrRow = screen.getByTestId('terminal-session-drawer-row-herdr-missing');
    expect(herdrRow.getAttribute('data-terminal-backend')).toBe('herdr');
    expect(herdrRow.getAttribute('data-availability')).toBe('remote-missing');
    const tmuxRow = screen.getByTestId('terminal-session-drawer-row-tmux-usable');
    expect(tmuxRow.getAttribute('data-terminal-backend')).toBe('tmux');
    expect(tmuxRow.getAttribute('data-availability')).toBe('available');
    const closedRow = screen.getByTestId('terminal-session-drawer-row-tmux-closed');
    expect(closedRow.getAttribute('data-availability')).toBe('closed');
  });
});
