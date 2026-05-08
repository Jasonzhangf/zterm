// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS, type Session, TerminalResizeHandler, TerminalViewportChangeHandler } from '../lib/types';
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
  TerminalHeader: ({
    onOpenQuickTabPicker,
  }: {
    onOpenQuickTabPicker?: (paneId?: string) => void;
  }) => (
    <div data-testid="terminal-header">
      <button type="button" onClick={() => onOpenQuickTabPicker?.('pane-2')}>
        open-quick-picker-pane-2
      </button>
    </div>
  ),
}));

vi.mock('../components/terminal/TabManagerSheet', () => ({
  TabManagerSheet: () => null,
}));

vi.mock('../components/terminal/TerminalQuickBar', () => ({
  TerminalQuickBar: ({
    activeSessionId,
    sessionDraft,
    onSendSequence,
    onSessionDraftChange,
    onSessionDraftSend,
    splitAvailable,
    splitVisible,
    onToggleSplitLayout,
    onCycleSplitPane,
    onMeasuredHeightChange,
  }: {
    activeSessionId?: string;
    sessionDraft?: string;
    onSendSequence?: (sequence: string) => void;
    onSessionDraftChange?: (value: string) => void;
    onSessionDraftSend?: (value: string) => void;
    splitAvailable?: boolean;
    splitVisible?: boolean;
    onToggleSplitLayout?: () => void;
    onCycleSplitPane?: () => void;
    onMeasuredHeightChange?: (height: number) => void;
  }) => (
    <div
      data-testid="terminal-quickbar"
      data-active-session-id={activeSessionId || ''}
      data-session-draft={sessionDraft || ''}
      data-split-available={splitAvailable ? 'true' : 'false'}
      data-split-visible={splitVisible ? 'true' : 'false'}
    >
      <button type="button" onClick={() => onSendSequence?.('quick-seq')}>send-quick</button>
      <button type="button" onClick={() => onSessionDraftChange?.('draft-next')}>change-draft</button>
      <button type="button" onClick={() => onSessionDraftSend?.('draft-send')}>send-draft</button>
      <button type="button" onClick={() => onToggleSplitLayout?.()}>toggle-split</button>
      <button type="button" onClick={() => onCycleSplitPane?.()}>cycle-split</button>
      <button type="button" onClick={() => onMeasuredHeightChange?.(180)}>measure-quickbar</button>
    </div>
  ),
}));

