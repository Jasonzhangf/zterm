import { useMemo, useState } from 'react';
import { ConnectionCard } from '../components/connections/ConnectionCard';
import { ConnectionFab } from '../components/connections/ConnectionFab';
import { ConnectionsBottomNav } from '../components/connections/ConnectionsBottomNav';
import { ConnectionsHeader } from '../components/connections/ConnectionsHeader';
import { formatBridgeEndpoint, getResolvedSessionName } from '../lib/connection-target';
import { mobileTheme } from '../lib/mobile-ui';
import type { Host, Session, SessionGroupHistory } from '../lib/types';

interface ConnectionsPageProps {
  hosts: Host[];
  sessions: Session[];
  sessionGroups: SessionGroupHistory[];
  onConnect: (host: Host) => void;
  onResumeSession: (sessionId: string) => void;
  onRestoreSessionGroup: (group: SessionGroupHistory) => void;
  onOpenGroupSession: (group: SessionGroupHistory, sessionName: string) => void;
  onEdit: (host: Host) => void;
  onDelete: (host: Host) => void;
  onAddNew: () => void;
  onOpenSettings: () => void;
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
  onConnect,
  onResumeSession,
  onRestoreSessionGroup,
  onOpenGroupSession,
  onEdit,
  onDelete,
  onAddNew,
  onOpenSettings,
}: ConnectionsPageProps) {
  const [expandedGroupIds, setExpandedGroupIds] = useState<string[]>([]);

  const liveSessionMap = useMemo(() => {
    const map = new Map<string, Session>();
    for (const session of sessions) {
      const key = `${session.bridgeHost}:${session.bridgePort}:${session.sessionName}`;
      map.set(key, session);
    }
    return map;
  }, [sessions]);

  const groupsWithStatus = useMemo(() => {
    return sessionGroups.map((group) => {
      const matchingSessions = group.sessionNames
        .map((sessionName) => liveSessionMap.get(`${group.bridgeHost}:${group.bridgePort}:${sessionName}`) || null);
      const openSessions = matchingSessions.filter((session): session is Session => session !== null);
      return {
        group,
        matchingSessions,
        isOpen: openSessions.length > 0,
        isFullyOpen: openSessions.length === group.sessionNames.length,
        preferredSession: openSessions[0] || null,
      };
    });
  }, [liveSessionMap, sessionGroups]);

  const toggleGroupExpanded = (groupId: string) => {
    setExpandedGroupIds((current) =>
      current.includes(groupId) ? current.filter((item) => item !== groupId) : [...current, groupId],
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
      <div style={{ padding: `${mobileTheme.safeArea.top} 18px 24px`, display: 'flex', flexDirection: 'column', gap: '22px' }}>
        <ConnectionsHeader />

        {sessionGroups.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ fontSize: '14px', fontWeight: 800, color: mobileTheme.colors.lightMuted }}>SESSION GROUPS</div>
            {groupsWithStatus.map(({ group, matchingSessions, isOpen, isFullyOpen, preferredSession }) => {
              const expanded = expandedGroupIds.includes(group.id);
              return (
                <div key={group.id} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <ConnectionCard
                    title={group.name}
                    subtitle={`${group.bridgeHost}:${group.bridgePort}`}
                    preview={isOpen ? `Live now · ${matchingSessions.filter(Boolean).length}/${group.sessionNames.length} sessions open` : `Last active ${formatRelative(group.lastOpenedAt)}`}
                    accentLabel={`${group.sessionNames.length} tabs · ${isFullyOpen ? 'ready' : isOpen ? 'partial' : 'restore'}`}
                    icon="◫"
                    actionLabel={isOpen ? 'Enter' : 'Restore'}
                    secondaryLabel={expanded ? '−' : '+'}
                    onPrimaryAction={() => {
                      if (preferredSession) {
                        onResumeSession(preferredSession.id);
                        return;
                      }
                      onRestoreSessionGroup(group);
                    }}
                    onSecondaryAction={() => toggleGroupExpanded(group.id)}
                  />

                  {expanded && (
                    <div
                      style={{
                        borderRadius: '18px',
                        backgroundColor: '#ffffff',
                        padding: '10px',
                        boxShadow: mobileTheme.shadow.soft,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                      }}
                    >
                      {group.sessionNames.map((sessionName, index) => {
                        const liveSession = matchingSessions[index];
                        return (
                          <button
                            key={`${group.id}:${sessionName}`}
                            onClick={() => {
                              if (liveSession) {
                                onResumeSession(liveSession.id);
                                return;
                              }
                              onOpenGroupSession(group, sessionName);
                            }}
                            style={{
                              width: '100%',
                              border: 'none',
                              borderRadius: '14px',
                              padding: '12px 14px',
                              backgroundColor: liveSession ? 'rgba(31,214,122,0.12)' : '#f6f8fb',
                              color: mobileTheme.colors.lightText,
                              textAlign: 'left',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: '12px',
                              cursor: 'pointer',
                            }}
                          >
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
                              <div style={{ fontWeight: 800 }}>{sessionName}</div>
                              <div style={{ fontSize: '12px', color: mobileTheme.colors.lightMuted }}>
                                {liveSession ? `Open · ${liveSession.state}` : 'Restore this session only'}
                              </div>
                            </div>
                            <div
                              style={{
                                borderRadius: '999px',
                                padding: '4px 10px',
                                backgroundColor: liveSession ? mobileTheme.colors.accentSoft : 'rgba(16,18,24,0.06)',
                                color: liveSession ? mobileTheme.colors.accent : mobileTheme.colors.lightMuted,
                                fontSize: '11px',
                                fontWeight: 700,
                                flexShrink: 0,
                              }}
                            >
                              {liveSession ? 'Enter' : 'Restore'}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', paddingBottom: '120px' }}>
          <div style={{ fontSize: '14px', fontWeight: 800, color: mobileTheme.colors.lightMuted }}>CONNECTIONS</div>

          {hosts.length === 0 ? (
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
          ) : (
            hosts.map((host) => (
              <ConnectionCard
                key={host.id}
                title={host.name}
                subtitle={formatBridgeEndpoint(host)}
                preview={host.lastConnected ? `Last active ${formatRelative(host.lastConnected)}` : undefined}
                accentLabel={host.pinned ? `Pinned · ${getResolvedSessionName(host)}` : `Session · ${getResolvedSessionName(host)}`}
                icon={host.pinned ? '★' : '⌘'}
                actionLabel="Open"
                secondaryLabel="Edit"
                tertiaryLabel="Del"
                onPrimaryAction={() => onConnect(host)}
                onSecondaryAction={() => onEdit(host)}
                onTertiaryAction={() => onDelete(host)}
              />
            ))
          )}
        </div>
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
