// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('renders a close button on the active tab and forwards close callback', () => {
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
    expect(onCloseSession).toHaveBeenCalledWith('session-1');
    expect(onSwitchSession).not.toHaveBeenCalled();
  });
});
