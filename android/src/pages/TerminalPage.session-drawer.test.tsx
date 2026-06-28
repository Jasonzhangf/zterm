// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../lib/types';
import {
  TerminalPage,
  resolveTerminalSessionGroupSlotReplacement,
  resolveTerminalSessionGroupViewportSlots,
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
  TerminalView: ({ sessionId }: { sessionId: string }) => (
    <div data-testid={`terminal-view-${sessionId}`}>terminal:{sessionId}</div>
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

  it('hides the header in portrait and opens the session drawer on right swipe', () => {
    const sessions = [makeSession('s1'), makeSession('s2')];
    const onSwitchSession = vi.fn();

    render(
      <TerminalPage
        sessions={sessions}
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

    fireEvent.click(screen.getByTestId(`terminal-session-drawer-row-${targetSessionId}`));
    expect(onSwitchSession).toHaveBeenCalledWith(targetSessionId);
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
    expect(onOpenQuickTabPicker).toHaveBeenCalled();
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
