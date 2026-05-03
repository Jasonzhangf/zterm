// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../lib/types';
import { TerminalPage } from './TerminalPage';
import { ImeAnchor } from '../plugins/ImeAnchorPlugin';
import { Keyboard } from '@capacitor/keyboard';

const imeRemoveMocks: any[] = [];
const keyboardRemoveMocks: any[] = [];
const visualViewportAdd = vi.fn();
const visualViewportRemove = vi.fn();
const replacementVisualViewportRemove = vi.fn();
const virtualKeyboardAdd = vi.fn();
const virtualKeyboardRemove = vi.fn();
const windowAddSpy = vi.spyOn(window, 'addEventListener');
const windowRemoveSpy = vi.spyOn(window, 'removeEventListener');

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'android',
  },
}));

vi.mock('@capacitor/keyboard', () => ({
  Keyboard: {
    addListener: vi.fn(async () => {
      const remove = vi.fn(async () => undefined);
      keyboardRemoveMocks.push(remove);
      return { remove };
    }),
    hide: vi.fn(async () => undefined),
    show: vi.fn(async () => undefined),
  },
}));

vi.mock('../plugins/ImeAnchorPlugin', () => ({
  ImeAnchor: {
    show: vi.fn(async () => ({})),
    hide: vi.fn(async () => undefined),
    blur: vi.fn(async () => undefined),
    setEditorActive: vi.fn(async () => ({})),
    addListener: vi.fn(async () => {
      const remove = vi.fn(async () => undefined);
      imeRemoveMocks.push(remove);
      return { remove };
    }),
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
  TerminalView: ({ sessionId }: { sessionId: string }) => <div data-testid={`terminal-view-${sessionId}`} />,
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

describe('TerminalPage lifecycle cleanup', () => {
  beforeEach(() => {
    imeRemoveMocks.length = 0;
    keyboardRemoveMocks.length = 0;
    vi.mocked(ImeAnchor.addListener).mockClear();
    vi.mocked(Keyboard.addListener).mockClear();
    visualViewportAdd.mockClear();
    visualViewportRemove.mockClear();
    replacementVisualViewportRemove.mockClear();
    virtualKeyboardAdd.mockClear();
    virtualKeyboardRemove.mockClear();
    windowAddSpy.mockClear();
    windowRemoveSpy.mockClear();

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

    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        width: 1024,
        height: 768,
        offsetTop: 0,
        addEventListener: visualViewportAdd,
        removeEventListener: visualViewportRemove,
      },
    });

    Object.defineProperty(navigator, 'virtualKeyboard', {
      configurable: true,
      value: {
        overlaysContent: false,
        boundingRect: { height: 0 },
        addEventListener: virtualKeyboardAdd,
        removeEventListener: virtualKeyboardRemove,
      },
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  function renderPage(activeSession: Session | null, sessions: Session[]) {
    return render(
      <TerminalPage
        sessions={sessions}
        activeSession={activeSession}
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
  }

  it('does not re-register keyboard or IME listeners when only active session changes', async () => {
    const session1 = makeSession('s1');
    const session2 = makeSession('s2');
    const view = renderPage(session1, [session1, session2]);

    await waitFor(() => {
      expect(vi.mocked(ImeAnchor.addListener).mock.calls.length).toBe(3);
      expect(vi.mocked(Keyboard.addListener).mock.calls.length).toBe(2);
    });
    expect(visualViewportAdd).toHaveBeenCalledTimes(1);
    expect(virtualKeyboardAdd).toHaveBeenCalledTimes(1);

    view.rerender(
      <TerminalPage
        sessions={[session1, session2]}
        activeSession={session2}
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

    expect(vi.mocked(ImeAnchor.addListener).mock.calls.length).toBe(3);
    expect(vi.mocked(Keyboard.addListener).mock.calls.length).toBe(2);
    expect(visualViewportAdd).toHaveBeenCalledTimes(1);
    expect(virtualKeyboardAdd).toHaveBeenCalledTimes(1);
  });

  it('removes listeners from the original visualViewport instance on unmount', async () => {
    const session1 = makeSession('s1');
    const view = renderPage(session1, [session1]);

    await waitFor(() => {
      expect(vi.mocked(ImeAnchor.addListener).mock.calls.length).toBe(3);
      expect(vi.mocked(Keyboard.addListener).mock.calls.length).toBe(2);
    });

    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        width: 900,
        height: 700,
        offsetTop: 0,
        addEventListener: vi.fn(),
        removeEventListener: replacementVisualViewportRemove,
      },
    });

    view.unmount();
    await Promise.resolve();
    await Promise.resolve();

    expect(visualViewportRemove).toHaveBeenCalledTimes(1);
    expect(visualViewportRemove).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(replacementVisualViewportRemove).not.toHaveBeenCalled();
    expect(virtualKeyboardRemove).toHaveBeenCalledTimes(1);
    expect(virtualKeyboardRemove).toHaveBeenCalledWith('geometrychange', expect.any(Function));
    expect(windowRemoveSpy).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(windowRemoveSpy).toHaveBeenCalledWith('online', expect.any(Function));
    expect(windowRemoveSpy).toHaveBeenCalledWith('offline', expect.any(Function));
    expect(imeRemoveMocks).toHaveLength(3);
    imeRemoveMocks.forEach((remove) => expect(remove).toHaveBeenCalledTimes(1));
    expect(keyboardRemoveMocks).toHaveLength(2);
    keyboardRemoveMocks.forEach((remove) => expect(remove).toHaveBeenCalledTimes(1));
  });
});
