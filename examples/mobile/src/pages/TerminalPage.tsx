import { useEffect, useState } from 'react';
import { useRef } from 'react';
import { Keyboard } from '@capacitor/keyboard';
import { Capacitor } from '@capacitor/core';
import { TerminalCanvas } from '../components/terminal/TerminalCanvas';
import { TerminalHeader } from '../components/terminal/TerminalHeader';
import { TerminalQuickBar } from '../components/terminal/TerminalQuickBar';
import { mobileTheme } from '../lib/mobile-ui';
import type { QuickAction, Session } from '../lib/types';

type VirtualKeyboardApi = {
  overlaysContent: boolean;
  boundingRect: DOMRectReadOnly;
  addEventListener: (type: 'geometrychange', listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: 'geometrychange', listener: EventListenerOrEventListenerObject) => void;
};

const IME_LAYOUT_THRESHOLD_PX = 96;

interface TerminalPageProps {
  sessions: Session[];
  activeSession: Session | null;
  resumeNonce?: number;
  onSwitchSession: (id: string) => void;
  onRenameSession: (id: string, name: string) => void;
  onCloseSession: (id: string) => void;
  onOpenConnections: () => void;
  onOpenQuickTabPicker: () => void;
  onSwipeSession: (direction: 'prev' | 'next') => void;
  onTitleChange?: (title: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onTerminalInput?: (data: string) => void;
  onImagePaste?: (file: File) => Promise<void> | void;
  onBufferLinesChange?: (sessionId: string, lines: string[]) => void;
  quickActions: QuickAction[];
  onQuickActionInput?: (sequence: string) => void;
  onQuickActionsChange?: (actions: QuickAction[]) => void;
  forceScrollToBottomNonce?: number;
}

export function TerminalPage({
  sessions,
  activeSession,
  resumeNonce = 0,
  onSwitchSession,
  onRenameSession,
  onCloseSession,
  onOpenConnections,
  onOpenQuickTabPicker,
  onSwipeSession,
  onTitleChange,
  onResize,
  onTerminalInput,
  onImagePaste,
  onBufferLinesChange,
  quickActions,
  onQuickActionInput,
  onQuickActionsChange,
  forceScrollToBottomNonce = 0,
}: TerminalPageProps) {
  const isAndroid = Capacitor.getPlatform() === 'android';
  const [focusNonce, setFocusNonce] = useState(0);
  const [terminalFontSize, setTerminalFontSize] = useState(5);
  const [terminalKeyboardRequested, setTerminalKeyboardRequested] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window !== 'undefined' ? window.visualViewport?.height || window.innerHeight : 0,
  );
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [baseViewportHeight, setBaseViewportHeight] = useState(() =>
    typeof window !== 'undefined' ? Math.max(window.innerHeight, window.visualViewport?.height || 0) : 0,
  );
  const [headerHeight, setHeaderHeight] = useState(0);
  const [quickBarHeight, setQuickBarHeight] = useState(0);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const quickBarRef = useRef<HTMLDivElement | null>(null);

  const focusTerminalInput = () => {
    setFocusNonce((value) => value + 1);

    const input = document.querySelector('[data-active-terminal="true"] .wterm textarea[data-wterm-input="true"]') as HTMLTextAreaElement | null;
    if (!input) {
      return;
    }

    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
  };

  const handleToggleKeyboard = async () => {
    if (terminalKeyboardRequested || keyboardInset > 0) {
      setTerminalKeyboardRequested(false);
      try {
        await Keyboard.hide();
      } catch (error) {
        console.warn('[TerminalPage] Keyboard.hide() failed:', error);
      }
      const input = document.querySelector('[data-active-terminal="true"] .wterm textarea[data-wterm-input="true"]') as HTMLTextAreaElement | null;
      input?.blur();
      return;
    }

    setTerminalKeyboardRequested(true);
    focusTerminalInput();
    if (isAndroid) {
      window.setTimeout(focusTerminalInput, 32);
      window.setTimeout(focusTerminalInput, 120);
      return;
    }

    try {
      void Keyboard.show();
    } catch (error) {
      console.warn('[TerminalPage] Keyboard.show() failed:', error);
    }

    window.setTimeout(() => {
      focusTerminalInput();
      void Keyboard.show().catch(() => undefined);
    }, 32);

    window.setTimeout(() => {
      focusTerminalInput();
      void Keyboard.show().catch(() => undefined);
    }, 120);
  };

  useEffect(() => {
    const syncViewportHeight = () => {
      const nextViewportHeight = window.visualViewport?.height || window.innerHeight;
      setViewportHeight(nextViewportHeight);
      setBaseViewportHeight((current) =>
        keyboardInset > 0 ? current : Math.max(window.innerHeight, nextViewportHeight),
      );
    };

    syncViewportHeight();
    window.addEventListener('resize', syncViewportHeight);
    window.visualViewport?.addEventListener('resize', syncViewportHeight);

    return () => {
      window.removeEventListener('resize', syncViewportHeight);
      window.visualViewport?.removeEventListener('resize', syncViewportHeight);
    };
  }, [keyboardInset]);

