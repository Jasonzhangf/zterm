// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { Session, SessionDebugOverlayMetrics } from '../lib/types';
import type { TerminalQuickBarProps } from '../components/terminal/TerminalQuickBar';
import { TerminalPage as TerminalPageBase } from './TerminalPage';
import { renderTerminalShellUi } from '../lib/plugin-host/terminal-shell-ui-plugin';

// TerminalPage reads attachment counts from SessionContext (badge/drawer).
// These page-level tests render TerminalPage directly without the app-level
// SessionProvider, so provide the minimal session facade the page consumes.
vi.mock('../contexts/SessionContext', () => ({
  useSession: () => ({
    getPendingAttachmentCount: () => 0,
    getPendingAttachments: () => [],
  }),
}));

class ResizeObserverMock { observe(){} unobserve(){} disconnect(){} }

beforeAll(() => {
  (globalThis as any).ResizeObserver = ResizeObserverMock;
  (Element.prototype as any).scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  const m = new Map<string,string>();
  vi.stubGlobal('localStorage', {
    get length(){ return m.size;},
    clear(){ m.clear(); },
    getItem(k:string){ return m.has(k)?m.get(k)!:null; },
    key(i:number){ return [...m.keys()][i] ?? null; },
    removeItem(k:string){ m.delete(k); },
    setItem(k:string,v:string){ m.set(k,String(v)); },
  } as Storage);
});

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'web', isNativePlatform: () => false },
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
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
  },
}));

vi.mock('../components/terminal/TerminalHeader', () => ({ TerminalHeader: () => <div data-testid="terminal-header"/> }));
vi.mock('../components/terminal/TabManagerSheet', () => ({ TabManagerSheet: () => null }));
vi.mock('../components/terminal/SessionScheduleSheet', () => ({ SessionScheduleSheet: () => null }));
vi.mock('../components/terminal/FileTransferSheet', () => ({ FileTransferSheet: () => null }));
vi.mock('../components/terminal/RemoteScreenshotSheet', () => ({ RemoteScreenshotSheet: () => null }));

const renderQuickBar = (_props: TerminalQuickBarProps) => (
  <div data-testid="terminal-quickbar" />
);

function TerminalPage(props: ComponentProps<typeof TerminalPageBase>) {
  return (
    <TerminalPageBase
      {...props}
      renderQuickBar={props.renderQuickBar || renderQuickBar}
      renderTerminalShell={props.renderTerminalShell || renderTerminalShellUi}
    />
  );
}

// Track TerminalView renders to verify decoupling
const terminalViewCalls: {
  sessionId: string;
  active: boolean;
  live: boolean;
  onViewportChange?: (sessionId: string, viewState: {
    mode: 'follow' | 'reading';
    viewportEndIndex: number;
    viewportRows: number;
  }) => void;
}[] = [];
vi.mock('../components/TerminalView', () => ({
  TerminalView: ({
    sessionId,
    active,
    live,
    onViewportChange,
  }: {
    sessionId: string;
    active?: boolean;
    live?: boolean;
    onViewportChange?: (sessionId: string, viewState: {
      mode: 'follow' | 'reading';
      viewportEndIndex: number;
      viewportRows: number;
    }) => void;
  }) => {
    terminalViewCalls.push({
      sessionId,
      active: !!active,
      live: !!live,
      onViewportChange,
    });
    return (
      <div
        data-testid={`terminal-view-${sessionId}`}
        data-active={active ? 'true' : 'false'}
        data-live={live ? 'true' : 'false'}
        data-session-id={sessionId}
      >
        <textarea
          data-wterm-input="true"
          data-terminal-input-session-id={sessionId}
          data-active={active ? 'true' : 'false'}
        />
      </div>
    );
  },
}));

function s(id: string, title = id): Session {
  return {
    id,
    hostId: `h-${id}`,
    connectionName: `c-${id}`,
    bridgeHost: '1.1.1.1',
    bridgePort: 3333,
    sessionName: `tmux-${id}`,
    title,
    ws: null,
    state: 'connected',
    hasUnread: false,
    createdAt: 1,
    buffer: {
      lines: [], gapRanges: [], startIndex: 0, endIndex: 0,
      bufferHeadStartIndex: 0, bufferTailEndIndex: 0,
      cols: 80, rows: 24, cursorKeysApp: false, cursor: null,
      updateKind: 'replace', revision: 1,
    },
  } as any;
}

