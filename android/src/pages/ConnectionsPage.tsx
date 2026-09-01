import { type CSSProperties, useMemo } from 'react';
import { hasRelayRtcCandidate } from '../lib/home-connection-projection';
import { mobileTheme } from '../lib/mobile-ui';
import type { Host, Session } from '../lib/types';

export type ConnectionsHomeActiveSession = Pick<
  Session,
  | 'id'
  | 'title'
  | 'customName'
  | 'connectionName'
  | 'bridgeHost'
  | 'bridgePort'
  | 'daemonHostId'
  | 'sessionName'
  | 'state'
  | 'resolvedEndpoint'
  | 'resolvedPath'
>;

interface ConnectionsPageProps {
  savedConnections?: Host[];
  activeSessions?: ConnectionsHomeActiveSession[];
  activeSessionId?: string | null;
  onResumeSession?: (sessionId: string) => void;
  onOpenSavedConnection?: (host: Host) => void;
  onOpenSettings: () => void;
}

const pageStyle: CSSProperties = {
  minHeight: '100dvh',
  maxHeight: '100dvh',
  overflowY: 'auto',
  WebkitOverflowScrolling: 'touch',
  backgroundColor: mobileTheme.colors.lightBg,
  color: mobileTheme.colors.lightText,
};

const contentStyle: CSSProperties = {
  width: 'min(100%, clamp(320px, 70vw, 880px))',
  margin: '0 auto',
  padding: `${mobileTheme.safeArea.top} 16px ${mobileTheme.safeArea.bottom}`,
  boxSizing: 'border-box',
  display: 'grid',
  gap: '16px',
};

const sectionHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: '14px',
  fontWeight: 900,
  lineHeight: 1.1,
  letterSpacing: 0,
};

function getSessionLabel(session: ConnectionsHomeActiveSession) {
  return session.customName?.trim()
    || session.title.trim()
    || session.sessionName.trim()
    || session.connectionName.trim()
    || session.id;
}

function getSessionEndpoint(session: ConnectionsHomeActiveSession) {
  return session.resolvedEndpoint?.trim() || `${session.bridgeHost}:${session.bridgePort}`;
}

function getSessionStateColor(state: ConnectionsHomeActiveSession['state']) {
  if (state === 'connected') return '#087a46';
  if (state === 'connecting' || state === 'reconnecting') return '#9a6300';
  if (state === 'error' || state === 'closed') return '#a22c3f';
  return mobileTheme.colors.lightMuted;
}

function getHostEndpoint(host: Host) {
  const bridgeHost = host.bridgeHost.trim() || host.daemonHostId?.trim() || host.relayHostId?.trim() || 'server';
  return `${bridgeHost}:${host.bridgePort}`;
}

function getHostBadge(host: Host) {
  const tagText = (host.tags || []).join(' ').toLowerCase();
  const endpoint = getHostEndpoint(host).toLowerCase();
  if (hasRelayRtcCandidate(host)) {
    return 'Auto';
  }
  if (tagText.includes('tailscale') || endpoint.includes('100.') || endpoint.includes('.ts.net')) {
    return 'Tailscale';
  }
  if (tagText.includes('bridge-server')) {
    return 'Preset';
  }
  return 'Direct';
}

function getServerMark(label: string) {
  const trimmed = label.trim();
  if (!trimmed) return '>';
  return trimmed.slice(0, 1).toUpperCase();
}

