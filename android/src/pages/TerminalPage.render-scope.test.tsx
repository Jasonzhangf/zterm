// @vitest-environment jsdom

import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, SessionGroupHistory } from '../lib/types';
import { STORAGE_KEYS } from '../lib/types';
import { TerminalPage } from './TerminalPage';

const debugSnapshotState = vi.hoisted(() => ({
  registrations: new Map<string, number>(),
  producers: new Map<string, () => unknown>(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'web',
  },
  registerPlugin: () => ({
    readText: vi.fn(async () => ({ value: '' })),
    writeText: vi.fn(async () => undefined),
  }),
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

vi.mock('../plugins/StoragePermissionPlugin', () => ({
  StoragePermissionPlugin: {
    check: vi.fn(async () => ({ granted: true, mode: 'manage-external-storage' })),
    request: vi.fn(async () => ({ granted: true, mode: 'manage-external-storage' })),
  },
}));

vi.mock('../lib/client-debug-snapshot', () => ({
  registerClientDebugSnapshotSource: vi.fn((sourceId: string, producer: () => unknown) => {
    debugSnapshotState.registrations.set(
      sourceId,
      (debugSnapshotState.registrations.get(sourceId) || 0) + 1,
    );
    debugSnapshotState.producers.set(sourceId, producer);
    return () => {
      debugSnapshotState.producers.delete(sourceId);
    };
  }),
  collectClientDebugSnapshot: vi.fn(() => ({})),
}));

const renderCounts = new Map<string, number>();

function bumpRenderCount(key: string) {
  renderCounts.set(key, (renderCounts.get(key) || 0) + 1);
}

function readRenderCount(key: string) {
  return renderCounts.get(key) || 0;
}

function readDebugSnapshotRegistrationCount(sourceId: string) {
  return debugSnapshotState.registrations.get(sourceId) || 0;
}

vi.mock('../components/terminal/TerminalHeader', () => ({
  TerminalHeader: ({
    showBackButton,
    sessions = [],
    paneGroups = [],
    splitVisible,
    onSwitchSession,
  }: {
    showBackButton?: boolean;
    sessions?: Array<{ id: string; sessionName: string }>;
    paneGroups?: Array<{ paneId: string; sessions: Array<{ id: string; sessionName: string }> }>;
    splitVisible?: boolean;
    onSwitchSession?: (sessionId: string) => void;
  }) => {
    bumpRenderCount('terminal-header');
    const visibleSessions = splitVisible ? paneGroups.flatMap((group) => group.sessions) : sessions;
    return (
      <div data-testid="terminal-header" data-show-back-button={showBackButton ? 'true' : 'false'}>
        {visibleSessions.map((session) => (
          <button key={session.id} type="button" onClick={() => onSwitchSession?.(session.id)}>
            {session.sessionName}
          </button>
        ))}
      </div>
    );
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
    live,
    onViewportChange,
    showAbsoluteLineNumbers,
  }: {
    sessionId: string;
    active?: boolean;
    live?: boolean;
    onViewportChange?: (sessionId: string, viewState: { mode: 'follow' | 'reading'; viewportEndIndex: number; viewportRows: number }) => void;
    showAbsoluteLineNumbers?: boolean;
  }) => {
    useEffect(() => {
      if (!live || !onViewportChange) {
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
        data-live={live ? 'true' : 'false'}
        data-show-line-numbers={showAbsoluteLineNumbers ? 'true' : 'false'}
      >
        renderer:{sessionId}
      </div>
    );
  },
}));

// TerminalPage reads attachment counts from SessionContext (badge/drawer).
// These page-level tests render TerminalPage directly without the app-level
// SessionProvider, so provide the minimal session facade the page consumes.
vi.mock('../contexts/SessionContext', () => ({
  useSession: () => ({
    getPendingAttachmentCount: () => 0,
    getPendingAttachments: () => [],
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
  };
}

function makeDebugMetrics(active: boolean) {
  return {
    uplinkBps: 0,
    downlinkBps: 0,
    renderHz: 0,
    pullHz: 0,
    transportBufferedBytes: 0,
    transportBackpressured: false,
    lastRenderCommitAt: 0,
    bufferPullActive: false,
    status: 'waiting' as const,
    active,
    updatedAt: 1,
  };
}

function renderTerminalPage(
  sessions: Session[],
  activeSession: Session | null,
  sessionGroups: SessionGroupHistory[] = [],
) {
  return render(
    <TerminalPage
      sessions={sessions}
      sessionGroups={sessionGroups}
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
    />,
  );
}

describe('TerminalPage renderer scope', () => {
  beforeEach(() => {
    renderCounts.clear();
    debugSnapshotState.registrations.clear();
    debugSnapshotState.producers.clear();
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

  it('renders only the active renderer when split is disabled and swaps mounted body on tab switch', () => {
    const session1 = makeSession('s1');
    const session2 = makeSession('s2');
    const view = renderTerminalPage([session1, session2], session1);

    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-active')).toBe('true');
    expect(screen.queryByTestId('terminal-view-s2')).toBeNull();

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
    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-live')).toBe('true');
    expect(screen.getByTestId('terminal-view-s2').getAttribute('data-active')).toBe('false');
    expect(screen.getByTestId('terminal-view-s2').getAttribute('data-live')).toBe('true');
    expect(screen.queryByTestId('terminal-view-s3')).toBeNull();
  });

  it('uses pane count as the single split width truth and ignores persisted skewed pane ratios', () => {
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify({
      panes: [
        { id: 'pane-1', size: 0.62, activeTabId: 'tab-s1', tabs: [{ id: 'tab-s1', sessionId: 's1' }] },
        { id: 'pane-2', size: 0.23, activeTabId: 'tab-s2', tabs: [{ id: 'tab-s2', sessionId: 's2' }] },
        { id: 'pane-3', size: 0.15, activeTabId: 'tab-s3', tabs: [{ id: 'tab-s3', sessionId: 's3' }] },
      ],
      activePaneId: 'pane-1',
    }));

    const session1 = makeSession('s1');
    const session2 = makeSession('s2');
    const session3 = makeSession('s3');

    renderTerminalPage([session1, session2, session3], session1);

    const panes = screen.getAllByTestId('terminal-pane-shell');
    expect(panes).toHaveLength(3);
    expect(panes.map((pane) => pane.style.flex)).toEqual([
      '0.3333333333333333 1 0%',
      '0.3333333333333333 1 0%',
      '0.3333333333333333 1 0%',
    ]);
    expect(panes.map((pane) => pane.style.height)).toEqual(['100%', '100%', '100%']);
  });

  it('gives the split pane strip full height so each visible renderer can measure and scroll independently', () => {
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify({
      panes: [
        { id: 'pane-1', size: 0.5, activeTabId: 'tab-s1', tabs: [{ id: 'tab-s1', sessionId: 's1' }] },
        { id: 'pane-2', size: 0.5, activeTabId: 'tab-s2', tabs: [{ id: 'tab-s2', sessionId: 's2' }] },
      ],
      activePaneId: 'pane-1',
    }));
    const session1 = makeSession('s1');
    const session2 = makeSession('s2');

    renderTerminalPage([session1, session2], session1);

    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-live')).toBe('true');
    expect(screen.getByTestId('terminal-view-s2').getAttribute('data-live')).toBe('true');
    expect(screen.getAllByTestId('terminal-pane-shell').map((pane) => pane.style.height)).toEqual(['100%', '100%']);
  });

  it('switches the tapped split tab inside its owning pane instead of only changing global active session', () => {
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify({
      panes: [
        { id: 'pane-1', size: 0.5, activeTabId: 'tab-s1', tabs: [{ id: 'tab-s1', sessionId: 's1' }] },
        {
          id: 'pane-2',
          size: 0.5,
          activeTabId: 'tab-s2',
          tabs: [
            { id: 'tab-s2', sessionId: 's2' },
            { id: 'tab-s3', sessionId: 's3' },
          ],
        },
      ],
      activePaneId: 'pane-1',
    }));
    const session1 = makeSession('s1');
    const session2 = makeSession('s2');
    const session3 = makeSession('s3');
    const onSwitchSession = vi.fn();

    render(
      <TerminalPage
        sessions={[session1, session2, session3]}
        activeSession={session1}
        getSessionDebugMetrics={(sessionId) => makeDebugMetrics(sessionId === 's1')}
        onSwitchSession={onSwitchSession}
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
      />,
    );

    expect(screen.queryByTestId('terminal-view-s3')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'tmux-s3' }));

    expect(onSwitchSession).toHaveBeenCalledWith('s3');
    expect(screen.getByTestId('terminal-view-s3').getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-live')).toBe('true');
    expect(screen.getByTestId('terminal-view-s3').getAttribute('data-live')).toBe('true');
    expect(screen.queryByTestId('terminal-view-s2')).toBeNull();
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

    fireEvent.click(screen.getByRole('button', { name: '状态' }));
    expect(screen.getByText('渲染')).not.toBeNull();
    expect(screen.getByText('follow')).not.toBeNull();
    expect(screen.getByTestId('terminal-debug-active-flag').textContent).toBe('connected / waiting · A');
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
      />,
    );

    expect(screen.getByText('reading')).not.toBeNull();
    expect(screen.getByTestId('terminal-debug-active-flag').textContent).toBe('connected / waiting · A');
    expect(screen.getByTestId('terminal-view-s2').getAttribute('data-show-line-numbers')).toBe('false');
  });

  it('toggles debug overlay off and on from the 状态 quickbar button without changing line numbers', () => {
    const session1 = makeSession('s1');
    renderTerminalPage([session1], session1);

    expect(screen.queryByText('渲染')).toBeNull();
    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-show-line-numbers')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: '状态' }));

    expect(screen.getByText('渲染')).not.toBeNull();
    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-show-line-numbers')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: '状态' }));

    expect(screen.queryByText('渲染')).toBeNull();
    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-show-line-numbers')).toBe('false');
  });

  it('shows per-visible-pane performance metrics in split debug overlay', () => {
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify({
      panes: [
        { id: 'pane-1', size: 0.25, activeTabId: 'tab-s1', tabs: [{ id: 'tab-s1', sessionId: 's1' }] },
        { id: 'pane-2', size: 0.25, activeTabId: 'tab-s2', tabs: [{ id: 'tab-s2', sessionId: 's2' }] },
        { id: 'pane-3', size: 0.25, activeTabId: 'tab-s3', tabs: [{ id: 'tab-s3', sessionId: 's3' }] },
        { id: 'pane-4', size: 0.25, activeTabId: 'tab-s4', tabs: [{ id: 'tab-s4', sessionId: 's4' }] },
      ],
      activePaneId: 'pane-1',
    }));

    const sessions = ['s1', 's2', 's3', 's4'].map(makeSession);
    render(
      <TerminalPage
        sessions={sessions}
        activeSession={sessions[0]}
        getSessionDebugMetrics={(sessionId) => ({
          ...makeDebugMetrics(sessionId === 's1'),
          downlinkBps: sessionId === 's3' ? 4096 : 1024,
          renderHz: sessionId === 's2' ? 7.5 : 15,
          pullHz: sessionId === 's4' ? 2.5 : 10,
          transportBufferedBytes: sessionId === 's4' ? 256 * 1024 : 0,
          transportBackpressured: sessionId === 's4',
          lastRenderCommitAt: 1000,
        })}
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
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '状态' }));

    expect(screen.getByText('窗格')).not.toBeNull();
    expect(screen.getByText('x4')).not.toBeNull();
    expect(screen.queryByTestId('terminal-debug-pane-metrics')).toBeNull();
    expect(screen.queryByTestId('terminal-debug-pane-metric-s1')).toBeNull();
    expect(screen.queryByTestId('terminal-debug-pane-metric-s2')).toBeNull();
    expect(screen.queryByTestId('terminal-debug-pane-metric-s3')).toBeNull();
    expect(screen.queryByTestId('terminal-debug-pane-metric-s4')).toBeNull();
  });

  it('toggles absolute line numbers independently from the 行号 quickbar button', () => {
    const session1 = makeSession('s1');
    renderTerminalPage([session1], session1);

    expect(screen.queryByText('渲染')).toBeNull();
    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-show-line-numbers')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: '行号' }));
    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-show-line-numbers')).toBe('true');
    expect(screen.queryByText('渲染')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '行号' }));
    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-show-line-numbers')).toBe('false');
  });

  it('does not repeat live session notifications when the visible pane id set is unchanged', () => {
    const session1 = makeSession('s1');
    const session2 = makeSession('s2');
    const onLiveSessionIdsChange = vi.fn();

    const view = render(
      <TerminalPage
        sessions={[session1, session2]}
        activeSession={session1}
        getSessionDebugMetrics={(sessionId) => makeDebugMetrics(sessionId === 's1')}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        onLiveSessionIdsChange={onLiveSessionIdsChange}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    expect(onLiveSessionIdsChange).toHaveBeenCalledTimes(1);
    expect(onLiveSessionIdsChange).toHaveBeenLastCalledWith(['s1']);

    view.rerender(
      <TerminalPage
        sessions={[
          session1,
          {
            ...session2,
            state: 'reconnecting',
            lastError: 'probe timeout',
          },
        ]}
        activeSession={session1}
        getSessionDebugMetrics={(sessionId) => makeDebugMetrics(sessionId === 's1')}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        onLiveSessionIdsChange={onLiveSessionIdsChange}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    expect(onLiveSessionIdsChange).toHaveBeenCalledTimes(1);
  });

  it('switches live session notifications to the new active tab in non-split mode without keeping the previous tab live', () => {
    const session1 = makeSession('s1');
    const session2 = makeSession('s2');
    const onLiveSessionIdsChange = vi.fn();

    const view = render(
      <TerminalPage
        sessions={[session1, session2]}
        activeSession={session1}
        getSessionDebugMetrics={(sessionId) => makeDebugMetrics(sessionId === 's1')}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        onLiveSessionIdsChange={onLiveSessionIdsChange}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    expect(onLiveSessionIdsChange).toHaveBeenCalledTimes(1);
    expect(onLiveSessionIdsChange).toHaveBeenLastCalledWith(['s1']);

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
        onLiveSessionIdsChange={onLiveSessionIdsChange}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    expect(onLiveSessionIdsChange).toHaveBeenCalledTimes(2);
    expect(onLiveSessionIdsChange).toHaveBeenLastCalledWith(['s2']);
    expect(onLiveSessionIdsChange).not.toHaveBeenLastCalledWith(['s1', 's2']);
  });

  it('clears live session notifications on unmount so SessionContext does not keep refreshing stale panes', () => {
    const session1 = makeSession('s1');
    const onLiveSessionIdsChange = vi.fn();

    const view = render(
      <TerminalPage
        sessions={[session1]}
        activeSession={session1}
        getSessionDebugMetrics={(sessionId) => makeDebugMetrics(sessionId === 's1')}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        onLiveSessionIdsChange={onLiveSessionIdsChange}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    expect(onLiveSessionIdsChange).toHaveBeenCalledWith(['s1']);

    view.unmount();

    expect(onLiveSessionIdsChange).toHaveBeenLastCalledWith([]);
  });

  it('keeps the back button visible when split mode is enabled so users can still return to Connections', () => {
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify({
      panes: [
        { id: 'pane-1', size: 0.5, activeTabId: 'tab-s1', tabs: [{ id: 'tab-s1', sessionId: 's1' }] },
        { id: 'pane-2', size: 0.5, activeTabId: 'tab-s2', tabs: [{ id: 'tab-s2', sessionId: 's2' }] },
      ],
      activePaneId: 'pane-1',
    }));
    const session1 = makeSession('s1');
    const session2 = makeSession('s2');

    renderTerminalPage([session1, session2], session1);

    expect(screen.getByTestId('terminal-header').getAttribute('data-show-back-button')).toBe('true');
  });

  it('keeps an empty split pane visible and opens the scoped session picker when tapped', () => {
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify({
      panes: [
        { id: 'pane-1', size: 0.5, activeTabId: 'tab-s1', tabs: [{ id: 'tab-s1', sessionId: 's1' }] },
        { id: 'pane-2', size: 0.5, activeTabId: '', tabs: [] },
      ],
      activePaneId: 'pane-1',
    }));
    const session1 = makeSession('s1');
    const onOpenQuickTabPicker = vi.fn();

    render(
      <TerminalPage
        sessions={[session1]}
        activeSession={session1}
        getSessionDebugMetrics={(sessionId) => makeDebugMetrics(sessionId === 's1')}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={onOpenQuickTabPicker}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    fireEvent.click(screen.getByTestId('terminal-empty-pane-pane-2'));

    expect(onOpenQuickTabPicker).toHaveBeenCalledWith('pane-2', undefined, undefined);
    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-live')).toBe('true');
    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-active')).toBe('false');
  });

  it('does not reregister terminal-page snapshot source when keyboardInset changes', async () => {
    const originalVirtualKeyboard = (navigator as Navigator & { virtualKeyboard?: unknown }).virtualKeyboard;
    const geometryListeners = new Set<() => void>();
    const virtualKeyboard = {
      overlaysContent: false,
      boundingRect: { height: 0 },
      addEventListener: vi.fn((event: string, listener: () => void) => {
        if (event === 'geometrychange') {
          geometryListeners.add(listener);
        }
      }),
      removeEventListener: vi.fn((event: string, listener: () => void) => {
        if (event === 'geometrychange') {
          geometryListeners.delete(listener);
        }
      }),
    };
    Object.defineProperty(navigator, 'virtualKeyboard', {
      configurable: true,
      value: virtualKeyboard,
    });

    const session1 = makeSession('s1');
    renderTerminalPage([session1], session1);

    expect(readDebugSnapshotRegistrationCount('terminal-page')).toBe(1);

    await act(async () => {
      virtualKeyboard.boundingRect.height = 240;
      for (const listener of geometryListeners) {
        listener();
      }
      await Promise.resolve();
    });

    expect(readDebugSnapshotRegistrationCount('terminal-page')).toBe(1);

    const producer = debugSnapshotState.producers.get('terminal-page');
    expect(producer).toBeTypeOf('function');
    expect(producer?.()).toMatchObject({
      keyboardInset: 240,
    });

    await act(async () => {
      for (let i = 0; i < 50; i += 1) {
        virtualKeyboard.boundingRect.height = 200 + (i % 5) * 30;
        for (const listener of geometryListeners) {
          listener();
        }
      }
      await Promise.resolve();
    });

    expect(readDebugSnapshotRegistrationCount('terminal-page')).toBe(1);

    Object.defineProperty(navigator, 'virtualKeyboard', {
      configurable: true,
      value: originalVirtualKeyboard,
    });
  });
});
