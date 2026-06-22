// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalSessionDrawer } from './TerminalSessionDrawer';

afterEach(() => {
  cleanup();
});

describe('TerminalSessionDrawer', () => {
  const sessions = [
    {
      id: 's1',
      title: 'rcc',
      subtitle: '100.127.23.27:3333 · rcc',
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

    fireEvent.click(screen.getByTestId('terminal-session-drawer-add'));
    expect(onOpenQuickTabPicker).toHaveBeenCalledTimes(1);
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
        title: 'rcc',
        subtitle: '100.127.23.27:3333 · rcc',
        status: 'connected' as const,
        paneLabel: 'P1',
        active: true,
        hostKey: '100.127.23.27:3333',
        hostLabel: 'rcc-machine',
      },
      {
        id: 's2',
        title: 'android',
        subtitle: '100.66.1.82:3333 · android',
        status: 'connecting' as const,
        paneLabel: 'P2',
        active: false,
        hostKey: '100.127.23.27:3333',
        hostLabel: 'rcc-machine',
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

    // 应显示 host rail
    expect(screen.getByTestId('terminal-session-drawer-host-rail')).toBeTruthy();
    // 两个 host pill
    expect(screen.getByTestId('terminal-session-drawer-host-100.127.23.27:3333')).toBeTruthy();
    expect(screen.getByTestId('terminal-session-drawer-host-100.66.1.82:3333')).toBeTruthy();

    // 默认选中 active session 所在 host（rcc-machine），应显示 s1、s2，不显示 s3
    expect(screen.getByTestId('terminal-session-drawer-row-s1')).toBeTruthy();
    expect(screen.getByTestId('terminal-session-drawer-row-s2')).toBeTruthy();
    expect(() => screen.getByTestId('terminal-session-drawer-row-s3')).toThrow();

    // 点击 mac-dev host pill → 显示 s3
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

  it('does not show host rail when all sessions share the same hostKey', () => {
    const singleHostSessions = [
      {
        id: 's1',
        title: 'rcc',
        subtitle: '100.127.23.27:3333 · rcc',
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

    // 无 host rail
    expect(() => screen.getByTestId('terminal-session-drawer-host-rail')).toThrow();
    // 所有 session 都直接展示
    expect(screen.getByTestId('terminal-session-drawer-row-s1')).toBeTruthy();
    expect(screen.getByTestId('terminal-session-drawer-row-s2')).toBeTruthy();
  });
});
