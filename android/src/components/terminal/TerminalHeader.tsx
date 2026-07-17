import { memo, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { PaneTabs, resolvePaneProfile, type PaneTabDescriptor } from '@zterm/shared';
import { getServerColorTone } from '../../lib/server-color';
import { resolveTerminalOrientation } from '../../lib/terminal-viewport-metrics';

const DOUBLE_TAP_MS = 280;

export interface TerminalHeaderSessionItem {
  id: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  customName?: string;
  resolvedPath?: 'tailscale' | 'ipv6' | 'ipv4' | 'rtc-relay';
  resolvedRelayTransport?: 'direct' | 'turn';
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

export interface TerminalHeaderProps {
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
  onForceRelaySession?: (id: string) => void;
  onUseAutoSession?: (id: string) => void;
  splitVisible?: boolean;
  paneGroups?: TerminalHeaderPaneGroup[];
  onAssignSessionToPane?: (id: string, paneId: string) => void;
  onMoveSessionToOtherPane?: (id: string) => void;
  onActivatePane?: (paneId: string) => void;
}

function formatResolvedPath(
  path?: TerminalHeaderSessionItem['resolvedPath'],
  relayTransport?: TerminalHeaderSessionItem['resolvedRelayTransport'],
) {
  switch (path) {
    case 'tailscale':
      return 'TS';
    case 'ipv6':
      return 'IPv6';
    case 'ipv4':
      return 'IPv4';
    case 'rtc-relay':
      if (relayTransport === 'turn') {
        return 'TURN';
      }
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
  onForceRelaySession,
  onUseAutoSession,
  splitVisible = false,
  paneGroups,
  onAssignSessionToPane,
  onMoveSessionToOtherPane,
  onActivatePane,
}: TerminalHeaderProps) {
  const headerRootRef = useRef<HTMLDivElement | null>(null);
  const paneMenuRef = useRef<HTMLDivElement | null>(null);
  const tabTapRef = useRef<{ sessionId: string; timestamp: number } | null>(null);
  const [paneMenuState, setPaneMenuState] = useState<PaneMenuState | null>(null);
  const landscape = typeof window !== 'undefined' ? resolveTerminalOrientation() === 'landscape' : false;
  const paneProfile = resolvePaneProfile({ platform: 'phone', splitVisible, topInsetPx, landscape });

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
  const sessionPaneMap = new Map<string, { paneId: string; paneIndex: number }>();
  const sessionById = new Map<string, TerminalHeaderSessionItem>();
  resolvedPaneGroups.forEach((group, index) => {
    group.sessions.forEach((session) => {
      sessionPaneMap.set(session.id, { paneId: group.paneId, paneIndex: index });
      sessionById.set(session.id, session);
    });
  });

  const openPaneMenu = (sessionId: string, anchor?: { left: number; top: number }) => {
    setPaneMenuState({
      sessionId,
      anchorLeft: Math.max(8, Math.round(anchor?.left ?? (window.innerWidth * 0.5) - 82)),
      anchorTop: Math.max(8, Math.round(anchor?.top ?? 8)),
    });
  };

  const handleCloseTabIntent = (sessionId: string) => {
    closePaneMenu();
    onCloseSession(sessionId, 'terminal-header-close-button');
  };

  const renameSession = (session: TerminalHeaderSessionItem) => {
    if (!onRenameSession) {
      return;
    }
    const next = window.prompt('Rename tab', session.customName || session.sessionName);
    if (next !== null) {
      onRenameSession(session.id, next);
    }
  };

  const handleTabTap = (session: TerminalHeaderSessionItem, paneId: string) => {
    const now = Date.now();
    const previousTap = tabTapRef.current;
    closePaneMenu();
    if (splitVisible) {
      onActivatePane?.(paneId);
    }
    onSwitchSession(session.id);
    if (previousTap && previousTap.sessionId === session.id && now - previousTap.timestamp <= DOUBLE_TAP_MS) {
      tabTapRef.current = null;
      if (splitVisible) {
        openPaneMenu(session.id);
        return;
      }
      renameSession(session);
      return;
    }
    tabTapRef.current = { sessionId: session.id, timestamp: now };
  };

  useEffect(() => {
    if (!activeSession?.id) {
      return;
    }
    const activeTab = headerRootRef.current?.querySelector<HTMLElement>(`[data-tab-id="${activeSession.id}"]`);
    activeTab?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'auto' });
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

  return (
    <div
      ref={headerRootRef}
        style={{
          padding: paneProfile.header.outerPadding,
          display: splitVisible ? 'flex' : undefined,
          alignItems: splitVisible ? 'stretch' : undefined,
          gap: splitVisible ? paneProfile.stage.paneGap : undefined,
          width: splitVisible ? '100%' : undefined,
          boxSizing: splitVisible ? 'border-box' : undefined,
          backgroundColor: splitVisible ? 'rgba(11, 15, 24, 0.94)' : undefined,
          borderBottom: splitVisible ? '1px solid rgba(255,255,255,0.08)' : undefined,
        }}
    >
      {renderedPaneGroups.map((group, groupIndex) => {
        const resolvedGroupIndex = resolvedPaneGroups.findIndex((candidate) => candidate.paneId === group.paneId);
        const paneIndex = resolvedGroupIndex >= 0 ? resolvedGroupIndex : groupIndex;
        const tabs: PaneTabDescriptor[] = group.sessions.map((session) => {
          const active = splitVisible ? session.id === group.activeSessionId : session.id === activeSession?.id;
          const paneMeta = sessionPaneMap.get(session.id);
          return {
            id: session.id,
            title: session.sessionName,
            customName: session.customName,
            badge: `P${(paneMeta?.paneIndex ?? paneIndex) + 1}`,
            isActive: active,
            isResolvedRelay: session.resolvedPath === 'rtc-relay',
          };
        });
        return (
          <div
            key={group.paneId}
            data-testid={`terminal-header-pane-group-${group.paneId}`}
            style={{
              flex: `${Math.max(0.01, group.size ?? 1)} 1 0%`,
              minWidth: 0,
              borderRight:
                splitVisible && groupIndex < renderedPaneGroups.length - 1
                  ? '1px solid rgba(255,255,255,0.12)'
                  : undefined,
              paddingRight:
                splitVisible && groupIndex < renderedPaneGroups.length - 1
                  ? '3px'
                  : undefined,
              boxSizing: 'border-box',
            }}
          >
            <PaneTabs
              platform="phone"
              profile={{
                ...paneProfile,
                header: { ...paneProfile.header, outerPadding: '0px' },
              }}
              paneId={group.paneId}
              paneIndex={paneIndex}
              isActivePane={group.isActivePane}
              tabs={tabs}
              backButton={showBackButton && groupIndex === 0 ? { onBack } : undefined}
              plusButton={{
                onQuickNew: () => onOpenQuickTabPicker(splitVisible ? group.paneId : undefined),
                onOpenTabManager: () => onOpenTabManager(splitVisible ? group.paneId : undefined),
              }}
              onSelectTab={(sessionId) => {
                const session = sessionById.get(sessionId);
                if (session) {
                  handleTabTap(session, group.paneId);
                }
              }}
              onCloseTab={handleCloseTabIntent}
              onActivatePane={(paneId) => onActivatePane?.(paneId)}
              onLongPressTab={(sessionId, anchor) => {
                if (splitVisible) {
                  openPaneMenu(sessionId, anchor);
                }
              }}
              onRenameTab={(sessionId) => {
                const session = sessionById.get(sessionId);
                if (session) {
                  renameSession(session);
                }
              }}
              onForceRelay={(sessionId) => onForceRelaySession?.(sessionId)}
              onUseAuto={(sessionId) => onUseAutoSession?.(sessionId)}
              renderTabExtras={(tab) => renderTabExtras(
                sessionById.get(tab.id),
                tab.isActive,
                onForceRelaySession,
                onUseAutoSession,
              )}
            />
          </div>
        );
      })}
      {renderedPaneGroups.flatMap((group, groupIndex) => {
        const resolvedGroupIndex = resolvedPaneGroups.findIndex((candidate) => candidate.paneId === group.paneId);
        void groupIndex;
        void resolvedGroupIndex;
        return group.sessions.map((session) => {
          const active = splitVisible ? session.id === group.activeSessionId : session.id === activeSession?.id;
          const paneMeta = sessionPaneMap.get(session.id);
          const menuOpen = paneMenuState?.sessionId === session.id;
          if (!menuOpen) {
            return null;
          }
          return (
            <div
              key={`${group.paneId}:${session.id}:menu`}
              ref={paneMenuRef}
              style={{
                position: 'fixed',
                left: paneMenuState.anchorLeft,
                top: paneMenuState.anchorTop,
                zIndex: 9999,
                minWidth: '168px',
                borderRadius: '14px',
                padding: '8px',
                backgroundColor: 'rgba(16, 20, 30, 0.96)',
                border: '1px solid rgba(255,255,255,0.12)',
                boxShadow: '0 18px 40px rgba(0,0,0,0.42)',
                display: 'grid',
                gap: '6px',
              }}
            >
              {resolvedPaneGroups.length > 0 ? (
                <div style={{ display: 'grid', gap: '6px' }}>
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
        });
      })}
    </div>
  );
}

function renderTabExtras(
  session: TerminalHeaderSessionItem | undefined,
  active: boolean,
  onForceRelaySession: TerminalHeaderProps['onForceRelaySession'],
  onUseAutoSession: TerminalHeaderProps['onUseAutoSession'],
): ReactNode {
  if (!session || !active) {
    return null;
  }
  const resolvedPathLabel = formatResolvedPath(session.resolvedPath, session.resolvedRelayTransport);
  if (!resolvedPathLabel) {
    return null;
  }
  const tone = getServerColorTone(session);
  return (
    <button
      type="button"
      aria-label={session.resolvedPath === 'rtc-relay' ? '切回 Auto 重连当前 tab' : '强制 Relay 重连当前 tab'}
      tabIndex={-1}
      onFocus={(event) => event.currentTarget.blur()}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation();
        if (session.resolvedPath === 'rtc-relay') {
          onUseAutoSession?.(session.id);
          return;
        }
        onForceRelaySession?.(session.id);
      }}
      style={{
        position: 'absolute',
        right: '32px',
        top: '50%',
        transform: 'translateY(-50%)',
        zIndex: 2,
        minHeight: '18px',
        padding: '2px 6px',
        borderRadius: '999px',
        border: `1px solid ${tone.accentMuted}`,
        backgroundColor: tone.tabActiveBackground,
        color: tone.accent,
        fontSize: '9px',
        fontWeight: 900,
        lineHeight: 1.2,
        cursor: 'pointer',
      }}
    >
      {resolvedPathLabel}
    </button>
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

export const TerminalHeader = memo(TerminalHeaderComponent);
