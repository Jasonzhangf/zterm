// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../lib/types';
import { TerminalHeader } from './TerminalHeader';

function makeSession(id: string): Session {
  return {
    id,
    hostId: `host-${id}`,
    connectionName: `conn-${id}`,
    bridgeHost: '100.120.0.1',
    bridgePort: 3333,
    sessionName: `tmux-${id}`,
    title: `tab-${id}`,
    ws: null,
    state: 'connected',
    hasUnread: false,
    createdAt: 1,
    buffer: {
      lines: [],
      gapRanges: [],
      startIndex: 0,
      endIndex: 0,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 0,
      cols: 80,
      rows: 24,
      cursorKeysApp: false,
      updateKind: 'replace',
      revision: 1,
    },
  };
}

describe('TerminalHeader split pane menu', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = vi.fn();
  }

  it('opens pane menu on long press and assigns tab to requested pane', () => {
    vi.useFakeTimers();
    const sessions = [makeSession('s1'), makeSession('s2')];
    const onAssignSessionToPane = vi.fn();

    render(
      <TerminalHeader
        sessions={sessions}
        activeSession={sessions[0]}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={vi.fn()}
        onSwitchSession={vi.fn()}
        onRenameSession={vi.fn()}
        splitVisible
        sessionPaneAssignments={{ s1: 'primary', s2: 'secondary' }}
        onAssignSessionToPane={onAssignSessionToPane}
        onMoveSessionToOtherPane={vi.fn()}
      />,
    );

    const targetTab = screen.getByRole('button', { name: /tmux-s2/i });
    fireEvent.mouseDown(targetTab);
    act(() => {
      vi.advanceTimersByTime(700);
    });

    fireEvent.click(screen.getByRole('button', { name: '归到左屏' }));
    expect(onAssignSessionToPane).toHaveBeenCalledWith('s2', 'primary');
  });

  it('opens pane menu on two-finger tap for current tab and moves it to the other pane', () => {
    const sessions = [makeSession('s1'), makeSession('s2')];
    const onMoveSessionToOtherPane = vi.fn();

    render(
      <TerminalHeader
        sessions={sessions}
        activeSession={sessions[0]}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={vi.fn()}
        onSwitchSession={vi.fn()}
        onRenameSession={vi.fn()}
        splitVisible
        sessionPaneAssignments={{ s1: 'primary', s2: 'secondary' }}
        onAssignSessionToPane={vi.fn()}
        onMoveSessionToOtherPane={onMoveSessionToOtherPane}
      />,
    );

    const activeTab = screen.getByRole('button', { name: /tmux-s1/i });
    fireEvent.touchStart(activeTab, {
      touches: [
        { identifier: 1, clientX: 10, clientY: 10 },
        { identifier: 2, clientX: 20, clientY: 10 },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: '当前 tab 移到另一屏' }));
    expect(onMoveSessionToOtherPane).toHaveBeenCalledWith('s1');
  });

  it('keeps tab manager reachable via long press on the plus button', () => {
    vi.useFakeTimers();
    const sessions = [makeSession('s1')];
    const onOpenTabManager = vi.fn();

    render(
      <TerminalHeader
        sessions={sessions}
        activeSession={sessions[0]}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={onOpenTabManager}
        onSwitchSession={vi.fn()}
        onRenameSession={vi.fn()}
      />,
    );

    const plusButton = screen.getByRole('button', { name: '+' });
    fireEvent.mouseDown(plusButton);
    vi.advanceTimersByTime(700);

    expect(onOpenTabManager).toHaveBeenCalledTimes(1);
  });

  it('opens tab manager on long press of a tab when split is not visible', () => {
    vi.useFakeTimers();
    const sessions = [makeSession('s1'), makeSession('s2')];
    const onOpenTabManager = vi.fn();

    render(
      <TerminalHeader
        sessions={sessions}
        activeSession={sessions[0]}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={onOpenTabManager}
        onSwitchSession={vi.fn()}
        onRenameSession={vi.fn()}
      />,
    );

    const targetTab = screen.getByRole('button', { name: /tmux-s2/i });
    fireEvent.mouseDown(targetTab);
    act(() => {
      vi.advanceTimersByTime(700);
    });
    fireEvent.click(targetTab);

    expect(onOpenTabManager).toHaveBeenCalledTimes(1);
  });
});
