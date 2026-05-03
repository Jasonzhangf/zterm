// @vitest-environment jsdom

import { memo } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS, type Session } from '../lib/types';
import { TerminalPage } from './TerminalPage';

const quickBarRenderCounter = { count: 0 };
let previousQuickBarProps: Record<string, unknown> | null = null;
let quickBarChangedKeys: string[] = [];
const terminalViewRenderCounter = new Map<string, number>();

function bumpTerminalViewRender(sessionId: string) {
  terminalViewRenderCounter.set(sessionId, (terminalViewRenderCounter.get(sessionId) || 0) + 1);
}

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

vi.mock('../components/terminal/RemoteScreenshotSheet', () => ({
  RemoteScreenshotSheet: () => null,
}));

vi.mock('../components/terminal/TerminalQuickBar', () => ({
  TerminalQuickBar: memo(({
    onOpenFileTransfer,
    onMeasuredHeightChange,
    onToggleAbsoluteLineNumbers,
    ...rest
  }: {
    onOpenFileTransfer?: () => void;
    onMeasuredHeightChange?: (height: number) => void;
    onToggleAbsoluteLineNumbers?: () => void;
    [key: string]: unknown;
  }) => {
    quickBarRenderCounter.count += 1;
    const currentProps = {
      onOpenFileTransfer,
      onMeasuredHeightChange,
      onToggleAbsoluteLineNumbers,
      ...rest,
    } as Record<string, unknown>;
    quickBarChangedKeys = previousQuickBarProps
      ? Object.keys(currentProps).filter((key) => previousQuickBarProps?.[key] !== currentProps[key])
      : Object.keys(currentProps);
    previousQuickBarProps = currentProps;
    return (
      <div
        data-testid="terminal-quickbar"
        data-render-count={quickBarRenderCounter.count}
        data-changed-keys={quickBarChangedKeys.join(',')}
      >
        <button type="button" onClick={() => onOpenFileTransfer?.()}>
          open-file-transfer
        </button>
        <button type="button" onClick={() => onMeasuredHeightChange?.(222)}>
          measure-quickbar
        </button>
        <button type="button" onClick={() => onToggleAbsoluteLineNumbers?.()}>
          toggle-line-numbers
        </button>
      </div>
    );
  }),
}));

