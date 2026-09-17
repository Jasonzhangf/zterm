// @vitest-environment jsdom

import { useState, type ComponentType } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JUNCTION_PREVIEW_LATTICE_STORAGE_KEY } from '../lib/junction-preview-lattice';
import type { Session } from '../lib/types';
import type { ComponentProps } from 'react';
import type { TerminalQuickBarProps } from '../components/terminal/TerminalQuickBar';
import { TerminalSessionDrawer } from '../components/terminal/TerminalSessionDrawer';
import { TerminalPage as TerminalPageComponent } from './TerminalPage';
import { renderTerminalShellUi } from '../lib/plugin-host/terminal-shell-ui-plugin';

function withTerminalShell(Page: ComponentType<ComponentProps<typeof TerminalPageComponent>>) {
  return (props: ComponentProps<typeof Page>) => (
    <Page
      {...props}
      renderTerminalShell={props.renderTerminalShell || renderTerminalShellUi}
    />
  );
}

function withSessionDrawer(Page: typeof TerminalPageComponent) {
  return (props: ComponentProps<typeof Page>) => (
    <Page
      {...props}
      renderSessionDrawer={(drawerProps) => <TerminalSessionDrawer {...drawerProps} />}
    />
  );
}

class ResizeObserverMock { observe(){} unobserve(){} disconnect(){} }
beforeAll(() => {
  (globalThis as any).ResizeObserver = ResizeObserverMock;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: {
      width: 360,
      height: 800,
      offsetTop: 0,
      offsetLeft: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
});

const appListenerMock = vi.hoisted(() => ({ backButton: null as null | (() => void) }));

beforeEach(() => {
  localStorage.clear();
  appListenerMock.backButton = null;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  localStorage.clear();
});

vi.mock('../contexts/SessionContext', () => ({
  useSession: () => ({
    getPendingAttachmentCount: () => 0,
    getPendingAttachments: () => [],
  }),
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'web', isNativePlatform: () => false },
  registerPlugin: () => ({ addListener: vi.fn(async () => ({ remove: vi.fn() })) }),
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
    addListener: vi.fn((eventName: string, listener: () => void) => {
      if (eventName === 'backButton') appListenerMock.backButton = listener;
      return Promise.resolve({
        remove: vi.fn(() => {
          if (appListenerMock.backButton === listener) appListenerMock.backButton = null;
        }),
      });
    }),
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
  TerminalHeader: () => null,
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

const renderQuickBar = (props: TerminalQuickBarProps) => (
  <div
    data-testid="terminal-quickbar"
    data-active-session-id={props.activeSessionId || ''}
  >
    <button
      type="button"
      data-testid="terminal-quickbar-send"
      onClick={() => props.onSendSequence?.('PING')}
    >
      send
    </button>
  </div>
);

vi.mock('../components/TerminalView', () => ({
  TerminalView: ({ sessionId }: { sessionId: string }) => <div data-testid={`terminal-view-${sessionId}`} />,
}));

function makeSession(id: string): Session {
  return {
    id,
    title: `Session ${id}`,
    sessionName: `tmux-${id}`,
    state: 'connected',
    bridgeHost: 'mac.local',
    bridgePort: 3333,
    createdAt: id === 's1' ? 1 : 2,
  } as Session;
}

const baseProps = {
  interactiveSession: makeSession('s1'),
  renderedPaneSessions: [makeSession('s1')],
  visiblePaneEntries: [],
  splitVisible: false,
  activePaneId: 'pane-main',
  terminalChromeBottomPx: 0,
  terminalKeyboardRequested: false,
  isAndroid: true,
  handleTerminalViewportChange: vi.fn(),
  handleSwipeTab: vi.fn(),
  handleActiveTerminalActivateInput: vi.fn(),
  focusNonce: 0,
  terminalFontSize: 10,
  terminalThemeId: 'default',
  terminalWidthMode: 'mirror-fixed' as const,
  absoluteLineNumbersVisible: false,
  copySelection: { active: false, sessionId: null, startRowIndex: null, endRowIndex: null, menu: null },
  onLongPressRow: vi.fn(),
};

function writeLattice(sessions: Session[]) {
  const cells = sessions.map((session, index) => {
    if (index === 0) return { col: 0, row: 0, target: session };
    if (index === 1) return { col: -1, row: 0, target: session };
    if (index === 2) return { col: 0, row: -1, target: session };
    if (index === 3) return { col: 0, row: 1, target: session };
    return { col: 1, row: 0, target: session };
  });
  localStorage.setItem(JUNCTION_PREVIEW_LATTICE_STORAGE_KEY, JSON.stringify({
    version: 1,
    cells: cells.map(({ col, row, target }) => ({
      col,
      row,
      target: {
        sessionId: target.id,
        daemonHostId: target.daemonHostId,
        bridgeHost: target.bridgeHost,
        bridgePort: target.bridgePort,
        sessionName: target.sessionName,
      },
    })),
  }));
}

async function openPreview(stage: HTMLElement) {
  fireEvent.touchStart(stage, { touches: [{ clientX: 338, clientY: 400 }] });
  fireEvent.touchMove(stage, { touches: [{ clientX: 270, clientY: 404 }], cancelable: true });
  fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 270, clientY: 404 }] });
  await waitFor(() => expect(screen.getByTestId('terminal-preview-grid')).toBeTruthy());
}

