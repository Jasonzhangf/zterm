import { memo, useEffect, useMemo, useRef, useState } from 'react';
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
   * host 展示名（machineName / alias），由 TerminalPage 注入。
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
  onRefreshHostSessions?: (hostKey?: string) => void;
  onDebugAddEvent?: (eventName: string) => void;
  previewSelectionMode?: boolean;
  previewSelectedSessionIds?: string[];
  previewSelectionError?: string | null;
  onPreviewSelectionModeChange?: (active: boolean) => void;
  onTogglePreviewSession?: (sessionId: string) => void;
  onClearPreviewSelection?: () => void;
}

const DRAWER_WIDTH = '48vw';
const DRAWER_MAX_WIDTH = '187px';
const SWIPE_CLOSE_THRESHOLD_PX = 48;
const SWIPE_CLOSE_VERTICAL_TOLERANCE_PX = 44;
const UNSCOPED_HOST_GROUP_KEY = '__unscoped__';
const UNSCOPED_HOST_GROUP_LABEL = '未绑定主机';

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
  onRefreshHostSessions,
  onDebugAddEvent,
  previewSelectionMode = false,
  previewSelectedSessionIds = [],
  previewSelectionError = null,
  onPreviewSelectionModeChange,
  onTogglePreviewSession,
  onClearPreviewSelection,
}: TerminalSessionDrawerProps) {
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const suppressNextClickRef = useRef(false);
  const selectionPressRef = useRef<{ sessionId: string; x: number; y: number } | null>(null);
  const closeTouchHandledRef = useRef<string | null>(null);
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

  const activateCloseSession = (sessionId: string) => {
    clearLongPressTimer();
    onCloseSession(sessionId);
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
    const groups = new Map<
      string,
      { groupKey: string; hostKey?: string; hostLabel: string; connected?: boolean; sessions: TerminalSessionDrawerItem[] }
    >();
    for (const host of hosts) {
      const hostKey = host.hostKey.trim();
      if (!hostKey) {
        continue;
      }
      groups.set(hostKey, {
        groupKey: hostKey,
        hostKey,
        hostLabel: host.hostLabel.trim() || hostKey,
        connected: host.connected,
        sessions: [],
      });
    }
    for (const session of sessions) {
      const hostKey = session.hostKey;
      if (!hostKey) {
        let group = groups.get(UNSCOPED_HOST_GROUP_KEY);
        if (!group) {
          group = {
            groupKey: UNSCOPED_HOST_GROUP_KEY,
            hostLabel: session.hostLabel?.trim() || UNSCOPED_HOST_GROUP_LABEL,
            sessions: [],
          };
          groups.set(UNSCOPED_HOST_GROUP_KEY, group);
        }
        group.sessions.push(session);
        continue;
      }
      const hostLabel = session.hostLabel || hostKey;
      let group = groups.get(hostKey);
      if (!group) {
        group = { groupKey: hostKey, hostKey, hostLabel, sessions: [] };
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
    if (selectedHostKey && hostGroups.some((g) => g.groupKey === selectedHostKey)) {
      return selectedHostKey;
    }
    const activeGroup = hostGroups.find((g) => g.sessions.some((s) => s.active));
    return activeGroup?.groupKey || hostGroups[0]?.groupKey || null;
  }, [hostGroups, multiHost, selectedHostKey]);

  const visibleSessions = useMemo(() => {
    if (!multiHost || !effectiveHostKey) {
      return sessions;
    }
    const group = hostGroups.find((g) => g.groupKey === effectiveHostKey);
    return group?.sessions || [];
  }, [effectiveHostKey, hostGroups, multiHost, sessions]);
  const currentHostGroup = useMemo(() => {
    if (!multiHost) {
      return hostGroups[0] || null;
    }
    return hostGroups.find((g) => g.groupKey === effectiveHostKey) || hostGroups[0] || null;
  }, [effectiveHostKey, hostGroups, multiHost]);
  const refreshHostKey = currentHostGroup?.hostKey;

  useEffect(() => {
    selectionPressRef.current = null;
  }, [open]);

  useEffect(() => {
    if (!open || !onRefreshHostSessions || !refreshHostKey) {
      return;
    }
    void Promise.resolve(onRefreshHostSessions(refreshHostKey)).catch((error) => {
      console.error('[TerminalSessionDrawer] Failed to refresh host sessions:', error);
    });
  }, [onRefreshHostSessions, open, refreshHostKey]);

  const openNewSessionDialog = () => {
    setNewSessionDraft({
      hostKey: currentHostGroup?.hostKey,
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
          maxWidth: DRAWER_MAX_WIDTH,
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
              marginTop: '6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
            }}
          >
            <span style={{ fontSize: '17px', fontWeight: 780, color: '#dce8ff' }}>
              {previewSelectionMode ? '选择快捷预览' : '快速切换'}
            </span>
            {onPreviewSelectionModeChange ? (
              <button
                type="button"
                data-testid="terminal-session-drawer-preview-mode"
                aria-pressed={previewSelectionMode}
                onClick={(event) => {
                  event.stopPropagation();
                  onPreviewSelectionModeChange(!previewSelectionMode);
                }}
                style={{
                  height: '28px', padding: '0 8px', borderRadius: '6px',
                  border: '1px solid rgba(139,213,255,0.35)',
                  background: previewSelectionMode ? 'rgba(139,213,255,0.18)' : 'rgba(255,255,255,0.05)',
                  color: '#8bd5ff', fontSize: '11px', fontWeight: 850,
                }}
              >
                {previewSelectionMode ? '完成' : '预览多选'}
              </button>
            ) : null}
          </div>
          <div
            style={{
              marginTop: '6px',
              fontSize: '12px',
              lineHeight: 1.4,
              color: 'rgba(220, 232, 255, 0.6)',
            }}
          >
            {previewSelectionMode
              ? `点击勾选，最多 6 个。已选 ${previewSelectedSessionIds.length}/6。`
              : '左滑收起，点击进入，上下滑动浏览。'}
          </div>
          {previewSelectionError ? (
            <div role="alert" style={{ marginTop: '6px', color: '#ff9ba3', fontSize: '11px' }}>
              {previewSelectionError}
            </div>
          ) : null}
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
              const isActive = group.groupKey === effectiveHostKey;
              const tone = group.hostKey
                ? getServerIdentityTone({ daemonHostId: group.hostKey, connectionName: group.hostLabel })
                : {
                    accent: 'rgba(220, 232, 255, 0.26)',
                    accentSoft: 'rgba(220, 232, 255, 0.08)',
                    lightCardBorder: 'rgba(255,255,255,0.08)',
                    tabActiveBackground: 'rgba(255,255,255,0.06)',
                    previewText: '#dce8ff',
                  };
              const statusColor = group.connected === false ? '#ff727d' : group.connected ? '#44e2a0' : 'rgba(220,232,255,0.45)';
              return (
                <button
                  key={group.groupKey}
                  type="button"
                  data-testid={`terminal-session-drawer-host-${group.groupKey}`}
                  onClick={() => setSelectedHostKey(group.groupKey)}
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
            flex: '0 1 auto',
            minHeight: 0,
            overflowY: 'auto',
            padding: '10px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          {visibleSessions.map((session) => {
            const unavailable = Boolean(session.remoteMissing);
            const previewUnavailable = unavailable || session.status === 'closed';
            const previewSelectionIndex = previewSelectedSessionIds.indexOf(session.id);
            const slotTone = resolveSessionGroupSlotTone(session.sessionGroupSlot, sessionGroupLayoutAxis);
            return (
            <div
              key={session.id}
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
              style={{
                minHeight: '72px',
                width: '100%',
                padding: 0,
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
                overflow: 'hidden',
              }}
            >
                <button
                  type="button"
                  data-testid={`terminal-session-drawer-select-${session.id}`}
                  onMouseDown={(event) => {
                    selectionPressRef.current = {
                      sessionId: session.id,
                      x: event.clientX,
                      y: event.clientY,
                    };
                  }}
                  onTouchStart={(event) => {
                    const touch = event.touches[0];
                    if (!touch) {
                      selectionPressRef.current = null;
                      return;
                    }
                    selectionPressRef.current = {
                      sessionId: session.id,
                      x: touch.clientX,
                      y: touch.clientY,
                    };
                  }}
                  onTouchMove={(event) => {
                    const press = selectionPressRef.current;
                    const touch = event.touches[0];
                    if (
                      !press
                      || press.sessionId !== session.id
                      || !touch
                      || Math.hypot(touch.clientX - press.x, touch.clientY - press.y) > 8
                    ) {
                      selectionPressRef.current = null;
                    }
                  }}
                  onTouchCancel={() => {
                    if (selectionPressRef.current?.sessionId === session.id) {
                      selectionPressRef.current = null;
                    }
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    const pointerClick = event.detail > 0;
                    const pressStartedOnThisRow = selectionPressRef.current?.sessionId === session.id;
                    selectionPressRef.current = null;
                    if (pointerClick && !pressStartedOnThisRow) {
                      event.preventDefault();
                      return;
                    }
                    if (suppressNextClickRef.current) {
                      event.preventDefault();
                      suppressNextClickRef.current = false;
                      return;
                    }
                    if (previewSelectionMode) {
                      if (!previewUnavailable) onTogglePreviewSession?.(session.id);
                      return;
                    }
                    if (!unavailable) onSelectSession(session.id);
                  }}
                  style={{
                  height: '100%',
                  minHeight: '72px',
                  minWidth: 0,
                  border: 'none',
                  background: 'transparent',
                  color: 'inherit',
                  textAlign: 'left',
                  padding: '10px 0 10px 12px',
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
              </button>

              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-end',
                  gap: '8px',
                }}
              >
                {previewSelectionMode ? (
                  <button
                    type="button"
                    data-testid={`terminal-session-drawer-preview-check-${session.id}`}
                    aria-label={previewSelectionIndex >= 0 ? `预览顺序 ${previewSelectionIndex + 1}` : '选择预览'}
                    disabled={previewUnavailable}
                    onMouseDown={(event) => event.stopPropagation()}
                    onTouchStart={(event) => {
                      event.stopPropagation();
                      clearLongPressTimer();
                    }}
                    onTouchEnd={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (!previewUnavailable) onTogglePreviewSession?.(session.id);
                    }}
                    style={{
                      padding: 0,
                      width: '24px', height: '24px', borderRadius: '6px', display: 'flex',
                      alignItems: 'center', justifyContent: 'center',
                      border: previewSelectionIndex >= 0 ? '1px solid #8bd5ff' : '1px solid rgba(255,255,255,0.16)',
                      background: previewSelectionIndex >= 0 ? 'rgba(139,213,255,0.18)' : 'transparent',
                      color: previewSelectionIndex >= 0 ? '#8bd5ff' : previewUnavailable ? 'rgba(220,232,255,0.18)' : 'rgba(220,232,255,0.45)',
                      opacity: previewUnavailable ? 0.45 : 1,
                      fontSize: '11px', fontWeight: 900,
                    }}
                  >
                    {previewSelectionIndex >= 0 ? previewSelectionIndex + 1 : ''}
                  </button>
                ) : null}
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
                <button
                  type="button"
                  aria-label={`关闭 ${session.title}`}
                  data-testid={`terminal-session-drawer-close-${session.id}`}
                  onTouchStart={(event) => {
                    event.stopPropagation();
                    clearLongPressTimer();
                  }}
                  onTouchEnd={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    closeTouchHandledRef.current = session.id;
                    activateCloseSession(session.id);
                  }}
                  onTouchCancel={(event) => {
                    event.stopPropagation();
                    if (closeTouchHandledRef.current === session.id) {
                      closeTouchHandledRef.current = null;
                    }
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (closeTouchHandledRef.current === session.id) {
                      closeTouchHandledRef.current = null;
                      return;
                    }
                    activateCloseSession(session.id);
                  }}
                  style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '999px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: 'none',
                    background: 'rgba(255,255,255,0.06)',
                    color: 'rgba(220, 232, 255, 0.72)',
                    fontSize: '14px',
                    lineHeight: 1,
                    pointerEvents: 'auto',
                  }}
                >
                  ×
                </button>
              </div>
            </div>
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

        {previewSelectionMode ? (
          <div
            data-testid="terminal-session-drawer-preview-footer"
            style={{
              padding: `10px 12px ${Math.max(12, Math.round(bottomInsetPx) + 12)}px`,
              borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', gap: '8px', flexShrink: 0,
            }}
          >
            <button
              type="button"
              onClick={onClearPreviewSelection}
              disabled={previewSelectedSessionIds.length === 0}
              style={{ flex: 1, height: '38px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(255,255,255,0.05)', color: '#dce8ff' }}
            >
              清空
            </button>
            <button
              type="button"
              onClick={() => onPreviewSelectionModeChange?.(false)}
              style={{ flex: 1, height: '38px', borderRadius: '6px', border: '1px solid rgba(139,213,255,0.35)', background: 'rgba(139,213,255,0.18)', color: '#8bd5ff', fontWeight: 850 }}
            >
              完成 {previewSelectedSessionIds.length}/6
            </button>
          </div>
        ) : (
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
        )}
      </aside>
    </>
  );
}

export const TerminalSessionDrawer = memo(TerminalSessionDrawerComponent);