function HomeBadge({ children }: { children: string }) {
  return (
    <span
      style={{
        minWidth: 0,
        padding: '4px 8px',
        borderRadius: '999px',
        backgroundColor: '#eef3f8',
        color: mobileTheme.colors.lightMuted,
        fontSize: '11px',
        fontWeight: 850,
        lineHeight: 1,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

function PlusGlyph() {
  return (
    <svg aria-hidden="true" fill="none" height="20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="20">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function SettingsGlyph() {
  return (
    <svg aria-hidden="true" fill="none" height="20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="20">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function ServerGlyph({ label, active = false }: { label: string; active?: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: '42px',
        height: '42px',
        borderRadius: '14px',
        backgroundColor: active ? mobileTheme.colors.shell : '#e6edf3',
        color: active ? '#ffffff' : '#253548',
        display: 'grid',
        placeItems: 'center',
        fontSize: active ? '17px' : '15px',
        fontWeight: 950,
        flex: '0 0 auto',
        boxShadow: active ? '0 12px 22px rgba(23, 27, 45, 0.18)' : 'none',
      }}
    >
      {active ? '>_' : getServerMark(label)}
    </span>
  );
}

export function ConnectionsPage({
  savedConnections = [],
  activeSessions = [],
  activeSessionId = null,
  onResumeSession,
  onOpenSavedConnection,
  onOpenSettings,
}: ConnectionsPageProps) {
  const orderedActiveSessions = useMemo(() => [...activeSessions].sort((left, right) => {
    if (left.id === activeSessionId) return -1;
    if (right.id === activeSessionId) return 1;
    if (left.state === 'connected' && right.state !== 'connected') return -1;
    if (right.state === 'connected' && left.state !== 'connected') return 1;
    return getSessionLabel(left).localeCompare(getSessionLabel(right));
  }), [activeSessionId, activeSessions]);

  const orderedSavedConnections = useMemo(() => [...savedConnections].sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }
    const timeDelta = (right.lastConnected || right.createdAt) - (left.lastConnected || left.createdAt);
    return timeDelta || left.name.localeCompare(right.name);
  }), [savedConnections]);

  return (
    <main
      data-testid="connections-home"
      className="connections-home-shell"
      style={pageStyle}
    >
      <div style={contentStyle}>
        <header
          data-testid="connections-home-header"
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 4,
            margin: `calc(${mobileTheme.safeArea.top} * -1) -16px 0`,
            padding: `${mobileTheme.safeArea.top} 16px 14px`,
            backgroundColor: 'rgba(237, 242, 246, 0.94)',
            backdropFilter: 'blur(14px)',
            borderBottom: `1px solid ${mobileTheme.colors.lightBorder}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
            <div
              aria-hidden="true"
              style={{
                width: '48px',
                height: '48px',
                borderRadius: '16px',
                backgroundColor: mobileTheme.colors.shell,
                color: '#ffffff',
                display: 'grid',
                placeItems: 'center',
                fontSize: '18px',
                fontWeight: 950,
                boxShadow: '0 14px 28px rgba(23, 27, 45, 0.20)',
                flex: '0 0 auto',
              }}
            >
              &gt;_
            </div>
            <div style={{ minWidth: 0 }}>
              <h1 style={{ margin: 0, fontSize: '22px', lineHeight: 1.05, fontWeight: 920, letterSpacing: 0 }}>
                zterm
              </h1>
              <div style={{ marginTop: '5px', display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                <HomeBadge>{`${orderedSavedConnections.length} servers`}</HomeBadge>
                {orderedActiveSessions.length > 0 ? <HomeBadge>{`${orderedActiveSessions.length} live`}</HomeBadge> : null}
              </div>
            </div>
          </div>
          <button
            type="button"
            aria-label="设置和升级"
            title="设置和升级"
            onClick={onOpenSettings}
            style={{
              minWidth: '78px',
              height: '48px',
              padding: '0 12px',
              borderRadius: '16px',
              border: `1px solid ${mobileTheme.colors.lightBorder}`,
              backgroundColor: '#ffffff',
              color: mobileTheme.colors.lightText,
              fontSize: '14px',
              fontWeight: 900,
              boxShadow: mobileTheme.shadow.soft,
              flex: '0 0 auto',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
            }}
          >
            <SettingsGlyph />
            <span>设置</span>
          </button>
        </header>

        {orderedActiveSessions.length > 0 ? (
          <section aria-labelledby="active-connections-title" style={{ display: 'grid', gap: '10px' }}>
            <div style={sectionHeaderStyle}>
              <h2 id="active-connections-title" style={sectionTitleStyle}>Active</h2>
              <span style={{ color: mobileTheme.colors.lightMuted, fontSize: '12px', fontWeight: 800 }}>
                {orderedActiveSessions.length}
              </span>
            </div>
            <div data-testid="active-session-list" style={{ display: 'grid', gap: '10px' }}>
              {orderedActiveSessions.map((session) => {
                const label = getSessionLabel(session);
                const stateColor = getSessionStateColor(session.state);
                return (
                  <button
                    key={session.id}
                    type="button"
                    data-testid="active-session-row"
                    aria-label={`Resume ${label}`}
                    onClick={() => onResumeSession?.(session.id)}
                    style={{
                      width: '100%',
                      minHeight: '76px',
                      padding: '12px',
                      border: `1px solid ${session.id === activeSessionId ? 'rgba(8, 122, 70, 0.34)' : mobileTheme.colors.lightBorder}`,
                      borderRadius: '20px',
                      backgroundColor: '#ffffff',
                      color: mobileTheme.colors.lightText,
                      display: 'grid',
                      gridTemplateColumns: 'auto 1fr auto',
                      alignItems: 'center',
                      gap: '12px',
                      textAlign: 'left',
                      boxShadow: mobileTheme.shadow.soft,
                    }}
                  >
                    <ServerGlyph label={label} active />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: '15px', fontWeight: 900, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {label}
                      </span>
                      <span style={{ display: 'block', marginTop: '5px', color: mobileTheme.colors.lightMuted, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {session.connectionName} · {getSessionEndpoint(session)}
                      </span>
                    </span>
                    <span
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        color: stateColor,
                        fontSize: '11px',
                        fontWeight: 900,
                        textTransform: 'uppercase',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          width: '7px',
                          height: '7px',
                          borderRadius: '999px',
                          backgroundColor: stateColor,
                        }}
                      />
                      {session.id === activeSessionId ? 'current' : session.state}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}

        <section aria-labelledby="saved-connections-title" style={{ display: 'grid', gap: '10px' }}>
          <div style={sectionHeaderStyle}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0 }}>
              <h2 id="saved-connections-title" style={sectionTitleStyle}>服务器</h2>
              <span style={{ color: mobileTheme.colors.lightMuted, fontSize: '12px', fontWeight: 800 }}>
                {orderedSavedConnections.length}
              </span>
            </div>
            <button
              type="button"
              aria-label="Configure servers"
              title="Configure servers"
              onClick={onOpenSettings}
              style={{
                width: '44px',
                height: '44px',
                borderRadius: '14px',
                border: 'none',
                backgroundColor: mobileTheme.colors.shell,
                color: '#ffffff',
                lineHeight: 1,
                boxShadow: mobileTheme.shadow.soft,
                flex: '0 0 auto',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <PlusGlyph />
            </button>
          </div>
          {orderedSavedConnections.length === 0 ? (
            <div
              data-testid="connections-empty-state"
              role="region"
              aria-label="No configured servers yet"
              style={{
                minHeight: '160px',
                padding: '20px 18px',
                border: `1px dashed ${mobileTheme.colors.lightBorder}`,
                borderRadius: '22px',
                backgroundColor: 'rgba(255,255,255,0.78)',
                color: mobileTheme.colors.lightText,
                display: 'grid',
                gap: '10px',
                justifyItems: 'center',
                alignContent: 'center',
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: '15px', fontWeight: 850 }}>
                <span>No configured servers</span>
                <span aria-hidden="true"> · </span>
                Configure your first server to start a terminal session
              </div>
              <div style={{ fontSize: '13px', color: mobileTheme.colors.lightMuted, lineHeight: 1.5, maxWidth: '28em' }}>
                Add a Tailscale IP, a bridge host, or a Relay device so you can open or rejoin sessions from any device.
              </div>
              <button
                type="button"
                aria-label="Add the first server"
                title="Add server"
                onClick={onOpenSettings}
                style={{
                  marginTop: '6px',
                  minHeight: '44px',
                  padding: '0 18px',
                  borderRadius: '16px',
                  border: 'none',
                  backgroundColor: mobileTheme.colors.shell,
                  color: '#ffffff',
                  fontSize: '14px',
                  fontWeight: 800,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '8px',
                  boxShadow: mobileTheme.shadow.soft,
                  cursor: 'pointer',
                }}
              >
                <PlusGlyph />
                Add server
              </button>
            </div>
          ) : (
            <div data-testid="saved-connection-list" style={{ display: 'grid', gap: '10px' }}>
              {orderedSavedConnections.map((host) => {
                const endpoint = getHostEndpoint(host);
                const hostBadge = getHostBadge(host);
                const relayAvailable = hasRelayRtcCandidate(host);
                return (
                  <div
                    key={host.id}
                    data-testid="saved-connection-row"
                    style={{
                      width: '100%',
                      minHeight: '82px',
                      border: `1px solid ${mobileTheme.colors.lightBorder}`,
                      borderRadius: '20px',
                      backgroundColor: '#ffffff',
                      color: mobileTheme.colors.lightText,
                      display: 'grid',
                      gridTemplateColumns: '1fr',
                      alignItems: 'center',
                      textAlign: 'left',
                      boxShadow: mobileTheme.shadow.soft,
                      overflow: 'hidden',
                    }}
                  >
                    <button
                      type="button"
                      data-testid="saved-connection-open"
                      aria-label={`Open ${host.name}`}
                      onClick={() => onOpenSavedConnection?.(host)}
                      style={{
                        width: '100%',
                        minHeight: '82px',
                        padding: '13px 12px',
                        border: 'none',
                        backgroundColor: 'transparent',
                        color: 'inherit',
                        display: 'grid',
                        gridTemplateColumns: 'auto 1fr auto',
                        alignItems: 'center',
                        gap: '12px',
                        textAlign: 'left',
                        minWidth: 0,
                      }}
                    >
                      <ServerGlyph label={host.name} />
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: '15px', fontWeight: 900, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {host.name}
                        </span>
                        <span style={{ display: 'block', marginTop: '5px', color: mobileTheme.colors.lightMuted, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {endpoint}
                        </span>
                        <span style={{ marginTop: '8px', display: 'flex', gap: '6px', minWidth: 0, flexWrap: 'wrap' }}>
                          <HomeBadge>{hostBadge}</HomeBadge>
                          {relayAvailable ? <HomeBadge>自动线路</HomeBadge> : null}
                          {host.pinned ? <HomeBadge>Pinned</HomeBadge> : null}
                        </span>
                      </span>
                      <span
                        style={{
                          width: '32px',
                          height: '32px',
                          borderRadius: '12px',
                          display: 'grid',
                          placeItems: 'center',
                          backgroundColor: '#eef3f8',
                          color: mobileTheme.colors.lightMuted,
                          fontSize: '20px',
                          lineHeight: 1,
                        }}
                        aria-hidden="true"
                      >
                        ›
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
