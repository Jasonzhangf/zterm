// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session, TerminalResizeHandler, TerminalViewportChangeHandler } from '../lib/types';
import { TerminalPage } from './TerminalPage';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'web',
  },
  registerPlugin: () => ({
    show: vi.fn(async () => ({})),
    hide: vi.fn(async () => undefined),
    blur: vi.fn(async () => undefined),
    getState: vi.fn(async () => ({})),
    debugEmitInput: vi.fn(async () => ({})),
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
  }),
}));

vi.mock('@capacitor/keyboard', () => ({
  Keyboard: {
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
    hide: vi.fn(async () => undefined),
    show: vi.fn(async () => undefined),
  },
}));

vi.mock('../components/terminal/TerminalHeader', () => ({
  TerminalHeader: () => <div data-testid="terminal-header" />,
}));

vi.mock('../components/terminal/TabManagerSheet', () => ({
  TabManagerSheet: () => null,
}));

vi.mock('../components/terminal/TerminalQuickBar', () => ({
  TerminalQuickBar: () => <div data-testid="terminal-quickbar" />,
}));

vi.mock('../components/TerminalView', () => ({
  TerminalView: ({
    sessionId,
    active,
    onInput,
    onResize,
    onViewportChange,
  }: {
    sessionId: string;
    active?: boolean;
    onInput?: (sessionId: string, data: string) => void;
    onResize?: TerminalResizeHandler;
    onViewportChange?: TerminalViewportChangeHandler;
  }) => (
    <div data-testid={`terminal-view-${sessionId}`} data-active={active ? 'true' : 'false'}>
      <button type="button" onClick={() => onInput?.(sessionId, `typed:${sessionId}`)}>
        input-{sessionId}
      </button>
      <button type="button" onClick={() => onResize?.(sessionId, 81, 25)}>
        resize-{sessionId}
      </button>
      <button
        type="button"
        onClick={() =>
          onViewportChange?.(sessionId, { mode: 'follow', viewportEndIndex: 120, viewportRows: 24 })
        }
      >
        viewport-{sessionId}
      </button>
    </div>
  ),
}));

function makeSession(id: string): Session {
  return {
    id,
    hostId: `host-${id}`,
    connectionName: `conn-${id}`,
    bridgeHost: '100.127.23.27',
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
      viewportEndIndex: 0,
      cols: 80,
      rows: 24,
      cursorKeysApp: false,
      updateKind: 'replace',
      revision: 1,
    },
  };
}

describe('TerminalPage tab isolation', () => {
  afterEach(() => {
    cleanup();
  });

  it('keeps every tab view mounted and only flips active visibility on switch', () => {
    const sessions = [makeSession('s1'), makeSession('s2')];
    const view = render(
      <TerminalPage
        sessions={sessions}
        activeSession={sessions[0]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('terminal-view-s2').getAttribute('data-active')).toBe('false');

    view.rerender(
      <TerminalPage
        sessions={sessions}
        activeSession={sessions[1]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-active')).toBe('false');
    expect(screen.getByTestId('terminal-view-s2').getAttribute('data-active')).toBe('true');
  });

  it('routes input/resize/viewport callbacks with explicit sessionId', async () => {
    const sessions = [makeSession('s1'), makeSession('s2')];
    const onTerminalInput = vi.fn();
    const onResize = vi.fn();
    const onTerminalViewportChange = vi.fn();

    render(
      <TerminalPage
        sessions={sessions}
        activeSession={sessions[1]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={onResize}
        onTerminalInput={onTerminalInput}
        onTerminalViewportChange={onTerminalViewportChange}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    screen.getByText('input-s2').click();
    screen.getByText('resize-s2').click();
    screen.getByText('viewport-s2').click();

    expect(onTerminalInput).toHaveBeenCalledWith('s2', 'typed:s2');
    expect(onResize).toHaveBeenCalledWith('s2', 81, 25);
    expect(onTerminalViewportChange).toHaveBeenCalledWith('s2', {
      mode: 'follow',
      viewportEndIndex: 120,
      viewportRows: 24,
    });
  });
});
