import { memo, useMemo, useRef } from 'react';

export interface TerminalSessionDrawerItem {
  id: string;
  title: string;
  subtitle: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'closed' | 'error' | 'idle';
  paneLabel?: string | null;
  active?: boolean;
}

export interface TerminalSessionDrawerProps {
  open: boolean;
  topInsetPx?: number;
  sessions: TerminalSessionDrawerItem[];
  onClose: () => void;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onOpenQuickTabPicker: () => void;
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
  sessions,
  onClose,
  onSelectSession,
  onCloseSession,
  onOpenQuickTabPicker,
}: TerminalSessionDrawerProps) {
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  const visibleSessions = useMemo(
    () => sessions,
    [sessions],
  );

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
        onTouchStart={(event) => {
          const touch = event.touches[0];
          if (!touch) {
            touchStartRef.current = null;
            return;
          }
          touchStartRef.current = { x: touch.clientX, y: touch.clientY };
        }}
        onTouchEnd={(event) => {
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
          {visibleSessions.map((session) => (
            <button
              key={session.id}
              type="button"
              data-testid={`terminal-session-drawer-row-${session.id}`}
              onClick={() => onSelectSession(session.id)}
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
                color: '#dce8ff',
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
                  <span>{session.status}</span>
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
                  }}
                >
                  ×
                </span>
              </div>
            </button>
          ))}
        </div>

        <div
          style={{
            padding: '10px 12px 12px',
            borderTop: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <button
            type="button"
            data-testid="terminal-session-drawer-add"
            onClick={onOpenQuickTabPicker}
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
          </button>
        </div>
      </aside>
    </>
  );
}

export const TerminalSessionDrawer = memo(TerminalSessionDrawerComponent);