vi.mock('../components/TerminalView', () => ({
  TerminalView: ({
    sessionId,
    active,
    onInput,
    onResize,
    onWidthModeChange,
    onViewportChange,
    onSwipeTab,
    widthMode,
  }: {
    sessionId: string;
    active?: boolean;
    onInput?: (sessionId: string, data: string) => void;
    onResize?: TerminalResizeHandler;
    onWidthModeChange?: (sessionId: string, mode: 'adaptive-phone' | 'mirror-fixed', cols?: number | null) => void;
    onViewportChange?: TerminalViewportChangeHandler;
    onSwipeTab?: (sessionId: string, direction: 'previous' | 'next') => void;
    widthMode?: 'adaptive-phone' | 'mirror-fixed';
  }) => (
    <div
      data-testid={`terminal-view-${sessionId}`}
      data-active={active ? 'true' : 'false'}
      data-has-oninput={onInput ? 'true' : 'false'}
      data-has-onresize={onResize ? 'true' : 'false'}
      data-has-onwidthmodechange={onWidthModeChange ? 'true' : 'false'}
      data-has-onviewport={onViewportChange ? 'true' : 'false'}
      data-has-onswipetab={onSwipeTab ? 'true' : 'false'}
      data-width-mode={widthMode || 'adaptive-phone'}
    >
      <button type="button" onClick={() => onInput?.(sessionId, `typed:${sessionId}`)}>
        input-{sessionId}
      </button>
      <button type="button" onClick={() => onResize?.(sessionId, 81, 25)}>
        resize-{sessionId}
      </button>
      <button type="button" onClick={() => onWidthModeChange?.(sessionId, widthMode || 'adaptive-phone', 81)}>
        widthmode-{sessionId}
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

describe('TerminalPage tab isolation', () => {
  beforeEach(() => {
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
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        width: 1200,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('renders only the active tab view when split is disabled and switches body with active session', () => {
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
    expect(screen.queryByTestId('terminal-view-s2')).toBeNull();

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

    expect(screen.getByTestId('terminal-view-s2').getAttribute('data-active')).toBe('true');
    expect(screen.queryByTestId('terminal-view-s1')).toBeNull();
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

  it('only wires width-mode callback for active pane session', async () => {
    const sessions = [makeSession('s1'), makeSession('s2')];
    const onTerminalWidthModeChange = vi.fn();

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
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        onTerminalWidthModeChange={onTerminalWidthModeChange}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
        terminalWidthMode="mirror-fixed"
      />,
    );

    expect(screen.getByTestId('terminal-view-s2').getAttribute('data-has-onwidthmodechange')).toBe('true');
    screen.getByText('widthmode-s2').click();
    expect(onTerminalWidthModeChange).toHaveBeenCalledWith('s2', 'mirror-fixed', 81);
  });

  it('does not emit a second visible-range callback when viewport state already carries mode truth', async () => {
    const sessions = [makeSession('s1')];
    const onTerminalViewportChange = vi.fn();

    render(
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
        onTerminalViewportChange={onTerminalViewportChange}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    screen.getByText('viewport-s1').click();

    expect(onTerminalViewportChange).toHaveBeenCalledTimes(1);
    expect(onTerminalViewportChange).toHaveBeenCalledWith('s1', {
      mode: 'follow',
      viewportEndIndex: 120,
      viewportRows: 24,
    });
  });

  it('reserves terminal shell bottom space from the measured quick bar height so input area is not occluded', async () => {
    const sessions = [makeSession('s1')];

    render(
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

    fireEvent.click(screen.getByText('measure-quickbar'));

    await waitFor(() => {
      const shell = screen.getByTestId('terminal-stage-shell').parentElement as HTMLElement | null;
      expect(shell).toBeTruthy();
      expect(shell?.getAttribute('style') || '').not.toContain('padding-bottom: 180px;');
      expect(screen.getByTestId('terminal-stage-shell').getAttribute('style') || '').toContain('bottom: 180px;');
    });
  });

  it('keeps pane-target truth when applying an explicit non-P1 pane attach intent', async () => {
    const sessions = [makeSession('s1'), makeSession('s2'), makeSession('s3')];
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify({
      panes: [
        { id: 'pane-1', size: 0.5, activeTabId: 'tab-s1', tabs: [{ id: 'tab-s1', sessionId: 's1' }] },
        { id: 'pane-2', size: 0.5, activeTabId: 'tab-s2', tabs: [{ id: 'tab-s2', sessionId: 's2' }] },
      ],
      activePaneId: 'pane-1',
    }));

    const view = render(
      <TerminalPage
        sessions={[sessions[0], sessions[1]]}
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

    view.rerender(
      <TerminalPage
        sessions={[sessions[0], sessions[1], sessions[2]]}
        activeSession={sessions[2]}
        pendingPaneAttachIntent={{ sessionIds: ['s3'], paneId: 'pane-2', nonce: 99 }}
        onPaneAttachIntentApplied={vi.fn()}
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

    await waitFor(() => {
      expect(screen.getByTestId('terminal-view-s3')).toBeTruthy();
    });
    const panes = Array.from(document.querySelectorAll('[data-testid="terminal-pane-shell"]'));
    const pane2 = panes.find((node) => node.getAttribute('data-pane-id') === 'pane-2') as HTMLElement | undefined;
    expect(pane2?.querySelector('[data-testid="terminal-view-s3"]')).toBeTruthy();
  });

  it('uses the active pane session as the single UI owner in split mode even before runtime active catches up', () => {
    const sessions = [makeSession('s1'), makeSession('s2')];
    const onQuickActionInput = vi.fn();
    const onSessionDraftChange = vi.fn();
    const onSessionDraftSend = vi.fn();
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify({
      panes: [
        { id: 'pane-1', size: 0.5, activeTabId: 'tab-s1', tabs: [{ id: 'tab-s1', sessionId: 's1' }] },
        { id: 'pane-2', size: 0.5, activeTabId: 'tab-s2', tabs: [{ id: 'tab-s2', sessionId: 's2' }] },
      ],
      activePaneId: 'pane-2',
    }));

    render(
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
        onQuickActionInput={onQuickActionInput}
        onSessionDraftChange={onSessionDraftChange}
        onSessionDraftSend={onSessionDraftSend}
        onLoadSavedTabList={vi.fn()}
      />,
    );

    expect(screen.getByTestId('terminal-quickbar').getAttribute('data-active-session-id')).toBe('s2');
    fireEvent.click(screen.getByText('send-quick'));
    fireEvent.click(screen.getByText('change-draft'));
    fireEvent.click(screen.getByText('send-draft'));

    expect(onQuickActionInput).toHaveBeenCalledWith('quick-seq', 's2');
    expect(onSessionDraftChange).toHaveBeenCalledWith('draft-next', 's2');
    expect(onSessionDraftSend).toHaveBeenCalledWith('draft-send', 's2');
  });

  it('applies explicit pane-attach intent so a newly opened session lands in the requested pane without relying on P1 fallback', async () => {
    const sessions = [makeSession('s1'), makeSession('s2'), makeSession('s3')];
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify({
      panes: [
        { id: 'pane-1', size: 0.5, activeTabId: 'tab-s1', tabs: [{ id: 'tab-s1', sessionId: 's1' }] },
        { id: 'pane-2', size: 0.5, activeTabId: 'tab-s2', tabs: [{ id: 'tab-s2', sessionId: 's2' }] },
      ],
      activePaneId: 'pane-1',
    }));
    const onPaneAttachIntentApplied = vi.fn();

    render(
      <TerminalPage
        sessions={sessions}
        activeSession={sessions[2]}
        pendingPaneAttachIntent={{ sessionIds: ['s3'], paneId: 'pane-2', nonce: 1 }}
        onPaneAttachIntentApplied={onPaneAttachIntentApplied}
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

    await waitFor(() => {
      const panes = Array.from(document.querySelectorAll('[data-testid="terminal-pane-shell"]'));
      const pane2 = panes.find((node) => node.getAttribute('data-pane-id') === 'pane-2') as HTMLElement | undefined;
      expect(pane2?.querySelector('[data-testid="terminal-view-s3"]')).toBeTruthy();
    });
    expect(onPaneAttachIntentApplied).toHaveBeenCalledWith({ sessionIds: ['s3'], paneId: 'pane-2', nonce: 1 });
  });

  it('enables manual split regardless of width and keeps non-render logic bound to the active session', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 520 });
    window.dispatchEvent(new Event('resize'));
    const sessions = [makeSession('s1'), makeSession('s2')];
    const onQuickActionInput = vi.fn();
    const onSessionDraftChange = vi.fn();
    const onSessionDraftSend = vi.fn();

    render(
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
        onQuickActionInput={onQuickActionInput}
        sessionDraft="draft-s1"
        onSessionDraftChange={onSessionDraftChange}
        onSessionDraftSend={onSessionDraftSend}
        onLoadSavedTabList={vi.fn()}
      />,
    );

    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-active')).toBe('true');
    expect(screen.queryByTestId('terminal-view-s2')).toBeNull();
    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-has-oninput')).toBe('true');

    expect(screen.getByTestId('terminal-quickbar').getAttribute('data-split-available')).toBe('true');

    fireEvent.click(screen.getByText('toggle-split'));

    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('terminal-view-s2').getAttribute('data-active')).toBe('false');
    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-has-oninput')).toBe('true');
    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-has-onresize')).toBe('true');
    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-has-onviewport')).toBe('true');
    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-has-onswipetab')).toBe('true');
    expect(screen.getByTestId('terminal-view-s2').getAttribute('data-has-oninput')).toBe('false');
    expect(screen.getByTestId('terminal-view-s2').getAttribute('data-has-onresize')).toBe('false');
    expect(screen.getByTestId('terminal-view-s2').getAttribute('data-has-onviewport')).toBe('true');
    expect(screen.getByTestId('terminal-view-s2').getAttribute('data-has-onswipetab')).toBe('false');
    expect(screen.getByTestId('terminal-quickbar').getAttribute('data-active-session-id')).toBe('s1');
    expect(screen.getByTestId('terminal-quickbar').getAttribute('data-session-draft')).toBe('draft-s1');
    expect(screen.getByTestId('terminal-quickbar').getAttribute('data-split-visible')).toBe('true');

    fireEvent.click(screen.getByText('send-quick'));
    fireEvent.click(screen.getByText('change-draft'));
    fireEvent.click(screen.getByText('send-draft'));

    expect(onQuickActionInput).toHaveBeenCalledWith('quick-seq', 's1');
    expect(onSessionDraftChange).toHaveBeenCalledWith('draft-next', 's1');
    expect(onSessionDraftSend).toHaveBeenCalledWith('draft-send', 's1');
  });

  it('auto closes split when width shrinks back from wide profile to single-column', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        width: 1200,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    const sessions = [makeSession('s1'), makeSession('s2')];

    render(
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

    fireEvent.click(screen.getByText('toggle-split'));
    expect(screen.getByTestId('terminal-quickbar').getAttribute('data-split-visible')).toBe('true');

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 120 });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        width: 120,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    fireEvent(window, new Event('resize'));

    await waitFor(() => {
      expect(screen.getByTestId('terminal-quickbar').getAttribute('data-split-visible')).toBe('false');
    });
  });

  it('persists split layout and restores it on remount', () => {
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

    fireEvent.click(screen.getByText('toggle-split'));

    expect(screen.getByTestId('terminal-quickbar').getAttribute('data-split-visible')).toBe('true');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.TERMINAL_LAYOUT) || '{}')).toMatchObject({
      panes: [
        { tabs: [{ sessionId: 's1' }], activeTabId: 'tab-s1' },
        { tabs: [{ sessionId: 's2' }], activeTabId: 'tab-s2' },
      ],
    });

    view.unmount();

    render(
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

    expect(screen.getByTestId('terminal-quickbar').getAttribute('data-split-visible')).toBe('true');
  });

  it('prunes closed sessions from persisted split layout', () => {
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

    fireEvent.click(screen.getByText('toggle-split'));

    view.rerender(
      <TerminalPage
        sessions={[sessions[0]]}
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

    expect(screen.getByTestId('terminal-quickbar').getAttribute('data-split-visible')).toBe('false');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.TERMINAL_LAYOUT) || '{}')).toMatchObject({
      panes: [
        { tabs: [{ sessionId: 's1' }], activeTabId: 'tab-s1' },
      ],
    });
  });
});
