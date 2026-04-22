import { useEffect, useRef, useState } from 'react';
import { Keyboard } from '@capacitor/keyboard';
import { Capacitor } from '@capacitor/core';
import { TerminalCanvas } from '../components/terminal/TerminalCanvas';
import { TerminalHeader } from '../components/terminal/TerminalHeader';
import { TerminalQuickBar } from '../components/terminal/TerminalQuickBar';
import { mobileTheme } from '../lib/mobile-ui';
import type { QuickAction, Session, TerminalShortcutAction } from '../lib/types';

type VirtualKeyboardApi = {
  overlaysContent: boolean;
  boundingRect: DOMRectReadOnly;
  addEventListener: (type: 'geometrychange', listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: 'geometrychange', listener: EventListenerOrEventListenerObject) => void;
};

const IME_LAYOUT_THRESHOLD_PX = 96;
const NETWORK_BANNER_GRACE_MS = 3000;

interface TerminalPageProps {
  sessions: Session[];
  activeSession: Session | null;
  resumeNonce?: number;
  onSwitchSession: (id: string) => void;
  onMoveSession: (id: string, toIndex: number) => void;
  onRenameSession: (id: string, name: string) => void;
  onCloseSession: (id: string) => void;
  onOpenConnections: () => void;
  onOpenQuickTabPicker: () => void;
  onSwipeSession: (direction: 'prev' | 'next') => void;
  onTitleChange?: (title: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onTerminalInput?: (data: string) => void;
  onRequestBufferRange?: (sessionId: string, startIndex: number, endIndex: number) => void;
  onImagePaste?: (file: File) => Promise<void> | void;
  quickActions: QuickAction[];
  shortcutActions: TerminalShortcutAction[];
  onQuickActionInput?: (sequence: string) => void;
  onQuickActionsChange?: (actions: QuickAction[]) => void;
  onShortcutActionsChange?: (actions: TerminalShortcutAction[]) => void;
  sessionDraft: string;
  onSessionDraftChange?: (value: string) => void;
  onSessionDraftSend?: (value: string) => void;
  forceScrollToBottomNonce?: number;
}

export function TerminalPage({
  sessions,
  activeSession,
  resumeNonce = 0,
  onSwitchSession,
  onMoveSession,
  onRenameSession,
  onCloseSession,
  onOpenConnections,
  onOpenQuickTabPicker,
  onSwipeSession,
  onTitleChange,
  onResize,
  onTerminalInput,
  onRequestBufferRange,
  onImagePaste,
  quickActions,
  shortcutActions,
  onQuickActionInput,
  onQuickActionsChange,
  onShortcutActionsChange,
  sessionDraft,
  onSessionDraftChange,
  onSessionDraftSend,
  forceScrollToBottomNonce = 0,
}: TerminalPageProps) {
  const isAndroid = Capacitor.getPlatform() === 'android';
  const [focusNonce, setFocusNonce] = useState(0);
  const [terminalFontSize, setTerminalFontSize] = useState(5);
  const [terminalKeyboardRequested, setTerminalKeyboardRequested] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window !== 'undefined' ? window.visualViewport?.height || window.innerHeight : 0,
  );
  const [networkOnline, setNetworkOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const [connectionIssueVisible, setConnectionIssueVisible] = useState(false);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [baseViewportHeight, setBaseViewportHeight] = useState(() =>
    typeof window !== 'undefined' ? Math.max(window.innerHeight, window.visualViewport?.height || 0) : 0,
  );
  const connectionIssueTimerRef = useRef<number | null>(null);

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

  const keepTerminalInputFocused = () => {
    window.setTimeout(focusTerminalInput, 0);
    window.setTimeout(focusTerminalInput, 32);
    window.setTimeout(focusTerminalInput, 120);
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
      keepTerminalInputFocused();
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
    const syncOnlineState = () => {
      setNetworkOnline(typeof navigator === 'undefined' ? true : navigator.onLine);
    };

    syncOnlineState();
    window.addEventListener('online', syncOnlineState);
    window.addEventListener('offline', syncOnlineState);

    return () => {
      window.removeEventListener('online', syncOnlineState);
      window.removeEventListener('offline', syncOnlineState);
    };
  }, []);

