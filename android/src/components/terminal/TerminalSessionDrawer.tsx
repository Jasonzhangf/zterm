import { memo, useMemo, useRef, useState } from 'react';

export interface TerminalSessionDrawerItem {
  id: string;
  title: string;
  subtitle: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'closed' | 'error' | 'idle';
  remoteMissing?: boolean;
  paneLabel?: string | null;
  active?: boolean;
  /**
   * 唯一 host 真源键（由 TerminalPage 在投递 drawer items 时显式传入），
   * 不得由 drawer 内部隐式从 session/bridge 字段派生。
   * 多机场景下用于 host rail 分组；单机场景可省略。
   */
  hostKey?: string;
  /**
   * host 展示名（machineName / alias / "default"），由 TerminalPage 注入。
   * 未传入时回退到 hostKey；不允许 drawer 内部自行拼装。
   */
  hostLabel?: string;
}

export interface TerminalSessionDrawerProps {
  open: boolean;
  topInsetPx?: number;
  bottomInsetPx?: number;
  sessions: TerminalSessionDrawerItem[];
  onClose: () => void;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onOpenQuickTabPicker: () => void;
  onDebugAddEvent?: (eventName: string) => void;
}

const DRAWER_WIDTH = 'min(280px, 72vw)';
const SWIPE_CLOSE_THRESHOLD_PX = 48;
const SWIPE_CLOSE_VERTICAL_TOLERANCE_PX = 44;

function resolveStatusTone(status: TerminalSessionDrawerItem['status']) {
  switch (status) {
    case 'connected':
      return '#44e2a0';
    case 'connecting':
      return '#f5b659';
    case 'disconnected':
    case 'closed':
    case 'error':
      return '#ff727d';
    default:
      return 'rgba(220, 232, 255, 0.45)';
  }
}