function renderPage(overrides: Partial<ComponentProps<typeof TerminalPageComponent>> = {}) {
  const TerminalPage = withTerminalShell(TerminalPageComponent);
  const onSwitchSession = vi.fn();
  const stableNoop = vi.fn();

  function Harness() {
    const [activeSession, setActiveSession] = useState(makeSession('s1'));
    const sessions = overrides.sessions || [activeSession];
    return (
      <TerminalPage
        sessions={sessions}
        activeSession={overrides.activeSession || activeSession}
        onSwitchSession={(sessionId) => {
          onSwitchSession(sessionId);
          const next = sessions.find((item) => item.id === sessionId);
          if (next) setActiveSession(next);
        }}
        onMoveSession={stableNoop}
        onRenameSession={stableNoop}
        onCloseSession={stableNoop}
        onOpenConnections={stableNoop}
        onOpenQuickTabPicker={stableNoop}
        onTerminalViewportChange={stableNoop}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        {...overrides}
      />
    );
  }

  const view = render(<Harness />);
  return { view, onSwitchSession, stableNoop };
}

describe('TerminalPage junction preview integration', () => {
  it('opens preview only for a left swipe starting at the right edge', async () => {
    const { TerminalStageShell } = await import('./TerminalPageStageShell');
    const onOpenSessionPreview = vi.fn();
    render(
      <TerminalStageShell
        {...baseProps}
        sessionPreviewCandidates={[makeSession('s1')]}
        onOpenSessionPreview={onOpenSessionPreview}
      />,
    );
    const stage = screen.getByTestId('terminal-stage-shell');

    fireEvent.touchStart(stage, { touches: [{ clientX: 338, clientY: 400 }] });
    fireEvent.touchMove(stage, { touches: [{ clientX: 270, clientY: 404 }] });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 270, clientY: 404 }] });
    expect(onOpenSessionPreview).toHaveBeenCalledTimes(1);

    fireEvent.touchStart(stage, { touches: [{ clientX: 180, clientY: 400 }] });
    fireEvent.touchMove(stage, { touches: [{ clientX: 100, clientY: 402 }] });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 100, clientY: 402 }] });
    expect(onOpenSessionPreview).toHaveBeenCalledTimes(1);
  });

  it('subscribes only visible lattice cells while preview is open', async () => {
    const sessions = Array.from({ length: 5 }, (_, index) => makeSession(`s${index + 1}`));
    writeLattice(sessions);
    const onLiveSessionIdsChange = vi.fn();
    renderPage({
      sessions,
      activeSession: sessions[0],
      onLiveSessionIdsChange,
    });

    const stage = screen.getByTestId('terminal-stage-shell');
    await openPreview(stage);

    await waitFor(() => expect(onLiveSessionIdsChange.mock.calls.at(-1)?.[0]).toEqual(
      expect.arrayContaining(['s1', 's2', 's3', 's4']),
    ));
    expect(onLiveSessionIdsChange.mock.calls.at(-1)?.[0]).not.toContain('s5');
  });

  it('pans focus to an edge cell without switching the active shell session', async () => {
    const sessions = [makeSession('s1'), makeSession('s2'), makeSession('s3')];
    writeLattice(sessions);
    const { onSwitchSession } = renderPage({ sessions, activeSession: sessions[0] });
    const stage = screen.getByTestId('terminal-stage-shell');
    await openPreview(stage);

    fireEvent.click(screen.getByTestId('terminal-preview-tile-s2'));

    await waitFor(() => expect(screen.getByTestId('terminal-preview-tile-s2').dataset.previewFocus).toBe('true'));
    expect(onSwitchSession).not.toHaveBeenCalled();
    expect(screen.queryByTestId('terminal-preview-grid')).toBeTruthy();
  });

  it('treats a reused session id with changed endpoint identity as an empty persisted cell', async () => {
    const activeSession = makeSession('s1');
    writeLattice([activeSession]);
    const staleRaw = localStorage.getItem(JUNCTION_PREVIEW_LATTICE_STORAGE_KEY);
    expect(staleRaw).not.toBeNull();
    localStorage.setItem(
      JUNCTION_PREVIEW_LATTICE_STORAGE_KEY,
      staleRaw!.replace('"bridgePort":3333', '"bridgePort":4444'),
    );
    const { onSwitchSession } = renderPage({
      sessions: [activeSession],
      activeSession,
    });
    const stage = screen.getByTestId('terminal-stage-shell');

    await openPreview(stage);

    await waitFor(() => expect(screen.getByTestId('terminal-preview-tile-s1').dataset.previewFocus).toBe('true'));
    expect(screen.getByTestId('terminal-preview-grid')).toBeTruthy();
    expect(onSwitchSession).not.toHaveBeenCalled();
  });

  it('opens the drawer from the left edge during preview and changes only the focus cell', async () => {
    const sessions = [makeSession('s1'), makeSession('s2'), makeSession('s3')];
    writeLattice([sessions[0], sessions[1]]);
    const stableNoop = vi.fn();
    const { TerminalPage: TerminalPageBase } = await import('./TerminalPage');
    const TerminalPage = withTerminalShell(withSessionDrawer(TerminalPageBase));
    render(
      <TerminalPage
        sessions={sessions}
        sessionGroups={[{
          id: 'mac-local',
          name: 'Mac Local',
          bridgeHost: 'mac.local',
          bridgePort: 3333,
          sessionNames: sessions.map((session) => session.sessionName),
          lastOpenedAt: 1,
        }]}
        activeSession={sessions[0]}
        onSwitchSession={stableNoop}
        onMoveSession={stableNoop}
        onRenameSession={stableNoop}
        onCloseSession={stableNoop}
        onOpenConnections={stableNoop}
        onOpenQuickTabPicker={stableNoop}
        onTerminalViewportChange={stableNoop}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );
    const stage = screen.getByTestId('terminal-stage-shell');
    await openPreview(stage);

    fireEvent.touchStart(stage, { touches: [{ clientX: 30, clientY: 400 }] });
    fireEvent.touchMove(stage, { touches: [{ clientX: 160, clientY: 404 }], cancelable: true });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 160, clientY: 404 }] });
    await waitFor(() => expect(screen.getByTestId('terminal-session-drawer')).toBeTruthy());

    const unscopedHost = screen.queryByTestId('terminal-session-drawer-host-__unscoped__');
    if (unscopedHost) fireEvent.click(unscopedHost);
    await waitFor(() => expect(screen.getByTestId('terminal-session-drawer-select-s3')).toBeTruthy());
    fireEvent.click(screen.getByTestId('terminal-session-drawer-select-s3'));
    await waitFor(() => expect(screen.getByTestId('terminal-session-drawer').getAttribute('aria-hidden')).toBe('true'));
    await waitFor(() => expect(screen.getByTestId('terminal-preview-tile-s3').dataset.previewFocus).toBe('true'));
    expect(screen.getByTestId('terminal-preview-tile-s2').dataset.previewEdge).toBe('left');
    expect(screen.getByTestId('terminal-preview-grid')).toBeTruthy();
  });

  it('keeps the preview drawer reachable from the left edge in landscape', async () => {
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    const originalClientHeight = document.documentElement.clientHeight;
    const originalVisualViewport = window.visualViewport;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        width: 1280,
        height: 800,
        offsetTop: 0,
        offsetLeft: 0,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    try {
      const sessions = [makeSession('s1'), makeSession('s2')];
      writeLattice(sessions);
      const stableNoop = vi.fn();
      const { TerminalPage: TerminalPageBase } = await import('./TerminalPage');
      const TerminalPage = withTerminalShell(withSessionDrawer(TerminalPageBase));
      render(
        <TerminalPage
          sessions={sessions}
          sessionGroups={[{
            id: 'mac-local',
            name: 'Mac Local',
            bridgeHost: 'mac.local',
            bridgePort: 3333,
            sessionNames: sessions.map((session) => session.sessionName),
            lastOpenedAt: 1,
          }]}
          activeSession={sessions[0]}
          onSwitchSession={stableNoop}
          onMoveSession={stableNoop}
          onRenameSession={stableNoop}
          onCloseSession={stableNoop}
          onOpenConnections={stableNoop}
          onOpenQuickTabPicker={stableNoop}
          onTerminalViewportChange={stableNoop}
          quickActions={[]}
          shortcutActions={[]}
          sessionDraft=""
        />,
      );
      const stage = screen.getByTestId('terminal-stage-shell');
      fireEvent.touchStart(stage, { touches: [{ clientX: 1250, clientY: 400 }] });
      fireEvent.touchMove(stage, { touches: [{ clientX: 1160, clientY: 404 }], cancelable: true });
      fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 1160, clientY: 404 }] });
      await waitFor(() => expect(screen.getByTestId('terminal-preview-grid')).toBeTruthy());

      const preview = screen.getByTestId('terminal-preview-grid');
      fireEvent.touchStart(preview, { touches: [{ clientX: 30, clientY: 400 }] });
      fireEvent.touchMove(preview, { touches: [{ clientX: 160, clientY: 404 }], cancelable: true });
      fireEvent.touchEnd(preview, { changedTouches: [{ clientX: 160, clientY: 404 }] });

      await waitFor(() => expect(screen.getByTestId('terminal-session-drawer')).toBeTruthy());
      expect(screen.getByTestId('terminal-preview-grid')).toBeTruthy();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
      Object.defineProperty(document.documentElement, 'clientHeight', {
        configurable: true,
        value: originalClientHeight,
      });
      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: originalVisualViewport,
      });
    }
  });

  it('routes QuickBar input to the focused preview session without exiting preview', async () => {
    const sessions = [makeSession('s1'), makeSession('s2')];
    writeLattice(sessions);
    const onQuickActionInput = vi.fn();
    const stableNoop = vi.fn();
    const { TerminalPage: TerminalPageBase } = await import('./TerminalPage');
    const TerminalPage = withTerminalShell(TerminalPageBase);
    render(
      <TerminalPage
        sessions={sessions}
        activeSession={sessions[0]}
        onSwitchSession={stableNoop}
        onMoveSession={stableNoop}
        onRenameSession={stableNoop}
        onCloseSession={stableNoop}
        onOpenConnections={stableNoop}
        onOpenQuickTabPicker={stableNoop}
        onTerminalViewportChange={stableNoop}
        onQuickActionInput={onQuickActionInput}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        renderQuickBar={renderQuickBar}
      />,
    );
    const stage = screen.getByTestId('terminal-stage-shell');
    await openPreview(stage);

    expect(screen.getByTestId('terminal-quickbar').dataset.activeSessionId).toBe('s1');
    fireEvent.click(screen.getByTestId('terminal-preview-tile-s2'));
    await waitFor(() => expect(screen.getByTestId('terminal-preview-tile-s2').dataset.previewFocus).toBe('true'));
    expect(screen.getByTestId('terminal-quickbar').dataset.activeSessionId).toBe('s2');

    fireEvent.click(screen.getByTestId('terminal-quickbar-send'));
    expect(onQuickActionInput).toHaveBeenCalledWith('PING', 's2');
  });

  it('exits from the top close control and restores the entry projection', async () => {
    const sessions = [makeSession('s1'), makeSession('s2')];
    writeLattice(sessions);
    const onSwitchSession = vi.fn();
    const stableNoop = vi.fn();
    const { TerminalPage: TerminalPageBase } = await import('./TerminalPage');
    const TerminalPage = withTerminalShell(TerminalPageBase);
    render(
      <TerminalPage
        sessions={sessions}
        activeSession={sessions[0]}
        onSwitchSession={onSwitchSession}
        onMoveSession={stableNoop}
        onRenameSession={stableNoop}
        onCloseSession={stableNoop}
        onOpenConnections={stableNoop}
        onOpenQuickTabPicker={stableNoop}
        onTerminalViewportChange={stableNoop}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );
    const stage = screen.getByTestId('terminal-stage-shell');
    await openPreview(stage);

    fireEvent.click(screen.getByLabelText('退出终端预览'));
    await waitFor(() => expect(screen.queryByTestId('terminal-preview-grid')).toBeNull());
    expect(onSwitchSession).not.toHaveBeenCalled();
    expect(screen.getByTestId('terminal-view-s1')).toBeTruthy();
  });

  it('consumes system Back while preview is open', async () => {
    const sessions = [makeSession('s1'), makeSession('s2')];
    writeLattice(sessions);
    const stableNoop = vi.fn();
    const { TerminalPage: TerminalPageBase } = await import('./TerminalPage');
    const TerminalPage = withTerminalShell(TerminalPageBase);
    render(
      <TerminalPage
        sessions={sessions}
        activeSession={sessions[0]}
        onSwitchSession={stableNoop}
        onMoveSession={stableNoop}
        onRenameSession={stableNoop}
        onCloseSession={stableNoop}
        onOpenConnections={stableNoop}
        onOpenQuickTabPicker={stableNoop}
        onTerminalViewportChange={stableNoop}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );
    const stage = screen.getByTestId('terminal-stage-shell');
    await openPreview(stage);
    expect(appListenerMock.backButton).not.toBeNull();
    act(() => appListenerMock.backButton?.());
    await waitFor(() => expect(screen.queryByTestId('terminal-preview-grid')).toBeNull());
  });
});
