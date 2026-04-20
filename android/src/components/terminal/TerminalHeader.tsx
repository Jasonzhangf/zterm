import { useEffect, useRef, useState } from 'react';
import type { Session } from '../../lib/types';
import { mobileTheme } from '../../lib/mobile-ui';
import { getServerColorTone } from '../../lib/server-color';

interface TerminalHeaderProps {
  sessions: Session[];
  activeSession: Session | null;
  onBack: () => void;
  onOpenConnections: () => void;
  onOpenQuickTabPicker: () => void;
  onSwitchSession: (id: string) => void;
  onMoveSession: (id: string, toIndex: number) => void;
  onRenameSession: (id: string, name: string) => void;
  onCloseSession: (id: string) => void;
}

const LONG_PRESS_MS = 420;
const DOUBLE_TAP_MS = 280;

export function TerminalHeader({
  sessions,
  activeSession,
  onBack,
  onOpenConnections,
  onOpenQuickTabPicker,
  onSwitchSession,
  onMoveSession,
  onRenameSession,
  onCloseSession,
}: TerminalHeaderProps) {
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const tabsScrollerRef = useRef<HTMLDivElement | null>(null);
  const tabTapRef = useRef<{ sessionId: string; timestamp: number } | null>(null);
  const tabDragTimerRef = useRef<number | null>(null);
  const tabDragTriggeredRef = useRef(false);
  const [dragState, setDragState] = useState<{
    sessionId: string;
    pointerId: number;
    startX: number;
    offsetX: number;
    startIndex: number;
    targetIndex: number;
  } | null>(null);

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

  const clearTabDragTimer = () => {
    if (tabDragTimerRef.current !== null) {
      window.clearTimeout(tabDragTimerRef.current);
      tabDragTimerRef.current = null;
    }
  };

  const getPointerTargetIndex = (clientX: number) => {
    const tabNodes = Array.from(tabsScrollerRef.current?.querySelectorAll<HTMLElement>('[data-tab-slot="true"]') || []);
    if (tabNodes.length === 0) {
      return -1;
    }

    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    tabNodes.forEach((node, index) => {
      const rect = node.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const distance = Math.abs(centerX - clientX);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });

    return bestIndex;
  };

  const handleTabTap = (session: Session) => {
    const now = Date.now();
    const previousTap = tabTapRef.current;
    onSwitchSession(session.id);
    if (previousTap && previousTap.sessionId === session.id && now - previousTap.timestamp <= DOUBLE_TAP_MS) {
      tabTapRef.current = null;
      requestRename(session);
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
          {sessions.map((session, index) => {
            const active = session.id === activeSession?.id;
            const dragging = dragState?.sessionId === session.id;
            const tone = getServerColorTone(session);
            return (
              <div
                key={session.id}
                data-session-id={session.id}
                data-tab-slot="true"
                onPointerDown={(event) => {
                  if ((event.target as HTMLElement | null)?.closest('[data-tab-close="true"]')) {
                    return;
                  }
                  clearTabDragTimer();
                  tabDragTriggeredRef.current = false;
                  tabDragTimerRef.current = window.setTimeout(() => {
                    tabDragTriggeredRef.current = true;
                    setDragState({
                      sessionId: session.id,
                      pointerId: event.pointerId,
                      startX: event.clientX,
                      offsetX: 0,
                      startIndex: index,
                      targetIndex: index,
                    });
                  }, LONG_PRESS_MS);
                  try {
                    event.currentTarget.setPointerCapture(event.pointerId);
                  } catch {}
                }}
                onPointerMove={(event) => {
                  if (!dragState || dragState.sessionId !== session.id || dragState.pointerId !== event.pointerId) {
                    return;
                  }
                  event.preventDefault();
                  const targetIndex = getPointerTargetIndex(event.clientX);
                  setDragState({
                    ...dragState,
                    offsetX: event.clientX - dragState.startX,
                    targetIndex: targetIndex >= 0 ? targetIndex : dragState.targetIndex,
                  });
                }}
                onPointerUp={(event) => {
                  clearTabDragTimer();
                  try {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  } catch {}

                  if (dragState && dragState.sessionId === session.id && dragState.pointerId === event.pointerId) {
                    if (dragState.targetIndex !== dragState.startIndex) {
                      onMoveSession(session.id, dragState.targetIndex);
                    } else {
                      onSwitchSession(session.id);
                    }
                    setDragState(null);
                    tabDragTriggeredRef.current = false;
                    return;
                  }

                  if (tabDragTriggeredRef.current) {
                    tabDragTriggeredRef.current = false;
                    return;
                  }

                  handleTabTap(session);
                }}
                onPointerCancel={(event) => {
                  clearTabDragTimer();
                  tabDragTriggeredRef.current = false;
                  if (dragState?.sessionId === session.id && dragState.pointerId === event.pointerId) {
                    setDragState(null);
                  }
                  try {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  } catch {}
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: active ? '6px' : '0',
                  flexShrink: 0,
                  width: active ? '90px' : '58px',
                  padding: active ? '0 8px 0 10px' : '0 10px',
                  minHeight: '36px',
                  borderRadius: '10px',
                  backgroundColor: active ? tone.tabActiveBackground : tone.tabIdleBackground,
                  border: `1px solid ${tone.accentMuted}`,
                  transform: dragging ? `translateX(${dragState?.offsetX || 0}px)` : 'translateX(0)',
                  zIndex: dragging ? 3 : 1,
                  boxShadow: dragging ? '0 10px 18px rgba(0,0,0,0.24)' : 'none',
                  touchAction: 'none',
                }}
              >
                <div
                  title="Tap: switch tab · Double tap: rename · Long press: reorder"
                  style={{
                    color: active ? tone.accent : mobileTheme.colors.textPrimary,
                    fontWeight: 700,
                    fontSize: '11px',
                    lineHeight: 1,
                    width: '100%',
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
                </div>
                {active && (
                  <button
                    data-tab-close="true"
                    onClick={(event) => {
                      event.stopPropagation();
                      onCloseSession(session.id);
                    }}
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
