// @vitest-environment jsdom

import { memo } from 'react';
import type { ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalQuickBarProps } from '../components/terminal/TerminalQuickBar';
import { STORAGE_KEYS, type Session } from '../lib/types';
import { TerminalPage as TerminalPageBase } from './TerminalPage';
import { renderTerminalShellUi } from '../lib/plugin-host/terminal-shell-ui-plugin';

function TerminalPage(props: ComponentProps<typeof TerminalPageBase>) {
  return (
    <TerminalPageBase
      {...props}
      renderTerminalShell={props.renderTerminalShell || renderTerminalShellUi}
    />
  );
}

// TerminalPage reads attachment counts from SessionContext (badge/drawer).
// These page-level tests render TerminalPage directly without the app-level
// SessionProvider, so provide the minimal session facade the page consumes.
vi.mock('../contexts/SessionContext', () => ({
  useSession: () => ({
    getPendingAttachmentCount: () => 0,
    getPendingAttachments: () => [],
  }),
}));

const quickBarRenderCounter = { count: 0 };
let previousQuickBarProps: Record<string, unknown> | null = null;
let quickBarChangedKeys: string[] = [];
const terminalViewRenderCounter = new Map<string, number>();
const terminalHeaderRenderCounter = { count: 0 };
const terminalViewInstanceCounter = { next: 1 };

function bumpTerminalViewRender(sessionId: string) {
  terminalViewRenderCounter.set(sessionId, (terminalViewRenderCounter.get(sessionId) || 0) + 1);
}

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'web',
    isNativePlatform: () => false,
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

