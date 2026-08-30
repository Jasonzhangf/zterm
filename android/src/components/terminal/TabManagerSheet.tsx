import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { mobileTheme } from '../../lib/mobile-ui';
import { RenameDialog } from './RenameDialog';

const DRAG_HANDLE_LONG_PRESS_MS = 360;

export interface TabManagerSessionItem {
  id: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  customName?: string;
  resolvedPath?: 'lan' | 'rtc-direct' | 'tailscale' | 'ipv6' | 'ipv4' | 'rtc-relay';
  resolvedRelayTransport?: 'direct' | 'turn';
}

interface TabManagerSheetProps {
  open: boolean;
  sessions: TabManagerSessionItem[];
  activeSessionId?: string | null;
  onClose: () => void;
  onSwitchSession: (id: string) => void;
  onRenameSession: (id: string, name: string) => void;
  onCloseSession: (id: string, source?: string) => void;
  onMoveSession: (id: string, toIndex: number) => void;
  onOpenQuickTabPicker: () => void;
}

function formatResolvedPath(
  path?: TabManagerSessionItem['resolvedPath'],
  relayTransport?: TabManagerSessionItem['resolvedRelayTransport'],
) {
  switch (path) {
    case 'lan':
      return '局域网';
    case 'rtc-direct':
      return 'RTC';
    case 'tailscale':
      return 'Tailscale';
    case 'ipv6':
      return 'IPv6';
    case 'ipv4':
      return 'IPv4';
    case 'rtc-relay':
      if (relayTransport === 'turn') {
        return 'Relay TURN';
      }
      return 'Relay';
    default:
      return null;
  }
}

function moveSessionItem(sessions: TabManagerSessionItem[], sessionId: string, toIndex: number) {
  const currentIndex = sessions.findIndex((session) => session.id === sessionId);
  if (currentIndex < 0) {
    return sessions;
  }

  const nextIndex = Math.max(0, Math.min(toIndex, sessions.length - 1));
  if (currentIndex === nextIndex) {
    return sessions;
  }

  const nextSessions = [...sessions];
  const [session] = nextSessions.splice(currentIndex, 1);
  nextSessions.splice(nextIndex, 0, session);
  return nextSessions;
}