const base = {
  getSessionDebugMetrics: (): SessionDebugOverlayMetrics => ({
    uplinkBps: 0, downlinkBps: 0, renderHz: 0, pullHz: 0,
    transportBufferedBytes: 0, transportBackpressured: false, lastRenderCommitAt: 0,
    bufferPullActive: false, status: 'waiting', active: false, updatedAt: 1,
  }),
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
};

// ---------------------------------------------------------------------------
// CATEGORY 1: paneA input isolation
// ---------------------------------------------------------------------------
describe('multi-pane input isolation', () => {
  beforeEach(() => { terminalViewCalls.length = 0; });

  it('onTerminalInput receives the active pane sessionId only', () => {
    const sessions = [s('s1'), s('s2')];
    const onTerminalInput = vi.fn();
    render(
      <TerminalPage
        {...base}
        sessions={sessions}
        activeSession={sessions[0]}
        onTerminalInput={onTerminalInput}
      />,
    );

    // The only rendered input should belong to active session s1
    const inputs = document.querySelectorAll('textarea[data-wterm-input="true"]');
    expect(inputs.length).toBeGreaterThanOrEqual(1);
    const inputSessionIds = Array.from(inputs).map(el =>
      el.getAttribute('data-terminal-input-session-id'),
    );
    // s2 (inactive) must not have a textarea rendered at all
    expect(inputSessionIds).not.toContain('s2');
  });

  it('inactive pane has no input element in DOM', () => {
    const sessions = [s('s1'), s('s2')];
    render(
      <TerminalPage
        {...base}
        sessions={sessions}
        activeSession={sessions[0]}
      />,
    );
    // s2 is not active, so it should not have any textarea
    const s2Input = document.querySelector(
      'textarea[data-terminal-input-session-id="s2"]',
    );
    expect(s2Input).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CATEGORY 2: paneA refresh does not pollute paneB display
// ---------------------------------------------------------------------------
describe('multi-pane refresh decoupling', () => {
  beforeEach(() => { terminalViewCalls.length = 0; });

  it('all split-visible panes render immediately and only focus pane is active', () => {
    localStorage.setItem('zterm:terminal-layout', JSON.stringify({
      panes: [
        { id: 'pane-1', size: 0.5, activeTabId: 'tab-s1', tabs: [{ id: 'tab-s1', sessionId: 's1' }] },
        { id: 'pane-2', size: 0.5, activeTabId: 'tab-s2', tabs: [{ id: 'tab-s2', sessionId: 's2' }] },
      ],
      activePaneId: 'pane-1',
    }));
    const sessions = [s('s1'), s('s2')];
    const { queryByTestId } = render(
      <TerminalPage {...base} sessions={sessions} activeSession={sessions[0]} />,
    );
    expect(queryByTestId('terminal-view-s1')).not.toBeNull();
    expect(queryByTestId('terminal-view-s2')).not.toBeNull();
    expect(queryByTestId('terminal-view-s1')?.getAttribute('data-active')).toBe('true');
    expect(queryByTestId('terminal-view-s2')?.getAttribute('data-active')).toBe('false');
  });

  it('switching active session re-renders the new active only', () => {
    const sessions = [s('s1'), s('s2')];
    const { rerender, queryByTestId } = render(
      <TerminalPage {...base} sessions={sessions} activeSession={sessions[0]} />,
    );
    expect(queryByTestId('terminal-view-s1')).not.toBeNull();
    expect(queryByTestId('terminal-view-s2')).toBeNull();

    // Switch to s2
    rerender(
      <TerminalPage {...base} sessions={sessions} activeSession={sessions[1]} />,
    );
    expect(queryByTestId('terminal-view-s2')).not.toBeNull();
    expect(queryByTestId('terminal-view-s1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CATEGORY 3: active/inactive pane pull decoupling
// ---------------------------------------------------------------------------
describe('multi-pane pull decoupling', () => {
  beforeEach(() => { terminalViewCalls.length = 0; });

  it('inactive pane TerminalView receives active=false but still mounts', () => {
    localStorage.setItem('zterm:terminal-layout', JSON.stringify({
      panes: [
        { id: 'pane-1', size: 0.5, activeTabId: 'tab-s1', tabs: [{ id: 'tab-s1', sessionId: 's1' }] },
        { id: 'pane-2', size: 0.5, activeTabId: 'tab-s2', tabs: [{ id: 'tab-s2', sessionId: 's2' }] },
      ],
      activePaneId: 'pane-1',
    }));
    const sessions = [s('s1'), s('s2')];
    render(
      <TerminalPage {...base} sessions={sessions} activeSession={sessions[0]} />,
    );
    const s1Calls = terminalViewCalls.filter(c => c.sessionId === 's1');
    const s2Calls = terminalViewCalls.filter(c => c.sessionId === 's2');
    expect(s1Calls.length).toBeGreaterThan(0);
    expect(s2Calls.length).toBeGreaterThan(0);
    expect(s2Calls.every(c => c.active === false)).toBe(true);
  });

  it('announces every split-visible pane as live and lets each renderer own its measured viewport demand', () => {
    localStorage.setItem('zterm:terminal-layout', JSON.stringify({
      panes: [
        { id: 'pane-1', size: 0.5, activeTabId: 'tab-s1', tabs: [{ id: 'tab-s1', sessionId: 's1' }] },
        { id: 'pane-2', size: 0.5, activeTabId: 'tab-s2', tabs: [{ id: 'tab-s2', sessionId: 's2' }] },
      ],
      activePaneId: 'pane-1',
    }));
    const sessions = [s('s1'), s('s2')];
    const onLiveSessionIdsChange = vi.fn();
    const onTerminalViewportChange = vi.fn();

    render(
      <TerminalPage
        {...base}
        sessions={sessions}
        activeSession={sessions[0]}
        onLiveSessionIdsChange={onLiveSessionIdsChange}
        onTerminalViewportChange={onTerminalViewportChange}
      />,
    );

    expect(onLiveSessionIdsChange).toHaveBeenCalledWith(['s1', 's2']);
    expect(terminalViewCalls.filter(c => c.sessionId === 's2').every(c => c.live)).toBe(true);
    expect(onTerminalViewportChange).not.toHaveBeenCalledWith('s2', expect.objectContaining({
      viewportEndIndex: 0,
      viewportRows: 24,
    }));

    const inactivePaneView = terminalViewCalls.find((call) => call.sessionId === 's2');
    inactivePaneView?.onViewportChange?.('s2', {
      mode: 'follow',
      viewportEndIndex: 120,
      viewportRows: 12,
    });
    expect(onTerminalViewportChange).toHaveBeenCalledWith('s2', {
      mode: 'follow',
      viewportEndIndex: 120,
      viewportRows: 12,
    });
  });
});

// ---------------------------------------------------------------------------
// CATEGORY 5: system copy selection does not cross panes
// ---------------------------------------------------------------------------
describe('system copy does not cross panes', () => {
  beforeEach(() => { terminalViewCalls.length = 0; });

  it('each pane TerminalView carries its own data-session-id', () => {
    localStorage.setItem('zterm:terminal-layout', JSON.stringify({
      panes: [
        { id: 'pane-1', size: 0.5, activeTabId: 'tab-s1', tabs: [{ id: 'tab-s1', sessionId: 's1' }] },
        { id: 'pane-2', size: 0.5, activeTabId: 'tab-s2', tabs: [{ id: 'tab-s2', sessionId: 's2' }] },
      ],
      activePaneId: 'pane-1',
    }));
    const sessions = [s('s1'), s('s2')];
    render(
      <TerminalPage {...base} sessions={sessions} activeSession={sessions[0]} />,
    );
    const views = document.querySelectorAll('[data-session-id]');
    const sessionIds = Array.from(views).map(el => el.getAttribute('data-session-id'));
    expect(sessionIds.filter(id => id === 's1').length).toBeGreaterThan(0);
    expect(sessionIds.filter(id => id === 's2').length).toBeGreaterThan(0);
  });
});
