import { useEffect, useRef } from 'react';
import type { Session } from '../../lib/types';
import { mobileTheme } from '../../lib/mobile-ui';

interface TerminalHeaderProps {
  sessions: Session[];
  activeSession: Session | null;
  onBack: () => void;
  onOpenConnections: () => void;
  onOpenQuickTabPicker: () => void;
  onSwitchSession: (id: string) => void;
  onRenameSession: (id: string, name: string) => void;
  onCloseSession: (id: string) => void;
}

const LONG_PRESS_MS = 420;

export function TerminalHeader({
  sessions,
  activeSession,
  onBack,
  onOpenConnections,
  onOpenQuickTabPicker,
  onSwitchSession,
  onRenameSession,
  onCloseSession,
}: TerminalHeaderProps) {
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const tabLongPressTimerRef = useRef<number | null>(null);
  const tabLongPressTriggeredRef = useRef(false);
  const tabsScrollerRef = useRef<HTMLDivElement | null>(null);

  const requestRename = (session: Session) => {
    const next = window.prompt('Rename tab', session.customName || session.sessionName);
    if (next === null) {
      return;
    }
    onRenameSession(session.id, next);
  };

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const startLongPress = () => {
    clearLongPress();
    longPressTriggeredRef.current = false;
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTriggeredRef.current = true;
      onOpenQuickTabPicker();
    }, LONG_PRESS_MS);
  };

  const endLongPress = () => {
    clearLongPress();
  };

  const clearTabLongPress = () => {
    if (tabLongPressTimerRef.current !== null) {
      window.clearTimeout(tabLongPressTimerRef.current);
      tabLongPressTimerRef.current = null;
    }
  };

  const startTabLongPress = (session: Session) => {
    clearTabLongPress();
    tabLongPressTriggeredRef.current = false;
    tabLongPressTimerRef.current = window.setTimeout(() => {
      tabLongPressTriggeredRef.current = true;
      requestRename(session);
    }, LONG_PRESS_MS);
  };

  const endTabLongPress = () => {
    clearTabLongPress();
  };

  useEffect(() => {
    if (!activeSession?.id) {
      return;
    }

    const activeTab = tabsScrollerRef.current?.querySelector<HTMLElement>(`[data-session-id="${activeSession.id}"]`);
    activeTab?.scrollIntoView({
      inline: 'center',
      block: 'nearest',
      behavior: 'smooth',
    });
  }, [activeSession?.id]);

  return (
    <div
      style={{
        padding: `${mobileTheme.safeArea.top} 6px 6px`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <button
          onClick={onBack}
          style={{
            width: '36px',
            height: '36px',
            borderRadius: '12px',
            border: 'none',
            backgroundColor: mobileTheme.colors.shellMuted,
            color: mobileTheme.colors.textPrimary,
            fontSize: '20px',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          ‹
        </button>

        <div
          ref={tabsScrollerRef}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            overflowX: 'auto',
            overflowY: 'hidden',
            scrollbarWidth: 'none',
            WebkitOverflowScrolling: 'touch',
          }}
        >
          {sessions.map((session) => {
            const active = session.id === activeSession?.id;
            return (
              <div
                key={session.id}
                data-session-id={session.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: active ? '6px' : '0',
                  flexShrink: 0,
                  width: active ? '90px' : '58px',
                  padding: active ? '0 8px 0 10px' : '0 10px',
                  minHeight: '36px',
                  borderRadius: '10px',
                  backgroundColor: active ? 'rgba(31, 214, 122, 0.18)' : mobileTheme.colors.shellMuted,
                }}
              >
                <button
                  onClick={() => {
                    if (tabLongPressTriggeredRef.current) {
                      tabLongPressTriggeredRef.current = false;
                      return;
                    }
                    onSwitchSession(session.id);
                  }}
                  onMouseDown={() => startTabLongPress(session)}
                  onMouseUp={endTabLongPress}
                  onMouseLeave={endTabLongPress}
                  onTouchStart={() => startTabLongPress(session)}
                  onTouchEnd={endTabLongPress}
                  onTouchCancel={endTabLongPress}
                  title="Tap: switch tab · Long press: rename"
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: active ? mobileTheme.colors.accent : mobileTheme.colors.textPrimary,
                    fontWeight: 700,
                    cursor: 'pointer',
                    fontSize: '11px',
                    lineHeight: 1,
                    width: '100%',
                    padding: '0',
                    minWidth: 0,
                  }}
                >
                  <span
                    style={{
                      display: 'block',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {session.customName || session.sessionName}
                  </span>
                </button>
                {active && (
                  <button
                    onClick={() => onCloseSession(session.id)}
                    style={{
                      width: '20px',
                      height: '20px',
                      borderRadius: '999px',
                      border: 'none',
                      backgroundColor: 'rgba(255,255,255,0.10)',
                      color: mobileTheme.colors.textSecondary,
                      fontSize: '12px',
                      cursor: 'pointer',
                      flexShrink: 0,
                      padding: 0,
                    }}
                    aria-label="Close current tab"
                    title="Close current tab"
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <button
          onClick={() => {
            if (longPressTriggeredRef.current) {
              longPressTriggeredRef.current = false;
              return;
            }
            onOpenConnections();
          }}
          onMouseDown={startLongPress}
          onMouseUp={endLongPress}
          onMouseLeave={endLongPress}
          onTouchStart={startLongPress}
          onTouchEnd={endLongPress}
          onTouchCancel={endLongPress}
          style={{
            width: '36px',
            height: '36px',
            borderRadius: '12px',
            border: 'none',
            backgroundColor: mobileTheme.colors.shellMuted,
            color: mobileTheme.colors.textPrimary,
            fontSize: '20px',
            cursor: 'pointer',
            flexShrink: 0,
          }}
          title="Tap: connections · Long press: quick tmux picker"
        >
          +
        </button>
      </div>
    </div>
  );
}
