import { useEffect, useMemo, useRef, useState } from 'react';
import { ConnectionCard } from '../components/connections/ConnectionCard';
import { ConnectionFab } from '../components/connections/ConnectionFab';
import { ConnectionsBottomNav } from '../components/connections/ConnectionsBottomNav';
import { ConnectionsHeader } from '../components/connections/ConnectionsHeader';
import { buildConnectionsServerGroups, type ServerGroupView } from '../lib/connections-server-groups';
import { mobileTheme } from '../lib/mobile-ui';
import { readTraversalRelayAccountState } from '../lib/traversal-relay-client';
import { getServerIdentityTone } from '../lib/server-identity';
import { sessionSemanticOwnersMatch } from '../lib/session-semantic-identity';
import { type BridgeSettings } from '../lib/bridge-settings';
import type { Host, Session, SessionGroupHistory, TraversalRelayDeviceSnapshot } from '../lib/types';
import type { RelayEndpointCandidate } from '@zterm/shared/relay-directory';
import type { TraversalRouteHealthCache } from '../lib/traversal/route-health-cache';

interface ConnectionsGroupTarget {
  bridgeHost: string;
  bridgePort: number;
  daemonHostId?: string;
  authToken?: string;
  relayEndpointCandidates?: RelayEndpointCandidate[];
}

interface ConnectionsPageProps {
  bridgeSettings?: Pick<BridgeSettings, 'traversalPathPriority'>;
  routeHealthCache?: Pick<TraversalRouteHealthCache, 'get' | 'list'>;
  hosts: Host[];
  sessions: Session[];
  sessionGroups: SessionGroupHistory[];
  relayDevices?: TraversalRelayDeviceSnapshot[];
  onResumeSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string, source?: string) => void;
  onOpenGroupSession: (group: ConnectionsGroupTarget, sessionName: string) => void;
  onEditServerGroup: (group: ConnectionsGroupTarget, sessionNames: string[]) => void;
  onSaveServerGroupSelection: (group: ConnectionsGroupTarget, sessionNames: string[]) => void;
  onDeleteServerGroup: (group: { bridgeHost: string; bridgePort: number; daemonHostId?: string }) => void;
  onOpenServerGroups: (groups: Array<{
    name: string;
    bridgeHost: string;
    bridgePort: number;
    daemonHostId?: string;
    authToken?: string;
    relayEndpointCandidates?: RelayEndpointCandidate[];
    sessionNames: string[];
  }>) => void;
  onEdit: (host: Host) => void;
  onDelete: (host: Host) => void;
  onAddNew?: () => void;
  onOpenVaults?: () => void;
  onOpenSettings: () => void;
}

function getGroupDisplayName(group: Pick<ServerGroupView, 'daemonHostId' | 'bridgeHost'>) {
  return group.daemonHostId?.trim() || group.bridgeHost;
}

function getGroupTitleName(group: ServerGroupView) {
  return group.relayDeviceTruth && group.name.trim() ? group.name : getGroupDisplayName(group);
}

function getSessionCountLabel(count: number) {
  return count === 1 ? '1 session' : `${count} sessions`;
}

function getRouteSummaryLabel(group: ServerGroupView) {
  const routeDiagnostics = group.routeDiagnostics;
  if (!routeDiagnostics) {
    return null;
  }
  const parts = [routeDiagnostics.badge];
  if (routeDiagnostics.selectedRttLabel) {
    parts.push(`RTT ${routeDiagnostics.selectedRttLabel}`);
  }
  if (routeDiagnostics.lastSuccessLabel) {
    parts.push(`last success ${routeDiagnostics.lastSuccessLabel}`);
  }
  if (routeDiagnostics.lastErrorLabel) {
    parts.push(`last error ${routeDiagnostics.lastErrorLabel}`);
  }
  return parts.join(' · ');
}

