// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionBufferState } from '../lib/terminal-buffer';
import { createSessionRenderBufferStore } from '../lib/session-render-buffer-store';
import type { Session, SessionRenderBufferSnapshot, TerminalCell } from '../lib/types';
import { TerminalPage } from './TerminalPage';

class ResizeObserverMock {
  static instances = new Set<ResizeObserverMock>();

  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverMock.instances.add(this);
  }

  observe() {}
  unobserve() {}
  disconnect() {
    ResizeObserverMock.instances.delete(this);
  }

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }

  static triggerAll() {
    for (const instance of Array.from(ResizeObserverMock.instances)) {
      instance.trigger();
    }
  }

  static reset() {
    ResizeObserverMock.instances.clear();
  }
}

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'web' },
  registerPlugin: () => ({
    readText: vi.fn(async () => ({ value: '' })),
    writeText: vi.fn(async () => undefined),
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

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
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
  TerminalHeader: ({
    sessions = [],
    activeSession,
    onSwitchSession,
  }: {
    sessions?: Array<{ id: string; sessionName: string }>;
    activeSession?: { id: string; sessionName: string } | null;
    onSwitchSession?: (sessionId: string) => void;
  }) => (
    <div
      data-testid="terminal-header"
      data-active-session-id={activeSession?.id || ''}
      data-active-session-name={activeSession?.sessionName || ''}
    >
      {sessions.map((session) => (
        <button key={session.id} type="button" onClick={() => onSwitchSession?.(session.id)}>
          {session.sessionName}
        </button>
      ))}
    </div>
  ),
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
  TerminalQuickBar: () => <div data-testid="terminal-quickbar" />,
}));

function terminalCell(char: string): TerminalCell {
  return {
    char: char.codePointAt(0) || 32,
    fg: 256,
    bg: 256,
    flags: 0,
    width: 1,
  };
}

function makeRenderSnapshot(rows: string[], revision: number): SessionRenderBufferSnapshot {
  const buffer = createSessionBufferState({
    lines: rows,
    startIndex: 0,
    endIndex: rows.length,
    bufferHeadStartIndex: 0,
    bufferTailEndIndex: rows.length,
    cols: 80,
    rows: 24,
    revision,
    cacheLines: 200,
  });
  return {
    ...buffer,
    daemonHeadRevision: revision,
    daemonHeadEndIndex: buffer.bufferTailEndIndex,
    lines: buffer.lines.map((row) => row.map((cell) => ({ ...cell }))),
  };
}

type TestSession = Session & { buffer: import('../lib/types').SessionBufferState };

function makeSession(id: string, name: string): TestSession {
  return {
    id,
    hostId: `host-${id}`,
    connectionName: `conn-${id}`,
    bridgeHost: '127.0.0.1',
    bridgePort: 3333,
    sessionName: name,
    title: name,
    ws: null,
    state: 'connected',
    hasUnread: false,
    createdAt: 1,
    buffer: createSessionBufferState({
      lines: [name].map((line) => Array.from(line).map(terminalCell)),
      startIndex: 0,
      endIndex: 1,
      bufferTailEndIndex: 1,
      cols: 80,
      rows: 24,
      revision: 1,
      cacheLines: 200,
    }),
  };
}