  useEffect(() => {
    setTerminalKeyboardRequested(false);
    const input = document.querySelector('[data-active-terminal="true"] .wterm textarea[data-wterm-input="true"]') as HTMLTextAreaElement | null;
    input?.blur();
  }, [activeSession?.id]);

  useEffect(() => {
    let disposed = false;

    const showListenerPromise = Keyboard.addListener('keyboardDidShow', (info) => {
      if (!disposed) {
        setKeyboardInset(Math.max(0, Math.round(info.keyboardHeight || 0)));
      }
    });
    const hideListenerPromise = Keyboard.addListener('keyboardDidHide', () => {
      if (!disposed) {
        setTerminalKeyboardRequested(false);
        setKeyboardInset(0);
        setBaseViewportHeight((current) => Math.max(current, window.innerHeight, window.visualViewport?.height || 0));
      }
    });

    return () => {
      disposed = true;
      void showListenerPromise.then((listener) => listener.remove());
      void hideListenerPromise.then((listener) => listener.remove());
    };
  }, []);

  useEffect(() => {
    if (typeof navigator === 'undefined') {
      return;
    }

    const virtualKeyboard = (navigator as Navigator & { virtualKeyboard?: VirtualKeyboardApi }).virtualKeyboard;
    if (!virtualKeyboard) {
      return;
    }

    virtualKeyboard.overlaysContent = true;
    const syncKeyboardInset = () => {
      const nextInset = Math.max(0, Math.round(virtualKeyboard.boundingRect?.height || 0));
      setKeyboardInset(nextInset);
    };

    syncKeyboardInset();
    virtualKeyboard.addEventListener('geometrychange', syncKeyboardInset);
    return () => {
      virtualKeyboard.removeEventListener('geometrychange', syncKeyboardInset);
    };
  }, []);

  const viewportInset = Math.max(0, Math.round(baseViewportHeight - viewportHeight));
  const imeInset = Math.max(keyboardInset, viewportInset);
  const keyboardLayoutActive = terminalKeyboardRequested && imeInset >= IME_LAYOUT_THRESHOLD_PX;
  const resolvedKeyboardInset = keyboardLayoutActive ? imeInset : 0;
  const shellHeight = Math.max(0, baseViewportHeight);
  const canvasHeight = Math.max(0, shellHeight - headerHeight - quickBarHeight - resolvedKeyboardInset);

  useEffect(() => {
    const headerNode = headerRef.current;
    const quickBarNode = quickBarRef.current;
    if (!headerNode && !quickBarNode) {
      return;
    }

    const observer = new ResizeObserver(() => {
      setHeaderHeight(headerRef.current?.getBoundingClientRect().height || 0);
      setQuickBarHeight(quickBarRef.current?.getBoundingClientRect().height || 0);
    });

    if (headerNode) {
      observer.observe(headerNode);
      setHeaderHeight(headerNode.getBoundingClientRect().height || 0);
    }
    if (quickBarNode) {
      observer.observe(quickBarNode);
      setQuickBarHeight(quickBarNode.getBoundingClientRect().height || 0);
    }

    return () => observer.disconnect();
  }, []);

  return (
    <div
      style={{
        height: shellHeight ? `${shellHeight}px` : '100dvh',
        maxHeight: shellHeight ? `${shellHeight}px` : '100dvh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: mobileTheme.colors.shell,
      }}
    >
      <div ref={headerRef}>
        <TerminalHeader
          sessions={sessions}
          activeSession={activeSession}
          onBack={onOpenConnections}
          onOpenConnections={onOpenConnections}
          onOpenQuickTabPicker={onOpenQuickTabPicker}
          onSwitchSession={onSwitchSession}
          onRenameSession={onRenameSession}
          onCloseSession={onCloseSession}
        />
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: `${Math.max(0, shellHeight - headerHeight)}px`,
          minHeight: 0,
        }}
      >
        <TerminalCanvas
          sessions={sessions}
          activeSession={activeSession}
          onTitleChange={onTitleChange}
          onResize={onResize}
          onInput={onTerminalInput}
          onBufferLinesChange={onBufferLinesChange}
          focusNonce={focusNonce}
          allowDomFocus={terminalKeyboardRequested}
          domInputOffscreen={isAndroid}
          resumeNonce={resumeNonce}
          fontSize={terminalFontSize}
          onFontSizeChange={setTerminalFontSize}
          onSwipeSession={onSwipeSession}
          forceScrollToBottomNonce={forceScrollToBottomNonce}
          heightPx={canvasHeight}
        />
        <div ref={quickBarRef}>
          <TerminalQuickBar
            quickActions={quickActions}
            onSendSequence={onQuickActionInput}
            onImagePaste={onImagePaste}
            keyboardVisible={keyboardLayoutActive && keyboardInset > 0}
            keyboardInsetPx={Math.max(keyboardInset, viewportInset)}
            onToggleKeyboard={handleToggleKeyboard}
            onQuickActionsChange={onQuickActionsChange}
          />
        </div>
      </div>
    </div>
  );
}
