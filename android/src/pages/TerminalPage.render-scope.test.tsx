// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../lib/types';
import { STORAGE_KEYS } from '../lib/types';
import { TerminalPage } from './TerminalPage';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'web',
  },
}));

vi.mock('@capacitor/keyboard', () => ({
  Keyboard: {
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
    hide: vi.fn(async () => undefined),
    show: vi.fn(async () => undefined),
  },
}));

vi.mock('../plugins/ImeAnchorPlugin', () => ({
  ImeAnchor: {
    show: vi.fn(async () => ({})),
    hide: vi.fn(async () => undefined),
    blur: vi.fn(async () => undefined),
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
  },
}));

vi.mock('../components/terminal/TerminalHeader', () => ({
  TerminalHeader: () => <div data-testid="terminal-header" />,
}));

vi.mock('../components/terminal/TabManagerSheet', () => ({
  TabManagerSheet: () => null,
}));

vi.mock('../components/terminal/SessionScheduleSheet', () => ({
  SessionScheduleSheet: () => null,
}));

vi.mock('../components/terminal/TerminalQuickBar', () => ({
  TerminalQuickBar: () => <div data-testid="terminal-quickbar" />,
}));

vi.mock('../components/TerminalView', () => ({
  TerminalView: ({
    sessionId,
    active,
  }: {
    sessionId: string;
    active?: boolean;
  }) => (
    <div
      data-testid={`terminal-view-${sessionId}`}
      data-session-id={sessionId}
      data-active={active ? 'true' : 'false'}
    >
      renderer:{sessionId}
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

function renderTerminalPage(sessions: Session[], activeSession: Session | null) {
  return render(
    <TerminalPage
      sessions={sessions}
      activeSession={activeSession}
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
}

describe('TerminalPage renderer scope', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('renders only the active session renderer when split is disabled and switches body with active session', () => {
    const session1 = makeSession('s1');
    const session2 = makeSession('s2');
    const view = renderTerminalPage([session1, session2], session1);

    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-active')).toBe('true');
    expect(screen.queryByTestId('terminal-view-s2')).toBeNull();

    view.rerender(
      <TerminalPage
        sessions={[session1, session2]}
        activeSession={session2}
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

    expect(screen.getByTestId('terminal-view-s2').getAttribute('data-active')).toBe('true');
    expect(screen.queryByTestId('terminal-view-s1')).toBeNull();
  });

  it('renders only split-visible renderers when split mode is enabled', () => {
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify({
      splitEnabled: true,
      splitSecondarySessionId: 's2',
      splitPaneAssignments: {
        s1: 'primary',
        s2: 'secondary',
        s3: 'secondary',
      },
    }));

    const session1 = makeSession('s1');
    const session2 = makeSession('s2');
    const session3 = makeSession('s3');

    renderTerminalPage([session1, session2, session3], session1);

    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('terminal-view-s2').getAttribute('data-active')).toBe('false');
    expect(screen.queryByTestId('terminal-view-s3')).toBeNull();
  });
});
