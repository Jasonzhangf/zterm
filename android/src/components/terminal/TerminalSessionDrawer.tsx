import { memo, useMemo, useRef, useState } from 'react';
import { getServerIdentityTone } from '../../lib/server-identity';

export type TerminalSessionGroupSlotName = 'top' | 'center' | 'bottom';
export type TerminalSessionGroupLayoutAxis = 'vertical' | 'horizontal';

export interface TerminalSessionDrawerItem {
  id: string;
  title: string;
  subtitle: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'closed' | 'error' | 'idle';
  remoteMissing?: boolean;
  paneLabel?: string | null;
  sessionGroupSlot?: TerminalSessionGroupSlotName | null;
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

export interface TerminalSessionDrawerHost {
  hostKey: string;
  hostLabel: string;
  connected?: boolean;
}

export interface TerminalSessionDrawerProps {
  open: boolean;
  topInsetPx?: number;
  bottomInsetPx?: number;
  sessions: TerminalSessionDrawerItem[];
  hosts?: TerminalSessionDrawerHost[];
  onClose: () => void;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onAssignSessionGroupSlot?: (sessionId: string, slot: TerminalSessionGroupSlotName) => void;
  sessionGroupLayoutAxis?: TerminalSessionGroupLayoutAxis;
  onOpenQuickTabPicker: (hostKey?: string, createOptions?: { sessionName?: string; cwd?: string }) => void;
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

function resolveSessionGroupSlotTone(
  slot: TerminalSessionGroupSlotName | null | undefined,
  axis: TerminalSessionGroupLayoutAxis = 'vertical',
) {
  const beforeLabel = axis === 'horizontal' ? '左侧' : '上方';
  const afterLabel = axis === 'horizontal' ? '右侧' : '下方';
  switch (slot) {
    case 'top':
      return {
        label: beforeLabel,
        color: '#8bd5ff',
        background: 'rgba(139, 213, 255, 0.14)',
        border: 'rgba(139, 213, 255, 0.70)',
      };
    case 'center':
      return {
        label: '中间',
        color: '#44e2a0',
        background: 'rgba(68, 226, 160, 0.14)',
        border: 'rgba(68, 226, 160, 0.72)',
      };
    case 'bottom':
      return {
        label: afterLabel,
        color: '#f5b659',
        background: 'rgba(245, 182, 89, 0.14)',
        border: 'rgba(245, 182, 89, 0.72)',
      };
    default:
      return null;
  }
}

function TerminalSessionDrawerComponent({
  open,
  topInsetPx = 0,
  bottomInsetPx = 0,
  sessions,
  hosts = [],
  onClose,
  onSelectSession,
  onCloseSession,
  onAssignSessionGroupSlot,
  sessionGroupLayoutAxis = 'vertical',
  onOpenQuickTabPicker,
  onDebugAddEvent,
}: TerminalSessionDrawerProps) {
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const suppressNextClickRef = useRef(false);
  const [slotMenu, setSlotMenu] = useState<{
    sessionId: string;
    title: string;
    x: number;
    y: number;
  } | null>(null);
  const [newSessionDraft, setNewSessionDraft] = useState<{
    hostKey?: string;
    sessionName: string;
    cwd: string;
  } | null>(null);

  const buildDefaultSessionName = () => {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+$/, '')
      .replace('T', '-');
    return `zterm-${stamp}`;
  };

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const openSlotMenu = (session: TerminalSessionDrawerItem, x: number, y: number) => {
    if (!onAssignSessionGroupSlot || session.remoteMissing) {
      return;
    }
    suppressNextClickRef.current = true;
    setSlotMenu({
      sessionId: session.id,
      title: session.title,
      x,
      y,
    });
  };

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
    const groups = new Map<string, { hostKey: string; hostLabel: string; connected?: boolean; sessions: TerminalSessionDrawerItem[] }>();
    for (const host of hosts) {
      const hostKey = host.hostKey.trim();
      if (!hostKey) {
        continue;
      }
      groups.set(hostKey, {
        hostKey,
        hostLabel: host.hostLabel.trim() || hostKey,
        connected: host.connected,
        sessions: [],
      });
    }
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
  }, [hosts, sessions]);

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

  const openNewSessionDialog = () => {
    setNewSessionDraft({
      hostKey: effectiveHostKey || hostGroups[0]?.hostKey,
      sessionName: buildDefaultSessionName(),
      cwd: '~/',
    });
  };

  const confirmNewSession = () => {
    const sessionName = newSessionDraft?.sessionName.trim() || '';
    const cwd = newSessionDraft?.cwd.trim() || '~/';
    if (!newSessionDraft || !sessionName) {
      return;
    }
    onOpenQuickTabPicker(newSessionDraft.hostKey, { sessionName, cwd });
    setNewSessionDraft(null);
  };

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
              flexDirection: 'column',
              gap: '8px',
              padding: '10px',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              overflowY: 'auto',
              overflowX: 'hidden',
              flexShrink: 0,
            }}
          >
            {hostGroups.map((group) => {
              const isActive = group.hostKey === effectiveHostKey;
              const tone = getServerIdentityTone({ daemonHostId: group.hostKey, connectionName: group.hostLabel });
              const statusColor = group.connected === false ? '#ff727d' : group.connected ? '#44e2a0' : 'rgba(220,232,255,0.45)';
              return (
                <button
                  key={group.hostKey}
                  type="button"
                  data-testid={`terminal-session-drawer-host-${group.hostKey}`}
                  onClick={() => setSelectedHostKey(group.hostKey)}
                  style={{
                    width: '100%',
                    flexShrink: 0,
                    padding: '10px 12px',
                    borderRadius: '14px',
                    border: isActive
                      ? `1px solid ${tone.accent}`
                      : `1px solid ${tone.lightCardBorder}`,
                    background: isActive
                      ? tone.tabActiveBackground
                      : 'rgba(255,255,255,0.04)',
                    color: isActive ? tone.previewText : 'rgba(220, 232, 255, 0.7)',
                    fontSize: '12px',
                    fontWeight: 700,
                    textAlign: 'left',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                    <span
                      style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: '999px',
                        background: statusColor,
                        boxShadow: `0 0 0 2px ${tone.accentSoft}`,
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ minWidth: 0, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {group.hostLabel}
                    </span>
                    <span style={{ flexShrink: 0, color: 'rgba(220, 232, 255, 0.52)', fontSize: '10px' }}>
                      {group.sessions.length}
                    </span>
                  </div>
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
            const slotTone = resolveSessionGroupSlotTone(session.sessionGroupSlot, sessionGroupLayoutAxis);
            return (
            <button
              key={session.id}
              type="button"
              data-testid={`terminal-session-drawer-row-${session.id}`}
              onContextMenu={(event) => {
                event.preventDefault();
                openSlotMenu(session, event.clientX, event.clientY);
              }}
              onTouchStart={(event) => {
                const touch = event.touches[0];
                if (!touch) {
                  return;
                }
                clearLongPressTimer();
                longPressTimerRef.current = window.setTimeout(() => {
                  longPressTimerRef.current = null;
                  openSlotMenu(session, touch.clientX, touch.clientY);
                }, 420);
              }}
              onTouchMove={clearLongPressTimer}
              onTouchEnd={clearLongPressTimer}
              onTouchCancel={clearLongPressTimer}
              onClick={(event) => {
                if (suppressNextClickRef.current) {
                  event.preventDefault();
                  event.stopPropagation();
                  suppressNextClickRef.current = false;
                  return;
                }
                if (!unavailable) onSelectSession(session.id);
              }}
              style={{
                minHeight: '72px',
                width: '100%',
                textAlign: 'left',
                padding: '10px 12px',
                borderRadius: '12px',
                border: slotTone
                  ? `1px solid ${slotTone.border}`
                  : session.active
                  ? '1px solid rgba(106, 167, 255, 0.9)'
                  : '1px solid rgba(255,255,255,0.08)',
                background: slotTone
                  ? `linear-gradient(90deg, ${slotTone.background}, rgba(255,255,255,0.04))`
                  : session.active
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
                {slotTone ? (
                  <span
                    data-testid={`terminal-session-drawer-slot-${session.id}`}
                    style={{
                      minWidth: '38px',
                      padding: '3px 7px',
                      borderRadius: '999px',
                      background: slotTone.background,
                      color: slotTone.color,
                      textAlign: 'center',
                      fontSize: '10px',
                      fontWeight: 900,
                      border: `1px solid ${slotTone.border}`,
                    }}
                  >
                    {slotTone.label}
                  </span>
                ) : null}
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
          {visibleSessions.length === 0 && (
            <div
              data-testid="terminal-session-drawer-empty-host"
              style={{
                margin: '8px 2px',
                padding: '14px',
                borderRadius: '14px',
                border: '1px dashed rgba(220,232,255,0.16)',
                color: 'rgba(220,232,255,0.62)',
                fontSize: '12px',
                lineHeight: 1.5,
              }}
            >
              当前机器没有活跃 session。点击底部 New Session 会在这台机器上创建一个空白 session。
            </div>
          )}
        </div>

        {slotMenu && onAssignSessionGroupSlot ? (
          <div
            data-testid="terminal-session-drawer-slot-menu"
            style={{
              position: 'absolute',
              left: `${Math.min(Math.max(12, slotMenu.x), 190)}px`,
              top: `${Math.max(72, slotMenu.y - 18)}px`,
              zIndex: 2,
              width: '160px',
              padding: '8px',
              borderRadius: '14px',
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(10, 16, 26, 0.96)',
              boxShadow: '0 14px 30px rgba(0,0,0,0.34)',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}
          >
            <div
              style={{
                padding: '2px 4px 5px',
                color: 'rgba(220, 232, 255, 0.68)',
                fontSize: '11px',
                lineHeight: 1.3,
              }}
            >
              设置 {slotMenu.title} 的位置
            </div>
            {([
              ['top', sessionGroupLayoutAxis === 'horizontal' ? '放到左侧' : '放到上方'],
              ['center', '放到中间'],
              ['bottom', sessionGroupLayoutAxis === 'horizontal' ? '放到右侧' : '放到下方'],
            ] as const).map(([slot, label]) => {
              const tone = resolveSessionGroupSlotTone(slot, sessionGroupLayoutAxis);
              return (
                <button
                  key={slot}
                  type="button"
                  data-testid={`terminal-session-drawer-slot-menu-${slot}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onAssignSessionGroupSlot(slotMenu.sessionId, slot);
                    suppressNextClickRef.current = true;
                    setSlotMenu(null);
                  }}
                  style={{
                    height: '34px',
                    borderRadius: '10px',
                    border: `1px solid ${tone?.border || 'rgba(255,255,255,0.10)'}`,
                    background: tone?.background || 'rgba(255,255,255,0.05)',
                    color: tone?.color || '#dce8ff',
                    fontSize: '13px',
                    fontWeight: 800,
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        ) : null}

        {newSessionDraft ? (
          <div
            data-testid="terminal-session-drawer-new-session-dialog"
            style={{
              margin: '8px 10px',
              padding: '12px',
              borderRadius: '16px',
              border: '1px solid rgba(255,255,255,0.14)',
              background: 'rgba(10, 16, 26, 0.96)',
              boxShadow: '0 14px 30px rgba(0,0,0,0.28)',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <div
              style={{
                color: '#dce8ff',
                fontSize: '13px',
                fontWeight: 850,
              }}
            >
              新建 Session
            </div>
            <label
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '5px',
                color: 'rgba(220,232,255,0.68)',
                fontSize: '11px',
                fontWeight: 800,
              }}
            >
              名称
              <input
                aria-label="新 session 名称"
                value={newSessionDraft.sessionName}
                onChange={(event) => setNewSessionDraft((current) => (
                  current ? { ...current, sessionName: event.target.value } : current
                ))}
                style={{
                  height: '34px',
                  borderRadius: '10px',
                  border: '1px solid rgba(255,255,255,0.12)',
                  background: 'rgba(255,255,255,0.06)',
                  color: '#dce8ff',
                  padding: '0 10px',
                  fontSize: '13px',
                }}
              />
            </label>
            <label
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '5px',
                color: 'rgba(220,232,255,0.68)',
                fontSize: '11px',
                fontWeight: 800,
              }}
            >
              启动路径
              <input
                aria-label="新 session 启动路径"
                value={newSessionDraft.cwd}
                placeholder="~/"
                onChange={(event) => setNewSessionDraft((current) => (
                  current ? { ...current, cwd: event.target.value } : current
                ))}
                style={{
                  height: '34px',
                  borderRadius: '10px',
                  border: '1px solid rgba(255,255,255,0.12)',
                  background: 'rgba(255,255,255,0.06)',
                  color: '#dce8ff',
                  padding: '0 10px',
                  fontSize: '13px',
                }}
              />
            </label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                onClick={() => setNewSessionDraft(null)}
                style={{
                  flex: 1,
                  height: '34px',
                  borderRadius: '10px',
                  border: '1px solid rgba(255,255,255,0.12)',
                  background: 'rgba(255,255,255,0.06)',
                  color: 'rgba(220,232,255,0.78)',
                  fontWeight: 800,
                }}
              >
                取消
              </button>
              <button
                type="button"
                disabled={!newSessionDraft.sessionName.trim()}
                onClick={confirmNewSession}
                style={{
                  flex: 1,
                  height: '34px',
                  borderRadius: '10px',
                  border: '1px solid rgba(106,167,255,0.35)',
                  background: newSessionDraft.sessionName.trim() ? 'rgba(106,167,255,0.22)' : 'rgba(255,255,255,0.05)',
                  color: newSessionDraft.sessionName.trim() ? '#8bd5ff' : 'rgba(220,232,255,0.42)',
                  fontWeight: 900,
                }}
              >
                创建
              </button>
            </div>
          </div>
        ) : null}

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
            openNewSessionDialog();
          }}
          onPointerDown={() => {
            onDebugAddEvent?.('add:pointerdown');
          }}
          onPointerUp={() => {
            onDebugAddEvent?.('add:pointerup');
          }}
          onClick={() => {
            onDebugAddEvent?.('add:click');
            if (!newSessionDraft) {
              openNewSessionDialog();
            }
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