  useEffect(() => {
    const hasIssue = !networkOnline || activeSession?.state === 'reconnecting' || activeSession?.state === 'error';

    if (!hasIssue) {
      if (connectionIssueTimerRef.current !== null) {
        window.clearTimeout(connectionIssueTimerRef.current);
        connectionIssueTimerRef.current = null;
      }
      setConnectionIssueVisible(false);
      return;
    }

    if (connectionIssueVisible || connectionIssueTimerRef.current !== null) {
      return;
    }

    connectionIssueTimerRef.current = window.setTimeout(() => {
      connectionIssueTimerRef.current = null;
      setConnectionIssueVisible(true);
    }, NETWORK_BANNER_GRACE_MS);

    return () => {
      if (connectionIssueTimerRef.current !== null) {
        window.clearTimeout(connectionIssueTimerRef.current);
        connectionIssueTimerRef.current = null;
      }
    };
  }, [activeSession?.state, connectionIssueVisible, networkOnline]);

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
  const networkBanner = !connectionIssueVisible
    ? null
    : !networkOnline
    ? {
        tone: '#ff6b6b',
        background: 'rgba(109, 24, 33, 0.92)',
        border: 'rgba(255, 107, 107, 0.42)',
        title: '网络已断开',
        detail: '当前网络不可用，终端不会继续刷新。',
      }
    : activeSession?.state === 'reconnecting'
      ? {
          tone: '#ffb020',
          background: 'rgba(97, 63, 13, 0.92)',
          border: 'rgba(255, 176, 32, 0.42)',
          title: '连接已断开，正在重连',
          detail: activeSession.lastError || '网络或 daemon 连接已中断，正在指数退避重试。',
        }
      : activeSession?.state === 'error'
        ? {
            tone: '#ff6b6b',
            background: 'rgba(109, 24, 33, 0.92)',
            border: 'rgba(255, 107, 107, 0.42)',
            title: '连接失败',
            detail: activeSession.lastError || '当前 tab 已断开，请检查网络或服务器状态。',
          }
        : null;
  const shellHeight = Math.max(
    0,
    baseViewportHeight || viewportHeight || (typeof window !== 'undefined' ? window.innerHeight : 0),
  );

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
      <div>
        <TerminalHeader
          sessions={sessions}
          activeSession={activeSession}
          onBack={onOpenConnections}
          onOpenConnections={onOpenConnections}
          onOpenQuickTabPicker={onOpenQuickTabPicker}
          onSwitchSession={onSwitchSession}
          onMoveSession={onMoveSession}
          onRenameSession={onRenameSession}
          onCloseSession={onCloseSession}
        />
      </div>
      {networkBanner && (
        <div
          style={{
            margin: '0 10px 8px',
            padding: '9px 12px',
            borderRadius: '12px',
            border: `1px solid ${networkBanner.border}`,
            background: networkBanner.background,
            color: '#fff',
            boxShadow: '0 10px 24px rgba(0,0,0,0.18)',
          }}
        >
          <div style={{ fontSize: '13px', fontWeight: 800, color: networkBanner.tone }}>
            {networkBanner.title}
          </div>
          <div style={{ marginTop: '3px', fontSize: '12px', lineHeight: 1.35, color: 'rgba(255,255,255,0.9)' }}>
            {networkBanner.detail}
          </div>
        </div>
      )}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minHeight: 0,
          transform: resolvedKeyboardInset > 0 ? `translateY(-${resolvedKeyboardInset}px)` : 'translateY(0)',
          transition: 'transform 180ms ease',
          willChange: resolvedKeyboardInset > 0 ? 'transform' : undefined,
        }}
      >
        <TerminalCanvas
          sessions={sessions}
          activeSession={activeSession}
          onTitleChange={onTitleChange}
          onResize={onResize}
          freezeResize={keyboardLayoutActive}
          onInput={onTerminalInput}
          onRequestBufferRange={onRequestBufferRange}
          focusNonce={focusNonce}
          allowDomFocus={terminalKeyboardRequested}
          domInputOffscreen={isAndroid}
          resumeNonce={resumeNonce}
          fontSize={terminalFontSize}
          onFontSizeChange={setTerminalFontSize}
          onSwipeSession={onSwipeSession}
          forceScrollToBottomNonce={forceScrollToBottomNonce}
        />
        <TerminalQuickBar
          quickActions={quickActions}
          shortcutActions={shortcutActions}
          onSendSequence={(sequence) => {
            onQuickActionInput?.(sequence);
            if (terminalKeyboardRequested || keyboardInset > 0) {
              keepTerminalInputFocused();
            }
          }}
          onImagePaste={onImagePaste}
          keyboardVisible={keyboardLayoutActive && keyboardInset > 0}
          keyboardInsetPx={Math.max(keyboardInset, viewportInset)}
          onToggleKeyboard={handleToggleKeyboard}
          onQuickActionsChange={onQuickActionsChange}
          onShortcutActionsChange={onShortcutActionsChange}
          sessionDraft={sessionDraft}
          onSessionDraftChange={onSessionDraftChange}
          onSessionDraftSend={(value) => {
            onSessionDraftSend?.(value);
            if (terminalKeyboardRequested || keyboardInset > 0) {
              keepTerminalInputFocused();
            }
          }}
        />
      </div>
    </div>
  );
}
