import { memo, useEffect, useRef, useState } from 'react';
import { mobileTheme } from '../../lib/mobile-ui';
import { getServerColorTone } from '../../lib/server-color';
import { resolveTerminalLayoutProfile } from '../../lib/terminal-layout-profile';
import { resolveTerminalOrientation } from '../../lib/terminal-viewport-metrics';

const TAB_LONG_PRESS_MS = 920;
const PLUS_LONG_PRESS_MS = 680;
const DOUBLE_TAP_MS = 280;
const TAB_TOUCH_TAP_SLOP_PX = 12;

export interface TerminalHeaderSessionItem {
  id: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  customName?: string;
  resolvedPath?: 'tailscale' | 'ipv6' | 'ipv4' | 'rtc-relay';
}

export interface TerminalHeaderPaneGroup {
  paneId: string;
  size?: number;
  sessions: TerminalHeaderSessionItem[];
  activeSessionId: string | null;
  isActivePane: boolean;
}

interface PaneMenuState {
  sessionId: string;
  anchorLeft: number;
  anchorTop: number;
}

interface TerminalHeaderProps {
  sessions: TerminalHeaderSessionItem[];
  activeSession: TerminalHeaderSessionItem | null;
  topInsetPx?: number;
  showBackButton?: boolean;
  renderPaneIds?: string[];
  onBack: () => void;
  onOpenQuickTabPicker: (paneId?: string) => void;
  onOpenTabManager: (paneId?: string) => void;
  onSwitchSession: (id: string) => void;
  onRenameSession?: (id: string, name: string) => void;
  onCloseSession: (id: string, source?: string) => void;
  splitVisible?: boolean;
  paneGroups?: TerminalHeaderPaneGroup[];
  onAssignSessionToPane?: (id: string, paneId: string) => void;
  onMoveSessionToOtherPane?: (id: string) => void;
  onActivatePane?: (paneId: string) => void;
}

function formatResolvedPath(path?: TerminalHeaderSessionItem['resolvedPath']) {
  switch (path) {
    case 'tailscale':
      return 'TS';
    case 'ipv6':
      return 'IPv6';
    case 'ipv4':
      return 'IPv4';
    case 'rtc-relay':
      return 'Relay';
    default:
      return null;
  }
}

