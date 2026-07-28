// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../lib/types';
import { TerminalHeader, type TerminalHeaderSessionItem } from './TerminalHeader';

if (!HTMLElement.prototype.scrollIntoView) {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

function makeSession(id?: string): Session {
  return {
    id: id || 'session-1',
    hostId: 'host-1',
    connectionName: 'local',
    bridgeHost: '127.0.0.1',
    bridgePort: 3333,
    sessionName: 'zterm',
    title: 'zterm',
    ws: null,
    state: 'connected',
    hasUnread: false,
    createdAt: 1,
  };
}


function toHeaderSession(session: Session): TerminalHeaderSessionItem {
  return {
    id: session.id,
    bridgeHost: session.bridgeHost,
    bridgePort: session.bridgePort,
    sessionName: session.sessionName,
    customName: session.customName,
    resolvedPath: session.resolvedPath,
    resolvedRelayTransport: session.resolvedRelayTransport,
  };
}
describe('TerminalHeader', () => {
  it('uses the UI-shell top inset as the single header padding truth', () => {
    const session = makeSession();
    const { container } = render(
      <TerminalHeader
        sessions={[toHeaderSession(session)]}
        activeSession={toHeaderSession(session)}
        topInsetPx={24}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={vi.fn()}
        onSwitchSession={vi.fn()}
        onCloseSession={vi.fn()}
      />,
    );

    const root = container.firstElementChild as HTMLElement | null;
    expect(root).toBeTruthy();
    expect(root?.style.padding).toBe('44px 6px 6px');
  });

  it('uses the compact split-landscape header profile when split is visible in landscape', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 1200,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: 700,
    });
    const session = makeSession();
    const { container } = render(
      <TerminalHeader
        sessions={[toHeaderSession(session)]}
        activeSession={toHeaderSession(session)}
        topInsetPx={0}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={vi.fn()}
        onSwitchSession={vi.fn()}
        onCloseSession={vi.fn()}
        splitVisible
        paneGroups={[{
          paneId: 'pane-1',
          size: 1,
          sessions: [toHeaderSession(session)],
          activeSessionId: session.id,
          isActivePane: true,
        }]}
      />,
    );

    const root = container.firstElementChild as HTMLElement | null;
    expect(root?.style.padding).toBe('1px 4px 2px');
  });

  it('uses only the real status-bar inset above split tabs', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 1200,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: 700,
    });
    const session = makeSession();
    const { container } = render(
      <TerminalHeader
        sessions={[toHeaderSession(session)]}
        activeSession={toHeaderSession(session)}
        topInsetPx={16}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={vi.fn()}
        onSwitchSession={vi.fn()}
        onCloseSession={vi.fn()}
        splitVisible
        paneGroups={[{
          paneId: 'pane-1',
          size: 1,
          sessions: [toHeaderSession(session)],
          activeSessionId: session.id,
          isActivePane: true,
        }]}
      />,
    );

    const root = container.firstElementChild as HTMLElement | null;
    expect(root?.style.padding).toBe('17px 4px 2px');
  });

  it('renders a close button on the active tab and closes on single tap', () => {
    const session = makeSession();
    const onCloseSession = vi.fn();
    const onSwitchSession = vi.fn();

    render(
      <TerminalHeader
        sessions={[toHeaderSession(session)]}
        activeSession={toHeaderSession(session)}
        topInsetPx={0}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={vi.fn()}
        onSwitchSession={onSwitchSession}
        onCloseSession={onCloseSession}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '关闭当前 tab' })[0]!);
    expect(onCloseSession).toHaveBeenCalledWith('session-1', 'terminal-header-close-button');
    expect(onSwitchSession).not.toHaveBeenCalled();
  });

  it('toggles relay mode from the active path badge without adding header width', () => {
    const session = makeSession();
    session.resolvedPath = 'tailscale';
    const onForceRelaySession = vi.fn();
    const onUseAutoSession = vi.fn();

    const { rerender } = render(
      <TerminalHeader
        sessions={[toHeaderSession(session)]}
        activeSession={toHeaderSession(session)}
        topInsetPx={0}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={vi.fn()}
        onSwitchSession={vi.fn()}
        onCloseSession={vi.fn()}
        onForceRelaySession={onForceRelaySession}
        onUseAutoSession={onUseAutoSession}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '强制 Relay 重连当前 tab' }));
    expect(screen.getByRole('button', { name: '强制 Relay 重连当前 tab' }).style.position).toBe('absolute');
    expect(onForceRelaySession).toHaveBeenCalledWith('session-1');
    expect(onUseAutoSession).not.toHaveBeenCalled();

    const relaySession = { ...session, resolvedPath: 'rtc-relay' as const };
    rerender(
      <TerminalHeader
        sessions={[toHeaderSession(relaySession)]}
        activeSession={toHeaderSession(relaySession)}
        topInsetPx={0}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={vi.fn()}
        onSwitchSession={vi.fn()}
        onCloseSession={vi.fn()}
        onForceRelaySession={onForceRelaySession}
        onUseAutoSession={onUseAutoSession}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '切回 Auto 重连当前 tab' }));
    expect(onUseAutoSession).toHaveBeenCalledWith('session-1');
  });

  it('shows TURN on the active path badge when relay RTC resolves through TURN', () => {
    const session = makeSession();
    session.resolvedPath = 'rtc-relay';
    session.resolvedRelayTransport = 'turn';

    render(
      <TerminalHeader
        sessions={[toHeaderSession(session)]}
        activeSession={toHeaderSession(session)}
        topInsetPx={0}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={vi.fn()}
        onSwitchSession={vi.fn()}
        onCloseSession={vi.fn()}
        onForceRelaySession={vi.fn()}
        onUseAutoSession={vi.fn()}
      />,
    );

    const badge = screen.getByRole('button', { name: '切回 Auto 重连当前 tab' });
    expect(badge.textContent).toBe('TURN');
  });

  it('keeps active-tab close working on touch events used by touch devices', () => {
    const session = makeSession();
    const onCloseSession = vi.fn();

    render(
      <TerminalHeader
        sessions={[toHeaderSession(session)]}
        activeSession={toHeaderSession(session)}
        topInsetPx={0}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={vi.fn()}
        onSwitchSession={vi.fn()}
        onCloseSession={onCloseSession}
      />,
    );

    const closeButton = screen.getAllByRole('button', { name: '关闭当前 tab' })[0]!;
    fireEvent.touchEnd(closeButton);
    expect(onCloseSession).toHaveBeenCalledWith('session-1', 'terminal-header-close-button');
  });

  it('switches tab first and only closes after explicit close tap on the newly active tab', () => {
    const session1 = makeSession();
    const session2 = {
      ...makeSession(),
      id: 'session-2',
      hostId: 'host-2',
      sessionName: 'zterm-2',
      title: 'zterm-2',
    };
    const onCloseSession = vi.fn();
    const onSwitchSession = vi.fn();

    const { rerender } = render(
      <TerminalHeader
        sessions={[toHeaderSession(session1), toHeaderSession(session2)]}
        activeSession={toHeaderSession(session1)}
        topInsetPx={0}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={vi.fn()}
        onSwitchSession={onSwitchSession}
        onCloseSession={onCloseSession}
      />,
    );

    fireEvent.click(screen.getByText('zterm-2'));
    expect(onSwitchSession).toHaveBeenCalledWith('session-2');

    rerender(
      <TerminalHeader
        sessions={[toHeaderSession(session1), toHeaderSession(session2)]}
        activeSession={toHeaderSession(session2)}
        topInsetPx={0}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={vi.fn()}
        onSwitchSession={onSwitchSession}
        onCloseSession={onCloseSession}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '关闭当前 tab' }));
    expect(onCloseSession).toHaveBeenCalledWith('session-2', 'terminal-header-close-button');
  });

  it('does not render close buttons for non-active tabs', () => {
    const session1 = makeSession();
    const session2 = {
      ...makeSession(),
      id: 'session-2',
      hostId: 'host-2',
      sessionName: 'zterm-2',
      title: 'zterm-2',
    };

    render(
      <TerminalHeader
        sessions={[toHeaderSession(session1), toHeaderSession(session2)]}
        activeSession={toHeaderSession(session1)}
        topInsetPx={0}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={vi.fn()}
        onSwitchSession={vi.fn()}
        onCloseSession={vi.fn()}
      />,
    );

    expect(screen.getAllByRole('button', { name: '关闭当前 tab' })).toHaveLength(1);
  });

  it('does not open the tab manager when long pressing a non-split tab', () => {
    const session = makeSession();
    const onOpenTabManager = vi.fn();

    render(
      <TerminalHeader
        sessions={[toHeaderSession(session)]}
        activeSession={toHeaderSession(session)}
        topInsetPx={0}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={onOpenTabManager}
        onSwitchSession={vi.fn()}
        onCloseSession={vi.fn()}
      />,
    );

    fireEvent.mouseDown(screen.getByText('zterm'));
    vi.advanceTimersByTime(1000);
    fireEvent.mouseUp(screen.getByText('zterm'));

    expect(onOpenTabManager).not.toHaveBeenCalled();
  });

  it('opens the pane menu on long press only when split is enabled', () => {
    const session = makeSession();

    render(
      <TerminalHeader
        sessions={[toHeaderSession(session)]}
        activeSession={toHeaderSession(session)}
        topInsetPx={0}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={vi.fn()}
        onSwitchSession={vi.fn()}
        onCloseSession={vi.fn()}
        splitVisible
        onAssignSessionToPane={vi.fn()}
      />,
    );

    const tabButton = screen.getAllByTitle('Tap: switch · Long press tab: pane menu · Two-finger tap current tab: move menu')[0]!;
    fireEvent.mouseDown(tabButton);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    fireEvent.mouseUp(tabButton);

    expect(screen.getByText('当前在 P1')).toBeTruthy();
  });

  it('does not treat a horizontal tab-strip touch scroll as a tap on the touch-start tab', () => {
    const session1 = makeSession();
    const session2 = {
      ...makeSession(),
      id: 'session-2',
      hostId: 'host-2',
      sessionName: 'zterm-2',
      title: 'zterm-2',
    };
    const session3 = {
      ...makeSession(),
      id: 'session-3',
      hostId: 'host-3',
      sessionName: 'zterm-3',
      title: 'zterm-3',
    };
    const onSwitchSession = vi.fn();

    render(
      <TerminalHeader
        sessions={[toHeaderSession(session1), toHeaderSession(session2), toHeaderSession(session3)]}
        activeSession={toHeaderSession(session3)}
        topInsetPx={0}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={vi.fn()}
        onSwitchSession={onSwitchSession}
        onCloseSession={vi.fn()}
      />,
    );

    const touchedTab = screen.getByText('zterm-2').closest('button');
    expect(touchedTab).toBeTruthy();

    fireEvent.touchStart(touchedTab!, {
      touches: [{ clientX: 220, clientY: 24 }],
    });
    fireEvent.touchMove(touchedTab!, {
      touches: [{ clientX: 96, clientY: 28 }],
    });
    fireEvent.touchEnd(touchedTab!, {
      changedTouches: [{ clientX: 96, clientY: 28 }],
    });

    // Mobile browsers can still synthesize a click on the original touch-start
    // target after a horizontal scroll gesture unless the component gates it.
    fireEvent.click(touchedTab!);

    expect(onSwitchSession).not.toHaveBeenCalled();
  });

  it('renders real pane targets in split tab long-press menu and routes assignment to the chosen pane', () => {
    const session1 = makeSession();
    const session2 = {
      ...makeSession(),
      id: 'session-2',
      hostId: 'host-2',
      sessionName: 'zterm-2',
      title: 'zterm-2',
    };
    const onAssignSessionToPane = vi.fn();
    const onOpenTabManager = vi.fn();

    render(
      <TerminalHeader
        sessions={[toHeaderSession(session1), toHeaderSession(session2)]}
        activeSession={toHeaderSession(session1)}
        topInsetPx={0}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={onOpenTabManager}
        onSwitchSession={vi.fn()}
        onCloseSession={vi.fn()}
        splitVisible
        paneGroups={[
          {
            paneId: 'pane-1',
            size: 0.5,
            sessions: [toHeaderSession(session1)],
            activeSessionId: session1.id,
            isActivePane: true,
          },
          {
            paneId: 'pane-2',
            size: 0.5,
            sessions: [toHeaderSession(session2)],
            activeSessionId: session2.id,
            isActivePane: false,
          },
        ]}
        onAssignSessionToPane={onAssignSessionToPane}
      />,
    );

    const tabButton = screen.getAllByTitle('Tap: switch · Long press tab: pane menu · Two-finger tap current tab: move menu')[0]!;
    fireEvent.mouseDown(tabButton);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    fireEvent.mouseUp(tabButton);

    expect(screen.getByText('当前在 P1')).toBeTruthy();
    const changeButton = screen.getByText('更改 P1 Session');
    fireEvent.click(changeButton);
    expect(onOpenTabManager).toHaveBeenCalledWith('pane-1');

    fireEvent.mouseDown(tabButton);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    fireEvent.mouseUp(tabButton);

    const moveButton = screen.getByText('移到 P2');
    fireEvent.click(moveButton);
    expect(onAssignSessionToPane).toHaveBeenCalledWith('session-1', 'pane-2');
  });

  it('uses pane size as the shared split-width truth', () => {
    const session = makeSession();
    const { container } = render(
      <TerminalHeader
        sessions={[toHeaderSession(session)]}
        activeSession={toHeaderSession(session)}
        topInsetPx={0}
        showBackButton={false}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={vi.fn()}
        onSwitchSession={vi.fn()}
        onCloseSession={vi.fn()}
        splitVisible
        paneGroups={[
          {
            paneId: 'pane-1',
            size: 0.25,
            sessions: [toHeaderSession(session)],
            activeSessionId: session.id,
            isActivePane: true,
          },
        ]}
      />,
    );

    expect(container.innerHTML).toContain('flex: 0.25 1 0%');
  });

  it('lays out split pane tab groups in one horizontal row', () => {
    const session1 = makeSession('session-1');
    const session2 = makeSession('session-2');
    const { container } = render(
      <TerminalHeader
        sessions={[toHeaderSession(session1), toHeaderSession(session2)]}
        activeSession={toHeaderSession(session1)}
        topInsetPx={0}
        showBackButton={false}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={vi.fn()}
        onSwitchSession={vi.fn()}
        onCloseSession={vi.fn()}
        splitVisible
        paneGroups={[
          {
            paneId: 'pane-1',
            size: 0.5,
            sessions: [toHeaderSession(session1)],
            activeSessionId: session1.id,
            isActivePane: true,
          },
          {
            paneId: 'pane-2',
            size: 0.5,
            sessions: [toHeaderSession(session2)],
            activeSessionId: session2.id,
            isActivePane: false,
          },
        ]}
      />,
    );

    const root = container.firstElementChild as HTMLElement;
    expect(root.style.display).toBe('flex');
    expect(root.style.alignItems).toBe('stretch');
    expect(root.style.width).toBe('100%');
    expect(container.innerHTML).toContain('flex: 0.5 1 0%');
  });

});
