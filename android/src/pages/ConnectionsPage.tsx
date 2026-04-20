import { useMemo, useState } from 'react';
import { ConnectionCard } from '../components/connections/ConnectionCard';
import { ConnectionFab } from '../components/connections/ConnectionFab';
import { ConnectionsBottomNav } from '../components/connections/ConnectionsBottomNav';
import { ConnectionsHeader } from '../components/connections/ConnectionsHeader';
import { getResolvedSessionName } from '../lib/connection-target';
import { mobileTheme } from '../lib/mobile-ui';
import { getServerColorTone } from '../lib/server-color';
import type { Host, Session, SessionGroupHistory } from '../lib/types';

interface ConnectionsPageProps {
  hosts: Host[];
  sessions: Session[];
  sessionGroups: SessionGroupHistory[];
  onResumeSession: (sessionId: string) => void;
  onOpenGroupSession: (group: { bridgeHost: string; bridgePort: number; authToken?: string }, sessionName: string) => void;
  onEditServerGroup: (group: { bridgeHost: string; bridgePort: number; authToken?: string }, sessionNames: string[]) => void;
  onSaveServerGroupSelection: (group: { bridgeHost: string; bridgePort: number; authToken?: string }, sessionNames: string[]) => void;
  onDeleteServerGroup: (group: { bridgeHost: string; bridgePort: number }) => void;
  onOpenServerGroups: (groups: Array<{
    name: string;
    bridgeHost: string;
    bridgePort: number;
    authToken?: string;
    sessionNames: string[];
  }>) => void;
  onEdit: (host: Host) => void;
  onDelete: (host: Host) => void;
  onAddNew: () => void;
  onOpenSettings: () => void;
}