function renderTerminalPage(options: {
  sessions: Session[];
  activeSession: Session | null;
  sessionBufferStore: ReturnType<typeof createSessionRenderBufferStore>;
  onSwitchSession?: (sessionId: string) => void;
}) {
  return render(
    <TerminalPage
      sessions={options.sessions}
      activeSession={options.activeSession}
      sessionBufferStore={options.sessionBufferStore}
      getSessionDebugMetrics={() => ({
        uplinkBps: 0,
        downlinkBps: 0,
        renderHz: 0,
        pullHz: 0,
        transportBufferedBytes: 0,
        transportBackpressured: false,
        lastRenderCommitAt: 0,
        bufferPullActive: false,
        status: 'waiting',
        active: true,
        updatedAt: 1,
      })}
      onSwitchSession={options.onSwitchSession || vi.fn()}
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

function readRenderedRows(container: HTMLElement) {
  return Array.from(container.querySelectorAll('[data-terminal-row="true"]'))
    .map((node) => (node.textContent || '').replace(/\s+$/u, ''));
}

describe('TerminalPage session content identity', () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  const originalWindowInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  const originalWindowInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
  const originalDocumentClientWidth = Object.getOwnPropertyDescriptor(document.documentElement, 'clientWidth');
  const originalDocumentClientHeight = Object.getOwnPropertyDescriptor(document.documentElement, 'clientHeight');
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  let mockViewportWidth = 640;
  let mockViewportHeight = 408;

  beforeEach(() => {
    cleanup();
    ResizeObserverMock.reset();
    mockViewportWidth = 640;
    mockViewportHeight = 408;
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      get() {
        return mockViewportWidth;
      },
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      get() {
        return mockViewportHeight;
      },
    });
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      get() {
        return mockViewportWidth;
      },
    });
    Object.defineProperty(document.documentElement, 'clientHeight', {
      configurable: true,
      get() {
        return mockViewportHeight;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return mockViewportWidth;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return mockViewportHeight;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 640,
        bottom: 408,
        width: 640,
        height: 17,
        toJSON() {
          return {};
        },
      } as DOMRect;
    };
    const storageBacking = new Map<string, string>();
    vi.stubGlobal('localStorage', {
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
    } as Storage);
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    globalThis.ResizeObserver = originalResizeObserver;
    if (originalClientWidth) {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
    }
    if (originalClientHeight) {
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
    }
    if (originalWindowInnerWidth) {
      Object.defineProperty(window, 'innerWidth', originalWindowInnerWidth);
    }
    if (originalWindowInnerHeight) {
      Object.defineProperty(window, 'innerHeight', originalWindowInnerHeight);
    }
    if (originalDocumentClientWidth) {
      Object.defineProperty(document.documentElement, 'clientWidth', originalDocumentClientWidth);
    } else {
      delete (document.documentElement as unknown as { clientWidth?: number }).clientWidth;
    }
    if (originalDocumentClientHeight) {
      Object.defineProperty(document.documentElement, 'clientHeight', originalDocumentClientHeight);
    } else {
      delete (document.documentElement as unknown as { clientHeight?: number }).clientHeight;
    }
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    ResizeObserverMock.reset();
  });

  it('keeps the active session name and rendered body matched across switch and foreground resume', async () => {
    const renderStore = createSessionRenderBufferStore();
    const alpha = makeSession('session-alpha', 'tmux-alpha');
    const beta = makeSession('session-beta', 'tmux-beta');
    renderStore.setBuffer(alpha.id, makeRenderSnapshot(['ALPHA_BODY_001', 'ALPHA_BODY_PROMPT'], 1));
    renderStore.setBuffer(beta.id, makeRenderSnapshot(['BETA_BODY_001', 'BETA_BODY_PROMPT'], 1));

    const view = renderTerminalPage({
      sessions: [alpha, beta],
      activeSession: alpha,
      sessionBufferStore: renderStore,
    });

    await waitFor(() => expect(screen.getByTestId('terminal-header').getAttribute('data-active-session-id')).toBe(alpha.id));
    expect(screen.getByTestId('terminal-header').getAttribute('data-active-session-name')).toBe('tmux-alpha');
    expect(readRenderedRows(view.container)).toContain('ALPHA_BODY_PROMPT');
    expect(readRenderedRows(view.container)).not.toContain('BETA_BODY_PROMPT');

    view.rerender(
      <TerminalPage
        sessions={[alpha, beta]}
        activeSession={beta}
        sessionBufferStore={renderStore}
        getSessionDebugMetrics={() => ({
          uplinkBps: 0,
          downlinkBps: 0,
          renderHz: 0,
          pullHz: 0,
          transportBufferedBytes: 0,
          transportBackpressured: false,
          lastRenderCommitAt: 0,
          bufferPullActive: false,
          status: 'waiting',
          active: true,
          updatedAt: 1,
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

    await waitFor(() => expect(screen.getByTestId('terminal-header').getAttribute('data-active-session-id')).toBe(beta.id));
    expect(screen.getByTestId('terminal-header').getAttribute('data-active-session-name')).toBe('tmux-beta');
    expect(readRenderedRows(view.container)).toContain('BETA_BODY_PROMPT');
    expect(readRenderedRows(view.container)).not.toContain('ALPHA_BODY_PROMPT');

    expect(renderStore.setBuffer(alpha.id, makeRenderSnapshot(['ALPHA_BODY_LATE', 'ALPHA_BODY_LATE_PROMPT'], 2))).toBe(true);
    expect(renderStore.setBuffer(beta.id, makeRenderSnapshot(['BETA_BODY_RESUMED', 'BETA_BODY_RESUMED_PROMPT'], 2))).toBe(true);

    await act(async () => {
      document.dispatchEvent(new Event('pause'));
      document.dispatchEvent(new Event('resume'));
      ResizeObserverMock.triggerAll();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(screen.getByTestId('terminal-header').getAttribute('data-active-session-id')).toBe(beta.id));
    expect(screen.getByTestId('terminal-header').getAttribute('data-active-session-name')).toBe('tmux-beta');
    expect(readRenderedRows(view.container)).toContain('BETA_BODY_RESUMED_PROMPT');
    expect(readRenderedRows(view.container)).not.toContain('ALPHA_BODY_LATE_PROMPT');
  });

  it('keeps portrait session-group center matched when an already connected active session changes externally', async () => {
    mockViewportWidth = 390;
    mockViewportHeight = 844;
    const renderStore = createSessionRenderBufferStore();
    const alpha = makeSession('session-alpha', 'tmux-alpha');
    const beta = makeSession('session-beta', 'tmux-beta');
    renderStore.setBuffer(alpha.id, makeRenderSnapshot(['ALPHA_PORTRAIT_BODY'], 1));
    renderStore.setBuffer(beta.id, makeRenderSnapshot(['BETA_PORTRAIT_BODY'], 1));

    const view = renderTerminalPage({
      sessions: [alpha, beta],
      activeSession: alpha,
      sessionBufferStore: renderStore,
    });

    await waitFor(() => expect(readRenderedRows(view.container)).toContain('ALPHA_PORTRAIT_BODY'));

    view.rerender(
      <TerminalPage
        sessions={[alpha, beta]}
        activeSession={beta}
        sessionBufferStore={renderStore}
        getSessionDebugMetrics={() => ({
          uplinkBps: 0,
          downlinkBps: 0,
          renderHz: 0,
          pullHz: 0,
          transportBufferedBytes: 0,
          transportBackpressured: false,
          lastRenderCommitAt: 0,
          bufferPullActive: false,
          status: 'waiting',
          active: true,
          updatedAt: 1,
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

    await waitFor(() => expect(readRenderedRows(view.container)).toContain('BETA_PORTRAIT_BODY'));
    expect(readRenderedRows(view.container)).not.toContain('ALPHA_PORTRAIT_BODY');
  });
});
