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
});
