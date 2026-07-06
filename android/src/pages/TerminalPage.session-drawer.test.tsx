// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../lib/types';
import { resolveSessionGroupBoundaryProjection } from '../lib/session-group-viewport';
import {
  TerminalPage,
  resolveTerminalSessionGroupSlotReplacement,
  resolveTerminalSessionGroupViewportSlots,
  resolveTerminalSessionGroupViewportProjection,
} from './TerminalPage';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'web',
  },
  registerPlugin: () => ({
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

vi.mock('../components/terminal/TerminalHeader', () => ({
  TerminalHeader: () => <div data-testid="terminal-header" />,
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

vi.mock('../components/TerminalView', () => ({
  TerminalView: ({ sessionId, active }: { sessionId: string; active?: boolean }) => (
    <div data-testid={`terminal-view-${sessionId}`} data-active={active ? 'true' : 'false'}>
      terminal:{sessionId}
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

describe('TerminalPage portrait session drawer', () => {
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
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        width: 390,
        height: 844,
        offsetTop: 0,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('hides the header in portrait and opens the session drawer on right swipe', async () => {
    const sessions = [makeSession('s1'), makeSession('s2')];
    sessions[0]!.daemonHostId = 'daemon-a';
    sessions[1]!.daemonHostId = 'daemon-a';
    const sessionGroups = [{
      id: 'daemon-a',
      name: 'Daemon A',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      daemonHostId: 'daemon-a',
      authToken: 'token-a',
      sessionNames: ['tmux-s1', 'tmux-s2'],
      lastOpenedAt: 1,
    }];
    const onSwitchSession = vi.fn();

    render(
      <TerminalPage
        sessions={sessions}
        sessionGroups={sessionGroups}
        activeSession={sessions[0]}
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
        onLoadSavedTabList={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('terminal-header')).toBeNull();

    expect(screen.getByTestId('terminal-session-drawer').getAttribute('aria-hidden')).toBe('true');

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    const resolvedSwipeSurface = swipeSurface!;
    const activeSurfaceSessionId = resolvedSwipeSurface.getAttribute('data-testid')?.replace('terminal-swipe-surface-', '') || '';
    const targetSessionId = activeSurfaceSessionId === 's1' ? 's2' : 's1';
    fireEvent.touchStart(resolvedSwipeSurface, { touches: [{ clientX: 48, clientY: 200 }] });
    fireEvent.touchMove(resolvedSwipeSurface, {
      touches: [{ clientX: 236, clientY: 206 }],
      cancelable: true,
    });
    fireEvent.touchEnd(resolvedSwipeSurface, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    expect(screen.getByTestId('terminal-session-drawer').getAttribute('aria-hidden')).toBe('false');

    fireEvent.click(await screen.findByTestId(`terminal-session-drawer-select-${targetSessionId}`));
    expect(onSwitchSession).toHaveBeenCalledWith(targetSessionId);
  });

  it('does not switch the session-group center before runtime active catches up after drawer selection', async () => {
    const sessions = [makeSession('s1'), makeSession('s2')];
    sessions[0]!.daemonHostId = 'daemon-a';
    sessions[1]!.daemonHostId = 'daemon-a';
    const sessionGroups = [{
      id: 'daemon-a',
      name: 'Daemon A',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      daemonHostId: 'daemon-a',
      authToken: 'token-a',
      sessionNames: ['tmux-s1', 'tmux-s2'],
      lastOpenedAt: 1,
    }];
    const onSwitchSession = vi.fn();
    const view = render(
      <TerminalPage
        sessions={sessions}
        sessionGroups={sessionGroups}
        activeSession={sessions[0]}
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
        onLoadSavedTabList={vi.fn()}
      />,
    );

    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-active')).toBe('true');
    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    fireEvent.touchStart(swipeSurface!, { touches: [{ clientX: 48, clientY: 200 }] });
    fireEvent.touchMove(swipeSurface!, {
      touches: [{ clientX: 236, clientY: 206 }],
      cancelable: true,
    });
    fireEvent.touchEnd(swipeSurface!, { changedTouches: [{ clientX: 236, clientY: 206 }] });
    fireEvent.click(await screen.findByTestId('terminal-session-drawer-select-s2'));

    expect(onSwitchSession).toHaveBeenCalledWith('s2');
    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-active')).toBe('true');
    expect(screen.queryByTestId('terminal-view-s2')).toBeNull();

    view.rerender(
      <TerminalPage
        sessions={sessions}
        sessionGroups={sessionGroups}
        activeSession={sessions[1]}
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
        onLoadSavedTabList={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-view-s2').getAttribute('data-active')).toBe('true'));
    expect(screen.queryByTestId('terminal-view-s1')).toBeNull();
  });

  it('routes drawer plus action to the quick tab picker', () => {
    const sessions = [makeSession('s1'), makeSession('s2')];
    const onOpenQuickTabPicker = vi.fn();

    render(
      <TerminalPage
        sessions={sessions}
        activeSession={sessions[0]}
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
        onLoadSavedTabList={vi.fn()}
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    const resolvedSwipeSurface = swipeSurface!;
    fireEvent.touchStart(resolvedSwipeSurface, { touches: [{ clientX: 48, clientY: 200 }] });
    fireEvent.touchMove(resolvedSwipeSurface, {
      touches: [{ clientX: 236, clientY: 206 }],
      cancelable: true,
    });
    fireEvent.touchEnd(resolvedSwipeSurface, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    fireEvent.touchEnd(screen.getByTestId('terminal-session-drawer-add'), {
      changedTouches: [{ clientX: 180, clientY: 560 }],
    });
    expect(screen.getByTestId('terminal-session-drawer-new-session-dialog')).toBeTruthy();
    fireEvent.click(screen.getByText('创建'));
    expect(onOpenQuickTabPicker).toHaveBeenCalled();
  });

  it('refreshes drawer host sessions and opens remote-only sessions from the drawer', async () => {
    const sessions = [makeSession('s1')];
    sessions[0]!.daemonHostId = 'daemon-a';
    const onRefreshDrawerHostSessions = vi.fn();
    const onOpenDrawerRemoteSession = vi.fn();

    render(
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
        activeSession={sessions[0]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenDrawerRemoteSession={onOpenDrawerRemoteSession}
        onRefreshDrawerHostSessions={onRefreshDrawerHostSessions}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    const resolvedSwipeSurface = swipeSurface!;
    fireEvent.touchStart(resolvedSwipeSurface, { touches: [{ clientX: 48, clientY: 200 }] });
    fireEvent.touchMove(resolvedSwipeSurface, {
      touches: [{ clientX: 236, clientY: 206 }],
      cancelable: true,
    });
    fireEvent.touchEnd(resolvedSwipeSurface, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    await waitFor(() => expect(onRefreshDrawerHostSessions).toHaveBeenCalledWith('daemon-a'));
    expect(await screen.findByText('remote-beta')).toBeTruthy();
    fireEvent.click(await screen.findByTestId('terminal-session-drawer-select-remote:daemon:daemon-a::session:remote-beta'));

    expect(onOpenDrawerRemoteSession).toHaveBeenCalledWith(
      {
        name: 'Daemon A',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        authToken: 'token-a',
        sessionNames: ['tmux-s1', 'remote-beta'],
      },
      'remote-beta',
    );
  });

  it('routes remote-only drawer close to remote tmux session close instead of local open-tab close', async () => {
    const sessions = [makeSession('s1')];
    sessions[0]!.daemonHostId = 'daemon-a';
    const onCloseSession = vi.fn();
    const onCloseDrawerRemoteSession = vi.fn();

    render(
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
        activeSession={sessions[0]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={onCloseSession}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenDrawerRemoteSession={vi.fn()}
        onCloseDrawerRemoteSession={onCloseDrawerRemoteSession}
        onRefreshDrawerHostSessions={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    const resolvedSwipeSurface = swipeSurface!;
    fireEvent.touchStart(resolvedSwipeSurface, { touches: [{ clientX: 48, clientY: 200 }] });
    fireEvent.touchMove(resolvedSwipeSurface, {
      touches: [{ clientX: 236, clientY: 206 }],
      cancelable: true,
    });
    fireEvent.touchEnd(resolvedSwipeSurface, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    await waitFor(() => expect(screen.getByText('remote-beta')).toBeTruthy());
    fireEvent.click(screen.getByTestId('terminal-session-drawer-close-remote:daemon:daemon-a::session:remote-beta'));

    expect(onCloseSession).not.toHaveBeenCalled();
    expect(onCloseDrawerRemoteSession).toHaveBeenCalledWith(
      {
        name: 'Daemon A',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        authToken: 'token-a',
        sessionNames: ['tmux-s1', 'remote-beta'],
      },
      'remote-beta',
    );
  });

  it('shows only daemon catalog sessions and hides stale opened tabs from the drawer', async () => {
    const sessions = [makeSession('live'), makeSession('stale')];
    sessions[0]!.daemonHostId = 'daemon-a';
    sessions[0]!.sessionName = 'live-main';
    sessions[0]!.title = 'live tab';
    sessions[1]!.daemonHostId = 'daemon-a';
    sessions[1]!.sessionName = 'stale-old';
    sessions[1]!.title = 'stale tab';
    const onSwitchSession = vi.fn();

    render(
      <TerminalPage
        sessions={sessions}
        sessionGroups={[{
          id: 'daemon:daemon-a',
          name: 'Daemon A',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          daemonHostId: 'daemon-a',
          authToken: 'token-a',
          sessionNames: ['live-main', 'remote-beta'],
          lastOpenedAt: 1,
        }]}
        activeSession={sessions[0]}
        onSwitchSession={onSwitchSession}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onRefreshDrawerHostSessions={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    const resolvedSwipeSurface = swipeSurface!;
    fireEvent.touchStart(resolvedSwipeSurface, { touches: [{ clientX: 48, clientY: 200 }] });
    fireEvent.touchMove(resolvedSwipeSurface, {
      touches: [{ clientX: 236, clientY: 206 }],
      cancelable: true,
    });
    fireEvent.touchEnd(resolvedSwipeSurface, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    await waitFor(() => expect(screen.getByTestId('terminal-session-drawer').getAttribute('aria-hidden')).toBe('false'));
    expect(screen.getByText('live tab')).toBeTruthy();
    expect(screen.getByText('remote-beta')).toBeTruthy();
    expect(screen.queryByText('stale tab')).toBeNull();
    expect(screen.queryByText('stale-old')).toBeNull();

    fireEvent.click(screen.getByText('live tab'));
    expect(onSwitchSession).toHaveBeenCalledWith('live');
  });
});

describe('resolveTerminalSessionGroupViewportSlots', () => {
  it('projects top into center without mutating the fixed slot map', () => {
    expect(resolveTerminalSessionGroupViewportSlots(
      { top: 's1', center: 's2', bottom: 's3' },
      'top',
    )).toEqual({
      top: null,
      center: 's1',
      bottom: 's2',
    });
  });

  it('projects bottom into center without mutating the fixed slot map', () => {
    expect(resolveTerminalSessionGroupViewportSlots(
      { top: 's1', center: 's2', bottom: 's3' },
      'bottom',
    )).toEqual({
      top: 's2',
      center: 's3',
      bottom: null,
    });
  });

  it('keeps fixed slots unchanged when the center slot is focused', () => {
    expect(resolveTerminalSessionGroupViewportSlots(
      { top: 's1', center: 's2', bottom: 's3' },
      'center',
    )).toEqual({
      top: 's1',
      center: 's2',
      bottom: 's3',
    });
  });
});

describe('resolveSessionGroupBoundaryProjection', () => {
  it('hides the before edge and shows only the after edge when focus is before', () => {
    expect(resolveSessionGroupBoundaryProjection(
      { before: 's1', center: 's2', after: 's3' },
      'before',
    )).toEqual({
      slots: {
        before: null,
        center: 's1',
        after: 's2',
      },
      visible: {
        before: false,
        after: true,
      },
    });
  });

  it('shows both edges when focus is center', () => {
    expect(resolveSessionGroupBoundaryProjection(
      { before: 's1', center: 's2', after: 's3' },
      'center',
    )).toEqual({
      slots: {
        before: 's1',
        center: 's2',
        after: 's3',
      },
      visible: {
        before: true,
        after: true,
      },
    });
  });

  it('shows only the before edge when focus is after', () => {
    expect(resolveSessionGroupBoundaryProjection(
      { before: 's1', center: 's2', after: 's3' },
      'after',
    )).toEqual({
      slots: {
        before: 's2',
        center: 's3',
        after: null,
      },
      visible: {
        before: true,
        after: false,
      },
    });
  });
});

describe('resolveTerminalSessionGroupViewportProjection', () => {
  it('hides the top peek when the top slot is focused', () => {
    expect(resolveTerminalSessionGroupViewportProjection(
      { top: 's1', center: 's2', bottom: 's3' },
      'top',
    )).toEqual({
      slots: {
        top: null,
        center: 's1',
        bottom: 's2',
      },
      visible: {
        top: false,
        bottom: true,
      },
    });
  });

  it('hides the bottom peek when the bottom slot is focused', () => {
    expect(resolveTerminalSessionGroupViewportProjection(
      { top: 's1', center: 's2', bottom: 's3' },
      'bottom',
    )).toEqual({
      slots: {
        top: 's2',
        center: 's3',
        bottom: null,
      },
      visible: {
        top: true,
        bottom: false,
      },
    });
  });

  it('keeps both peeks visible when the center slot is focused', () => {
    expect(resolveTerminalSessionGroupViewportProjection(
      { top: 's1', center: 's2', bottom: 's3' },
      'center',
    )).toEqual({
      slots: {
        top: 's1',
        center: 's2',
        bottom: 's3',
      },
      visible: {
        top: true,
        bottom: true,
      },
    });
  });
});

describe('resolveTerminalSessionGroupSlotReplacement', () => {
  it('replaces the currently focused bottom slot without changing top or center', () => {
    expect(resolveTerminalSessionGroupSlotReplacement(
      { top: 's1', center: 's2', bottom: 's3' },
      's4',
      'bottom',
    )).toEqual({
      top: 's1',
      center: 's2',
      bottom: 's4',
    });
  });

  it('replaces the currently focused top slot without changing center or bottom', () => {
    expect(resolveTerminalSessionGroupSlotReplacement(
      { top: 's1', center: 's2', bottom: 's3' },
      's4',
      'top',
    )).toEqual({
      top: 's4',
      center: 's2',
      bottom: 's3',
    });
  });

  it('moves an already assigned session into the target slot without duplicates', () => {
    expect(resolveTerminalSessionGroupSlotReplacement(
      { top: 's1', center: 's2', bottom: 's3' },
      's1',
      'bottom',
    )).toEqual({
      top: null,
      center: 's2',
      bottom: 's1',
    });
  });
});
