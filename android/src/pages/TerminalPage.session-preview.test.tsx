// @vitest-environment jsdom

import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_PREVIEW_SELECTION_STORAGE_KEY } from '../lib/session-preview-selection';
import type { Session } from '../lib/types';

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
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  localStorage.clear();
});

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'web' },
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

vi.mock('../components/terminal/TerminalQuickBar', () => ({
  TerminalQuickBar: () => null,
}));

vi.mock('../components/TerminalView', () => ({
  TerminalView: ({ sessionId }: { sessionId: string }) => <div data-testid={`terminal-view-${sessionId}`} />,
}));

const session = {
  id: 's1',
  title: 'Session 1',
  sessionName: 'tmux-1',
  state: 'connected',
  bridgeHost: 'mac.local',
  bridgePort: 3333,
} as Session;

function makeSession(id: string): Session {
  return {
    ...session,
    id,
    title: 'Session ' + id,
    sessionName: 'tmux-' + id,
    createdAt: id === 's1' ? 1 : 2,
  };
}

const baseProps = {
  interactiveSession: session,
  renderedPaneSessions: [session],
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

describe('TerminalPage session preview integration', () => {
  it('opens preview only for a left swipe starting at the right edge', async () => {
    const { TerminalStageShell } = await import('./TerminalPageStageShell');
    const onOpenSessionPreview = vi.fn();
    render(
      <TerminalStageShell
        {...baseProps}
        sessionPreviewSessions={[session]}
        onOpenSessionPreview={onOpenSessionPreview}
      />,
    );
    const stage = screen.getByTestId('terminal-stage-shell');
    fireEvent.touchStart(stage, { touches: [{ clientX: 338, clientY: 400 }] });
    fireEvent.touchMove(stage, { touches: [{ clientX: 270, clientY: 404 }] });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 270, clientY: 404 }] });
    expect(onOpenSessionPreview).toHaveBeenCalledTimes(1);
  });

  it('keeps middle fixed crop and wrong-direction gestures out of preview', async () => {
    const { TerminalStageShell } = await import('./TerminalPageStageShell');
    const onOpenSessionPreview = vi.fn();
    render(
      <TerminalStageShell
        {...baseProps}
        sessionPreviewSessions={[session]}
        onOpenSessionPreview={onOpenSessionPreview}
      />,
    );
    const stage = screen.getByTestId('terminal-stage-shell');
    fireEvent.touchStart(stage, { touches: [{ clientX: 180, clientY: 400 }] });
    fireEvent.touchMove(stage, { touches: [{ clientX: 100, clientY: 402 }] });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 100, clientY: 402 }] });
    fireEvent.touchStart(stage, { touches: [{ clientX: 338, clientY: 400 }] });
    fireEvent.touchMove(stage, { touches: [{ clientX: 359, clientY: 402 }] });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 359, clientY: 402 }] });
    expect(onOpenSessionPreview).not.toHaveBeenCalled();
  });

  it('replaces normal stage with a read-only preview and delegates one tile activation to the page owner', async () => {
    const { TerminalStageShell } = await import('./TerminalPageStageShell');
    const onActivatePreviewSession = vi.fn();
    const onCloseSessionPreview = vi.fn();
    render(
      <TerminalStageShell
        {...baseProps}
        sessionPreviewOpen
        sessionPreviewSessions={[session]}
        onActivatePreviewSession={onActivatePreviewSession}
        onCloseSessionPreview={onCloseSessionPreview}
      />,
    );
    expect(screen.getByTestId('terminal-preview-grid')).toBeTruthy();
    fireEvent.click(screen.getByTestId('terminal-preview-tile-s1'));
    expect(onActivatePreviewSession).toHaveBeenCalledWith('s1');
    expect(onActivatePreviewSession).toHaveBeenCalledTimes(1);
    expect(onCloseSessionPreview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('退出终端预览'));
    expect(onCloseSessionPreview).toHaveBeenCalledTimes(1);
  });

  it('projects a tapped preview tile into the real shell before preview subscriptions close', async () => {
    const sessions = [makeSession('s1'), makeSession('s2')];
    localStorage.setItem(SESSION_PREVIEW_SELECTION_STORAGE_KEY, JSON.stringify({
      version: 1,
      orderedTargets: sessions.map((item) => ({
        sessionId: item.id,
        bridgeHost: item.bridgeHost,
        bridgePort: item.bridgePort,
        sessionName: item.sessionName,
      })),
    }));
    const onSwitchSession = vi.fn();
    const stableNoop = vi.fn();

    function Harness() {
      const [activeSession, setActiveSession] = useState(sessions[0]);
      return (
        <TerminalPage
          sessions={sessions}
          activeSession={activeSession}
          onSwitchSession={(sessionId) => {
            onSwitchSession(sessionId);
            setActiveSession(sessions.find((item) => item.id === sessionId) || sessions[0]);
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
        />
      );
    }

    const { TerminalPage } = await import('./TerminalPage');
    render(<Harness />);

    const stage = screen.getByTestId('terminal-stage-shell');
    fireEvent.touchStart(stage, { touches: [{ clientX: 338, clientY: 400 }] });
    fireEvent.touchMove(stage, {
      touches: [{ clientX: 270, clientY: 404 }],
      cancelable: true,
    });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 270, clientY: 404 }] });

    fireEvent.click(await screen.findByTestId('terminal-preview-tile-s2'));
    expect(screen.getByTestId('terminal-preview-tile-s2').dataset.previewVariant).toBe('primary');
    expect(onSwitchSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('terminal-preview-tile-s2'));
    await waitFor(() => expect(screen.queryByTestId('terminal-preview-grid')).toBeNull());
    expect(onSwitchSession).toHaveBeenCalledTimes(1);
    expect(onSwitchSession).toHaveBeenCalledWith('s2');
    expect(screen.getByTestId('terminal-view-s2')).toBeTruthy();
    expect(screen.queryByTestId('terminal-view-s1')).toBeNull();
  });

  it('keeps every selected preview child in live body demand while foreground is true', async () => {
    const sessions = [makeSession('s1'), makeSession('s2'), makeSession('s3'), makeSession('s4')];
    localStorage.setItem(SESSION_PREVIEW_SELECTION_STORAGE_KEY, JSON.stringify({
      version: 1,
      orderedTargets: sessions.map((item) => ({
        sessionId: item.id,
        bridgeHost: item.bridgeHost,
        bridgePort: item.bridgePort,
        sessionName: item.sessionName,
      })),
    }));
    const onLiveSessionIdsChange = vi.fn();
    const stableNoop = vi.fn();
    const { TerminalPage } = await import('./TerminalPage');

    const renderPage = (appForegroundActive: boolean) => (
      <TerminalPage
        appForegroundActive={appForegroundActive}
        sessions={sessions}
        activeSession={sessions[0]}
        onSwitchSession={stableNoop}
        onMoveSession={stableNoop}
        onRenameSession={stableNoop}
        onCloseSession={stableNoop}
        onOpenConnections={stableNoop}
        onOpenQuickTabPicker={stableNoop}
        onTerminalViewportChange={stableNoop}
        onLiveSessionIdsChange={onLiveSessionIdsChange}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />
    );

    const view = render(renderPage(true));
    await waitFor(() => expect(onLiveSessionIdsChange).toHaveBeenLastCalledWith(['s1']));

    const stage = screen.getByTestId('terminal-stage-shell');
    fireEvent.touchStart(stage, { touches: [{ clientX: 338, clientY: 400 }] });
    fireEvent.touchMove(stage, { touches: [{ clientX: 270, clientY: 404 }], cancelable: true });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 270, clientY: 404 }] });
    await waitFor(() => expect(screen.getByTestId('terminal-preview-grid')).toBeTruthy());
    await waitFor(() => expect(onLiveSessionIdsChange).toHaveBeenLastCalledWith(['s1', 's2', 's3', 's4']));

    view.rerender(renderPage(false));
    await waitFor(() => expect(onLiveSessionIdsChange).toHaveBeenLastCalledWith(['s1']));
    expect(screen.getByTestId('terminal-preview-grid')).toBeTruthy();

    view.rerender(renderPage(true));
    await waitFor(() => expect(onLiveSessionIdsChange).toHaveBeenLastCalledWith(['s1', 's2', 's3', 's4']));
  });

  it('materializes a remote-only drawer row before adding it to preview selection', async () => {
    const currentSession = makeSession('s1');
    currentSession.daemonHostId = 'daemon-a';
    currentSession.sessionName = 'tmux-s1';
    const openedSession = makeSession('remote-opened');
    openedSession.daemonHostId = 'daemon-a';
    openedSession.bridgeHost = '100.127.23.27';
    openedSession.bridgePort = 3333;
    openedSession.sessionName = 'remote-beta';
    openedSession.title = 'remote beta tab';
    const onOpenDrawerRemoteSession = vi.fn((_target: unknown, _sessionName: string, _options?: { activate?: boolean; navigate?: boolean }) => 'remote-opened');
    const stableNoop = vi.fn();
    const { TerminalPage } = await import('./TerminalPage');

    function Harness() {
      const [sessions, setSessions] = useState<Session[]>([currentSession]);
      return (
        <TerminalPage
          sessions={sessions}
          sessionGroups={[{
            id: 'daemon:daemon-a',
            name: 'Daemon A',
            bridgeHost: '100.127.23.27',
            bridgePort: 3333,
            daemonHostId: 'daemon-a',
            authToken: 'token-a',
            sessionNames: ['tmux-s1', 'remote-beta'],
            lastOpenedAt: 1,
          }]}
          activeSession={sessions[0] || null}
          onSwitchSession={stableNoop}
          onMoveSession={stableNoop}
          onRenameSession={stableNoop}
          onCloseSession={stableNoop}
          onOpenConnections={stableNoop}
          onOpenQuickTabPicker={stableNoop}
          onOpenDrawerRemoteSession={(target, sessionName, options) => {
            const openedId = onOpenDrawerRemoteSession(target, sessionName, options);
            setSessions([currentSession, openedSession]);
            return openedId;
          }}
          onTerminalViewportChange={stableNoop}
          quickActions={[]}
          shortcutActions={[]}
          sessionDraft=""
        />
      );
    }

    render(<Harness />);
    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    fireEvent.touchStart(swipeSurface!, { touches: [{ clientX: 56, clientY: 200 }] });
    fireEvent.touchMove(swipeSurface!, { touches: [{ clientX: 236, clientY: 206 }], cancelable: true });
    fireEvent.touchEnd(swipeSurface!, { changedTouches: [{ clientX: 236, clientY: 206 }] });
    fireEvent.click(await screen.findByTestId('terminal-session-drawer-preview-mode'));
    fireEvent.click(await screen.findByTestId('terminal-session-drawer-preview-check-remote:daemon:daemon-a::session:remote-beta'));

    await waitFor(() => expect(onOpenDrawerRemoteSession).toHaveBeenCalledWith(
      {
        name: 'Daemon A',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        relayHostId: 'daemon-a',
        authToken: 'token-a',
        sessionNames: ['tmux-s1', 'remote-beta'],
      },
      'remote-beta',
      { activate: false, navigate: false },
    ));
    await waitFor(() => expect(screen.getByTestId('terminal-session-drawer-preview-check-remote-opened').textContent).toBe('1'));
    const stored = JSON.parse(localStorage.getItem(SESSION_PREVIEW_SELECTION_STORAGE_KEY) || '{}');
    expect(stored.orderedTargets.map((item: { sessionId: string }) => item.sessionId)).toEqual(['remote-opened']);
    expect(stored.orderedTargets[0]).toEqual(expect.objectContaining({
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      sessionName: 'remote-beta',
      daemonHostId: 'daemon-a',
    }));
    expect(stored.orderedTargets[0].sessionId).not.toContain('remote:daemon');
    expect(stableNoop).not.toHaveBeenCalledWith('remote:daemon:daemon-a::session:remote-beta');
  });

  it('does not persist a remote placeholder when preview auto-open fails', async () => {
    const currentSession = makeSession('s1');
    currentSession.daemonHostId = 'daemon-a';
    currentSession.sessionName = 'tmux-s1';
    const onOpenDrawerRemoteSession = vi.fn((_target: unknown, _sessionName: string, _options?: { activate?: boolean; navigate?: boolean }) => undefined);
    const stableNoop = vi.fn();
    const { TerminalPage } = await import('./TerminalPage');

    render(
      <TerminalPage
        sessions={[currentSession]}
        sessionGroups={[{
          id: 'daemon:daemon-a',
          name: 'Daemon A',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          daemonHostId: 'daemon-a',
          authToken: 'token-a',
          sessionNames: ['tmux-s1', 'remote-beta'],
          lastOpenedAt: 1,
        }]}
        activeSession={currentSession}
        onSwitchSession={stableNoop}
        onMoveSession={stableNoop}
        onRenameSession={stableNoop}
        onCloseSession={stableNoop}
        onOpenConnections={stableNoop}
        onOpenQuickTabPicker={stableNoop}
        onOpenDrawerRemoteSession={onOpenDrawerRemoteSession}
        onTerminalViewportChange={stableNoop}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    fireEvent.touchStart(swipeSurface!, { touches: [{ clientX: 56, clientY: 200 }] });
    fireEvent.touchMove(swipeSurface!, { touches: [{ clientX: 236, clientY: 206 }], cancelable: true });
    fireEvent.touchEnd(swipeSurface!, { changedTouches: [{ clientX: 236, clientY: 206 }] });
    fireEvent.click(await screen.findByTestId('terminal-session-drawer-preview-mode'));
    fireEvent.click(await screen.findByTestId('terminal-session-drawer-preview-check-remote:daemon:daemon-a::session:remote-beta'));

    expect(onOpenDrawerRemoteSession).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText('无法打开该 session，不能加入实时预览。')).toBeTruthy());
    const stored = localStorage.getItem(SESSION_PREVIEW_SELECTION_STORAGE_KEY);
    expect(stored === null || JSON.parse(stored).orderedTargets.length === 0).toBe(true);
  });

  it('replaces a preview tile with an unselected open session without changing active session', async () => {
    const previewSessions = [makeSession('s1'), makeSession('s2'), makeSession('s3')];
    localStorage.setItem(SESSION_PREVIEW_SELECTION_STORAGE_KEY, JSON.stringify({
      version: 1,
      orderedTargets: previewSessions.slice(0, 2).map((item) => ({
        sessionId: item.id,
        bridgeHost: item.bridgeHost,
        bridgePort: item.bridgePort,
        sessionName: item.sessionName,
      })),
    }));
    const onSwitchSession = vi.fn();
    const stableNoop = vi.fn();
    const { TerminalPage } = await import('./TerminalPage');
    render(
      <TerminalPage
        sessions={previewSessions}
        activeSession={previewSessions[0]}
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
    fireEvent.touchStart(stage, { touches: [{ clientX: 338, clientY: 400 }] });
    fireEvent.touchMove(stage, { touches: [{ clientX: 270, clientY: 404 }], cancelable: true });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 270, clientY: 404 }] });
    const tile = await screen.findByTestId('terminal-preview-tile-s1');
    fireEvent.contextMenu(tile);
    expect(screen.queryByTestId('terminal-preview-replace-s1')).toBeNull();
    expect(screen.queryByTestId('terminal-preview-replace-s2')).toBeNull();
    expect(screen.getByTestId('terminal-preview-replace-s3')).toBeTruthy();
    fireEvent.click(screen.getByTestId('terminal-preview-replace-s3'));

    expect(screen.queryByTestId('terminal-preview-tile-s1')).toBeNull();
    expect(screen.getByTestId('terminal-preview-tile-s3')).toBeTruthy();
    expect(onSwitchSession).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(SESSION_PREVIEW_SELECTION_STORAGE_KEY) || '{}').orderedTargets
      .map((item: { sessionId: string }) => item.sessionId)).toEqual(['s3', 's2']);
  });

  it('removes preview targets without closing Sessions and cancels after the final removal', async () => {
    const previewSessions = [makeSession('s1'), makeSession('s2')];
    localStorage.setItem(SESSION_PREVIEW_SELECTION_STORAGE_KEY, JSON.stringify({
      version: 1,
      orderedTargets: previewSessions.map((item) => ({
        sessionId: item.id,
        bridgeHost: item.bridgeHost,
        bridgePort: item.bridgePort,
        sessionName: item.sessionName,
      })),
    }));
    const onCloseSession = vi.fn();
    const stableNoop = vi.fn();
    const { TerminalPage } = await import('./TerminalPage');
    render(
      <TerminalPage
        sessions={previewSessions}
        activeSession={previewSessions[0]}
        onSwitchSession={stableNoop}
        onMoveSession={stableNoop}
        onRenameSession={stableNoop}
        onCloseSession={onCloseSession}
        onOpenConnections={stableNoop}
        onOpenQuickTabPicker={stableNoop}
        onTerminalViewportChange={stableNoop}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    const stage = screen.getByTestId('terminal-stage-shell');
    fireEvent.touchStart(stage, { touches: [{ clientX: 338, clientY: 400 }] });
    fireEvent.touchMove(stage, { touches: [{ clientX: 270, clientY: 404 }], cancelable: true });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 270, clientY: 404 }] });
    expect(await screen.findByTestId('terminal-preview-grid')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('从预览移除 Session s2'));
    await waitFor(() => expect(screen.queryByTestId('terminal-preview-tile-s2')).toBeNull());
    expect(screen.getAllByTestId(/terminal-preview-tile-/)).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(SESSION_PREVIEW_SELECTION_STORAGE_KEY) || '{}').orderedTargets)
      .toHaveLength(1);

    fireEvent.click(screen.getByLabelText('从预览移除 Session s1'));
    await waitFor(() => expect(screen.queryByTestId('terminal-preview-grid')).toBeNull());
    expect(onCloseSession).not.toHaveBeenCalled();
  });

  it('lists every open unselected Session after removing preview tiles and adds one back', async () => {
    const previewSessions = Array.from({ length: 6 }, (_, index) => makeSession(`s${index + 1}`));
    localStorage.setItem(SESSION_PREVIEW_SELECTION_STORAGE_KEY, JSON.stringify({
      version: 1,
      orderedTargets: previewSessions.map((item) => ({
        sessionId: item.id,
        bridgeHost: item.bridgeHost,
        bridgePort: item.bridgePort,
        sessionName: item.sessionName,
      })),
    }));
    const stableNoop = vi.fn();
    const { TerminalPage } = await import('./TerminalPage');
    render(
      <TerminalPage
        sessions={previewSessions}
        activeSession={previewSessions[0]}
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
    fireEvent.touchStart(stage, { touches: [{ clientX: 338, clientY: 400 }] });
    fireEvent.touchMove(stage, { touches: [{ clientX: 270, clientY: 404 }], cancelable: true });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 270, clientY: 404 }] });
    expect(await screen.findByTestId('terminal-preview-grid')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('从预览移除 Session s5'));
    fireEvent.click(screen.getByLabelText('从预览移除 Session s6'));
    await waitFor(() => expect(screen.getAllByTestId(/terminal-preview-tile-/)).toHaveLength(4));

    fireEvent.click(screen.getByRole('button', { name: '增加预览窗口' }));
    expect(screen.getByTestId('terminal-preview-add-s5')).toBeTruthy();
    expect(screen.getByTestId('terminal-preview-add-s6')).toBeTruthy();
    expect(screen.queryByTestId('terminal-preview-add-s1')).toBeNull();
    expect(screen.queryByTestId('terminal-preview-add-s2')).toBeNull();
    expect(screen.queryByTestId('terminal-preview-add-s3')).toBeNull();
    expect(screen.queryByTestId('terminal-preview-add-s4')).toBeNull();

    fireEvent.click(screen.getByTestId('terminal-preview-add-s6'));
    await waitFor(() => expect(screen.getByTestId('terminal-preview-tile-s6')).toBeTruthy());
    expect(JSON.parse(localStorage.getItem(SESSION_PREVIEW_SELECTION_STORAGE_KEY) || '{}').orderedTargets
      .map((item: { sessionId: string }) => item.sessionId)).toEqual(['s1', 's2', 's3', 's4', 's6']);
  });

  it('consumes system Back in preview and restores the session active when preview opened', async () => {
    const previewSessions = [makeSession('s1'), makeSession('s2')];
    localStorage.setItem(SESSION_PREVIEW_SELECTION_STORAGE_KEY, JSON.stringify({
      version: 1,
      orderedTargets: previewSessions.map((item) => ({
        sessionId: item.id,
        bridgeHost: item.bridgeHost,
        bridgePort: item.bridgePort,
        sessionName: item.sessionName,
      })),
    }));
    const onSwitchSession = vi.fn();
    const stableNoop = vi.fn();
    let moveActiveSession: ((sessionId: string) => void) | null = null;

    function Harness() {
      const [activeSession, setActiveSession] = useState(previewSessions[0]);
      moveActiveSession = (sessionId) => setActiveSession(
        previewSessions.find((item) => item.id === sessionId) || previewSessions[0],
      );
      return (
        <TerminalPage
          sessions={previewSessions}
          activeSession={activeSession}
          onSwitchSession={(sessionId) => {
            onSwitchSession(sessionId);
            moveActiveSession?.(sessionId);
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
        />
      );
    }

    const { TerminalPage } = await import('./TerminalPage');
    render(<Harness />);
    expect(appListenerMock.backButton).toBeNull();
    const stage = screen.getByTestId('terminal-stage-shell');
    fireEvent.touchStart(stage, { touches: [{ clientX: 338, clientY: 400 }] });
    fireEvent.touchMove(stage, { touches: [{ clientX: 270, clientY: 404 }], cancelable: true });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 270, clientY: 404 }] });
    expect(await screen.findByTestId('terminal-preview-grid')).toBeTruthy();
    act(() => moveActiveSession?.('s2'));
    await waitFor(() => expect(appListenerMock.backButton).not.toBeNull());
    act(() => appListenerMock.backButton?.());
    await waitFor(() => expect(screen.queryByTestId('terminal-preview-grid')).toBeNull());
    expect(onSwitchSession).toHaveBeenCalledTimes(1);
    expect(onSwitchSession).toHaveBeenCalledWith('s1');
    expect(screen.getByTestId('terminal-view-s1')).toBeTruthy();
    await waitFor(() => expect(appListenerMock.backButton).toBeNull());
  });
});
