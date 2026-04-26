// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  TerminalHeader: () => <div data-testid="terminal-header" />,
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
  }: {
    sessionId: string;
    allowDomFocus?: boolean;
  }) => (
    <div
      data-testid={`terminal-view-${sessionId}`}
      data-allow-dom-focus={allowDomFocus ? 'true' : 'false'}
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

    imeListeners.get('input')?.({ text: '语音输入\n下一行' });
    imeListeners.get('backspace')?.({ count: 2 });

    expect(onTerminalInput).toHaveBeenCalledWith('s1', '语音输入\r下一行');
    expect(onTerminalInput).toHaveBeenCalledWith('s1', '\x7f\x7f');
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
  });

  it('only shows ImeAnchor once when explicitly toggling the Android keyboard', async () => {
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

    vi.mocked(ImeAnchor.show).mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'toggle-keyboard' }));

    await waitFor(() => {
      expect(ImeAnchor.show).toHaveBeenCalled();
    });
    expect(vi.mocked(ImeAnchor.show)).toHaveBeenCalledTimes(1);
  });

  it('does not re-show ImeAnchor when Android keyboard actually shows', async () => {
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

    vi.mocked(ImeAnchor.show).mockClear();
    keyboardListeners.get('keyboardDidShow')?.({ keyboardHeight: 320 });

    await waitFor(() => {
      expect(screen.getByTestId('terminal-quickbar').getAttribute('data-keyboard-visible')).toBe('true');
      expect(screen.getByTestId('terminal-quickbar').getAttribute('data-keyboard-inset')).toBe('320');
    });
    expect(vi.mocked(ImeAnchor.show)).not.toHaveBeenCalled();
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
