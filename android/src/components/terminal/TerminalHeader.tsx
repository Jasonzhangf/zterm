import { useEffect, useRef } from 'react';
import type { Session } from '../../lib/types';
import { mobileTheme } from '../../lib/mobile-ui';
import { getServerColorTone } from '../../lib/server-color';

const LONG_PRESS_MS = 680;
const DOUBLE_TAP_MS = 280;

interface TerminalHeaderProps {
  sessions: Session[];
  activeSession: Session | null;
  onBack: () => void;
  onOpenQuickTabPicker: () => void;
  onOpenTabManager: () => void;
  onSwitchSession: (id: string) => void;
  onRenameSession: (id: string, name: string) => void;
}

export function TerminalHeader({
  sessions,
  activeSession,
  onBack,
  onOpenQuickTabPicker,
  onOpenTabManager,
  onSwitchSession,
  onRenameSession,
}: TerminalHeaderProps) {
  const tabsScrollerRef = useRef<HTMLDivElement | null>(null);
  const tabTapRef = useRef<{ sessionId: string; timestamp: number } | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);

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
      onOpenTabManager();
    }, LONG_PRESS_MS);
  };

  const endLongPress = () => {
    clearLongPress();
  };

  const handleTabTap = (session: Session) => {
    const now = Date.now();
    const previousTap = tabTapRef.current;
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
          onMouseDown={startLongPress}
          onMouseUp={endLongPress}
          onMouseLeave={endLongPress}
          onTouchStart={startLongPress}
          onTouchEnd={endLongPress}
          onTouchCancel={endLongPress}
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
            return (
              <button
                key={session.id}
                data-session-id={session.id}
                tabIndex={-1}
                onFocus={(event) => event.currentTarget.blur()}
                onClick={() => {
                  if (longPressTriggeredRef.current) {
                    longPressTriggeredRef.current = false;
                    return;
                  }
                  handleTabTap(session);
                }}
                style={{
                  flexShrink: 0,
                  minWidth: active ? '112px' : '78px',
                  maxWidth: active ? '160px' : '132px',
                  minHeight: '36px',
                  borderRadius: '12px',
                  outline: 'none',
                  border: `1px solid ${tone.accentMuted}`,
                  backgroundColor: active ? tone.tabActiveBackground : tone.tabIdleBackground,
                  color: active ? tone.accent : mobileTheme.colors.textPrimary,
                  fontSize: '11px',
                  fontWeight: 800,
                  padding: '0 12px',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  WebkitTapHighlightColor: 'transparent',
                }}
                title="Tap: switch · Double tap: rename · Long press strip: tab menu"
              >
                {session.customName || session.sessionName}
              </button>
            );
          })}
        </div>

        <button
          onClick={onOpenQuickTabPicker}
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
          title="Quick new tab"
        >
          +
        </button>
      </div>
    </div>
  );
}