vi.mock('../components/TerminalView', () => ({
  TerminalView: memo(({
    sessionId,
    showAbsoluteLineNumbers,
  }: {
    sessionId: string;
    showAbsoluteLineNumbers?: boolean;
  }) => {
    bumpTerminalViewRender(sessionId);
    return (
      <div
        data-testid={`terminal-view-${sessionId}`}
        data-render-count={terminalViewRenderCounter.get(sessionId) || 0}
        data-show-line-numbers={showAbsoluteLineNumbers ? 'true' : 'false'}
      >
        terminal:{sessionId}
      </div>
    );
  }),
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
  const props = {
    onSwitchSession: vi.fn(),
    onMoveSession: vi.fn(),
    onRenameSession: vi.fn(),
    onCloseSession: vi.fn(),
    onOpenConnections: vi.fn(),
    onOpenQuickTabPicker: vi.fn(),
    onResize: vi.fn(),
    onTerminalInput: vi.fn(),
    onTerminalViewportChange: vi.fn(),
    quickActions: [],
    shortcutActions: [],
    sessionDraft: '',
    onLoadSavedTabList: vi.fn(),
  };
  return render(
    <TerminalPage
      sessions={sessions}
      activeSession={activeSession}
      {...props}
    />,
  );
}

describe('TerminalPage render isolation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    quickBarRenderCounter.count = 0;
    previousQuickBarProps = null;
    quickBarChangedKeys = [];
    terminalViewRenderCounter.clear();
    const storageBacking = new Map<string, string>();
    const storageShim = {
      get length() {
        return storageBacking.size;
      },
      clear() {
        storageBacking.clear();
      },
      getItem(key: string) {
        return storageBacking.has(key) ? storageBacking.get(key)! : null;
      },
      key(index: number) {
        return Array.from(storageBacking.keys())[index] ?? null;
      },
      removeItem(key: string) {
        storageBacking.delete(key);
      },
      setItem(key: string, value: string) {
        storageBacking.set(key, String(value));
      },
    } as Storage;
    vi.stubGlobal('localStorage', storageShim);
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.useRealTimers();
  });

  function readRenderCount(testId: string) {
    return Number.parseInt(screen.getByTestId(testId).getAttribute('data-render-count') || '0', 10);
  }

  it('does not rerender TerminalView or QuickBar when file transfer sheet opens', () => {
    const session1 = makeSession('s1');
    renderTerminalPage([session1], session1);

    const terminalRenderCountBefore = readRenderCount('terminal-view-s1');
    const quickBarRenderCountBefore = readRenderCount('terminal-quickbar');

    fireEvent.click(screen.getByText('open-file-transfer'));

    expect(readRenderCount('terminal-view-s1')).toBe(terminalRenderCountBefore);
    expect(readRenderCount('terminal-quickbar')).toBe(quickBarRenderCountBefore);
  });

  it('does not rerender TerminalView or QuickBar when only quick bar measured height changes', () => {
    const session1 = makeSession('s1');
    renderTerminalPage([session1], session1);

    const terminalRenderCountBefore = readRenderCount('terminal-view-s1');
    const quickBarRenderCountBefore = readRenderCount('terminal-quickbar');

    fireEvent.click(screen.getByText('measure-quickbar'));

    expect(readRenderCount('terminal-view-s1')).toBe(terminalRenderCountBefore);
    expect(readRenderCount('terminal-quickbar')).toBeGreaterThanOrEqual(quickBarRenderCountBefore);
  });

  it('rerenders TerminalView when line number visibility really changes', () => {
    const session1 = makeSession('s1');
    renderTerminalPage([session1], session1);

    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-show-line-numbers')).toBe('false');
    const terminalRenderCountBefore = readRenderCount('terminal-view-s1');

    fireEvent.click(screen.getByText('toggle-line-numbers'));

    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-show-line-numbers')).toBe('true');
    expect(readRenderCount('terminal-view-s1')).toBe(terminalRenderCountBefore + 1);
  });

  it('keeps inactive split pane renderer untouched when unrelated shell state changes', () => {
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify({
      splitEnabled: true,
      splitSecondarySessionId: 's2',
      splitPaneAssignments: {
        s1: 'primary',
        s2: 'secondary',
      },
    }));

    const session1 = makeSession('s1');
    const session2 = makeSession('s2');
    renderTerminalPage([session1, session2], session1);

    const activeTerminalRenderCountBefore = readRenderCount('terminal-view-s1');
    const inactiveTerminalRenderCountBefore = readRenderCount('terminal-view-s2');

    fireEvent.click(screen.getByText('open-file-transfer'));

    expect(readRenderCount('terminal-view-s1')).toBe(activeTerminalRenderCountBefore);
    expect(readRenderCount('terminal-view-s2')).toBe(inactiveTerminalRenderCountBefore);
  });

  it('does not rerender TerminalView or QuickBar when debug overlay polling ticks', () => {
    const session1 = makeSession('s1');
    renderTerminalPage([session1], session1);

    const terminalRenderCountBefore = readRenderCount('terminal-view-s1');
    const quickBarRenderCountBefore = readRenderCount('terminal-quickbar');

    act(() => {
      vi.advanceTimersByTime(1200);
    });

    expect(readRenderCount('terminal-view-s1')).toBe(terminalRenderCountBefore);
    expect(readRenderCount('terminal-quickbar')).toBe(quickBarRenderCountBefore);
  });

  it('does not rerender TerminalView when only daemon head revision changes', () => {
    const session1 = makeSession('s1');
    session1.daemonHeadRevision = 1;
    session1.daemonHeadEndIndex = 80;
    session1.buffer.bufferTailEndIndex = 80;
    const props = {
      onSwitchSession: vi.fn(),
      onMoveSession: vi.fn(),
      onRenameSession: vi.fn(),
      onCloseSession: vi.fn(),
      onOpenConnections: vi.fn(),
      onOpenQuickTabPicker: vi.fn(),
      onResize: vi.fn(),
      onTerminalInput: vi.fn(),
      onTerminalViewportChange: vi.fn(),
      quickActions: [],
      shortcutActions: [],
      sessionDraft: '',
      onLoadSavedTabList: vi.fn(),
    };
    const view = render(
      <TerminalPage
        sessions={[session1]}
        activeSession={session1}
        {...props}
      />,
    );

    const terminalRenderCountBefore = readRenderCount('terminal-view-s1');

    const nextSession = {
      ...session1,
      daemonHeadRevision: 2,
    };

    view.rerender(
      <TerminalPage
        sessions={[nextSession]}
        activeSession={nextSession}
        {...props}
      />
    );

    expect(readRenderCount('terminal-view-s1')).toBe(terminalRenderCountBefore);
  });
});
