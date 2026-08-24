import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  DRAWER_WIDTH,
  DRAWER_MAX_WIDTH,
  SWIPE_CLOSE_THRESHOLD_PX,
  SWIPE_CLOSE_VERTICAL_TOLERANCE_PX,
  UNSCOPED_HOST_GROUP_KEY,
  UNSCOPED_HOST_GROUP_LABEL,
  resolveStatusTone,
  resolveSessionGroupSlotTone,
} from './terminal-session-drawer-helpers';
import { getServerIdentityTone } from '../../lib/server-identity';

export type TerminalSessionGroupSlotName = 'top' | 'center' | 'bottom';
export type TerminalSessionGroupLayoutAxis = 'vertical' | 'horizontal';

export interface TerminalSessionDrawerItem {
  id: string;
  /**
   * 稳定渲染键：React key 只用它，绝不随 liveSession 连接状态（id 的 local/remote
   * 切换）变化——否则亚秒级状态抖动会触发整列表 DOM 重建（抽屉狂闪）。
   */
  stableKey: string;
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
  terminalBackend?: 'tmux' | 'herdr';
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
  onOpenQuickTabPicker: (hostKey?: string, createOptions?: { sessionName?: string; cwd?: string; terminalBackend?: 'tmux' | 'herdr' }) => void;
  onDebugAddEvent?: (eventName: string) => void;
  previewSelectionMode?: boolean;
  previewSelectedSessionIds?: string[];
  previewSelectionError?: string | null;
  onPreviewSelectionModeChange?: (active: boolean) => void;
  onTogglePreviewSession?: (sessionId: string) => void;
  onClearPreviewSelection?: () => void;
  terminalShellSkin?: 'light' | 'blue' | 'black';
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
  previewSelectionMode = false,
  previewSelectedSessionIds = [],
  previewSelectionError = null,
  onPreviewSelectionModeChange,
  onTogglePreviewSession,
  onClearPreviewSelection,
  terminalShellSkin = 'light',
}: TerminalSessionDrawerProps) {
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
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
    terminalBackend: 'tmux' | 'herdr';
  } | null>(null);

  useEffect(() => {
    if (open) {
      closeButtonRef.current?.focus({ preventScroll: true });
    }
  }, [open]);

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

  const showHostRail = hostGroups.length > 0;
  const multiHost = hostGroups.length > 1;
  const [selectedHostKey, setSelectedHostKey] = useState<string | null>(null);

  const effectiveHostKey = useMemo(() => {
    if (selectedHostKey && hostGroups.some((g) => g.groupKey === selectedHostKey)) {
      return selectedHostKey;
    }
    const activeConnectedGroup = hostGroups.find((g) => (
      g.connected !== false && g.sessions.some((s) => s.active)
    ));
    if (activeConnectedGroup) {
      return activeConnectedGroup.groupKey;
    }
    const connectedGroup = hostGroups.find((g) => g.connected === true);
    if (connectedGroup) {
      return connectedGroup.groupKey;
    }
    const activeGroup = hostGroups.find((g) => g.sessions.some((s) => s.active));
    return activeGroup?.groupKey || hostGroups[0]?.groupKey || null;
  }, [hostGroups, selectedHostKey]);

  const visibleSessions = useMemo(() => {
    if (!effectiveHostKey) {
      return sessions;
    }
    const group = hostGroups.find((g) => g.groupKey === effectiveHostKey);
    return group?.sessions || [];
  }, [effectiveHostKey, hostGroups, sessions]);
  const currentHostGroup = useMemo(() => {
    if (!multiHost) {
      return hostGroups[0] || null;
    }
    return hostGroups.find((g) => g.groupKey === effectiveHostKey) || hostGroups[0] || null;
  }, [effectiveHostKey, hostGroups, multiHost]);
  useEffect(() => {
    selectionPressRef.current = null;
  }, [open]);

  const openNewSessionDialog = () => {
    setNewSessionDraft({
      hostKey: currentHostGroup?.hostKey,
      sessionName: buildDefaultSessionName(),
      cwd: '~/',
      terminalBackend: 'tmux',
    });
  };

  const confirmNewSession = () => {
    const sessionName = newSessionDraft?.sessionName.trim() || '';
    const cwd = newSessionDraft?.cwd.trim() || '~/';
    if (!newSessionDraft || !sessionName) {
      return;
    }
    onOpenQuickTabPicker(newSessionDraft.hostKey, { sessionName, cwd, terminalBackend: newSessionDraft.terminalBackend });
    setNewSessionDraft(null);
  };

  return (
    <>
      <button
        type="button"
        aria-label="关闭 session 抽屉"
        aria-hidden={!open}
        inert={!open}
        data-testid="terminal-session-drawer-overlay"
        disabled={!open}
        tabIndex={open ? 0 : -1}
        onClick={onClose}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onClose();
          }
        }}
        style={{
            position: 'absolute',
            inset: 0,
            border: 'none',
            background: 'rgba(0, 0, 0, 0.18)',
            zIndex: 149,
            padding: 0,
            margin: 0,
            opacity: open ? 1 : 0,
            pointerEvents: open ? 'auto' : 'none',
            transition: 'opacity 150ms ease',
        }}
      />
      <aside
        aria-hidden={!open}
        inert={!open}
        className="zterm-neo-drawer"
        data-terminal-shell-skin={terminalShellSkin}
        data-testid="terminal-session-drawer"
        data-state={open ? 'open' : 'closed'}
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
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onClose();
          }
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
          zIndex: 150,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--zterm-panel-bg)',
          borderRight: '1px solid var(--zterm-panel-border)',
          // Android WebView 对 backdrop-filter 支持差：抽屉背景已是不透明色，
          // 每次底层 terminal 内容更新都会触发模糊层重算 → 用户感知的抽屉闪烁。
          // 移除 backdropFilter 与动态 boxShadow（消除合成层伪影）。
          boxShadow: 'none',
          pointerEvents: open ? 'auto' : 'none',
        }}
      >
        <div
          data-testid="terminal-session-drawer-header"
          style={{
            padding: `${Math.max(10, topInsetPx + 8)}px 10px 9px`,
            borderBottom: '1px solid var(--zterm-panel-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
          }}
        >
          <span style={{ minWidth: 0, fontSize: '16px', fontWeight: 800, color: 'var(--zterm-panel-text)' }}>
            Sessions
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: '0 0 auto' }}>
            {previewSelectionMode ? (
              <span
                aria-label={`已选 ${previewSelectedSessionIds.length}/6`}
                style={{ color: 'var(--zterm-panel-muted)', fontSize: '11px', fontWeight: 800 }}
              >
                {previewSelectedSessionIds.length}/6
              </span>
            ) : null}
            <button
              type="button"
              aria-label="关闭 session 抽屉"
              data-testid="terminal-session-drawer-close"
              ref={closeButtonRef}
              onClick={onClose}
              style={{
                width: '44px',
                height: '44px',
                padding: 0,
                borderRadius: '8px',
                border: '1px solid var(--zterm-panel-border)',
                background: 'var(--zterm-panel-surface)',
                color: 'var(--zterm-panel-text)',
                fontSize: '16px',
                lineHeight: 1,
                fontWeight: 800,
              }}
            >
              ×
            </button>
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
                  height: '28px', padding: '0 9px', borderRadius: '6px',
                  border: '1px solid var(--zterm-panel-border)',
                  background: previewSelectionMode ? 'var(--zterm-panel-active)' : 'var(--zterm-panel-surface)',
                  color: previewSelectionMode ? 'var(--zterm-panel-accent)' : 'var(--zterm-panel-text)', fontSize: '11px', fontWeight: 850,
                }}
              >
                {previewSelectionMode ? '完成' : '多选'}
              </button>
            ) : null}
          </div>
        </div>
        {previewSelectionError ? (
          <div
            role="alert"
            style={{
              padding: '7px 10px',
              borderBottom: '1px solid var(--zterm-panel-border)',
              color: 'var(--zterm-panel-danger)',
              fontSize: '11px',
            }}
          >
            {previewSelectionError}
          </div>
        ) : null}

        {showHostRail ? (
          <div
            data-testid="terminal-session-drawer-host-rail"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              padding: '10px',
              borderBottom: '1px solid var(--zterm-panel-border)',
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
              const statusColor = group.connected === false ? '#ff727d' : group.connected ? '#44e2a0' : 'var(--zterm-panel-muted)';
              return (
                <button
                  key={group.groupKey}
                  type="button"
                  aria-selected={isActive}
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
                    background: isActive ? 'var(--zterm-panel-active)' : 'var(--zterm-panel-surface)',
                    color: isActive ? 'var(--zterm-panel-active-text)' : 'var(--zterm-panel-text)',
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
                    <span style={{ flexShrink: 0, color: 'var(--zterm-panel-muted)', fontSize: '10px' }}>
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
              key={session.stableKey}
              data-active={session.active ? 'true' : 'false'}
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
                  : '1px solid var(--zterm-panel-border)',
                background: slotTone
                  ? `linear-gradient(90deg, ${slotTone.background}, rgba(255,255,255,0.04))`
                  : session.active
                  ? 'var(--zterm-panel-active)'
                  : 'var(--zterm-panel-surface)',
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                gap: '8px',
                alignItems: 'center',
                color: unavailable ? 'var(--zterm-panel-muted)' : 'var(--zterm-panel-text)',
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
                    color: 'var(--zterm-panel-muted)',
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
                    color: 'var(--zterm-panel-text)',
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
                      border: previewSelectionIndex >= 0 ? '1px solid var(--zterm-panel-accent)' : '1px solid var(--zterm-panel-border)',
                      background: previewSelectionIndex >= 0 ? 'rgba(139,213,255,0.18)' : 'transparent',
                      color: previewSelectionIndex >= 0 ? 'var(--zterm-panel-accent)' : 'var(--zterm-panel-muted)',
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
                      color: 'var(--zterm-panel-accent)',
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
                    width: '44px',
                    height: '44px',
                    borderRadius: '999px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: 'none',
                    background: 'var(--zterm-panel-surface)',
                    color: 'var(--zterm-panel-muted)',
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
              border: '1px dashed var(--zterm-panel-border)',
              color: 'var(--zterm-panel-muted)',
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
              border: '1px solid var(--zterm-panel-border)',
              background: 'var(--zterm-panel-bg)',
              boxShadow: '0 14px 30px var(--zterm-panel-shadow)',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}
          >
            <div
              style={{
                padding: '2px 4px 5px',
                color: 'var(--zterm-panel-muted)',
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
                    border: `1px solid ${tone?.border || 'var(--zterm-panel-border)'}`,
                    background: tone?.background || 'var(--zterm-panel-surface)',
                    color: tone?.color || 'var(--zterm-panel-text)',
                    fontSize: '13px',
                    fontWeight: 800,
                  }}
                >
                  {label}
                </button>
              );
            })}
            <button
              type="button"
              data-testid="terminal-session-drawer-slot-menu-cancel"
              onClick={(event) => {
                event.stopPropagation();
                suppressNextClickRef.current = true;
                setSlotMenu(null);
              }}
              style={{
                height: '32px',
                borderRadius: '10px',
                border: '1px solid var(--zterm-panel-border)',
                background: 'var(--zterm-panel-surface)',
                color: 'var(--zterm-panel-muted)',
                fontSize: '12px',
                fontWeight: 750,
              }}
            >
              取消
            </button>
          </div>
        ) : null}

        {newSessionDraft ? (
          <div
            data-testid="terminal-session-drawer-new-session-dialog"
            style={{
              margin: '8px 10px',
              padding: '12px',
              borderRadius: '16px',
              border: '1px solid var(--zterm-panel-border)',
              background: 'var(--zterm-panel-bg)',
              boxShadow: '0 14px 30px var(--zterm-panel-shadow)',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <div
              style={{
                color: 'var(--zterm-panel-text)',
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
                color: 'var(--zterm-panel-muted)',
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
                  border: '1px solid var(--zterm-panel-border)',
                  background: 'var(--zterm-panel-surface)',
                  color: 'var(--zterm-panel-text)',
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
                color: 'var(--zterm-panel-muted)',
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
                  border: '1px solid var(--zterm-panel-border)',
                  background: 'var(--zterm-panel-surface)',
                  color: 'var(--zterm-panel-text)',
                  padding: '0 10px',
                  fontSize: '13px',
                }}
              />
            </label>
            <div
              aria-label="新 session backend"
              style={{ display: 'flex', gap: '6px' }}
            >
              {(['tmux', 'herdr'] as const).map((backend) => (
                <button
                  key={backend}
                  type="button"
                  aria-pressed={newSessionDraft.terminalBackend === backend}
                  onClick={() => setNewSessionDraft((current) => (
                    current ? { ...current, terminalBackend: backend } : current
                  ))}
                  style={{
                    flex: 1,
                    height: '34px',
                    borderRadius: '10px',
                    border: '1px solid var(--zterm-panel-border)',
                    background: newSessionDraft.terminalBackend === backend
                      ? 'var(--zterm-panel-active)'
                      : 'var(--zterm-panel-surface)',
                    color: newSessionDraft.terminalBackend === backend
                      ? 'var(--zterm-panel-accent)'
                      : 'var(--zterm-panel-muted)',
                    fontWeight: 850,
                  }}
                >
                  {backend === 'tmux' ? 'tmux' : 'Herdr'}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                onClick={() => setNewSessionDraft(null)}
                style={{
                  flex: 1,
                  height: '34px',
                  borderRadius: '10px',
                  border: '1px solid var(--zterm-panel-border)',
                  background: 'var(--zterm-panel-surface)',
                  color: 'var(--zterm-panel-muted)',
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
                  border: '1px solid var(--zterm-panel-border)',
                  background: newSessionDraft.sessionName.trim() ? 'var(--zterm-panel-active)' : 'var(--zterm-panel-surface)',
                  color: newSessionDraft.sessionName.trim() ? 'var(--zterm-panel-accent)' : 'var(--zterm-panel-muted)',
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
              borderTop: '1px solid var(--zterm-panel-border)', display: 'flex', gap: '8px', flexShrink: 0,
            }}
          >
            <button
              type="button"
              onClick={onClearPreviewSelection}
              disabled={previewSelectedSessionIds.length === 0}
              style={{ flex: 1, height: '38px', borderRadius: '6px', border: '1px solid var(--zterm-panel-border)', background: 'var(--zterm-panel-surface)', color: 'var(--zterm-panel-text)' }}
            >
              清空
            </button>
            <button
              type="button"
              onClick={() => onPreviewSelectionModeChange?.(false)}
              style={{ flex: 1, height: '38px', borderRadius: '6px', border: '1px solid var(--zterm-panel-border)', background: 'var(--zterm-panel-active)', color: 'var(--zterm-panel-accent)', fontWeight: 850 }}
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
            borderTop: '1px solid var(--zterm-panel-border)',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: '100%',
              minHeight: '50px',
              borderRadius: '12px',
              border: '1px solid var(--zterm-panel-border)',
              background: 'var(--zterm-panel-surface)',
              color: 'var(--zterm-panel-text)',
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
                background: 'var(--zterm-panel-active)',
                color: 'var(--zterm-panel-accent)',
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

function terminalSessionDrawerPropsEqual(
  prev: TerminalSessionDrawerProps,
  next: TerminalSessionDrawerProps,
) {
  const mismatchFields: string[] = [];
  if (prev.open !== next.open) mismatchFields.push('open');
  if (prev.topInsetPx !== next.topInsetPx) mismatchFields.push('topInsetPx');
  if (prev.bottomInsetPx !== next.bottomInsetPx) mismatchFields.push('bottomInsetPx');
  if (prev.previewSelectionMode !== next.previewSelectionMode) mismatchFields.push('previewSelectionMode');
  if (prev.sessionGroupLayoutAxis !== next.sessionGroupLayoutAxis) mismatchFields.push('sessionGroupLayoutAxis');
  if (prev.terminalShellSkin !== next.terminalShellSkin) mismatchFields.push('terminalShellSkin');
  if (prev.previewSelectionError !== next.previewSelectionError) mismatchFields.push('previewSelectionError');
  if (prev.onClose !== next.onClose) mismatchFields.push('onClose');
  if (prev.onSelectSession !== next.onSelectSession) mismatchFields.push('onSelectSession');
  if (prev.onCloseSession !== next.onCloseSession) mismatchFields.push('onCloseSession');
  if (prev.onAssignSessionGroupSlot !== next.onAssignSessionGroupSlot) mismatchFields.push('onAssignSessionGroupSlot');
  if (prev.onOpenQuickTabPicker !== next.onOpenQuickTabPicker) mismatchFields.push('onOpenQuickTabPicker');
  if (prev.onDebugAddEvent !== next.onDebugAddEvent) mismatchFields.push('onDebugAddEvent');
  if (prev.onPreviewSelectionModeChange !== next.onPreviewSelectionModeChange) mismatchFields.push('onPreviewSelectionModeChange');
  if (prev.onTogglePreviewSession !== next.onTogglePreviewSession) mismatchFields.push('onTogglePreviewSession');
  if (prev.onClearPreviewSelection !== next.onClearPreviewSelection) mismatchFields.push('onClearPreviewSelection');
  if (prev.sessions.length !== next.sessions.length) mismatchFields.push('sessions.length');
  const sessionCount = Math.min(prev.sessions.length, next.sessions.length);
  for (let i = 0; i < sessionCount; i += 1) {
    const p = prev.sessions[i]!;
    const n = next.sessions[i]!;
    if ((p.stableKey ?? p.id) !== (n.stableKey ?? n.id)) mismatchFields.push(`sessions[${i}].stableKey`);
    if ((p.title ?? '') !== (n.title ?? '')) mismatchFields.push(`sessions[${i}].title`);
    if ((p.subtitle ?? '') !== (n.subtitle ?? '')) mismatchFields.push(`sessions[${i}].subtitle`);
    if ((p.paneLabel ?? '') !== (n.paneLabel ?? '')) mismatchFields.push(`sessions[${i}].paneLabel`);
    if ((p.hostKey ?? '') !== (n.hostKey ?? '')) mismatchFields.push(`sessions[${i}].hostKey`);
    if ((p.hostLabel ?? '') !== (n.hostLabel ?? '')) mismatchFields.push(`sessions[${i}].hostLabel`);
    if ((p.terminalBackend ?? '') !== (n.terminalBackend ?? '')) mismatchFields.push(`sessions[${i}].terminalBackend`);
    if ((p.sessionGroupSlot ?? '') !== (n.sessionGroupSlot ?? '')) mismatchFields.push(`sessions[${i}].sessionGroupSlot`);
    if (Boolean(p.remoteMissing) !== Boolean(n.remoteMissing)) mismatchFields.push(`sessions[${i}].remoteMissing`);
    if (Boolean(p.active) !== Boolean(n.active)) mismatchFields.push(`sessions[${i}].active`);
  }
  const prevHosts = prev.hosts ?? [];
  const nextHosts = next.hosts ?? [];
  if (prevHosts.length !== nextHosts.length) mismatchFields.push('hosts.length');
  const hostCount = Math.min(prevHosts.length, nextHosts.length);
  for (let i = 0; i < hostCount; i += 1) {
    const a = prevHosts[i]!;
    const b = nextHosts[i]!;
    if (a.hostKey !== b.hostKey) mismatchFields.push(`hosts[${i}].hostKey`);
    if (a.hostLabel !== b.hostLabel) mismatchFields.push(`hosts[${i}].hostLabel`);
  }
  const prevSelected = prev.previewSelectedSessionIds ?? [];
  const nextSelected = next.previewSelectedSessionIds ?? [];
  if (prevSelected.length !== nextSelected.length) mismatchFields.push('previewSelected.length');
  return mismatchFields.length === 0;
}

export const TerminalSessionDrawer = memo(
  TerminalSessionDrawerComponent,
  terminalSessionDrawerPropsEqual,
);