interface ServerGroupView {
  id: string;
  name: string;
  bridgeHost: string;
  bridgePort: number;
  authToken?: string;
  sessions: Array<{
    id: string;
    sessionName: string;
    host?: Host;
    source: 'saved' | 'history' | 'live';
    lastOpenedAt: number;
    liveSession: Session | null;
  }>;
  defaultSessionNames: string[];
  lastOpenedAt: number;
  liveSessions: Session[];
  savedCount: number;
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
  hosts,
  sessions,
  sessionGroups,
  onResumeSession,
  onOpenGroupSession,
  onEditServerGroup,
  onSaveServerGroupSelection,
  onDeleteServerGroup,
  onOpenServerGroups,
  onEdit,
  onDelete,
  onAddNew,
  onOpenSettings,
}: ConnectionsPageProps) {
  const [expandedGroupIds, setExpandedGroupIds] = useState<string[]>([]);
  const [selectedSessionsByGroup, setSelectedSessionsByGroup] = useState<Record<string, string[]>>({});

  const liveSessionMap = useMemo(() => {
    const map = new Map<string, Session>();
    for (const session of sessions) {
      const key = `${session.bridgeHost}:${session.bridgePort}:${session.sessionName}`;
      map.set(key, session);
    }
    return map;
  }, [sessions]);

  const serverGroups = useMemo(() => {
    const grouped = new Map<
      string,
      {
        id: string;
        name: string;
        bridgeHost: string;
        bridgePort: number;
        authToken?: string;
        sessionsByName: Map<
          string,
          {
            id: string;
            sessionName: string;
            host?: Host;
            source: 'saved' | 'history' | 'live';
            lastOpenedAt: number;
            liveSession: Session | null;
          }
        >;
        lastOpenedAt: number;
      }
    >();

    const ensureGroup = (bridgeHost: string, bridgePort: number, authToken?: string) => {
      const key = `${bridgeHost}:${bridgePort}`;
      const current = grouped.get(key);
      if (current) {
        current.authToken = current.authToken || authToken;
        return current;
      }

      const created = {
        id: key,
        name: bridgeHost,
        bridgeHost,
        bridgePort,
        authToken,
        sessionsByName: new Map(),
        lastOpenedAt: 0,
      };
      grouped.set(key, created);
      return created;
    };

    const pickPreferredHost = (current: Host | undefined, candidate: Host) => {
      if (!current) {
        return candidate;
      }
      if (candidate.pinned !== current.pinned) {
        return candidate.pinned ? candidate : current;
      }
      return (candidate.lastConnected || 0) >= (current.lastConnected || 0) ? candidate : current;
    };

    for (const host of hosts) {
      const group = ensureGroup(host.bridgeHost, host.bridgePort, host.authToken);
      const sessionName = getResolvedSessionName(host);
      const current = group.sessionsByName.get(sessionName);
      const nextHost = pickPreferredHost(current?.host, host);
      group.sessionsByName.set(sessionName, {
        id: `${group.id}:${sessionName}`,
        sessionName,
        host: nextHost,
        source: 'saved',
        lastOpenedAt: Math.max(current?.lastOpenedAt || 0, host.lastConnected || 0),
        liveSession: liveSessionMap.get(`${group.bridgeHost}:${group.bridgePort}:${sessionName}`) || current?.liveSession || null,
      });
      group.lastOpenedAt = Math.max(group.lastOpenedAt, host.lastConnected || 0);
    }

    for (const groupHistory of sessionGroups) {
      const group = ensureGroup(groupHistory.bridgeHost, groupHistory.bridgePort, groupHistory.authToken);
      group.lastOpenedAt = Math.max(group.lastOpenedAt, groupHistory.lastOpenedAt);

      for (const sessionName of groupHistory.sessionNames) {
        const current = group.sessionsByName.get(sessionName);
        group.sessionsByName.set(sessionName, {
          id: `${group.id}:${sessionName}`,
          sessionName,
          host: current?.host,
          source: current?.source || 'history',
          lastOpenedAt: Math.max(current?.lastOpenedAt || 0, groupHistory.lastOpenedAt),
          liveSession: liveSessionMap.get(`${group.bridgeHost}:${group.bridgePort}:${sessionName}`) || current?.liveSession || null,
        });
      }
    }

    for (const liveSession of sessions) {
      const group = ensureGroup(liveSession.bridgeHost, liveSession.bridgePort, liveSession.authToken);
      const current = group.sessionsByName.get(liveSession.sessionName);
      group.sessionsByName.set(liveSession.sessionName, {
        id: `${group.id}:${liveSession.sessionName}`,
        sessionName: liveSession.sessionName,
        host: current?.host,
        source: current?.source || 'live',
        lastOpenedAt: Math.max(current?.lastOpenedAt || 0, liveSession.createdAt),
        liveSession,
      });
      group.lastOpenedAt = Math.max(group.lastOpenedAt, liveSession.createdAt);
    }

    return [...grouped.values()]
      .map((group) => {
        const groupSessions = [...group.sessionsByName.values()].sort((a, b) => {
          const aSaved = a.source === 'saved' ? 1 : 0;
          const bSaved = b.source === 'saved' ? 1 : 0;
          if (aSaved !== bSaved) {
            return bSaved - aSaved;
          }
          const aLive = a.liveSession ? 1 : 0;
          const bLive = b.liveSession ? 1 : 0;
          if (aLive !== bLive) {
            return bLive - aLive;
          }
          return b.lastOpenedAt - a.lastOpenedAt || a.sessionName.localeCompare(b.sessionName);
        });
        const liveSessions = groupSessions
          .map((entry) => entry.liveSession)
          .filter((entry): entry is Session => entry !== null);
        const savedSessions = groupSessions.filter((entry) => entry.source === 'saved').map((entry) => entry.sessionName);

        return {
          id: group.id,
          name: group.name,
          bridgeHost: group.bridgeHost,
          bridgePort: group.bridgePort,
          authToken: group.authToken,
          sessions: groupSessions,
          defaultSessionNames: savedSessions.length > 0 ? savedSessions : groupSessions.map((entry) => entry.sessionName),
          lastOpenedAt: group.lastOpenedAt,
          liveSessions,
          savedCount: savedSessions.length,
        };
      })
      .sort((a, b) => {
        if (a.liveSessions.length !== b.liveSessions.length) {
          return b.liveSessions.length - a.liveSessions.length;
        }
        return b.lastOpenedAt - a.lastOpenedAt;
      });
  }, [hosts, liveSessionMap, sessionGroups, sessions]);

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
      <div style={{ padding: `${mobileTheme.safeArea.top} 18px 24px`, display: 'flex', flexDirection: 'column', gap: '22px' }}>
        <ConnectionsHeader subtitle="Grouped by server IP. Tap to open, long-press to choose sessions." />

        {serverGroups.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ fontSize: '14px', fontWeight: 800, color: mobileTheme.colors.lightMuted }}>SERVERS</div>
            {serverGroups.map((group) => {
              const expanded = expandedGroupIds.includes(group.id);
              const selectedSessions = selectedSessionsByGroup[group.id] || [];
              const hasExplicitSelection = Object.prototype.hasOwnProperty.call(selectedSessionsByGroup, group.id);
              const isOpen = group.liveSessions.length > 0;
              const isFullyOpen = group.liveSessions.length === group.sessions.length;
              const actionSessionNames = hasExplicitSelection ? selectedSessions : group.defaultSessionNames;
              const tone = getServerColorTone(group);
              return (
                <div key={group.id} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <ConnectionCard
                    title={`${group.bridgeHost} · ${group.sessions.length} tabs`}
                    subtitle={`${group.bridgeHost}:${group.bridgePort}`}
                    preview={
                      isOpen
                        ? `Live now · ${group.liveSessions.length}/${group.sessions.length} sessions open`
                        : group.savedCount > 0
                          ? `Saved ${group.savedCount} sessions · last active ${formatRelative(group.lastOpenedAt)}`
                          : `History only · last active ${formatRelative(group.lastOpenedAt)}`
                    }
                    accentLabel={
                      expanded
                        ? `${hasExplicitSelection ? selectedSessions.length : group.defaultSessionNames.length} selected · ${isFullyOpen ? 'ready' : isOpen ? 'partial' : 'restore'}`
                        : `${group.savedCount || group.sessions.length} default · ${isFullyOpen ? 'ready' : isOpen ? 'partial' : 'restore'}`
                    }
                    icon="◫"
                    tone={tone}
                    actionLabel={isOpen ? 'Enter' : 'Open'}
                    secondaryLabel={expanded ? '−' : '+'}
                    onPrimaryAction={() => {
                      onOpenServerGroups([
                        {
                          name: `${group.bridgeHost} · ${actionSessionNames.length} tabs`,
                          bridgeHost: group.bridgeHost,
                          bridgePort: group.bridgePort,
                          authToken: group.authToken,
                          sessionNames: actionSessionNames,
                        },
                      ]);
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
                        const statusLabel = entry.liveSession
                          ? `Open · ${entry.liveSession.state}`
                          : entry.source === 'saved'
                            ? 'Saved in this server'
                            : entry.source === 'history'
                              ? 'History in this server'
                              : 'Live-only session';
                        return (
                          <label
                            key={entry.id}
                            style={{
                              width: '100%',
                              borderRadius: '14px',
                              padding: '12px 14px',
                              backgroundColor: entry.liveSession ? tone.accentSoft : '#f6f8fb',
                              color: mobileTheme.colors.lightText,
                              textAlign: 'left',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: '12px',
                              cursor: 'pointer',
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleGroupSessionSelection(group, entry.sessionName)}
                                style={{ width: '16px', height: '16px', accentColor: mobileTheme.colors.accent, flexShrink: 0 }}
                              />
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
                                <div style={{ fontWeight: 800 }}>{entry.sessionName}</div>
                                {entry.host && entry.host.name !== entry.sessionName && (
                                  <div style={{ fontSize: '12px', color: mobileTheme.colors.lightText, opacity: 0.75 }}>{entry.host.name}</div>
                                )}
                                <div style={{ fontSize: '12px', color: mobileTheme.colors.lightMuted }}>
                                  {statusLabel}
                                </div>
                              </div>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                              <button
                                onClick={(event) => {
                                  event.preventDefault();
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
                                  cursor: 'pointer',
                                }}
                              >
                                {entry.liveSession ? 'Enter' : 'Open'}
                              </button>
                              {entry.host && (
                                <>
                                  <button
                                    onClick={(event) => {
                                      event.preventDefault();
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
                          </label>
                        );
                      })}
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', paddingTop: '4px' }}>
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
                        <button
                          onClick={() => {
                            setSelectedSessionsByGroup((current) => ({
                              ...current,
                              [group.id]: [],
                            }));
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
                          onClick={() =>
                            onOpenServerGroups([
                              {
                                name: `${group.bridgeHost} · ${actionSessionNames.length} tabs`,
                                bridgeHost: group.bridgeHost,
                                bridgePort: group.bridgePort,
                                authToken: group.authToken,
                                sessionNames: actionSessionNames,
                              },
                            ])
                          }
                          style={{
                            border: 'none',
                            background: tone.accentSoft,
                            color: tone.accent,
                            borderRadius: '12px',
                            padding: '10px 14px',
                            fontWeight: 800,
                            cursor: 'pointer',
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

        {selectedGroupCount > 1 && (
          <div
            style={{
              position: 'sticky',
              top: `calc(${mobileTheme.safeArea.top} + 72px)`,
              zIndex: 3,
              marginTop: '-6px',
            }}
          >
            <button
              onClick={() =>
                onOpenServerGroups(
                  selectedServerGroups.map(({ group, sessionNames }) => ({
                    name: `${group.bridgeHost} · ${sessionNames.length} tabs`,
                    bridgeHost: group.bridgeHost,
                    bridgePort: group.bridgePort,
                    authToken: group.authToken,
                    sessionNames,
                  })),
                )
              }
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
                {selectedGroupCount} groups · {selectedSessionCount} tabs
              </span>
            </button>
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
              <div style={{ lineHeight: 1.6 }}>Use the floating + button to create your first terminal bridge in the new mobile layout.</div>
            </div>
          </div>
        )}
      </div>

      <ConnectionFab onClick={onAddNew} />
      <ConnectionsBottomNav
        activePage="connections"
        onOpenConnections={() => undefined}
        onOpenSettings={onOpenSettings}
      />
    </div>
  );
}