function TabManagerSheetComponent({
  open,
  sessions,
  activeSessionId,
  onClose,
  onSwitchSession,
  onRenameSession,
  onCloseSession,
  onMoveSession,
  onOpenQuickTabPicker,
}: TabManagerSheetProps) {
  const dragTimerRef = useRef<number | null>(null);
  const rowListRef = useRef<HTMLDivElement | null>(null);
  const [dragState, setDragState] = useState<{
    sessionId: string;
    pointerId: number;
    startY: number;
    startIndex: number;
    targetIndex: number;
    offsetY: number;
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<TabManagerSessionItem | null>(null);
  const dragStateRef = useRef<typeof dragState>(null);
  const lastPointerCloseIntentRef = useRef<{ sessionId: string; at: number } | null>(null);

  useEffect(() => {
    dragStateRef.current = dragState;
  }, [dragState]);

  const setDragStateSync = (
    next:
      | {
          sessionId: string;
          pointerId: number;
          startY: number;
          startIndex: number;
          targetIndex: number;
          offsetY: number;
        }
      | null,
  ) => {
    dragStateRef.current = next;
    setDragState(next);
  };

  const previewSessions = useMemo(() => {
    if (!dragState) {
      return sessions;
    }
    return moveSessionItem(sessions, dragState.sessionId, dragState.targetIndex);
  }, [dragState, sessions]);

  const clearDragTimer = () => {
    if (dragTimerRef.current !== null) {
      window.clearTimeout(dragTimerRef.current);
      dragTimerRef.current = null;
    }
  };

  const requestRename = (session: TabManagerSessionItem) => {
    setRenameTarget(session);
  };

  const getTargetIndex = (clientY: number, draggedSessionId: string) => {
    const nodes = Array.from(rowListRef.current?.querySelectorAll<HTMLElement>('[data-tab-list-row="true"]') || []);
    if (nodes.length === 0) {
      return -1;
    }

    const candidateNodes = nodes.filter((node) => node.dataset.tabRowSessionId !== draggedSessionId);
    if (candidateNodes.length === 0) {
      return 0;
    }

    let insertionIndex = 0;
    candidateNodes.forEach((node) => {
      const rect = node.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      if (clientY >= centerY) {
        insertionIndex += 1;
      }
    });
    return insertionIndex;
  };

  if (!open) {
    return null;
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 120,
        backgroundColor: 'rgba(10, 14, 24, 0.48)',
        display: 'flex',
        alignItems: 'flex-end',
      }}
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: '100%',
          maxHeight: '88dvh',
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
          borderTopLeftRadius: '28px',
          borderTopRightRadius: '28px',
          backgroundColor: mobileTheme.colors.lightBg,
          padding: `${mobileTheme.safeArea.top} 16px ${mobileTheme.safeArea.bottom}`,
          boxShadow: mobileTheme.shadow.strong,
          display: 'flex',
          flexDirection: 'column',
          gap: '14px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '21px', fontWeight: 800, color: mobileTheme.colors.lightText }}>Tab Menu</div>
            <div style={{ marginTop: '4px', fontSize: '13px', lineHeight: 1.5, color: mobileTheme.colors.lightMuted }}>
              当前 tab 只属于本次运行。长按右侧排序按钮可重排当前 tab。
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              width: '42px',
              height: '42px',
              borderRadius: '14px',
              border: 'none',
              backgroundColor: '#ffffff',
              color: mobileTheme.colors.lightText,
              fontSize: '20px',
              boxShadow: mobileTheme.shadow.soft,
            }}
          >
            ×
          </button>
        </div>

        <div
          style={{
            borderRadius: '22px',
            padding: '14px',
            backgroundColor: '#ffffff',
            boxShadow: mobileTheme.shadow.soft,
            display: 'grid',
            gridTemplateColumns: '1fr',
            gap: '10px',
          }}
        >
          <button
            onClick={onOpenQuickTabPicker}
            style={{
              minHeight: '46px',
              border: 'none',
              borderRadius: '16px',
              backgroundColor: mobileTheme.colors.shell,
              color: '#ffffff',
              fontWeight: 800,
            }}
          >
            + New Tab
          </button>
        </div>

        <div
          style={{
            borderRadius: '22px',
            padding: '14px',
            backgroundColor: '#ffffff',
            boxShadow: mobileTheme.shadow.soft,
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          <div style={{ fontSize: '15px', fontWeight: 800, color: mobileTheme.colors.lightText }}>Current Tabs</div>
          <div ref={rowListRef} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {previewSessions.map((session, index) => {
              const active = session.id === activeSessionId;
              const dragging = dragState?.sessionId === session.id;
              return (
                <div
                  key={session.id}
                  data-tab-list-row="true"
                  data-tab-row-session-id={session.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    borderRadius: '18px',
                    padding: '10px 12px',
                    backgroundColor: active ? 'rgba(31,214,122,0.14)' : '#f6f8fb',
                    transform: dragging ? `translateY(${dragState?.offsetY || 0}px)` : 'translateY(0)',
                    boxShadow: dragging ? '0 10px 18px rgba(0,0,0,0.16)' : 'none',
                    zIndex: dragging ? 3 : 1,
                    position: 'relative',
                  }}
                >
                  <button
                    onClick={() => onSwitchSession(session.id)}
                    style={{
                      flex: 1,
                      border: 'none',
                      background: 'transparent',
                      textAlign: 'left',
                      padding: 0,
                      color: mobileTheme.colors.lightText,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ fontWeight: 800 }}>{session.customName || session.sessionName}</div>
                      {active && (
                        <span style={{ fontSize: '10px', color: mobileTheme.colors.accent, fontWeight: 800 }}>ACTIVE</span>
                      )}
                    </div>
                    <div style={{ marginTop: '4px', fontSize: '11px', color: mobileTheme.colors.lightMuted }}>
                      {session.bridgeHost}:{session.bridgePort} · {session.sessionName}
                      {formatResolvedPath(session.resolvedPath, session.resolvedRelayTransport) ? ` · ${formatResolvedPath(session.resolvedPath, session.resolvedRelayTransport)}` : ''}
                    </div>
                  </button>
                  <button
                    type="button"
                    aria-label={`重命名 ${session.customName || session.sessionName}`}
                    onClick={() => requestRename(session)}
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: '12px',
                      border: 'none',
                      backgroundColor: '#ffffff',
                      color: mobileTheme.colors.lightText,
                    }}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    aria-label={`关闭 ${session.customName || session.sessionName}`}
                    tabIndex={-1}
                    onFocus={(event) => event.currentTarget.blur()}
                    onMouseDown={(event) => event.preventDefault()}
                    onPointerUp={(event) => {
                      event.stopPropagation();
                      lastPointerCloseIntentRef.current = { sessionId: session.id, at: Date.now() };
                      onCloseSession(session.id, 'tab-manager-close-button');
                    }}
                    onClick={() => {
                      const recentPointer = lastPointerCloseIntentRef.current;
                      if (
                        recentPointer
                        && recentPointer.sessionId === session.id
                        && Date.now() - recentPointer.at < 600
                      ) {
                        return;
                      }
                      onCloseSession(session.id, 'tab-manager-close-button');
                    }}
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: '12px',
                      border: 'none',
                      backgroundColor: 'rgba(255,124,146,0.16)',
                      color: mobileTheme.colors.danger,
                    }}
                  >
                    ×
                  </button>
                  <button
                    title="Long press to sort"
                    onPointerDown={(event) => {
                      clearDragTimer();
                      event.preventDefault();
                      dragTimerRef.current = window.setTimeout(() => {
                        setDragStateSync({
                          sessionId: session.id,
                          pointerId: event.pointerId,
                          startY: event.clientY,
                          startIndex: index,
                          targetIndex: index,
                          offsetY: 0,
                        });
                      }, DRAG_HANDLE_LONG_PRESS_MS);
                      try {
                        event.currentTarget.setPointerCapture(event.pointerId);
                      } catch (error) {
                        console.warn('[TabManagerSheet] Failed to set pointer capture:', error);
                      }
                    }}
                    onPointerMove={(event) => {
                      const currentDragState = dragStateRef.current;
                      if (!currentDragState || currentDragState.sessionId !== session.id || currentDragState.pointerId !== event.pointerId) {
                        return;
                      }
                      event.preventDefault();
                      const targetIndex = getTargetIndex(event.clientY, session.id);
                      setDragStateSync({
                        ...currentDragState,
                        offsetY: event.clientY - currentDragState.startY,
                        targetIndex: targetIndex >= 0 ? targetIndex : currentDragState.targetIndex,
                      });
                    }}
                    onPointerUp={(event) => {
                      clearDragTimer();
                      const currentDragState = dragStateRef.current;
                      if (currentDragState && currentDragState.sessionId === session.id && currentDragState.pointerId === event.pointerId) {
                        if (currentDragState.targetIndex !== currentDragState.startIndex) {
                          onMoveSession(session.id, currentDragState.targetIndex);
                        }
                        setDragStateSync(null);
                      }
                      try {
                        event.currentTarget.releasePointerCapture(event.pointerId);
                      } catch (error) {
                        console.warn('[TabManagerSheet] Failed to release pointer capture on pointer up:', error);
                      }
                    }}
                    onPointerCancel={(event) => {
                      clearDragTimer();
                      const currentDragState = dragStateRef.current;
                      if (currentDragState?.sessionId === session.id && currentDragState.pointerId === event.pointerId) {
                        setDragStateSync(null);
                      }
                      try {
                        event.currentTarget.releasePointerCapture(event.pointerId);
                      } catch (error) {
                        console.warn('[TabManagerSheet] Failed to release pointer capture on cancel:', error);
                      }
                    }}
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: '12px',
                      border: 'none',
                      backgroundColor: mobileTheme.colors.shellMuted,
                      color: '#ffffff',
                      fontWeight: 800,
                      touchAction: 'none',
                    }}
                    aria-label={`Sort ${session.customName || session.sessionName}`}
                  >
                    ≡
                  </button>
                </div>
              );
            })}
          </div>
        </div>

      </div>
      <RenameDialog
        open={renameTarget !== null}
        title="重命名标签页"
        inputLabel="新的标签页名称"
        initialValue={renameTarget?.customName || renameTarget?.sessionName || ''}
        onCancel={() => setRenameTarget(null)}
        onSubmit={(nextName) => {
          const target = renameTarget;
          setRenameTarget(null);
          if (target) {
            onRenameSession(target.id, nextName);
          }
        }}
      />
    </div>
  );
}

export const TabManagerSheet = memo(TabManagerSheetComponent);
TabManagerSheet.displayName = 'TabManagerSheet';