function TerminalSessionDrawerComponent({
  open,
  topInsetPx = 0,
  bottomInsetPx = 0,
  sessions,
  onClose,
  onSelectSession,
  onCloseSession,
  onOpenQuickTabPicker,
  onDebugAddEvent,
}: TerminalSessionDrawerProps) {
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  const describeEventTarget = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) {
      return 'unknown';
    }
    const testIdOwner = target.closest('[data-testid]') as HTMLElement | null;
    if (testIdOwner?.dataset.testid) {
      return testIdOwner.dataset.testid;
    }
    if (target.dataset.testid) {
      return target.dataset.testid;
    }
    return target.tagName.toLowerCase();
  };

  const hostGroups = useMemo(() => {
    const groups = new Map<string, { hostKey: string; hostLabel: string; sessions: TerminalSessionDrawerItem[] }>();
    for (const session of sessions) {
      const hostKey = session.hostKey;
      if (!hostKey) {
        // 单机场景：未显式提供 hostKey，则归入一个 sentinel "default" 分组。
        const fallbackKey = 'default';
        let group = groups.get(fallbackKey);
        if (!group) {
          group = { hostKey: fallbackKey, hostLabel: session.hostLabel || '本机', sessions: [] };
          groups.set(fallbackKey, group);
        }
        group.sessions.push(session);
        continue;
      }
      const hostLabel = session.hostLabel || hostKey;
      let group = groups.get(hostKey);
      if (!group) {
        group = { hostKey, hostLabel, sessions: [] };
        groups.set(hostKey, group);
      }
      group.sessions.push(session);
    }
    return Array.from(groups.values());
  }, [sessions]);

  const multiHost = hostGroups.length > 1;
  const [selectedHostKey, setSelectedHostKey] = useState<string | null>(null);

  const effectiveHostKey = useMemo(() => {
    if (!multiHost) {
      return null;
    }
    if (selectedHostKey && hostGroups.some((g) => g.hostKey === selectedHostKey)) {
      return selectedHostKey;
    }
    const activeGroup = hostGroups.find((g) => g.sessions.some((s) => s.active));
    return activeGroup?.hostKey || hostGroups[0]?.hostKey || null;
  }, [hostGroups, multiHost, selectedHostKey]);

  const visibleSessions = useMemo(() => {
    if (!multiHost || !effectiveHostKey) {
      return sessions;
    }
    const group = hostGroups.find((g) => g.hostKey === effectiveHostKey);
    return group?.sessions || [];
  }, [effectiveHostKey, hostGroups, multiHost, sessions]);

  return (
    <>
      {open ? (
        <button
          type="button"
          aria-label="关闭 session 抽屉"
          data-testid="terminal-session-drawer-overlay"
          onClick={onClose}
          style={{
            position: 'absolute',
            inset: 0,
            border: 'none',
            background: 'rgba(0, 0, 0, 0.18)',
            zIndex: 13,
            padding: 0,
            margin: 0,
          }}
        />
      ) : null}
      <aside
        aria-hidden={!open}
        data-testid="terminal-session-drawer"
        onTouchStartCapture={(event) => {
          onDebugAddEvent?.(`cap:start:${describeEventTarget(event.target)}`);
        }}
        onTouchEndCapture={(event) => {
          onDebugAddEvent?.(`cap:end:${describeEventTarget(event.target)}`);
        }}
        onTouchStart={(event) => {
          onDebugAddEvent?.('drawer:touchstart');
          const touch = event.touches[0];
          if (!touch) {
            touchStartRef.current = null;
            return;
          }
          touchStartRef.current = { x: touch.clientX, y: touch.clientY };
        }}
        onTouchEnd={(event) => {
          onDebugAddEvent?.('drawer:touchend');
          const start = touchStartRef.current;
          touchStartRef.current = null;
          const touch = event.changedTouches[0];
          if (!start || !touch) {
            return;
          }
          const dx = touch.clientX - start.x;
          const dy = touch.clientY - start.y;
          if (dx > -SWIPE_CLOSE_THRESHOLD_PX) {
            return;
          }
          if (Math.abs(dy) > SWIPE_CLOSE_VERTICAL_TOLERANCE_PX) {
            return;
          }
          onClose();
        }}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          bottom: 0,
          width: DRAWER_WIDTH,
          transform: open ? 'translateX(0)' : 'translateX(calc(-100% - 12px))',
          transition: 'transform 180ms ease',
          zIndex: 14,
          display: 'flex',
          flexDirection: 'column',
          background: 'rgba(16, 22, 34, 0.98)',
          borderRight: '1px solid rgba(255,255,255,0.08)',
          boxShadow: open ? '10px 0 28px rgba(0,0,0,0.24)' : 'none',
          backdropFilter: 'blur(16px)',
          pointerEvents: open ? 'auto' : 'none',
        }}
      >
        <div
          style={{
            padding: `${Math.max(10, topInsetPx + 8)}px 10px 10px`,
            borderBottom: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <div
            style={{
              fontSize: '10px',
              fontWeight: 800,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'rgba(220, 232, 255, 0.48)',
            }}
          >
            Sessions
          </div>
          <div
            style={{
              marginTop: '6px',
              fontSize: '17px',
              fontWeight: 780,
              color: '#dce8ff',
            }}
          >
            快速切换
          </div>
          <div
            style={{
              marginTop: '6px',
              fontSize: '12px',
              lineHeight: 1.4,
              color: 'rgba(220, 232, 255, 0.6)',
            }}
          >
            左滑收起，点击进入，上下滑动浏览。
          </div>
        </div>

        {multiHost ? (
          <div
            data-testid="terminal-session-drawer-host-rail"
            style={{
              display: 'flex',
              gap: '6px',
              padding: '8px 10px',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              overflowX: 'auto',
              flexShrink: 0,
            }}
          >
            {hostGroups.map((group) => {
              const isActive = group.hostKey === effectiveHostKey;
              return (
                <button
                  key={group.hostKey}
                  type="button"
                  data-testid={`terminal-session-drawer-host-${group.hostKey}`}
                  onClick={() => setSelectedHostKey(group.hostKey)}
                  style={{
                    flexShrink: 0,
                    padding: '6px 12px',
                    borderRadius: '999px',
                    border: isActive
                      ? '1px solid rgba(106, 167, 255, 0.9)'
                      : '1px solid rgba(255,255,255,0.08)',
                    background: isActive
                      ? 'rgba(106, 167, 255, 0.16)'
                      : 'rgba(255,255,255,0.04)',
                    color: isActive ? '#6aa7ff' : 'rgba(220, 232, 255, 0.7)',
                    fontSize: '12px',
                    fontWeight: 700,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {group.hostLabel}
                </button>
              );
            })}
          </div>
        ) : null}

        <div
          data-testid="terminal-session-drawer-list"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '10px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          {visibleSessions.map((session) => {
            const unavailable = Boolean(session.remoteMissing);
            return (
            <button
              key={session.id}
              type="button"
              data-testid={`terminal-session-drawer-row-${session.id}`}
              onClick={() => { if (!unavailable) onSelectSession(session.id); }}
              style={{
                minHeight: '72px',
                width: '100%',
                textAlign: 'left',
                padding: '10px 12px',
                borderRadius: '12px',
                border: session.active
                  ? '1px solid rgba(106, 167, 255, 0.9)'
                  : '1px solid rgba(255,255,255,0.08)',
                background: session.active
                  ? 'rgba(106, 167, 255, 0.16)'
                  : 'rgba(255,255,255,0.04)',
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                gap: '8px',
                alignItems: 'center',
                color: unavailable ? 'rgba(220, 232, 255, 0.35)' : '#dce8ff',
                opacity: unavailable ? 0.4 : 1,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: '15px',
                    fontWeight: 760,
                    lineHeight: 1.15,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {session.title}
                </div>
                <div
                  style={{
                    marginTop: '5px',
                    fontSize: '11px',
                    color: 'rgba(220, 232, 255, 0.58)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {session.subtitle}
                </div>
                <div
                  style={{
                    marginTop: '7px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '11px',
                    color: 'rgba(220, 232, 255, 0.72)',
                  }}
                >
                  <span
                    style={{
                      width: '7px',
                      height: '7px',
                      borderRadius: '999px',
                      flexShrink: 0,
                      background: resolveStatusTone(session.status),
                    }}
                  />
                  <span>{unavailable ? 'unavailable' : session.status}</span>
                </div>
              </div>

              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-end',
                  gap: '8px',
                }}
              >
                {session.paneLabel ? (
                  <span
                    style={{
                      minWidth: '34px',
                      padding: '3px 7px',
                      borderRadius: '999px',
                      background: 'rgba(106, 167, 255, 0.16)',
                      color: '#6aa7ff',
                      textAlign: 'center',
                      fontSize: '10px',
                      fontWeight: 900,
                    }}
                  >
                    {session.paneLabel}
                  </span>
                ) : (
                  <span />
                )}
                <span
                  aria-label={`关闭 ${session.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseSession(session.id);
                  }}
                  style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '999px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'rgba(255,255,255,0.06)',
                    color: 'rgba(220, 232, 255, 0.72)',
                    fontSize: '14px',
                    lineHeight: 1,
                    pointerEvents: 'auto',
                  }}
                >
                  ×
                </span>
              </div>
            </button>
          );
          })}
        </div>

        <div
          data-testid="terminal-session-drawer-add"
          role="button"
          aria-label="新建 session"
          tabIndex={-1}
          onTouchStartCapture={(event) => {
            onDebugAddEvent?.(`add:capstart:${describeEventTarget(event.target)}`);
          }}
          onTouchEndCapture={(event) => {
            onDebugAddEvent?.(`add:capend:${describeEventTarget(event.target)}`);
          }}
          onTouchStart={() => {
            onDebugAddEvent?.('add:touchstart');
          }}
          onTouchEnd={(event) => {
            onDebugAddEvent?.('add:touchend');
            event.preventDefault();
            event.stopPropagation();
            onDebugAddEvent?.('add:callback');
            onOpenQuickTabPicker();
          }}
          onPointerDown={() => {
            onDebugAddEvent?.('add:pointerdown');
          }}
          onPointerUp={() => {
            onDebugAddEvent?.('add:pointerup');
          }}
          onClick={() => {
            onDebugAddEvent?.('add:click');
          }}
          style={{
            padding: `10px 12px ${Math.max(12, Math.round(bottomInsetPx) + 12)}px`,
            borderTop: '1px solid rgba(255,255,255,0.08)',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: '100%',
              minHeight: '50px',
              borderRadius: '12px',
              border: '1px solid rgba(255,255,255,0.08)',
              background: 'rgba(255,255,255,0.05)',
              color: '#dce8ff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              fontSize: '14px',
              fontWeight: 760,
              touchAction: 'manipulation',
            }}
          >
            <span
              style={{
                width: '18px',
                height: '18px',
                borderRadius: '999px',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(106, 167, 255, 0.18)',
                color: '#6aa7ff',
                fontSize: '16px',
              }}
            >
              +
            </span>
            <span>New Session</span>
          </div>
        </div>
      </aside>
    </>
  );
}

export const TerminalSessionDrawer = memo(TerminalSessionDrawerComponent);
