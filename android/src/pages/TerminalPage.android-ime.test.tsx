// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../lib/types';
import { TerminalPage, resolveKeyboardLiftPx } from './TerminalPage';
import { ImeAnchor } from '../plugins/ImeAnchorPlugin';

const imeListeners = new Map<string, (event: any) => void>();
const keyboardListeners = new Map<string, (event: any) => void>();

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'android',
  },
}));

vi.mock('@capacitor/keyboard', () => ({
  Keyboard: {
    addListener: vi.fn(async (eventName: string, listener: (event: any) => void) => {
      keyboardListeners.set(eventName, listener);
      return {
        remove: vi.fn(async () => {
          keyboardListeners.delete(eventName);
        }),
      };
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
    addListener: vi.fn(async (eventName: string, listener: (event: any) => void) => {
      imeListeners.set(eventName, listener);
      return {
        remove: vi.fn(async () => {
          imeListeners.delete(eventName);
        }),
      };
    }),
  },
}));

vi.mock('../components/terminal/TerminalHeader', () => ({
  TerminalHeader: ({ topInsetPx }: { topInsetPx?: number }) => <div data-testid="terminal-header" data-top-inset={String(topInsetPx || 0)} />,
}));

vi.mock('../components/terminal/TabManagerSheet', () => ({
  TabManagerSheet: () => null,
}));

vi.mock('../components/terminal/TerminalQuickBar', () => ({
  TerminalQuickBar: ({
    onEditorDomFocusChange,
    onToggleKeyboard,
    keyboardVisible,
    keyboardInsetPx,
  }: {
    onEditorDomFocusChange?: (active: boolean) => void;
    onToggleKeyboard?: () => void;
    keyboardVisible?: boolean;
    keyboardInsetPx?: number;
  }) => (
    <div
      data-testid="terminal-quickbar"
      data-keyboard-visible={keyboardVisible ? 'true' : 'false'}
      data-keyboard-inset={String(keyboardInsetPx || 0)}
    >
      <button onClick={() => onEditorDomFocusChange?.(true)}>focus-quick-editor</button>
      <button onClick={() => onEditorDomFocusChange?.(false)}>blur-quick-editor</button>
      <button onClick={() => onToggleKeyboard?.()}>toggle-keyboard</button>
    </div>
  ),
}));

vi.mock('../components/TerminalView', () => ({
  TerminalView: ({
    sessionId,
    allowDomFocus,
    onActivateInput,
    onResize,
  }: {
    sessionId: string;
    allowDomFocus?: boolean;
    onActivateInput?: () => void;
    onResize?: (...args: any[]) => void;
  }) => (
    <div
      data-testid={`terminal-view-${sessionId}`}
      data-allow-dom-focus={allowDomFocus ? 'true' : 'false'}
      data-has-onresize={onResize ? 'true' : 'false'}
      onClick={() => onActivateInput?.()}
    />
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
      updateKind: 'replace',
      revision: 1,
    },
  };
}

describe('TerminalPage Android IME bridge', () => {
  beforeEach(() => {
    imeListeners.clear();
    keyboardListeners.clear();
  });

  afterEach(() => {
    cleanup();
    imeListeners.clear();
    keyboardListeners.clear();
  });

  it('disables DOM terminal focus on Android and routes native IME input to active session', async () => {
    const session = makeSession('s1');
    const onTerminalInput = vi.fn();

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={onTerminalInput}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(imeListeners.has('input')).toBe(true);
      expect(imeListeners.has('backspace')).toBe(true);
    });

    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-allow-dom-focus')).toBe('false');
    expect(screen.getByTestId('terminal-view-s1').getAttribute('data-has-onresize')).toBe('false');

    imeListeners.get('input')?.({ text: '语音输入\n下一行' });
    imeListeners.get('backspace')?.({ count: 2 });

    expect(onTerminalInput).toHaveBeenCalledWith('s1', '语音输入\r下一行');
    expect(onTerminalInput).toHaveBeenCalledWith('s1', '\x7f\x7f');
  });

  it('does not pass upstream terminal resize on Android, even when keyboard visibility changes', async () => {
    const session = makeSession('s1');

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
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

    await waitFor(() => {
      expect(keyboardListeners.has('keyboardDidShow')).toBe(true);
    });

    const terminalView = screen.getByTestId('terminal-view-s1');
    expect(terminalView.getAttribute('data-has-onresize')).toBe('false');

    keyboardListeners.get('keyboardDidShow')?.({ keyboardHeight: 320 });

    await waitFor(() => {
      expect(screen.getByTestId('terminal-view-s1').getAttribute('data-has-onresize')).toBe('false');
    });
  });

  it('suspends ImeAnchor routing while quick bar DOM editor owns focus', async () => {
    const session = makeSession('s1');
    const onTerminalInput = vi.fn();

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={onTerminalInput}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(imeListeners.has('input')).toBe(true);
    });

    fireEvent.click(screen.getByRole('button', { name: 'focus-quick-editor' }));

    await waitFor(() => {
      expect(ImeAnchor.blur).toHaveBeenCalled();
      expect(ImeAnchor.setEditorActive).toHaveBeenCalledWith({ active: true });
    });

    keyboardListeners.get('keyboardDidShow')?.({ keyboardHeight: 280 });

    await waitFor(() => {
      expect(screen.getByTestId('terminal-quickbar').getAttribute('data-keyboard-visible')).toBe('false');
      expect(screen.getByTestId('terminal-quickbar').getAttribute('data-keyboard-inset')).toBe('0');
    });

    imeListeners.get('input')?.({ text: '不该发到 terminal' });
    expect(onTerminalInput).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'blur-quick-editor' }));

    imeListeners.get('input')?.({ text: '恢复路由' });

    await waitFor(() => {
      expect(onTerminalInput).toHaveBeenCalledWith('s1', '恢复路由');
    });
    expect(vi.mocked(ImeAnchor.setEditorActive)).toHaveBeenLastCalledWith({ active: false });
  });

  it('re-activates ImeAnchor routing when quick editor yields focus while terminal keyboard is already visible', async () => {
    const session = makeSession('s1');

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
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

    await waitFor(() => {
      expect(keyboardListeners.has('keyboardDidShow')).toBe(true);
    });

    keyboardListeners.get('keyboardDidShow')?.({ keyboardHeight: 280 });
    fireEvent.click(screen.getByRole('button', { name: 'focus-quick-editor' }));

    await waitFor(() => {
      expect(ImeAnchor.blur).toHaveBeenCalled();
    });

    vi.mocked(ImeAnchor.show).mockClear();
    vi.mocked(ImeAnchor.setEditorActive).mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'blur-quick-editor' }));

    await waitFor(() => {
      expect(vi.mocked(ImeAnchor.show)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(ImeAnchor.setEditorActive)).toHaveBeenLastCalledWith({ active: false });
    });
  });

  it('toggles native editor-active state while handing IME focus between terminal and quick editor', async () => {
    const session = makeSession('s1');

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
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

    fireEvent.click(screen.getByRole('button', { name: 'focus-quick-editor' }));
    fireEvent.click(screen.getByRole('button', { name: 'blur-quick-editor' }));

    const calls = vi.mocked(ImeAnchor.setEditorActive).mock.calls.map(([payload]) => payload?.active);
    expect(calls).toContain(true);
    expect(calls[calls.length - 1]).toBe(false);
  });

  it('only shows ImeAnchor once when explicitly toggling the Android keyboard', async () => {
    const session = makeSession('s1');

    try {
      render(
        <TerminalPage
          sessions={[session]}
          activeSession={session}
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

      await waitFor(() => {
        expect(keyboardListeners.has('keyboardDidShow')).toBe(true);
      });

      vi.useFakeTimers();
      vi.mocked(ImeAnchor.show).mockClear();
      fireEvent.click(screen.getByRole('button', { name: 'toggle-keyboard' }));

      expect(ImeAnchor.show).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(1);
      });

      expect(vi.mocked(ImeAnchor.show)).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-activates ImeAnchor routing when tapping the Android terminal surface while keyboard stays visible', async () => {
    const session = makeSession('s1');

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
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

    await waitFor(() => {
      expect(keyboardListeners.has('keyboardDidShow')).toBe(true);
    });

    keyboardListeners.get('keyboardDidShow')?.({ keyboardHeight: 320 });
    await waitFor(() => {
      expect(screen.getByTestId('terminal-quickbar').getAttribute('data-keyboard-visible')).toBe('true');
    });
    vi.mocked(ImeAnchor.show).mockClear();
    fireEvent.click(screen.getByTestId('terminal-view-s1'));

    await waitFor(() => {
      expect(vi.mocked(ImeAnchor.show)).toHaveBeenCalledTimes(1);
    });
  });

  it('re-activates ImeAnchor routing when the active terminal session changes while the Android keyboard is already visible', async () => {
    const sessionOne = makeSession('s1');
    const sessionTwo = makeSession('s2');

    const view = render(
      <TerminalPage
        sessions={[sessionOne, sessionTwo]}
        activeSession={sessionOne}
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

    await waitFor(() => {
      expect(keyboardListeners.has('keyboardDidShow')).toBe(true);
    });

    keyboardListeners.get('keyboardDidShow')?.({ keyboardHeight: 320 });
    await waitFor(() => {
      expect(screen.getByTestId('terminal-quickbar').getAttribute('data-keyboard-visible')).toBe('true');
    });

    vi.mocked(ImeAnchor.show).mockClear();
    vi.mocked(ImeAnchor.setEditorActive).mockClear();

    view.rerender(
      <TerminalPage
        sessions={[sessionOne, sessionTwo]}
        activeSession={sessionTwo}
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

    await waitFor(() => {
      expect(vi.mocked(ImeAnchor.show)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(ImeAnchor.setEditorActive)).toHaveBeenLastCalledWith({ active: false });
    });
  });

  it('uses native ImeAnchor keyboardState to raise terminal chrome on Android', async () => {
    const session = makeSession('s1');

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
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

    await waitFor(() => {
      expect(imeListeners.has('keyboardState')).toBe(true);
    });

    fireEvent.click(screen.getByRole('button', { name: 'toggle-keyboard' }));
    imeListeners.get('keyboardState')?.({ visible: true, height: 320 });

    await waitFor(() => {
      expect(screen.getByTestId('terminal-quickbar').getAttribute('data-keyboard-visible')).toBe('true');
      expect(screen.getByTestId('terminal-quickbar').getAttribute('data-keyboard-inset')).toBe('320');
    });
  });

  it('shrinks the terminal stage from the bottom instead of translating the whole page when keyboard is visible', async () => {
    const session = makeSession('s1');

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
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

    const terminalStage = screen.getByTestId('terminal-stage');
    expect(terminalStage.getAttribute('style') || '').toContain('bottom: 64px;');
    expect(terminalStage.getAttribute('style') || '').not.toContain('transform: translateY');

    await waitFor(() => {
      expect(imeListeners.has('keyboardState')).toBe(true);
    });

    fireEvent.click(screen.getByRole('button', { name: 'toggle-keyboard' }));
    imeListeners.get('keyboardState')?.({ visible: true, height: 320 });

    await waitFor(() => {
      const style = terminalStage.getAttribute('style') || '';
      expect(style).toContain('bottom: 384px;');
      expect(style).not.toContain('transform: translateY');
    });
  });

  it('keeps a non-zero terminal header top inset on Android even when CSS safe-area env is unavailable', () => {
    const session = makeSession('s1');

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
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

    expect(Number(screen.getByTestId('terminal-header').getAttribute('data-top-inset') || '0')).toBeGreaterThan(0);
  });

  it('does not reattach native IME listeners on buffer rerenders and still routes to latest active session', async () => {
    const session = makeSession('s1');
    const onTerminalInput = vi.fn();

    const view = render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={onTerminalInput}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(imeListeners.has('input')).toBe(true);
      expect(imeListeners.has('backspace')).toBe(true);
    });
    const addListenerCallsBeforeRerender = vi.mocked(ImeAnchor.addListener).mock.calls.length;

    const updatedSession: Session = {
      ...session,
      buffer: {
        ...session.buffer,
        revision: 2,
        endIndex: 1,
      },
    };

    view.rerender(
      <TerminalPage
        sessions={[updatedSession]}
        activeSession={updatedSession}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={onTerminalInput}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    imeListeners.get('input')?.({ text: 'still-immediate' });

    expect(vi.mocked(ImeAnchor.addListener).mock.calls.length).toBe(addListenerCallsBeforeRerender);
    expect(onTerminalInput).toHaveBeenCalledWith('s1', 'still-immediate');
  });

  it('keeps native IME routing alive after a voice-style CJK commit without needing an extra priming character', async () => {
    const session = makeSession('s1');
    const onTerminalInput = vi.fn();

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={onTerminalInput}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(imeListeners.has('input')).toBe(true);
    });

    imeListeners.get('input')?.({ text: '语音识别结果' });
    imeListeners.get('input')?.({ text: '!' });

    await waitFor(() => {
      expect(onTerminalInput).toHaveBeenCalledWith('s1', '语音识别结果');
      expect(onTerminalInput).toHaveBeenCalledWith('s1', '!');
    });
  });

  it('keeps routing later native IME input after a buffer rerender that follows a voice-style commit', async () => {
    const session = makeSession('s1');
    const onTerminalInput = vi.fn();

    const view = render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={onTerminalInput}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(imeListeners.has('input')).toBe(true);
    });

    imeListeners.get('input')?.({ text: '语音识别结果' });

    const updatedSession: Session = {
      ...session,
      buffer: {
        ...session.buffer,
        revision: 2,
        endIndex: 1,
      },
    };

    view.rerender(
      <TerminalPage
        sessions={[updatedSession]}
        activeSession={updatedSession}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={onTerminalInput}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    imeListeners.get('input')?.({ text: '继续输入' });

    await waitFor(() => {
      expect(onTerminalInput).toHaveBeenCalledWith('s1', '语音识别结果');
      expect(onTerminalInput).toHaveBeenCalledWith('s1', '继续输入');
    });
  });
});

describe('resolveKeyboardLiftPx', () => {
  it('keeps the reported keyboard lift when WebView does not expose viewport occlusion', () => {
    const originalInnerHeight = window.innerHeight;
    const originalVisualViewport = window.visualViewport;

    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 900,
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        height: 900,
        offsetTop: 0,
      },
    });

    expect(resolveKeyboardLiftPx(320)).toBe(320);

    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: originalInnerHeight,
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: originalVisualViewport,
    });
  });

  it('caps the lift to the actual occluded bottom height when the keyboard overlays content', () => {
    const originalInnerHeight = window.innerHeight;
    const originalVisualViewport = window.visualViewport;

    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 900,
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        height: 620,
        offsetTop: 0,
      },
    });

    expect(resolveKeyboardLiftPx(400)).toBe(280);

    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: originalInnerHeight,
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: originalVisualViewport,
    });
  });
});
