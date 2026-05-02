import { useEffect, useRef, useState } from 'react';
import type { Session, TerminalSplitPaneId } from '../../lib/types';
import { mobileTheme } from '../../lib/mobile-ui';
import { getServerColorTone } from '../../lib/server-color';

const TAB_LONG_PRESS_MS = 920;
const PLUS_LONG_PRESS_MS = 680;
const HEADER_TOUCH_SAFE_OFFSET_PX = 20;
const DOUBLE_TAP_MS = 280;
const ACTIVE_TAB_CLOSE_CONFIRM_WINDOW_MS = 1600;

interface TerminalHeaderProps {
  sessions: Session[];
  activeSession: Session | null;
  topInsetPx?: number;
  onBack: () => void;
  onOpenQuickTabPicker: () => void;
  onOpenTabManager: () => void;
  onSwitchSession: (id: string) => void;
  onRenameSession: (id: string, name: string) => void;
  onCloseSession: (id: string, source?: string) => void;
  splitVisible?: boolean;
  sessionPaneAssignments?: Partial<Record<string, TerminalSplitPaneId>>;
  onAssignSessionToPane?: (id: string, paneId: TerminalSplitPaneId) => void;
  onMoveSessionToOtherPane?: (id: string) => void;
}

function formatResolvedPath(path?: Session['resolvedPath']) {
  switch (path) {
    case 'tailscale':
      return 'TS';
    case 'ipv6':
      return 'IPv6';
    case 'ipv4':
      return 'IPv4';
    case 'rtc-direct':
      return 'RTC';
    case 'rtc-relay':
      return 'TURN';
    default:
      return null;
  }
}

