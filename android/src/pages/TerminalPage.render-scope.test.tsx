// @vitest-environment jsdom

import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

const renderCounts = new Map<string, number>();

function bumpRenderCount(key: string) {
  renderCounts.set(key, (renderCounts.get(key) || 0) + 1);
}

function readRenderCount(key: string) {
  return renderCounts.get(key) || 0;
}

vi.mock('../components/terminal/TerminalHeader', () => ({
  TerminalHeader: () => {
    bumpRenderCount('terminal-header');
    return <div data-testid="terminal-header" />;
  },
}));

vi.mock('../components/terminal/TabManagerSheet', () => ({
  TabManagerSheet: ({ open }: { open?: boolean }) => {
    bumpRenderCount('tab-manager-sheet');
    return open ? <div data-testid="tab-manager-sheet" /> : null;
  },
}));

vi.mock('../components/terminal/SessionScheduleSheet', () => ({
  SessionScheduleSheet: () => null,
}));

vi.mock('../components/terminal/TerminalQuickBar', () => ({
  TerminalQuickBar: ({
    onToggleDebugOverlay,
    onToggleAbsoluteLineNumbers,
  }: {
    onToggleDebugOverlay?: () => void;
    onToggleAbsoluteLineNumbers?: () => void;
  }) => (
    <div data-testid="terminal-quickbar">
      <button type="button" onClick={() => onToggleDebugOverlay?.()}>
        状态
      </button>
      <button type="button" onClick={() => onToggleAbsoluteLineNumbers?.()}>
        行号
      </button>
    </div>
  ),
}));

vi.mock('../components/TerminalView', () => ({
  TerminalView: ({
    sessionId,
    active,
    onViewportChange,
    showAbsoluteLineNumbers,
  }: {
    sessionId: string;
    active?: boolean;
    onViewportChange?: (sessionId: string, viewState: { mode: 'follow' | 'reading'; viewportEndIndex: number; viewportRows: number }) => void;
    showAbsoluteLineNumbers?: boolean;
  }) => {
    useEffect(() => {
      if (!active || !onViewportChange) {
        return;
      }
      onViewportChange(sessionId, {
        mode: sessionId === 's2' ? 'reading' : 'follow',
        viewportEndIndex: 24,
        viewportRows: 24,
      });
    }, [active, onViewportChange, sessionId]);

    return (
      <div
        data-testid={`terminal-view-${sessionId}`}
        data-session-id={sessionId}
        data-active={active ? 'true' : 'false'}
        data-show-line-numbers={showAbsoluteLineNumbers ? 'true' : 'false'}
      >
        renderer:{sessionId}
      </div>
    );
  },
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

function makeDebugMetrics(active: boolean) {
  return {
    uplinkBps: 0,
    downlinkBps: 0,
    renderHz: 0,
    pullHz: 0,
    bufferPullActive: false,
    status: 'waiting' as const,
    active,
    updatedAt: 1,
  };
}

function renderTerminalPage(sessions: Session[], activeSession: Session | null) {
  return render(
    <TerminalPage
      sessions={sessions}
      activeSession={activeSession}
      getSessionDebugMetrics={(sessionId) => makeDebugMetrics(activeSession?.id === sessionId)}
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
    renderCounts.clear();
    vi.useFakeTimers();
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
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('keeps inactive renderers mounted but hides them when split is disabled and switches body with active session', () => {
    const session1 = makeSession('s1');
    const session2 = makeSession('s2');
    const view = renderTerminalPage([session1, session2], session1);

    const activePane = screen.getByTestId('terminal-view-s1').parentElement as HTMLElement;
    const inactivePane = screen.getByTestId('terminal-view-s2').parentElement as HTMLElement;
    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('terminal-view-s2').getAttribute('data-active')).toBe('false');
    expect(activePane.style.visibility).toBe('visible');
    expect(inactivePane.style.visibility).toBe('hidden');

    view.rerender(
      <TerminalPage
        sessions={[session1, session2]}
        activeSession={session2}
        getSessionDebugMetrics={(sessionId) => makeDebugMetrics(sessionId === 's2')}
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

    const nextActivePane = screen.getByTestId('terminal-view-s2').parentElement as HTMLElement;
    const nextInactivePane = screen.getByTestId('terminal-view-s1').parentElement as HTMLElement;
    expect(screen.getByTestId('terminal-view-s2').getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-active')).toBe('false');
    expect(nextActivePane.style.visibility).toBe('visible');
    expect(nextInactivePane.style.visibility).toBe('hidden');
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

  it('does not rerender header when only debug overlay polling ticks', () => {
    const session1 = makeSession('s1');
    renderTerminalPage([session1], session1);

    const headerRenderCountBefore = readRenderCount('terminal-header');

    act(() => {
      vi.advanceTimersByTime(1200);
    });

    expect(readRenderCount('terminal-header')).toBe(headerRenderCountBefore);
  });

  it('uses debug overlay only for overlay observability while line numbers stay independently controlled', () => {
    const session1 = makeSession('s1');
    const session2 = makeSession('s2');
    const view = renderTerminalPage([session1, session2], session1);

    expect(screen.getByText('渲染')).not.toBeNull();
    expect(screen.getByText('follow')).not.toBeNull();
    expect(screen.getByTestId('terminal-debug-active-flag').textContent).toBe('1');
    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-show-line-numbers')).toBe('false');

    view.rerender(
      <TerminalPage
        sessions={[session1, session2]}
        activeSession={session2}
        getSessionDebugMetrics={(sessionId) => makeDebugMetrics(sessionId === 's2')}
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

    expect(screen.getByText('reading')).not.toBeNull();
    expect(screen.getByTestId('terminal-debug-active-flag').textContent).toBe('1');
    expect(screen.getByTestId('terminal-view-s2').getAttribute('data-show-line-numbers')).toBe('false');
  });

  it('toggles debug overlay off and on from the 状态 quickbar button without changing line numbers', () => {
    const session1 = makeSession('s1');
    renderTerminalPage([session1], session1);

    expect(screen.getByText('渲染')).not.toBeNull();
    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-show-line-numbers')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: '状态' }));

    expect(screen.queryByText('渲染')).toBeNull();
    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-show-line-numbers')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: '状态' }));

    expect(screen.getByText('渲染')).not.toBeNull();
    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-show-line-numbers')).toBe('false');
  });

  it('toggles absolute line numbers independently from the 行号 quickbar button', () => {
    const session1 = makeSession('s1');
    renderTerminalPage([session1], session1);

    expect(screen.getByText('渲染')).not.toBeNull();
    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-show-line-numbers')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: '行号' }));
    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-show-line-numbers')).toBe('true');
    expect(screen.getByText('渲染')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '行号' }));
    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-show-line-numbers')).toBe('false');
  });
});