vi.mock('../components/terminal/TerminalHeader', () => ({
  TerminalHeader: memo(() => {
    terminalHeaderRenderCounter.count += 1;
    return (
      <div
        data-testid="terminal-header"
        data-render-count={terminalHeaderRenderCounter.count}
      />
    );
  }),
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

function quickBarSlotRender(props: TerminalQuickBarProps) {
  quickBarRenderCounter.count += 1;
  const currentProps = {
    onOpenFileTransfer: props.onOpenFileTransfer,
    onMeasuredHeightChange: props.onMeasuredHeightChange,
    onToggleAbsoluteLineNumbers: props.onToggleAbsoluteLineNumbers,
    ...props,
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
      <button type="button" onClick={() => props.onOpenFileTransfer?.()}>
        open-file-transfer
      </button>
      <button type="button" onClick={() => props.onMeasuredHeightChange?.(222)}>
        measure-quickbar
      </button>
      <button type="button" onClick={() => props.onToggleAbsoluteLineNumbers?.()}>
        toggle-line-numbers
      </button>
    </div>
  );
}

vi.mock('../components/TerminalView', () => ({
  TerminalView: memo(({
    sessionId,
    showAbsoluteLineNumbers,
  }: {
    sessionId: string;
    showAbsoluteLineNumbers?: boolean;
  }) => {
    const [instanceId] = (require('react') as typeof import('react')).useState(() => terminalViewInstanceCounter.next++);
    bumpTerminalViewRender(sessionId);
    return (
      <div
        data-testid={`terminal-view-${sessionId}`}
        data-render-count={terminalViewRenderCounter.get(sessionId) || 0}
        data-show-line-numbers={showAbsoluteLineNumbers ? 'true' : 'false'}
        data-instance-id={String(instanceId)}
      >
        terminal:{sessionId}
      </div>
    );
  }),
}));

type TestSession = Session & {
  buffer: import('../lib/types').SessionBufferState;
  daemonHeadRevision?: number;
  daemonHeadEndIndex?: number;
};

function makeSession(id: string): TestSession {
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
    renderQuickBar: quickBarSlotRender,
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
    terminalHeaderRenderCounter.count = 0;
    terminalViewInstanceCounter.next = 1;
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

  it('renders the file browser only through the plugin slot callback', () => {
    const session1 = makeSession('s1');
    const port = { daemonFileScopeId: 'daemon:s1', sendJson: vi.fn(), onFileTransferMessage: vi.fn() };
    const resolvePort = vi.fn(() => port);
    const renderFileBrowser = vi.fn((props: { open: boolean; mode?: string }) => (
      <div
        data-testid="plugin-file-browser-slot"
        data-open={String(props.open)}
        data-mode={props.mode || ''}
      />
    ));
    render(
      <TerminalPage
        sessions={[session1]}
        activeSession={session1}
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
        resolveFileBrowserSessionPort={resolvePort}
        renderFileBrowser={renderFileBrowser}
        renderQuickBar={quickBarSlotRender}
      />,
    );

    expect(renderFileBrowser).toHaveBeenCalled();
    expect(resolvePort).toHaveBeenCalledWith('s1');
    expect(renderFileBrowser.mock.calls.at(-1)?.[0]).toMatchObject(port);
    expect(screen.getByTestId('plugin-file-browser-slot').getAttribute('data-open')).toBe('false');

    fireEvent.click(screen.getByText('open-file-transfer'));

    expect(screen.getByTestId('plugin-file-browser-slot').getAttribute('data-open')).toBe('true');
  });

  it('renders no file browser when the plugin slot callback is absent', () => {
    const session1 = makeSession('s1');
    render(
      <TerminalPage
        sessions={[session1]}
        activeSession={session1}
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
        resolveFileBrowserSessionPort={() => ({ daemonFileScopeId: 'daemon:s1', sendJson: vi.fn(), onFileTransferMessage: vi.fn() })}
        renderQuickBar={quickBarSlotRender}
      />,
    );

    fireEvent.click(screen.getByText('open-file-transfer'));
    expect(screen.queryByTestId('plugin-file-browser-slot')).toBeNull();
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

  it('remounts the split pane renderer when the pane switches to a different session so stale buffer state cannot flash into P1', () => {
    const pane1S1Layout = {
      panes: [
        {
          id: 'pane-1',
          size: 0.5,
          activeTabId: 'tab-s1',
          tabs: [
            { id: 'tab-s1', sessionId: 's1' },
            { id: 'tab-s3', sessionId: 's3' },
          ],
        },
        {
          id: 'pane-2',
          size: 0.5,
          activeTabId: 'tab-s2',
          tabs: [{ id: 'tab-s2', sessionId: 's2' }],
        },
      ],
      activePaneId: 'pane-1',
    };
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify(pane1S1Layout));

    const session1 = makeSession('s1');
    const session2 = makeSession('s2');
    const session3 = makeSession('s3');
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
      renderQuickBar: quickBarSlotRender,
    };

    const view = render(
      <TerminalPage
        sessions={[session1, session2, session3]}
        activeSession={session1}
        {...props}
      />,
    );

    const firstPaneInstanceBefore = screen.getByTestId('terminal-view-s1').getAttribute('data-instance-id');
    expect(firstPaneInstanceBefore).toBeTruthy();
    expect(screen.getByTestId('terminal-view-s2')).toBeTruthy();

    view.unmount();

    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify({
      ...pane1S1Layout,
      panes: [
        {
          id: 'pane-1',
          size: 0.5,
          activeTabId: 'tab-s3',
          tabs: [
            { id: 'tab-s1', sessionId: 's1' },
            { id: 'tab-s3', sessionId: 's3' },
          ],
        },
        {
          id: 'pane-2',
          size: 0.5,
          activeTabId: 'tab-s2',
          tabs: [{ id: 'tab-s2', sessionId: 's2' }],
        },
      ],
      activePaneId: 'pane-1',
    }));

    render(
      <TerminalPage
        sessions={[session1, session2, session3]}
        activeSession={session1}
        {...props}
      />,
    );

    expect(screen.queryByTestId('terminal-view-s1')).toBeNull();
    expect(screen.getByTestId('terminal-view-s2')).toBeTruthy();
    expect(screen.getByTestId('terminal-view-s3')).toBeTruthy();
    expect(screen.getByTestId('terminal-view-s3').getAttribute('data-instance-id')).not.toBe(firstPaneInstanceBefore);
  });

  it('does not rerender terminal shell when only an inactive tab runtime status changes', () => {
    const session1 = makeSession('s1');
    const session2 = makeSession('s2');
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
      renderQuickBar: quickBarSlotRender,
    };
    const view = render(
      <TerminalPage
        sessions={[session1, session2]}
        activeSession={session1}
        {...props}
      />,
    );

    const terminalRenderCountBefore = readRenderCount('terminal-view-s1');
    const quickBarRenderCountBefore = readRenderCount('terminal-quickbar');
    const headerRenderCountBefore = readRenderCount('terminal-header');

    const nextInactiveSession = {
      ...session2,
      state: 'reconnecting' as const,
      lastError: 'probe timeout',
    };

    view.rerender(
      <TerminalPage
        sessions={[session1, nextInactiveSession]}
        activeSession={session1}
        {...props}
      />
    );

    expect(readRenderCount('terminal-view-s1')).toBe(terminalRenderCountBefore);
    expect(readRenderCount('terminal-quickbar')).toBe(quickBarRenderCountBefore);
    expect(readRenderCount('terminal-header')).toBe(headerRenderCountBefore);
  });

  it('does not rerender terminal shell when only an inactive tab non-chrome metadata changes', () => {
    const session1 = makeSession('s1');
    const session2 = makeSession('s2');
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
      renderQuickBar: quickBarSlotRender,
    };
    const view = render(
      <TerminalPage
        sessions={[session1, session2]}
        activeSession={session1}
        {...props}
      />,
    );

    const terminalRenderCountBefore = readRenderCount('terminal-view-s1');
    const quickBarRenderCountBefore = readRenderCount('terminal-quickbar');
    const headerRenderCountBefore = readRenderCount('terminal-header');

    const nextInactiveSession = {
      ...session2,
      title: 'renamed-hidden-tab',
      connectionName: 'updated-conn-name',
      createdAt: 999,
      authToken: 'new-token',
      autoCommand: 'echo hidden',
    };

    view.rerender(
      <TerminalPage
        sessions={[session1, nextInactiveSession]}
        activeSession={session1}
        {...props}
      />
    );

    expect(readRenderCount('terminal-view-s1')).toBe(terminalRenderCountBefore);
    expect(readRenderCount('terminal-quickbar')).toBe(quickBarRenderCountBefore);
    expect(readRenderCount('terminal-header')).toBe(headerRenderCountBefore);
  });

  it('does not rerender terminal shell when only the active tab runtime status changes', () => {
    const session1 = makeSession('s1');
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
      renderQuickBar: quickBarSlotRender,
    };
    const view = render(
      <TerminalPage
        sessions={[session1]}
        activeSession={session1}
        {...props}
      />,
    );

    const terminalRenderCountBefore = readRenderCount('terminal-view-s1');
    const quickBarRenderCountBefore = readRenderCount('terminal-quickbar');

    const nextActiveSession = {
      ...session1,
      state: 'reconnecting' as const,
      lastError: 'probe timeout',
    };

    view.rerender(
      <TerminalPage
        sessions={[nextActiveSession]}
        activeSession={nextActiveSession}
        {...props}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(3100);
    });

    expect(screen.queryByTestId('terminal-network-banner')).toBeNull();
    expect(readRenderCount('terminal-view-s1')).toBe(terminalRenderCountBefore);
    expect(readRenderCount('terminal-quickbar')).toBe(quickBarRenderCountBefore);
  });

  it('does not rerender terminal shell on a plain rerender when live session wiring changes are semantically irrelevant', () => {
    const session1 = makeSession('s1');
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
      onLiveSessionIdsChange: vi.fn(),
      quickActions: [],
      shortcutActions: [],
      sessionDraft: '',
      renderQuickBar: quickBarSlotRender,
    };
    const view = render(
      <TerminalPage
        sessions={[session1]}
        activeSession={session1}
        {...props}
      />,
    );

    const terminalRenderCountBefore = readRenderCount('terminal-view-s1');
    const quickBarRenderCountBefore = readRenderCount('terminal-quickbar');
    const headerRenderCountBefore = readRenderCount('terminal-header');

    view.rerender(
      <TerminalPage
        sessions={[session1]}
        activeSession={session1}
        {...props}
      />,
    );

    expect(readRenderCount('terminal-view-s1')).toBe(terminalRenderCountBefore);
    expect(readRenderCount('terminal-quickbar')).toBe(quickBarRenderCountBefore);
    expect(readRenderCount('terminal-header')).toBe(headerRenderCountBefore);
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
      renderQuickBar: quickBarSlotRender,
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
