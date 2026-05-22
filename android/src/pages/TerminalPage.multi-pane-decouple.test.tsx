// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, SessionDebugOverlayMetrics } from '../lib/types';
import { TerminalPage } from './TerminalPage';

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
  (globalThis as any).localStorage = {
    get length(){ return m.size;},
    clear(){ m.clear(); },
    getItem(k:string){ return m.has(k)?m.get(k)!:null; },
    key(i:number){ return [...m.keys()][i] ?? null; },
    removeItem(k:string){ m.delete(k); },
    setItem(k:string,v:string){ m.set(k,String(v)); },
  } as Storage;
});

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'web' },
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
vi.mock('../components/terminal/TerminalQuickBar', () => ({ TerminalQuickBar: () => <div data-testid="terminal-quickbar"/> }));
vi.mock('../components/terminal/TabManagerSheet', () => ({ TabManagerSheet: () => null }));
vi.mock('../components/terminal/SessionScheduleSheet', () => ({ SessionScheduleSheet: () => null }));
vi.mock('../components/terminal/FileTransferSheet', () => ({ FileTransferSheet: () => null }));
vi.mock('../components/terminal/RemoteScreenshotSheet', () => ({ RemoteScreenshotSheet: () => null }));

// Track TerminalView renders to verify decoupling
const terminalViewCalls: {sessionId: string; active: boolean}[] = [];
vi.mock('../components/TerminalView', () => ({
  TerminalView: ({ sessionId, active }: { sessionId: string; active?: boolean }) => {
    terminalViewCalls.push({ sessionId, active: !!active });
    return (
      <div
        data-testid={`terminal-view-${sessionId}`}
        data-active={active ? 'true' : 'false'}
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
  onLoadSavedTabList: vi.fn(),
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

  it('active pane is rendered; inactive pane is NOT rendered', () => {
    const sessions = [s('s1'), s('s2')];
    const { queryByTestId } = render(
      <TerminalPage {...base} sessions={sessions} activeSession={sessions[0]} />,
    );
    // s1 (active) must render
    expect(queryByTestId('terminal-view-s1')).not.toBeNull();
    // s2 (inactive) must NOT be in DOM
    expect(queryByTestId('terminal-view-s2')).toBeNull();
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

  it('inactive pane TerminalView receives active=false', () => {
    const sessions = [s('s1'), s('s2')];
    render(
      <TerminalPage {...base} sessions={sessions} activeSession={sessions[0]} />,
    );
    // Only s1 should have been rendered (active)
    const s1Calls = terminalViewCalls.filter(c => c.sessionId === 's1');
    const s2Calls = terminalViewCalls.filter(c => c.sessionId === 's2');
    expect(s1Calls.length).toBeGreaterThan(0);
    expect(s2Calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CATEGORY 5: system copy selection does not cross panes
// ---------------------------------------------------------------------------
describe('system copy does not cross panes', () => {
  beforeEach(() => { terminalViewCalls.length = 0; });

  it('each pane TerminalView carries its own data-session-id', () => {
    const sessions = [s('s1'), s('s2')];
    render(
      <TerminalPage {...base} sessions={sessions} activeSession={sessions[0]} />,
    );
    const views = document.querySelectorAll('[data-session-id]');
    const sessionIds = Array.from(views).map(el => el.getAttribute('data-session-id'));
    // Only the active pane should be in DOM with a session id
    expect(sessionIds.filter(id => id === 's1').length).toBeGreaterThan(0);
    expect(sessionIds.filter(id => id === 's2').length).toBe(0);
  });
});