export function TerminalHeader({
  sessions,
  activeSession,
  topInsetPx = 0,
  onBack,
  onOpenQuickTabPicker,
  onOpenTabManager,
  onSwitchSession,
  onRenameSession,
  onCloseSession,
  splitVisible = false,
  sessionPaneAssignments,
  onAssignSessionToPane,
  onMoveSessionToOtherPane,
}: TerminalHeaderProps) {
  const tabsScrollerRef = useRef<HTMLDivElement | null>(null);
  const tabTapRef = useRef<{ sessionId: string; timestamp: number } | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const plusLongPressTimerRef = useRef<number | null>(null);
  const plusLongPressTriggeredRef = useRef(false);
  const closeConfirmTimerRef = useRef<number | null>(null);
  const [paneMenuSessionId, setPaneMenuSessionId] = useState<string | null>(null);
  const [armedClosableSessionId, setArmedClosableSessionId] = useState<string | null>(null);

  const closePaneMenu = () => setPaneMenuSessionId(null);

  const resolveSessionPane = (sessionId: string): TerminalSplitPaneId => (
    sessionPaneAssignments?.[sessionId] === 'secondary' ? 'secondary' : 'primary'
  );

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const clearPlusLongPress = () => {
    if (plusLongPressTimerRef.current !== null) {
      window.clearTimeout(plusLongPressTimerRef.current);
      plusLongPressTimerRef.current = null;
    }
  };

  const clearCloseConfirm = () => {
    if (closeConfirmTimerRef.current !== null) {
      window.clearTimeout(closeConfirmTimerRef.current);
      closeConfirmTimerRef.current = null;
    }
    setArmedClosableSessionId(null);
  };

  const openPaneMenu = (sessionId: string) => {
    longPressTriggeredRef.current = true;
    setPaneMenuSessionId(sessionId);
  };

  const startTabLongPress = (sessionId: string) => {
    clearLongPress();
    longPressTriggeredRef.current = false;
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTriggeredRef.current = true;
      if (splitVisible) {
        setPaneMenuSessionId(sessionId);
        return;
      }
      onOpenTabManager();
    }, TAB_LONG_PRESS_MS);
  };

  const endTabLongPress = () => {
    clearLongPress();
  };

  const startPlusLongPress = () => {
    clearPlusLongPress();
    plusLongPressTriggeredRef.current = false;
    plusLongPressTimerRef.current = window.setTimeout(() => {
      plusLongPressTriggeredRef.current = true;
      onOpenTabManager();
    }, PLUS_LONG_PRESS_MS);
  };

  const endPlusLongPress = () => {
    clearPlusLongPress();
  };

  const handleTabTap = (session: Session) => {
    const now = Date.now();
    const previousTap = tabTapRef.current;
    closePaneMenu();
    onSwitchSession(session.id);
    if (previousTap && previousTap.sessionId === session.id && now - previousTap.timestamp <= DOUBLE_TAP_MS) {
      tabTapRef.current = null;
      const next = window.prompt('Rename tab', session.customName || session.sessionName);
      if (next !== null) {
        onRenameSession(session.id, next);
      }
      return;
    }
    tabTapRef.current = { sessionId: session.id, timestamp: now };
  };

  useEffect(() => {
    if (!activeSession?.id) {
      clearCloseConfirm();
      return clearCloseConfirm;
    }
    const activeTab = tabsScrollerRef.current?.querySelector<HTMLElement>(`[data-session-id="${activeSession.id}"]`);
    activeTab?.scrollIntoView({
      inline: 'center',
      block: 'nearest',
      behavior: 'smooth',
    });
    clearCloseConfirm();
    return clearCloseConfirm;
  }, [activeSession?.id]);

  useEffect(() => {
    if (!paneMenuSessionId) {
      return;
    }

    const closeIfOutside = () => closePaneMenu();
    document.addEventListener('pointerdown', closeIfOutside, true);
    return () => {
      document.removeEventListener('pointerdown', closeIfOutside, true);
    };
  }, [paneMenuSessionId]);

  useEffect(() => () => {
    clearLongPress();
    clearPlusLongPress();
    clearCloseConfirm();
  }, []);

  return (
    <div
      style={{
        padding: `${Math.max(0, Math.round(topInsetPx || 0)) + HEADER_TOUCH_SAFE_OFFSET_PX}px 6px 6px`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
        <button
          onClick={onBack}
          tabIndex={-1}
          onFocus={(event) => event.currentTarget.blur()}
          style={{
            width: '36px',
            height: '36px',
            borderRadius: '12px',
            border: 'none',
            outline: 'none',
            backgroundColor: mobileTheme.colors.shellMuted,
            color: mobileTheme.colors.textPrimary,
            fontSize: '20px',
            cursor: 'pointer',
            flexShrink: 0,
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          ‹
        </button>

        <div
          ref={tabsScrollerRef}
          tabIndex={-1}
          onFocus={(event) => event.currentTarget.blur()}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            overflowX: 'auto',
            overflowY: 'hidden',
            scrollbarWidth: 'none',
            WebkitOverflowScrolling: 'touch',
            touchAction: 'pan-x',
            WebkitTapHighlightColor: 'transparent',
            outline: 'none',
            boxShadow: 'none',
            userSelect: 'none',
          }}
        >
          {sessions.map((session) => {
            const active = session.id === activeSession?.id;
            const tone = getServerColorTone(session);
            const paneId = resolveSessionPane(session.id);
            const paneLabel = paneId === 'secondary' ? '右' : '左';
            const menuOpen = paneMenuSessionId === session.id;
            const resolvedPathLabel = formatResolvedPath(session.resolvedPath);
            return (
              <div
                key={session.id}
                style={{
                  position: 'relative',
                  flexShrink: 0,
                }}
              >
                <button
                  data-session-id={session.id}
                  tabIndex={-1}
                  onFocus={(event) => event.currentTarget.blur()}
                  onMouseDown={() => startTabLongPress(session.id)}
                  onMouseUp={endTabLongPress}
                  onMouseLeave={endTabLongPress}
                  onTouchStart={(event) => {
                    if (event.touches.length >= 2 && active) {
                      event.preventDefault();
                      openPaneMenu(session.id);
                      return;
                    }
                    startTabLongPress(session.id);
                  }}
                  onTouchEnd={endTabLongPress}
                  onTouchCancel={endTabLongPress}
                  onClick={() => {
                    if (longPressTriggeredRef.current) {
                      longPressTriggeredRef.current = false;
                      return;
                    }
                    handleTabTap(session);
                  }}
                  style={{
                    flexShrink: 0,
                    minWidth: active ? '120px' : '78px',
                    maxWidth: active ? '160px' : '132px',
                    minHeight: '36px',
                    borderRadius: '12px',
                    outline: 'none',
                    border: `1px solid ${tone.accentMuted}`,
                    backgroundColor: active ? tone.tabActiveBackground : tone.tabIdleBackground,
                    color: active ? tone.accent : mobileTheme.colors.textPrimary,
                    fontSize: '11px',
                    fontWeight: 800,
                    padding: active
                      ? (splitVisible ? '0 32px 0 10px' : '0 34px 0 12px')
                      : (splitVisible ? '0 10px' : '0 12px'),
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    WebkitTapHighlightColor: 'transparent',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                  title={splitVisible
                    ? 'Tap: switch · Double tap: rename · Long press tab: pane menu · Two-finger tap current tab: move menu'
                    : 'Tap: switch · Double tap: rename · Long press tab: tab manager'}
                >
                  {splitVisible ? (
                    <span
                      style={{
                        minWidth: '16px',
                        height: '16px',
                        borderRadius: '999px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '10px',
                        lineHeight: 1,
                        backgroundColor: paneId === 'secondary' ? 'rgba(113, 164, 255, 0.18)' : 'rgba(31, 214, 122, 0.18)',
                        color: paneId === 'secondary' ? '#8db7ff' : mobileTheme.colors.accent,
                        flexShrink: 0,
                      }}
                    >
                      {paneLabel}
                    </span>
                  ) : null}
                  <span
                    style={{
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                    }}
                  >
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {session.customName || session.sessionName}
                    </span>
                    {active && resolvedPathLabel ? (
                      <span
                        style={{
                          flexShrink: 0,
                          padding: '2px 6px',
                          borderRadius: '999px',
                          backgroundColor: 'rgba(255,255,255,0.14)',
                          fontSize: '9px',
                          lineHeight: 1.2,
                        }}
                      >
                        {resolvedPathLabel}
                      </span>
                    ) : null}
                  </span>
                </button>
                {active ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label="关闭当前 tab"
                    onFocus={(event) => event.currentTarget.blur()}
                    onMouseDown={(event) => event.preventDefault()}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (armedClosableSessionId === session.id) {
                        clearCloseConfirm();
                        closePaneMenu();
                        onCloseSession(session.id, 'terminal-header-close-button');
                        return;
                      }
                      clearCloseConfirm();
                      setArmedClosableSessionId(session.id);
                      closeConfirmTimerRef.current = window.setTimeout(() => {
                        setArmedClosableSessionId((current) => (current === session.id ? null : current));
                        closeConfirmTimerRef.current = null;
                      }, ACTIVE_TAB_CLOSE_CONFIRM_WINDOW_MS);
                    }}
                    style={{
                      position: 'absolute',
                      top: '50%',
                      right: '8px',
                      transform: 'translateY(-50%)',
                      width: '20px',
                      height: '20px',
                      borderRadius: '999px',
                      border: 'none',
                      outline: 'none',
                      padding: 0,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor:
                        armedClosableSessionId === session.id
                          ? 'rgba(255,124,146,0.22)'
                          : 'rgba(255,255,255,0.14)',
                      color: active ? tone.accent : mobileTheme.colors.textPrimary,
                      fontSize: '13px',
                      lineHeight: 1,
                      fontWeight: 900,
                      zIndex: 2,
                      WebkitTapHighlightColor: 'transparent',
                      opacity: armedClosableSessionId === session.id ? 1 : 0.72,
                      pointerEvents: 'auto',
                    }}
                  >
                    ×
                  </button>
                ) : null}
                {menuOpen ? (
                  <div
                    onPointerDown={(event) => event.stopPropagation()}
                    style={{
                      position: 'absolute',
                      top: 'calc(100% + 6px)',
                      left: 0,
                      minWidth: '164px',
                      padding: '8px',
                      borderRadius: '14px',
                      border: '1px solid rgba(255,255,255,0.08)',
                      backgroundColor: 'rgba(17, 21, 31, 0.96)',
                      boxShadow: '0 18px 40px rgba(0,0,0,0.28)',
                      zIndex: 40,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onAssignSessionToPane?.(session.id, 'primary');
                        closePaneMenu();
                      }}
                      style={paneMenuButtonStyle(resolveSessionPane(session.id) === 'primary')}
                    >
                      归到左屏
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onAssignSessionToPane?.(session.id, 'secondary');
                        closePaneMenu();
                      }}
                      style={paneMenuButtonStyle(resolveSessionPane(session.id) === 'secondary')}
                    >
                      归到右屏
                    </button>
                    {active ? (
                      <button
                        type="button"
                        onClick={() => {
                          onMoveSessionToOtherPane?.(session.id);
                          closePaneMenu();
                        }}
                        style={paneMenuButtonStyle(false)}
                      >
                        当前 tab 移到另一屏
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <button
          onMouseDown={startPlusLongPress}
          onMouseUp={endPlusLongPress}
          onMouseLeave={endPlusLongPress}
          onTouchStart={startPlusLongPress}
          onTouchEnd={endPlusLongPress}
          onTouchCancel={endPlusLongPress}
          onClick={() => {
            if (plusLongPressTriggeredRef.current) {
              plusLongPressTriggeredRef.current = false;
              return;
            }
            onOpenQuickTabPicker();
          }}
          tabIndex={-1}
          onFocus={(event) => event.currentTarget.blur()}
          style={{
            width: '36px',
            height: '36px',
            borderRadius: '12px',
            border: 'none',
            outline: 'none',
            backgroundColor: mobileTheme.colors.shellMuted,
            color: mobileTheme.colors.textPrimary,
            fontSize: '20px',
            cursor: 'pointer',
            flexShrink: 0,
            WebkitTapHighlightColor: 'transparent',
          }}
          title="Tap: quick new tab · Long press: tab manager"
        >
          +
        </button>
      </div>
    </div>
  );
}

function paneMenuButtonStyle(active: boolean) {
  return {
    minHeight: '34px',
    borderRadius: '10px',
    border: `1px solid ${active ? 'rgba(113, 164, 255, 0.28)' : 'rgba(255,255,255,0.08)'}`,
    backgroundColor: active ? 'rgba(113, 164, 255, 0.16)' : 'rgba(31, 38, 53, 0.82)',
    color: active ? '#8db7ff' : '#fff',
    fontSize: '12px',
    fontWeight: 700,
    textAlign: 'left' as const,
    padding: '0 12px',
  };
}