function TerminalHeaderComponent({
  sessions,
  activeSession,
  topInsetPx = 0,
  showBackButton = true,
  renderPaneIds,
  onBack,
  onOpenQuickTabPicker,
  onOpenTabManager,
  onSwitchSession,
  onRenameSession,
  onCloseSession,
  splitVisible = false,
  paneGroups,
  onAssignSessionToPane,
  onMoveSessionToOtherPane,
  onActivatePane,
}: TerminalHeaderProps) {
  const headerRootRef = useRef<HTMLDivElement | null>(null);
  const paneMenuRef = useRef<HTMLDivElement | null>(null);
  const tabTapRef = useRef<{ sessionId: string; timestamp: number } | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const plusLongPressTimerRef = useRef<number | null>(null);
  const plusLongPressTriggeredRef = useRef(false);
  const lastTouchCloseIntentRef = useRef<{ sessionId: string; at: number } | null>(null);
  const tabTouchGestureRef = useRef<{
    sessionId: string;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const suppressedTouchTabClickRef = useRef<{ sessionId: string; at: number } | null>(null);
  const [paneMenuState, setPaneMenuState] = useState<PaneMenuState | null>(null);
  const landscape = typeof window !== 'undefined' ? resolveTerminalOrientation() === 'landscape' : false;
  const layoutProfile = resolveTerminalLayoutProfile({ splitVisible, topInsetPx, landscape });

  const closePaneMenu = () => setPaneMenuState(null);
  const resolvedPaneGroups: TerminalHeaderPaneGroup[] = splitVisible && paneGroups?.length
    ? paneGroups
    : [{
        paneId: 'pane-main',
        size: 1,
        sessions,
        activeSessionId: activeSession?.id || null,
        isActivePane: true,
      }];
  const renderedPaneIdSet = renderPaneIds?.length ? new Set(renderPaneIds) : null;
  const visiblePaneGroups = renderedPaneIdSet
    ? resolvedPaneGroups.filter((group) => renderedPaneIdSet.has(group.paneId))
    : resolvedPaneGroups;
  const renderedPaneGroups = visiblePaneGroups.length > 0 ? visiblePaneGroups : resolvedPaneGroups;
  const sessionPaneMap = new Map<string, { paneId: string; paneIndex: number; paneLabel: string }>();
  resolvedPaneGroups.forEach((group, index) => {
    group.sessions.forEach((session) => {
      sessionPaneMap.set(session.id, {
        paneId: group.paneId,
        paneIndex: index,
        paneLabel: `Pane ${index + 1}`,
      });
    });
  });

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

  const openPaneMenu = (sessionId: string, anchorElement?: HTMLElement | null) => {
    const anchorRect = anchorElement?.getBoundingClientRect();
    longPressTriggeredRef.current = true;
    setPaneMenuState({
      sessionId,
      anchorLeft: Math.max(8, Math.round(anchorRect?.left ?? (window.innerWidth * 0.5) - 82)),
      anchorTop: Math.max(8, Math.round((anchorRect?.bottom ?? 0) + 6)),
    });
  };

  const handleCloseTabIntent = (sessionId: string) => {
    closePaneMenu();
    onCloseSession(sessionId, 'terminal-header-close-button');
  };

  const startTabLongPress = (sessionId: string, anchorElement?: HTMLElement | null) => {
    clearLongPress();
    longPressTriggeredRef.current = false;
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTriggeredRef.current = true;
      if (splitVisible) {
        openPaneMenu(sessionId, anchorElement);
      }
    }, TAB_LONG_PRESS_MS);
  };

  const endTabLongPress = () => {
    clearLongPress();
  };

  const startPlusLongPress = (paneId?: string) => {
    clearPlusLongPress();
    plusLongPressTriggeredRef.current = false;
    plusLongPressTimerRef.current = window.setTimeout(() => {
      plusLongPressTriggeredRef.current = true;
      onOpenTabManager(paneId);
    }, PLUS_LONG_PRESS_MS);
  };

  const endPlusLongPress = () => {
    clearPlusLongPress();
  };

  const handleTabTap = (session: TerminalHeaderSessionItem, anchorElement?: HTMLElement | null) => {
    const now = Date.now();
    const previousTap = tabTapRef.current;
    closePaneMenu();
    onSwitchSession(session.id);
    if (previousTap && previousTap.sessionId === session.id && now - previousTap.timestamp <= DOUBLE_TAP_MS) {
      tabTapRef.current = null;
      if (splitVisible) {
        openPaneMenu(session.id, anchorElement);
        return;
      }
      if (onRenameSession) {
        const next = window.prompt('Rename tab', session.customName || session.sessionName);
        if (next !== null) {
          onRenameSession(session.id, next);
        }
      }
      return;
    }
    tabTapRef.current = { sessionId: session.id, timestamp: now };
  };

  useEffect(() => {
    if (!activeSession?.id) {
      return;
    }
    const activeTab = headerRootRef.current?.querySelector<HTMLElement>(`[data-session-id="${activeSession.id}"]`);
    activeTab?.scrollIntoView({
      inline: 'center',
      block: 'nearest',
      behavior: 'auto',
    });
  }, [activeSession?.id]);

  useEffect(() => {
    if (!paneMenuState) {
      return;
    }
    const closeIfOutside = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && paneMenuRef.current?.contains(target)) {
        return;
      }
      closePaneMenu();
    };
    document.addEventListener('pointerdown', closeIfOutside, true);
    window.addEventListener('resize', closeIfOutside, true);
    window.addEventListener('scroll', closeIfOutside, true);
    return () => {
      document.removeEventListener('pointerdown', closeIfOutside, true);
      window.removeEventListener('resize', closeIfOutside, true);
      window.removeEventListener('scroll', closeIfOutside, true);
    };
  }, [paneMenuState]);

  useEffect(() => () => {
    clearLongPress();
    clearPlusLongPress();
  }, []);

  return (
    <div
      style={{
        padding: layoutProfile.header.outerPadding,
      }}
    >
      <div
        ref={headerRootRef}
        style={{ display: 'flex', alignItems: 'stretch', gap: layoutProfile.header.rowGap, marginTop: 0 }}
      >
        {showBackButton ? (
          <button
            onClick={onBack}
            tabIndex={-1}
            onFocus={(event) => event.currentTarget.blur()}
            style={{
              width: layoutProfile.header.backButtonSize,
              height: layoutProfile.header.backButtonSize,
              borderRadius: layoutProfile.header.backButtonRadius,
              border: 'none',
              outline: 'none',
              backgroundColor: mobileTheme.colors.shellMuted,
              color: mobileTheme.colors.textPrimary,
              fontSize: layoutProfile.header.backButtonFontSize,
              cursor: 'pointer',
              flexShrink: 0,
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            ‹
          </button>
        ) : null}

        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'stretch',
            gap: layoutProfile.header.paneGap,
          }}
        >
          {renderedPaneGroups.map((group, groupIndex) => {
            const resolvedGroupIndex = resolvedPaneGroups.findIndex((candidate) => candidate.paneId === group.paneId);
            const paneIndex = resolvedGroupIndex >= 0 ? resolvedGroupIndex : groupIndex;
            const paneTitle = `Pane ${paneIndex + 1}`;
            return (
              <div
                key={group.paneId}
                onPointerDown={() => onActivatePane?.(group.paneId)}
                style={{
                  flex: `${Math.max(0.01, group.size ?? 1)} 1 0%`,
                  minWidth: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: layoutProfile.header.paneGap,
                  padding: layoutProfile.header.panePadding,
                  borderRadius: layoutProfile.header.paneRadius,
                  border: splitVisible
                    ? `1px solid ${group.isActivePane ? 'rgba(83, 139, 255, 0.38)' : 'rgba(255,255,255,0.06)'}`
                    : 'none',
                  backgroundColor: splitVisible
                    ? (group.isActivePane ? 'rgba(19, 28, 43, 0.92)' : 'rgba(16, 21, 31, 0.82)')
                    : 'transparent',
                }}
              >
                {splitVisible ? (
                  <span
                    style={{
                      minWidth: layoutProfile.header.paneBadgeMinWidth,
                      height: layoutProfile.header.paneBadgeHeight,
                      borderRadius: '999px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: '0 6px',
                      fontSize: '9px',
                      fontWeight: 900,
                      backgroundColor: group.isActivePane ? 'rgba(113, 164, 255, 0.16)' : 'rgba(255,255,255,0.06)',
                      color: group.isActivePane ? '#8db7ff' : 'rgba(231,238,252,0.72)',
                      flexShrink: 0,
                      lineHeight: 1,
                      letterSpacing: '0.01em',
                    }}
                    title={paneTitle}
                  >
                    {`P${paneIndex + 1}`}
                  </span>
                ) : null}
                <div
                  tabIndex={-1}
                  onFocus={(event) => event.currentTarget.blur()}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: layoutProfile.header.paneGap,
                    overflowX: 'auto',
                    overflowY: 'hidden',
                    scrollbarWidth: 'none',
                    WebkitOverflowScrolling: 'touch',
                    touchAction: 'manipulation',
                    WebkitTapHighlightColor: 'transparent',
                    outline: 'none',
                    boxShadow: 'none',
                    userSelect: 'none',
                    minHeight: layoutProfile.header.paneScrollerMinHeight,
                  }}
                >
                  {group.sessions.map((session) => {
                    const active = splitVisible
                      ? session.id === group.activeSessionId
                      : session.id === activeSession?.id;
                    const tone = getServerColorTone(session);
                    const paneMeta = sessionPaneMap.get(session.id);
                    const paneLabel = `P${(paneMeta?.paneIndex ?? paneIndex) + 1}`;
                    const resolvedPathLabel = formatResolvedPath(session.resolvedPath);
                    const menuOpen = paneMenuState?.sessionId === session.id;
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
                          onMouseDown={(event) => startTabLongPress(session.id, event.currentTarget)}
                          onMouseUp={endTabLongPress}
                          onMouseLeave={endTabLongPress}
                          onTouchStart={(event) => {
                            if (event.touches.length >= 2 && active) {
                              event.preventDefault();
                              openPaneMenu(session.id, event.currentTarget);
                              return;
                            }
                            const touch = event.touches[0];
                            tabTouchGestureRef.current = touch ? {
                              sessionId: session.id,
                              startX: touch.clientX,
                              startY: touch.clientY,
                              moved: false,
                            } : null;
                            startTabLongPress(session.id, event.currentTarget);
                          }}
                          onTouchMove={(event) => {
                            const gesture = tabTouchGestureRef.current;
                            const touch = event.touches[0];
                            if (!gesture || !touch || gesture.sessionId !== session.id) {
                              return;
                            }
                            if (gesture.moved) {
                              return;
                            }
                            if (Math.hypot(touch.clientX - gesture.startX, touch.clientY - gesture.startY) < TAB_TOUCH_TAP_SLOP_PX) {
                              return;
                            }
                            gesture.moved = true;
                            endTabLongPress();
                          }}
                          onTouchEnd={() => {
                            const gesture = tabTouchGestureRef.current;
                            endTabLongPress();
                            if (gesture?.sessionId === session.id && gesture.moved) {
                              suppressedTouchTabClickRef.current = {
                                sessionId: session.id,
                                at: Date.now(),
                              };
                            }
                            tabTouchGestureRef.current = null;
                          }}
                          onTouchCancel={() => {
                            endTabLongPress();
                            tabTouchGestureRef.current = null;
                          }}
                          onClick={(event) => {
                            if (longPressTriggeredRef.current) {
                              longPressTriggeredRef.current = false;
                              return;
                            }
                            const suppressedTouchClick = suppressedTouchTabClickRef.current;
                            if (
                              suppressedTouchClick
                              && suppressedTouchClick.sessionId === session.id
                              && Date.now() - suppressedTouchClick.at < 600
                            ) {
                              return;
                            }
                            if (splitVisible) {
                              onActivatePane?.(group.paneId);
                            }
                            handleTabTap(session, event.currentTarget);
                          }}
                          style={{
                            flexShrink: 0,
                            minWidth: active ? layoutProfile.header.tabMinWidthActive : layoutProfile.header.tabMinWidthIdle,
                            maxWidth: active ? layoutProfile.header.tabMaxWidthActive : layoutProfile.header.tabMaxWidthIdle,
                            minHeight: layoutProfile.header.tabMinHeight,
                            borderRadius: layoutProfile.header.tabRadius,
                            outline: 'none',
                            border: `1px solid ${tone.accentMuted}`,
                            backgroundColor: active ? tone.tabActiveBackground : tone.tabIdleBackground,
                            color: active ? tone.accent : mobileTheme.colors.textPrimary,
                            fontSize: layoutProfile.header.tabFontSize,
                            fontWeight: 800,
                            padding: active
                              ? layoutProfile.header.tabActivePadding
                              : layoutProfile.header.tabIdlePadding,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            WebkitTapHighlightColor: 'transparent',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                          }}
                          title={splitVisible
                            ? 'Tap: switch · Long press tab: pane menu · Two-finger tap current tab: move menu'
                            : 'Tap: switch'}
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
                                backgroundColor: group.isActivePane ? 'rgba(113, 164, 255, 0.18)' : 'rgba(31, 214, 122, 0.18)',
                                color: group.isActivePane ? '#8db7ff' : mobileTheme.colors.accent,
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
                            aria-label="关闭当前 tab"
                            tabIndex={-1}
                            onFocus={(event) => event.currentTarget.blur()}
                            onMouseDown={(event) => event.preventDefault()}
                            onTouchEnd={(event) => { endTabLongPress();
                              event.stopPropagation();
                              event.preventDefault();
                              lastTouchCloseIntentRef.current = { sessionId: session.id, at: Date.now() };
                              handleCloseTabIntent(session.id);
                            }}
                            onClick={(event) => {
                              event.stopPropagation();
                              const recentTouch = lastTouchCloseIntentRef.current;
                              if (
                                recentTouch
                                && recentTouch.sessionId === session.id
                                && Date.now() - recentTouch.at < 600
                              ) {
                                return;
                              }
                              handleCloseTabIntent(session.id);
                            }}
                            style={{
                              position: 'absolute',
                              top: '50%',
                              right: layoutProfile.header.closeButtonRight,
                              transform: 'translateY(-50%)',
                              width: splitVisible ? '20px' : '20px',
                              height: splitVisible ? '20px' : '20px',
                              borderRadius: '999px',
                              border: 'none',
                              outline: 'none',
                              padding: 0,
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              backgroundColor: 'rgba(255,255,255,0.14)',
                              color: active ? tone.accent : mobileTheme.colors.textPrimary,
                              fontSize: '13px',
                              lineHeight: 1,
                              fontWeight: 900,
                              zIndex: 2,
                              WebkitTapHighlightColor: 'transparent',
                              opacity: 0.9,
                              pointerEvents: 'auto',
                            }}
                          >
                            ×
                          </button>
                        ) : null}
                        {menuOpen ? (
                          <div
                            ref={paneMenuRef}
                            onPointerDown={(event) => event.stopPropagation()}
                            style={{
                              position: 'fixed',
                              top: `${paneMenuState?.anchorTop ?? 0}px`,
                              left: `${paneMenuState?.anchorLeft ?? 0}px`,
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
                            {resolvedPaneGroups.map((targetGroup, targetIndex) => {
                              const currentPaneId = paneMeta?.paneId || group.paneId;
                              const targetActive = targetGroup.paneId === currentPaneId;
                              return (
                                <button
                                  key={targetGroup.paneId}
                                  type="button"
                                  onClick={() => {
                                    if (targetActive) {
                                      closePaneMenu();
                                      return;
                                    }
                                    onAssignSessionToPane?.(session.id, targetGroup.paneId);
                                    closePaneMenu();
                                  }}
                                  style={paneMenuButtonStyle(targetActive)}
                                >
                                  {targetActive ? `当前在 P${targetIndex + 1}` : `移到 P${targetIndex + 1}`}
                                </button>
                              );
                            })}
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
                {splitVisible ? (
                  <button
                    type="button"
                    aria-label={`${paneTitle} 新建 tab`}
                    tabIndex={-1}
                    onFocus={(event) => event.currentTarget.blur()}
                    onMouseDown={() => startPlusLongPress(group.paneId)}
                    onMouseUp={endPlusLongPress}
                    onMouseLeave={endPlusLongPress}
                    onTouchStart={() => startPlusLongPress(group.paneId)}
                    onTouchEnd={endPlusLongPress}
                    onTouchCancel={endPlusLongPress}
                    onClick={(event) => {
                      if (plusLongPressTriggeredRef.current) {
                        plusLongPressTriggeredRef.current = false;
                        return;
                      }
                      event.stopPropagation();
                      onOpenQuickTabPicker(group.paneId);
                    }}
                    style={plusButtonStyle(layoutProfile)}
                    title="Tap: quick new tab · Long press: pane tab manager"
                  >
                    +
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>

        {!splitVisible ? (
          <button
            onMouseDown={() => startPlusLongPress()}
            onMouseUp={endPlusLongPress}
            onMouseLeave={endPlusLongPress}
            onTouchStart={() => startPlusLongPress()}
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
            style={plusButtonStyle(layoutProfile)}
            title="Tap: quick new tab · Long press: tab manager"
          >
            +
          </button>
        ) : null}
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

function plusButtonStyle(layoutProfile: ReturnType<typeof resolveTerminalLayoutProfile>) {
  return {
    width: layoutProfile.header.plusButtonSize,
    height: layoutProfile.header.plusButtonSize,
    borderRadius: layoutProfile.header.plusButtonRadius,
    border: 'none',
    outline: 'none',
    backgroundColor: mobileTheme.colors.shellMuted,
    color: mobileTheme.colors.textPrimary,
    fontSize: layoutProfile.header.plusButtonFontSize,
    cursor: 'pointer',
    flexShrink: 0,
    WebkitTapHighlightColor: 'transparent',
  } as const;
}

export const TerminalHeader = memo(TerminalHeaderComponent);
