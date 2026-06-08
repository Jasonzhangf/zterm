// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleJobDraft, Session, SessionScheduleState } from '../lib/types';
import { TerminalPage } from './TerminalPage';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'web',
  },
  registerPlugin: () => ({
    show: vi.fn(async () => ({})),
    hide: vi.fn(async () => undefined),
    blur: vi.fn(async () => undefined),
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

vi.mock('../components/terminal/TerminalHeader', () => ({
  TerminalHeader: () => <div data-testid="terminal-header" />,
}));

vi.mock('../components/terminal/TabManagerSheet', () => ({
  TabManagerSheet: () => null,
}));

vi.mock('../components/TerminalView', () => ({
  TerminalView: ({ sessionId }: { sessionId: string }) => (
    <div data-testid={`terminal-view-${sessionId}`} />
  ),
}));

vi.mock('../components/terminal/TerminalQuickBar', () => ({
  TerminalQuickBar: ({
    onOpenScheduleComposer,
  }: {
    onOpenScheduleComposer?: (text: string) => void;
  }) => (
    <button type="button" onClick={() => onOpenScheduleComposer?.('echo from a')}>
      open-schedule
    </button>
  ),
}));

vi.mock('../components/terminal/SessionScheduleSheet', () => ({
  SessionScheduleSheet: ({
    sessionName,
    composerSeedText,
    onRefresh,
    onSave,
  }: {
    sessionName: string;
    composerSeedText?: string;
    onRefresh: () => void;
    onSave: (job: ScheduleJobDraft) => void;
  }) => (
    <div data-testid="schedule-sheet" data-session-name={sessionName} data-seed={composerSeedText || ''}>
      <button type="button" onClick={onRefresh}>schedule-refresh</button>
      <button
        type="button"
        onClick={() => onSave({
          targetSessionName: sessionName,
          payload: { text: 'echo from a', appendEnter: true },
          rule: { kind: 'interval', intervalMs: 60000, startAt: '2026-06-08T00:00:00.000Z' },
          execution: { maxRuns: 1 },
        })}
      >
        schedule-save
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
    title: `tmux-${id}`,
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

function makeScheduleState(sessionName: string): SessionScheduleState {
  return {
    sessionName,
    jobs: [],
    loading: false,
  };
}

function makeProps(sessions: Session[], activeSession: Session | null) {
  return {
    sessions,
    activeSession,
    getSessionDebugMetrics: vi.fn(() => null),
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
    getScheduleState: vi.fn((sessionId: string) => {
      const session = sessions.find((item) => item.id === sessionId);
      return makeScheduleState(session?.sessionName || '');
    }),
    onRequestScheduleList: vi.fn(),
    onUpsertScheduleJob: vi.fn(),
  };
}

describe('TerminalPage schedule target lifecycle', () => {
  beforeEach(() => {
    const storageBacking = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      get length() {
        return storageBacking.size;
      },
      clear: () => storageBacking.clear(),
      getItem: (key: string) => storageBacking.get(key) ?? null,
      key: (index: number) => Array.from(storageBacking.keys())[index] ?? null,
      removeItem: (key: string) => storageBacking.delete(key),
      setItem: (key: string, value: string) => storageBacking.set(key, String(value)),
    } as Storage);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        width: 390,
        height: 844,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('keeps schedule sheet operations bound to the session that opened it after active tab changes', () => {
    const sessions = [makeSession('a'), makeSession('b')];
    const props = makeProps(sessions, sessions[0]);
    const view = render(<TerminalPage {...props} />);

    fireEvent.click(screen.getByText('open-schedule'));
    expect(props.onRequestScheduleList).toHaveBeenCalledWith('a');
    expect(screen.getByTestId('schedule-sheet').dataset.sessionName).toBe('tmux-a');
    expect(screen.getByTestId('schedule-sheet').dataset.seed).toBe('echo from a');

    view.rerender(<TerminalPage {...props} activeSession={sessions[1]} scheduleState={makeScheduleState('tmux-b')} />);

    fireEvent.click(screen.getByText('schedule-refresh'));
    fireEvent.click(screen.getByText('schedule-save'));
    expect(props.onRequestScheduleList).toHaveBeenLastCalledWith('a');
    expect(props.onUpsertScheduleJob).toHaveBeenCalledWith('a', expect.objectContaining({
      targetSessionName: 'tmux-a',
    }));
  });
});