function getDaemonSubtitle(group: ServerGroupView) {
  const status = group.daemonConnected === false ? 'offline' : group.daemonConnected ? 'online' : 'saved';
  const version = group.daemonVersion?.trim() ? ` · daemon ${group.daemonVersion.trim()}` : '';
  if (group.bridgeHost && group.bridgePort) {
    return `${status}${version} · ${group.bridgeHost}:${group.bridgePort}`;
  }
  return `${status}${version}`;
}

function formatRelative(ts?: number) {
  if (!ts) return 'Never connected';
  const diff = Date.now() - ts;
  const minutes = Math.max(1, Math.floor(diff / 60000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}

export function ConnectionsPage({
  bridgeSettings,
  routeHealthCache,
  hosts,
  sessions,
  sessionGroups,
  relayDevices = [],
  onResumeSession,
  onCloseSession,
  onOpenGroupSession,
  onEditServerGroup,
  onSaveServerGroupSelection,
  onDeleteServerGroup,
  onOpenServerGroups,
  onEdit,
  onDelete,
  onAddNew,
  onOpenVaults,
  onOpenSettings,
}: ConnectionsPageProps) {
  const [expandedGroupIds, setExpandedGroupIds] = useState<string[]>([]);
  const [selectedSessionsByGroup, setSelectedSessionsByGroup] = useState<Record<string, string[]>>({});
  const [vaultNoticeVisible, setVaultNoticeVisible] = useState(false);
  const relayAccount = readTraversalRelayAccountState();
  const serverGroups = useMemo(() => buildConnectionsServerGroups({
    hosts,
    sessions,
    sessionGroups,
    relayDevices,
    accountId: relayAccount?.user?.id,
    traversalPathPriority: bridgeSettings?.traversalPathPriority,
    routeHealthCache,
  }), [bridgeSettings?.traversalPathPriority, hosts, relayAccount?.user?.id, relayDevices, routeHealthCache, sessionGroups, sessions]);
  const previousServerGroupsRef = useRef<ServerGroupView[]>(serverGroups);

  useEffect(() => {
    const previousGroups = previousServerGroupsRef.current;
    previousServerGroupsRef.current = serverGroups;
    if (previousGroups === serverGroups || previousGroups.length === 0 || serverGroups.length === 0) {
      return;
    }

    const remapGroupId = (groupId: string) => {
      const nextBySameId = serverGroups.find((group) => group.id === groupId);
      if (nextBySameId) {
        return nextBySameId.id;
      }
      const previousGroup = previousGroups.find((group) => group.id === groupId);
      if (!previousGroup) {
        return null;
      }
      const semanticMatch = serverGroups.find((group) => sessionSemanticOwnersMatch(group, previousGroup));
      return semanticMatch?.id || null;
    };

    setExpandedGroupIds((current) => {
      const remapped = current
        .map(remapGroupId)
        .filter((groupId): groupId is string => typeof groupId === 'string' && groupId.length > 0);
      return remapped.length === current.length
        && remapped.every((groupId, index) => groupId === current[index])
        ? current
        : [...new Set(remapped)];
    });

    setSelectedSessionsByGroup((current) => {
      let changed = false;
      const next: Record<string, string[]> = {};
      Object.entries(current).forEach(([groupId, sessionNames]) => {
        const nextGroupId = remapGroupId(groupId);
        if (!nextGroupId) {
          changed = true;
          return;
        }
        if (nextGroupId !== groupId || next[nextGroupId]) {
          changed = true;
        }
        next[nextGroupId] = next[nextGroupId]
          ? [...new Set([...next[nextGroupId]!, ...sessionNames])]
          : [...sessionNames];
      });
      return changed ? next : current;
    });
  }, [serverGroups]);

  const toggleGroupExpanded = (groupId: string) => {
    setExpandedGroupIds((current) =>
      current.includes(groupId) ? current.filter((item) => item !== groupId) : [...current, groupId],
    );
  };

  const ensureGroupSelection = (group: ServerGroupView) => {
    setSelectedSessionsByGroup((current) =>
      current[group.id]
        ? current
        : {
            ...current,
            [group.id]: [...group.defaultSessionNames],
          },
    );
  };

  const openGroupEditor = (group: ServerGroupView) => {
    ensureGroupSelection(group);
    setExpandedGroupIds((current) => (current.includes(group.id) ? current : [...current, group.id]));
  };

  const updateGroupSelection = (group: ServerGroupView, nextSelected: string[]) => {
    setSelectedSessionsByGroup((current) => ({
      ...current,
      [group.id]: nextSelected,
    }));
    onSaveServerGroupSelection(group, nextSelected);
  };

  const toggleGroupSessionSelection = (group: ServerGroupView, sessionName: string) => {
    setSelectedSessionsByGroup((current) => {
      const selected = current[group.id] || [];
      const nextSelected = selected.includes(sessionName)
        ? selected.filter((item) => item !== sessionName)
        : [...selected, sessionName];
      onSaveServerGroupSelection(group, nextSelected);
      return { ...current, [group.id]: nextSelected };
    });
  };

  const selectedServerGroups = useMemo(() => {
    return serverGroups
      .map((group) => ({
        group,
        sessionNames: selectedSessionsByGroup[group.id] || [],
      }))
      .filter((entry) => entry.sessionNames.length > 0);
  }, [selectedSessionsByGroup, serverGroups]);

  const selectedGroupCount = selectedServerGroups.length;
  const selectedSessionCount = selectedServerGroups.reduce((sum, entry) => sum + entry.sessionNames.length, 0);
  const managementMode = expandedGroupIds.length > 0 || selectedGroupCount > 0;

  const selectAllServerGroups = () => {
    const nextSelection: Record<string, string[]> = {};
    const nextExpanded: string[] = [];
    serverGroups.forEach((group) => {
      const sessionNames = group.openableSessions.length > 0
        ? group.openableSessions
        : group.defaultSessionNames;
      nextSelection[group.id] = [...sessionNames];
      nextExpanded.push(group.id);
      onSaveServerGroupSelection(group, sessionNames);
    });
    setSelectedSessionsByGroup(nextSelection);
    setExpandedGroupIds(nextExpanded);
  };

  const clearAllServerGroups = () => {
    serverGroups.forEach((group) => onSaveServerGroupSelection(group, []));
    setSelectedSessionsByGroup({});
    setExpandedGroupIds([]);
  };

  const exitManagementMode = () => {
    setExpandedGroupIds([]);
    setSelectedSessionsByGroup({});
  };

  const handleOpenVaults = () => {
    onOpenVaults?.();
    setVaultNoticeVisible(true);
  };

  const openSelectedServerGroups = () => {
    const groupsToOpen: Array<{
      name: string;
      bridgeHost: string;
      bridgePort: number;
      daemonHostId?: string;
      authToken?: string;
      relayEndpointCandidates?: RelayEndpointCandidate[];
      sessionNames: string[];
    }> = [];
    let firstLiveSessionId: string | null = null;

    selectedServerGroups.forEach(({ group, sessionNames }) => {
      const liveNames = new Set(group.liveSessions.map((session) => session.sessionName));
      const nonLiveSessionNames = sessionNames.filter((sessionName) => !liveNames.has(sessionName));
      if (!firstLiveSessionId) {
        firstLiveSessionId = group.sessions.find((entry) => sessionNames.includes(entry.sessionName) && entry.liveSession)?.liveSession?.id || null;
      }
      if (nonLiveSessionNames.length === 0) {
        return;
      }
      const target = resolveGroupBridgeTarget(group);
      groupsToOpen.push({
        name: `${getGroupTitleName(group)} · ${getSessionCountLabel(nonLiveSessionNames.length)}`,
        bridgeHost: target.bridgeHost,
        bridgePort: target.bridgePort,
        daemonHostId: group.daemonHostId,
        authToken: target.authToken,
        relayEndpointCandidates: target.relayEndpointCandidates,
        sessionNames: nonLiveSessionNames,
      });
    });

    if (groupsToOpen.length > 0) {
      onOpenServerGroups(groupsToOpen);
      return;
    }
    if (firstLiveSessionId) {
      onResumeSession(firstLiveSessionId);
    }
  };

  const resolveGroupBridgeTarget = (group: ServerGroupView): ConnectionsGroupTarget => {
    if (group.bridgeHost && group.bridgePort) {
      return { bridgeHost: group.bridgeHost, bridgePort: group.bridgePort, authToken: group.authToken, relayEndpointCandidates: group.relayEndpointCandidates };
    }
    if (group.daemonHostId) {
      const matchedHost = hosts.find(
        (h) => (h.daemonHostId || h.relayHostId || '').trim().toLowerCase() === group.daemonHostId!.trim().toLowerCase()
      );
      if (matchedHost) {
        return {
          bridgeHost: matchedHost.bridgeHost,
          bridgePort: matchedHost.bridgePort,
          authToken: matchedHost.authToken || group.authToken,
          relayEndpointCandidates: group.relayEndpointCandidates || matchedHost.relayEndpointCandidates,
        };
      }
    }
    return {
      bridgeHost: group.bridgeHost || group.daemonHostId || '',
      bridgePort: group.bridgePort || 0,
      daemonHostId: group.daemonHostId,
      authToken: group.authToken,
      relayEndpointCandidates: group.relayEndpointCandidates,
    };
  };

  const openGroupSessionPicker = (group: ServerGroupView, sessionNames: string[]) => {
    const target = resolveGroupBridgeTarget(group);
    onEditServerGroup(
      {
        bridgeHost: target.bridgeHost,
        bridgePort: target.bridgePort,
        daemonHostId: group.daemonHostId || target.daemonHostId,
        authToken: target.authToken,
        relayEndpointCandidates: target.relayEndpointCandidates,
      },
      sessionNames,
    );
  };

  return (
    <div
      data-testid="connections-scroll"
      style={{
        minHeight: '100dvh',
        maxHeight: '100dvh',
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: mobileTheme.colors.lightBg,
        color: mobileTheme.colors.lightText,
      }}
    >
      <div
        style={{
          padding: `${mobileTheme.safeArea.top} 18px ${managementMode ? 168 : 124}px`,
          display: 'flex',
          flexDirection: 'column',
          gap: '22px',
        }}
      >
        <ConnectionsHeader subtitle="Grouped by daemon first. Tap to open, long-press to choose sessions." />

        {serverGroups.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
              <div style={{ fontSize: '14px', fontWeight: 800, color: mobileTheme.colors.lightMuted }}>SERVERS</div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={selectAllServerGroups}
                  style={{
                    border: 'none',
                    borderRadius: '999px',
                    padding: '7px 10px',
                    backgroundColor: 'rgba(16,18,24,0.08)',
                    color: mobileTheme.colors.lightText,
                    fontSize: '12px',
                    fontWeight: 800,
                  }}
                >
                  All servers
                </button>
                <button
                  type="button"
                  onClick={clearAllServerGroups}
                  style={{
                    border: 'none',
                    borderRadius: '999px',
                    padding: '7px 10px',
                    backgroundColor: 'rgba(16,18,24,0.06)',
                    color: mobileTheme.colors.lightMuted,
                    fontSize: '12px',
                    fontWeight: 800,
                  }}
                >
                  Clear
                </button>
                {managementMode && (
                  <button
                    type="button"
                    onClick={exitManagementMode}
                    style={{
                      border: 'none',
                      borderRadius: '999px',
                      padding: '7px 10px',
                      backgroundColor: mobileTheme.colors.shell,
                      color: mobileTheme.colors.accent,
                      fontSize: '12px',
                      fontWeight: 800,
                    }}
                  >
                    Done
                  </button>
                )}
              </div>
            </div>
            {serverGroups.map((group) => {
              const expanded = expandedGroupIds.includes(group.id);
              const selectedSessions = selectedSessionsByGroup[group.id] || [];
              const hasExplicitSelection = Object.prototype.hasOwnProperty.call(selectedSessionsByGroup, group.id);
              const isOpen = group.liveSessions.length > 0;
              const isFullyOpen = group.liveSessions.length === group.sessions.length;
              const missingSessions = group.sessions.filter((entry) => entry.missingFromRemoteTruth);
              const actionSessionNames = (hasExplicitSelection ? selectedSessions : group.defaultSessionNames)
                .filter((sessionName) => group.openableSessions.includes(sessionName));
              const canOpenGroup = actionSessionNames.length > 0;
              const missingSessionCount = missingSessions.length;
              const missingSessionLabel = missingSessionCount > 0
                ? `${missingSessionCount} missing`
                : null;
              const routeSummaryLabel = getRouteSummaryLabel(group);
              const routeBadge = group.routeDiagnostics?.badge || null;
              const tone = getServerIdentityTone({
                daemonHostId: group.daemonHostId,
                bridgeHost: group.bridgeHost,
                bridgePort: group.bridgePort,
                connectionName: getGroupTitleName(group),
              });
              const previewParts = missingSessionCount > 0
                ? [`${missingSessionLabel}`, 'review and close stale sessions']
                : routeSummaryLabel
                  ? [routeSummaryLabel]
                  : isOpen
                    ? [`Live now`, `${group.liveSessions.length}/${group.sessions.length} sessions open`]
                    : group.savedCount > 0
                      ? [`Saved ${getSessionCountLabel(group.savedCount)}`, `last active ${formatRelative(group.lastOpenedAt)}`]
                      : group.sessions.length > 0
                        ? [`History only`, `last active ${formatRelative(group.lastOpenedAt)}`]
                        : [`No sessions reported`, `last seen ${formatRelative(Date.parse(group.daemonLastSeenAt || '') || 0)}`];
              return (
                <div key={group.id} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <ConnectionCard
                    title={`${getGroupTitleName(group)} · ${getSessionCountLabel(group.sessions.length)}`}
                    subtitle={getDaemonSubtitle(group)}
                    preview={previewParts.join(' · ')}
                    accentLabel={
                      missingSessionCount > 0
                        ? `${missingSessionLabel} · review`
                        : routeBadge
                          ? `${routeBadge}${group.routeDiagnostics?.selectedRttLabel ? ` · ${group.routeDiagnostics.selectedRttLabel}` : ''}`
                        : expanded
                        ? `${actionSessionNames.length} selected · ${canOpenGroup ? (isFullyOpen ? 'ready' : isOpen ? 'partial' : 'restore') : 'history-only'}`
                        : `${group.savedCount || group.sessions.length} default · ${canOpenGroup ? (isFullyOpen ? 'ready' : isOpen ? 'partial' : 'restore') : 'history-only'}`
                    }
                    icon="◫"
                    tone={tone}
                    actionLabel="Sessions"
                    secondaryLabel={expanded ? '−' : '+'}
                    secondaryAriaLabel={`${expanded ? 'Collapse' : 'Expand'} ${getGroupTitleName(group)} sessions`}
                    onPrimaryAction={() => {
                      if (missingSessionCount > 0) {
                        if (!expanded) {
                          ensureGroupSelection(group);
                        }
                        toggleGroupExpanded(group.id);
                        return;
                      }
                      openGroupSessionPicker(group, actionSessionNames);
                    }}
                    onActionButton={() => {
                      openGroupSessionPicker(group, actionSessionNames);
                    }}
                    onSecondaryAction={() => {
                      if (!expanded) {
                        ensureGroupSelection(group);
                      }
                      toggleGroupExpanded(group.id);
                    }}
                    onLongPress={() => openGroupEditor(group)}
                  />

                  {expanded && (
                    <div
                      style={{
                        borderRadius: '18px',
                        backgroundColor: '#ffffff',
                        padding: '10px',
                        boxShadow: mobileTheme.shadow.soft,
                        border: `1px solid ${tone.lightCardBorder}`,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                      }}
                    >
                      {group.sessions.map((entry) => {
                        const checked = selectedSessions.includes(entry.sessionName);
                        const statusLabel = entry.missingFromRemoteTruth
                          ? 'Missing on daemon'
                          : entry.liveSession
                          ? `Open · ${entry.liveSession.state}`
                          : entry.source === 'saved'
                            ? 'Saved in this server'
                            : entry.source === 'history'
                              ? 'History in this server'
                              : 'Live-only session';
                        return (
                          <div
                            key={entry.id}
                            style={{
                              width: '100%',
                              borderRadius: '14px',
                              padding: '12px 14px',
                              backgroundColor: entry.missingFromRemoteTruth ? '#eef1f5' : entry.liveSession ? tone.accentSoft : '#f6f8fb',
                              color: entry.missingFromRemoteTruth ? mobileTheme.colors.lightMuted : mobileTheme.colors.lightText,
                              textAlign: 'left',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: '12px',
                              cursor: 'default',
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={entry.missingFromRemoteTruth}
                                onChange={() => toggleGroupSessionSelection(group, entry.sessionName)}
                                onClick={(event) => event.stopPropagation()}
                                style={{ width: '16px', height: '16px', accentColor: mobileTheme.colors.accent, flexShrink: 0 }}
                              />
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
                                <div style={{ fontWeight: 800 }}>{entry.sessionName}</div>
                                {entry.host && entry.host.name !== entry.sessionName && (
                                  <div style={{ fontSize: '12px', color: entry.missingFromRemoteTruth ? mobileTheme.colors.lightMuted : mobileTheme.colors.lightText, opacity: 0.75 }}>{entry.host.name}</div>
                                )}
                                <div style={{ fontSize: '12px', color: mobileTheme.colors.lightMuted }}>
                                  {statusLabel}
                                </div>
                              </div>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                              {(entry.liveSession || entry.source === 'saved') && (
                                <button
                                  disabled={entry.missingFromRemoteTruth}
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    if (entry.liveSession) {
                                      onResumeSession(entry.liveSession.id);
                                      return;
                                    }
                                    onOpenGroupSession(group, entry.sessionName);
                                  }}
                                  style={{
                                    border: 'none',
                                    borderRadius: '999px',
                                    padding: '6px 10px',
                                    backgroundColor: entry.liveSession ? tone.accentSoft : 'rgba(16,18,24,0.06)',
                                    color: entry.liveSession ? tone.accent : mobileTheme.colors.lightMuted,
                                    fontSize: '11px',
                                    fontWeight: 700,
                                    flexShrink: 0,
                                    cursor: entry.missingFromRemoteTruth ? 'not-allowed' : 'pointer',
                                    opacity: entry.missingFromRemoteTruth ? 0.45 : 1,
                                  }}
                                >
                                  {entry.liveSession ? 'Enter' : 'Open'}
                                </button>
                              )}
                              {entry.liveSession && (
                                <button
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    onCloseSession(entry.liveSession!.id, 'connections-session-row-close-button');
                                  }}
                                  style={{
                                    border: 'none',
                                    borderRadius: '999px',
                                    padding: '6px 10px',
                                    backgroundColor: 'rgba(255,124,146,0.12)',
                                    color: mobileTheme.colors.danger,
                                    fontSize: '11px',
                                    fontWeight: 700,
                                    flexShrink: 0,
                                    cursor: 'pointer',
                                  }}
                                >
                                  Close
                                </button>
                              )}
                              {entry.host && (
                                <>
                                  <button
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      onEdit(entry.host!);
                                    }}
                                    style={{
                                      border: 'none',
                                      borderRadius: '999px',
                                      padding: '6px 10px',
                                      backgroundColor: 'rgba(16,18,24,0.06)',
                                      color: mobileTheme.colors.lightMuted,
                                      fontSize: '11px',
                                      fontWeight: 700,
                                      flexShrink: 0,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      onDelete(entry.host!);
                                    }}
                                    style={{
                                      border: 'none',
                                      borderRadius: '999px',
                                      padding: '6px 10px',
                                      backgroundColor: 'rgba(255,124,146,0.12)',
                                      color: mobileTheme.colors.danger,
                                      fontSize: '11px',
                                      fontWeight: 700,
                                      flexShrink: 0,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    Del
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })}
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', paddingTop: '4px', flexWrap: 'wrap' }}>
                        <button
                          onClick={() => updateGroupSelection(group, group.sessions.map((entry) => entry.sessionName))}
                          style={{
                            border: 'none',
                            background: 'rgba(16,18,24,0.06)',
                            color: mobileTheme.colors.lightText,
                            borderRadius: '12px',
                            padding: '10px 12px',
                            fontWeight: 700,
                            cursor: 'pointer',
                          }}
                        >
                          All
                        </button>
                        <button
                          onClick={() => updateGroupSelection(group, [])}
                          style={{
                            border: 'none',
                            background: 'rgba(16,18,24,0.06)',
                            color: mobileTheme.colors.lightText,
                            borderRadius: '12px',
                            padding: '10px 12px',
                            fontWeight: 700,
                            cursor: 'pointer',
                          }}
                        >
                          None
                        </button>
                        <button
                          onClick={() => onEditServerGroup(group, actionSessionNames)}
                          style={{
                            border: 'none',
                            background: '#eef5ff',
                            color: mobileTheme.colors.lightText,
                            borderRadius: '12px',
                            padding: '10px 12px',
                            fontWeight: 700,
                            cursor: 'pointer',
                          }}
                        >
                          Manage
                        </button>
                        {missingSessions.length > 0 && (
                          <button
                            onClick={() => {
                              const remainingSessionNames = group.sessions
                                .filter((entry) => !entry.missingFromRemoteTruth)
                                .map((entry) => entry.sessionName);
                              if (remainingSessionNames.length === 0) {
                                setSelectedSessionsByGroup((current) => ({
                                  ...current,
                                  [group.id]: [],
                                }));
                                setExpandedGroupIds((current) => current.filter((item) => item !== group.id));
                                onDeleteServerGroup(group);
                                return;
                              }
                              onSaveServerGroupSelection(group, remainingSessionNames);
                              setSelectedSessionsByGroup((current) => ({
                                ...current,
                                [group.id]: (current[group.id] || []).filter((sessionName) => remainingSessionNames.includes(sessionName)),
                              }));
                            }}
                            style={{
                              border: 'none',
                              background: '#eef1f5',
                              color: mobileTheme.colors.lightMuted,
                              borderRadius: '12px',
                              padding: '10px 12px',
                              fontWeight: 700,
                              cursor: 'pointer',
                            }}
                          >
                            Close missing
                          </button>
                        )}
                        <button
                          onClick={() => {
                            setSelectedSessionsByGroup((current) => ({
                              ...current,
                              [group.id]: [],
                            }));
                            setExpandedGroupIds((current) => current.filter((item) => item !== group.id));
                            onDeleteServerGroup(group);
                          }}
                          style={{
                            border: 'none',
                            background: 'rgba(255,124,146,0.12)',
                            color: mobileTheme.colors.danger,
                            borderRadius: '12px',
                            padding: '10px 12px',
                            fontWeight: 700,
                            cursor: 'pointer',
                          }}
                        >
                          Clear
                        </button>
                        <button
                          onClick={() => {
                            if (!canOpenGroup) {
                              return;
                            }
                            const target = resolveGroupBridgeTarget(group);
                            onOpenServerGroups([
                              {
                                name: `${getGroupTitleName(group)} · ${getSessionCountLabel(actionSessionNames.length)}`,
                                bridgeHost: target.bridgeHost,
                                bridgePort: target.bridgePort,
                                daemonHostId: group.daemonHostId,
                                authToken: target.authToken,
                                sessionNames: actionSessionNames,
                              },
                            ]);
                          }}
                          style={{
                            border: 'none',
                            background: tone.accentSoft,
                            color: tone.accent,
                            borderRadius: '12px',
                            padding: '10px 14px',
                            fontWeight: 800,
                            cursor: canOpenGroup ? 'pointer' : 'not-allowed',
                            opacity: canOpenGroup ? 1 : 0.45,
                          }}
                        >
                          Open checked
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {selectedGroupCount > 0 && (
          <div
            style={{
              position: 'sticky',
              top: `calc(${mobileTheme.safeArea.top} + 72px)`,
              zIndex: 3,
              marginTop: '-6px',
            }}
          >
            <button
              onClick={openSelectedServerGroups}
              style={{
                width: '100%',
                border: 'none',
                borderRadius: '16px',
                padding: '14px 16px',
                backgroundColor: mobileTheme.colors.shell,
                color: mobileTheme.colors.textPrimary,
                boxShadow: mobileTheme.shadow.strong,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                cursor: 'pointer',
              }}
            >
              <span style={{ fontWeight: 800 }}>Open selected groups</span>
              <span style={{ color: mobileTheme.colors.accent, fontWeight: 800 }}>
                {selectedGroupCount} groups · {selectedSessionCount} sessions
              </span>
            </button>
          </div>
        )}
        {managementMode && selectedGroupCount === 0 && (
          <div
            style={{
              position: 'sticky',
              top: `calc(${mobileTheme.safeArea.top} + 72px)`,
              zIndex: 3,
              marginTop: '-6px',
            }}
          >
            <button
              onClick={exitManagementMode}
              style={{
                width: '100%',
                border: 'none',
                borderRadius: '16px',
                padding: '14px 16px',
                backgroundColor: mobileTheme.colors.shell,
                color: mobileTheme.colors.accent,
                boxShadow: mobileTheme.shadow.strong,
                fontWeight: 800,
                cursor: 'pointer',
              }}
            >
              Done
            </button>
          </div>
        )}
        {vaultNoticeVisible && (
          <div
            role="status"
            style={{
              borderRadius: '16px',
              padding: '12px 14px',
              backgroundColor: '#ffffff',
              color: mobileTheme.colors.lightText,
              border: `1px solid ${mobileTheme.colors.lightBorder}`,
              boxShadow: mobileTheme.shadow.soft,
              fontWeight: 700,
            }}
          >
            Vaults are not available yet
          </div>
        )}
        {serverGroups.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', paddingBottom: '120px' }}>
            <div
              style={{
                borderRadius: '28px',
                padding: '28px',
                backgroundColor: '#ffffff',
                border: `1px dashed ${mobileTheme.colors.lightBorder}`,
                color: mobileTheme.colors.lightMuted,
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
              }}
            >
              <div style={{ fontSize: '20px', fontWeight: 800, color: mobileTheme.colors.lightText }}>No connections yet</div>
              <div style={{ lineHeight: 1.6 }}>Login to Relay in Settings, then use the server entry button to enter the workspace. Servers and live sessions are managed in the terminal drawer.</div>
            </div>
          </div>
        )}
      </div>

      {!managementMode && <ConnectionFab onClick={onAddNew} />}
      <ConnectionsBottomNav
        activePage="connections"
        onOpenVaults={handleOpenVaults}
        onOpenConnections={() => undefined}
        onOpenSettings={onOpenSettings}
      />
    </div>
  );
}
