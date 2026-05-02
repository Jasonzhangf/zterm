// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../lib/types';
import { TerminalHeader } from './TerminalHeader';

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

function makeSession(): Session {
  return {
    id: 'session-1',
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
      cursor: null,
      updateKind: 'replace',
      revision: 1,
    },
  };
}

describe('TerminalHeader', () => {
  it('uses the UI-shell top inset as the single header padding truth', () => {
    const session = makeSession();
    const { container } = render(
      <TerminalHeader
        sessions={[session]}
        activeSession={session}
        topInsetPx={24}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={vi.fn()}
        onSwitchSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
      />,
    );

    const root = container.firstElementChild as HTMLElement | null;
    expect(root).toBeTruthy();
    expect(root?.style.padding).toBe('44px 6px 6px');
  });

  it('renders a close button on the active tab and requires explicit second tap to close', () => {
    const session = makeSession();
    const onCloseSession = vi.fn();
    const onSwitchSession = vi.fn();

    render(
      <TerminalHeader
        sessions={[session]}
        activeSession={session}
        topInsetPx={0}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={vi.fn()}
        onSwitchSession={onSwitchSession}
        onRenameSession={vi.fn()}
        onCloseSession={onCloseSession}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '关闭当前 tab' })[0]!);
    expect(onCloseSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: '关闭当前 tab' })[0]!);
    expect(onCloseSession).toHaveBeenCalledWith('session-1', 'terminal-header-close-button');
    expect(onSwitchSession).not.toHaveBeenCalled();
  });

  it('does not let the same tap that switches tabs instantly close the newly active tab', () => {
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
        sessions={[session1, session2]}
        activeSession={session1}
        topInsetPx={0}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={vi.fn()}
        onSwitchSession={onSwitchSession}
        onRenameSession={vi.fn()}
        onCloseSession={onCloseSession}
      />,
    );

    fireEvent.click(screen.getByText('zterm-2'));
    expect(onSwitchSession).toHaveBeenCalledWith('session-2');

    rerender(
      <TerminalHeader
        sessions={[session1, session2]}
        activeSession={session2}
        topInsetPx={0}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={vi.fn()}
        onSwitchSession={onSwitchSession}
        onRenameSession={vi.fn()}
        onCloseSession={onCloseSession}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '关闭当前 tab' })[0]!);
    expect(onCloseSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: '关闭当前 tab' })[0]!);
    expect(onCloseSession).toHaveBeenCalledWith('session-2', 'terminal-header-close-button');
  });

  it('clears close confirmation if the second tap does not happen in time', () => {
    const session = makeSession();
    const onCloseSession = vi.fn();

    render(
      <TerminalHeader
        sessions={[session]}
        activeSession={session}
        topInsetPx={0}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={vi.fn()}
        onSwitchSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={onCloseSession}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '关闭当前 tab' })[0]!);
    act(() => {
      vi.advanceTimersByTime(1700);
    });
    fireEvent.click(screen.getAllByRole('button', { name: '关闭当前 tab' })[0]!);
    expect(onCloseSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: '关闭当前 tab' })[0]!);
    expect(onCloseSession).toHaveBeenCalledWith('session-1', 'terminal-header-close-button');
  });
});
