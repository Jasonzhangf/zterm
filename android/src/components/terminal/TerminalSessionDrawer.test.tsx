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
      title: 'demo',
      subtitle: '100.127.23.27:3333 · demo',
      status: 'connected' as const,
      paneLabel: 'P1',
      active: true,
    },
    {
      id: 's2',
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

    fireEvent.click(screen.getByTestId('terminal-session-drawer-row-s2'));
    expect(onSelectSession).toHaveBeenCalledWith('s2');

    fireEvent.touchEnd(screen.getByTestId('terminal-session-drawer-add'), {
      changedTouches: [{ clientX: 180, clientY: 560 }],
    });
    expect(screen.getByTestId('terminal-session-drawer-new-session-dialog')).toBeTruthy();
    expect(onOpenQuickTabPicker).not.toHaveBeenCalled();
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
    });
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
    });
  });

  it('does not show host rail when all sessions share the same hostKey', () => {
    const singleHostSessions = [
      {
        id: 's1',
        title: 'demo',
        subtitle: '100.127.23.27:3333 · demo',
        status: 'connected' as const,
        paneLabel: 'P1',
        active: true,
        hostKey: '100.127.23.27:3333',
      },
      {
        id: 's2',
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

    expect(() => screen.getByTestId('terminal-session-drawer-host-rail')).toThrow();
    expect(screen.getByTestId('terminal-session-drawer-row-s1')).toBeTruthy();
    expect(screen.getByTestId('terminal-session-drawer-row-s2')).toBeTruthy();
  });

  it('preserves caller-provided order (opened before unopened)', () => {
    // 排序由 TerminalPage 负责；drawer 只保持传入顺序
    const orderedSessions = [
      { id: 'o-bravo', title: 'bravo', subtitle: 'host · bravo', status: 'connected' as const, paneLabel: 'P1', active: true, hostKey: 'host:3333' },
      { id: 'u-alpha', title: 'alpha', subtitle: 'host · alpha', status: 'idle' as const, hostKey: 'host:3333' },
      { id: 'u-zeta', title: 'zeta', subtitle: 'host · zeta', status: 'idle' as const, hostKey: 'host:3333' },
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
    fireEvent.click(row);
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
});
