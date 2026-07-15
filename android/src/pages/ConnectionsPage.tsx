import { useEffect, useMemo, useState } from 'react';
import { useTraversalRelayAccount } from '../hooks/useTraversalRelayAccount';
import type { TraversalRelayClientSettings } from '../lib/bridge-settings';
import { getDefaultTraversalRelayBaseUrl } from '../lib/traversal-relay-client';
import { mobileTheme } from '../lib/mobile-ui';
import type { Host, Session, TraversalRelayDeviceSnapshot } from '../lib/types';

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
  relaySettings?: TraversalRelayClientSettings;
  relayDevices?: TraversalRelayDeviceSnapshot[];
  onResumeSession?: (sessionId: string) => void;
  onOpenSavedConnection?: (host: Host) => void;
  onOpenAddConnection?: () => void;
  onRelaySettingsChange: (settings: TraversalRelayClientSettings | undefined) => void;
  onOpenSettings: () => void;
}

function getDaemonName(device: TraversalRelayDeviceSnapshot) {
  return device.deviceName.trim() || device.daemon.hostId.trim() || device.deviceId;
}

function formatLastSeen(value?: string) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) {
    return 'No recent heartbeat';
  }
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 1) return 'Seen just now';
  if (elapsedMinutes < 60) return `Seen ${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  return elapsedHours < 24 ? `Seen ${elapsedHours}h ago` : `Seen ${Math.floor(elapsedHours / 24)}d ago`;
}

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

export function ConnectionsPage({
  savedConnections = [],
  activeSessions = [],
  activeSessionId = null,
  relaySettings,
  relayDevices = [],
  onResumeSession,
  onOpenSavedConnection,
  onOpenAddConnection,
  onRelaySettingsChange,
  onOpenSettings,
}: ConnectionsPageProps) {
  const {
    account,
    relayStatus,
    relayBusy,
    syncRelay,
    logoutRelay,
  } = useTraversalRelayAccount(relaySettings);
  const [username, setUsername] = useState(() => account?.username || relaySettings?.username || '');
  const [password, setPassword] = useState('');
  const relayHost = new URL(getDefaultTraversalRelayBaseUrl()).hostname;

  useEffect(() => {
    if (account?.username) {
      setUsername(account.username);
    }
  }, [account?.username]);

  const daemonDevices = useMemo(() => relayDevices
    .filter((device) => device.daemon.hostId.trim() || device.daemon.connected)
    .sort((left, right) => {
      if (left.daemon.connected !== right.daemon.connected) {
        return left.daemon.connected ? -1 : 1;
      }
      return getDaemonName(left).localeCompare(getDaemonName(right));
    }), [relayDevices]);

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

  const handleLogin = async () => {
    const result = await syncRelay('login', {
      relayBaseUrl: '',
      username,
      password,
    }, relaySettings);
    if (!result) {
      return;
    }
    setPassword('');
    onRelaySettingsChange(result.relaySettings);
  };

  const handleLogout = () => {
    logoutRelay();
    setPassword('');
    onRelaySettingsChange(undefined);
  };

  const loggedIn = Boolean(account?.accessToken && relaySettings?.accessToken);
  const busy = relayBusy !== null;

  return (
    <main
      data-testid="relay-login-home"
      style={{
        minHeight: '100dvh',
        maxHeight: '100dvh',
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch',
        backgroundColor: '#f2f5f7',
        color: mobileTheme.colors.lightText,
      }}
    >
      <div
        style={{
          width: 'min(100%, 720px)',
          margin: '0 auto',
          padding: `${mobileTheme.safeArea.top} 18px ${mobileTheme.safeArea.bottom}`,
          boxSizing: 'border-box',
          display: 'grid',
          gap: '24px',
        }}
      >
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
            <div
              aria-hidden="true"
              style={{
                width: '42px',
                height: '42px',
                borderRadius: '8px',
                backgroundColor: '#0a0b0f',
                color: '#fff',
                display: 'grid',
                placeItems: 'center',
                fontSize: '19px',
                fontWeight: 900,
                flex: '0 0 auto',
              }}
            >
              &gt;_
            </div>
            <div style={{ minWidth: 0 }}>
              <h1 style={{ margin: 0, fontSize: '20px', lineHeight: 1.2, letterSpacing: 0 }}>zterm</h1>
              <div style={{ marginTop: '3px', color: mobileTheme.colors.lightMuted, fontSize: '12px' }}>
                Connections
              </div>
            </div>
          </div>
          <button
            type="button"
            aria-label="Open settings"
            title="Settings"
            onClick={onOpenSettings}
            style={{
              width: '42px',
              height: '42px',
              borderRadius: '8px',
              border: `1px solid ${mobileTheme.colors.lightBorder}`,
              backgroundColor: '#fff',
              color: mobileTheme.colors.lightText,
              fontSize: '20px',
            }}
          >
            ⚙
          </button>
        </header>

        {orderedActiveSessions.length > 0 ? (
          <section aria-labelledby="active-connections-title" style={{ display: 'grid', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px' }}>
              <h2 id="active-connections-title" style={{ margin: 0, fontSize: '16px', letterSpacing: 0 }}>
                Active
              </h2>
              <span style={{ color: mobileTheme.colors.lightMuted, fontSize: '12px' }}>{orderedActiveSessions.length}</span>
            </div>
            <div style={{ borderTop: `1px solid ${mobileTheme.colors.lightBorder}` }}>
              {orderedActiveSessions.map((session) => {
                const label = getSessionLabel(session);
                return (
                  <button
                    key={session.id}
                    type="button"
                    data-testid="active-session-row"
                    aria-label={`Resume ${label}`}
                    onClick={() => onResumeSession?.(session.id)}
                    style={{
                      width: '100%',
                      minHeight: '68px',
                      padding: '12px 2px',
                      border: 'none',
                      borderBottom: `1px solid ${mobileTheme.colors.lightBorder}`,
                      backgroundColor: 'transparent',
                      color: mobileTheme.colors.lightText,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      textAlign: 'left',
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        width: '9px',
                        height: '9px',
                        borderRadius: '50%',
                        backgroundColor: getSessionStateColor(session.state),
                        flex: '0 0 auto',
                      }}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: '14px', fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {label}
                      </span>
                      <span style={{ display: 'block', marginTop: '4px', color: mobileTheme.colors.lightMuted, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {session.connectionName} · {getSessionEndpoint(session)}
                      </span>
                    </span>
                    <span style={{ color: getSessionStateColor(session.state), fontSize: '11px', fontWeight: 800, textTransform: 'uppercase' }}>
                      {session.id === activeSessionId ? 'CURRENT' : session.state}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}

        <section aria-labelledby="saved-connections-title" style={{ display: 'grid', gap: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
              <h2 id="saved-connections-title" style={{ margin: 0, fontSize: '16px', letterSpacing: 0 }}>
                Saved connections
              </h2>
              <span style={{ color: mobileTheme.colors.lightMuted, fontSize: '12px' }}>{orderedSavedConnections.length}</span>
            </div>
            <button
              type="button"
              aria-label="Add connection"
              title="Add connection"
              onClick={onOpenAddConnection}
              style={{
                width: '38px',
                height: '38px',
                borderRadius: '7px',
                border: `1px solid ${mobileTheme.colors.lightBorder}`,
                backgroundColor: '#fff',
                color: mobileTheme.colors.lightText,
                fontSize: '24px',
                lineHeight: 1,
              }}
            >
              +
            </button>
          </div>
          {orderedSavedConnections.length === 0 ? (
            <div
              style={{
                minHeight: '56px',
                border: `1px solid ${mobileTheme.colors.lightBorder}`,
                borderRadius: '7px',
                backgroundColor: '#fff',
                color: mobileTheme.colors.lightMuted,
                fontSize: '13px',
                display: 'grid',
                placeItems: 'center',
              }}
            >
              No saved connections
            </div>
          ) : (
            <div style={{ borderTop: `1px solid ${mobileTheme.colors.lightBorder}` }}>
              {orderedSavedConnections.map((host) => (
                <button
                  key={host.id}
                  type="button"
                  data-testid="saved-connection-row"
                  aria-label={`Open ${host.name}`}
                  onClick={() => onOpenSavedConnection?.(host)}
                  style={{
                    width: '100%',
                    minHeight: '68px',
                    padding: '12px 2px',
                    border: 'none',
                    borderBottom: `1px solid ${mobileTheme.colors.lightBorder}`,
                    backgroundColor: 'transparent',
                    color: mobileTheme.colors.lightText,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    textAlign: 'left',
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '7px',
                      backgroundColor: '#e8eef2',
                      color: '#263746',
                      display: 'grid',
                      placeItems: 'center',
                      fontSize: '14px',
                      fontWeight: 900,
                      flex: '0 0 auto',
                    }}
                  >
                    &gt;_
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: '14px', fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {host.name}
                    </span>
                    <span style={{ display: 'block', marginTop: '4px', color: mobileTheme.colors.lightMuted, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {host.bridgeHost}:{host.bridgePort}
                    </span>
                  </span>
                  <span style={{ color: mobileTheme.colors.lightMuted, fontSize: '18px', lineHeight: 1 }} aria-hidden="true">
                    ›
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section aria-labelledby="relay-login-title" style={{ display: 'grid', gap: '16px' }}>
          <div>
            <h2 id="relay-login-title" style={{ margin: 0, fontSize: '16px', lineHeight: 1.3, letterSpacing: 0 }}>
              Relay
            </h2>
            <div style={{ marginTop: '5px', color: mobileTheme.colors.lightMuted, fontSize: '13px' }}>
              Optional
            </div>
          </div>

          <div
            style={{
              border: `1px solid ${mobileTheme.colors.lightBorder}`,
              borderRadius: '8px',
              backgroundColor: '#fff',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '14px 16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '12px',
                borderBottom: `1px solid ${mobileTheme.colors.lightBorder}`,
              }}
            >
              <div>
                <div style={{ fontSize: '12px', color: mobileTheme.colors.lightMuted }}>Service</div>
                <div data-testid="relay-fixed-host" style={{ marginTop: '3px', fontSize: '14px', fontWeight: 800 }}>{relayHost}</div>
              </div>
              <div style={{ fontSize: '11px', fontWeight: 800, color: loggedIn ? '#087a46' : mobileTheme.colors.lightMuted }}>
                {loggedIn ? 'SIGNED IN' : 'FIXED'}
              </div>
            </div>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                void handleLogin();
              }}
              style={{ padding: '16px', display: 'grid', gap: '14px' }}
            >
              <label style={{ display: 'grid', gap: '7px', fontSize: '13px', fontWeight: 700 }}>
                Account
                <input
                  aria-label="Relay account"
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  disabled={busy}
                  style={{
                    minHeight: '48px',
                    boxSizing: 'border-box',
                    borderRadius: '7px',
                    border: `1px solid ${mobileTheme.colors.lightBorder}`,
                    backgroundColor: '#f8fafb',
                    padding: '0 13px',
                    color: mobileTheme.colors.lightText,
                    fontSize: '16px',
                    outline: 'none',
                  }}
                />
              </label>
              <label style={{ display: 'grid', gap: '7px', fontSize: '13px', fontWeight: 700 }}>
                Password
                <input
                  aria-label="Relay password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={busy}
                  style={{
                    minHeight: '48px',
                    boxSizing: 'border-box',
                    borderRadius: '7px',
                    border: `1px solid ${mobileTheme.colors.lightBorder}`,
                    backgroundColor: '#f8fafb',
                    padding: '0 13px',
                    color: mobileTheme.colors.lightText,
                    fontSize: '16px',
                    outline: 'none',
                  }}
                />
              </label>

              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  type="submit"
                  disabled={busy || !username.trim() || !password}
                  style={{
                    minHeight: '48px',
                    flex: 1,
                    border: 'none',
                    borderRadius: '7px',
                    backgroundColor: '#111820',
                    color: '#fff',
                    fontSize: '15px',
                    fontWeight: 800,
                    opacity: busy || !username.trim() || !password ? 0.55 : 1,
                  }}
                >
                  {relayBusy === 'login' ? 'Signing in…' : loggedIn ? 'Sign in again' : 'Sign in'}
                </button>
                {loggedIn ? (
                  <button
                    type="button"
                    onClick={handleLogout}
                    disabled={busy}
                    style={{
                      minHeight: '48px',
                      padding: '0 16px',
                      borderRadius: '7px',
                      border: `1px solid ${mobileTheme.colors.lightBorder}`,
                      backgroundColor: '#fff',
                      color: '#a22c3f',
                      fontWeight: 800,
                    }}
                  >
                    Sign out
                  </button>
                ) : null}
              </div>

              <div
                role={relayStatus && !relayStatus.includes('已登录') ? 'alert' : 'status'}
                style={{
                  minHeight: '20px',
                  fontSize: '12px',
                  lineHeight: 1.5,
                  color: relayStatus && !relayStatus.includes('已登录') ? '#a22c3f' : mobileTheme.colors.lightMuted,
                }}
              >
                {relayStatus || (loggedIn ? `Signed in as ${account?.user?.username || account?.username || username}` : 'Credentials are sent only to the fixed relay service.')}
              </div>
            </form>
          </div>
        </section>

        {loggedIn ? (
          <section aria-labelledby="relay-servers-title" style={{ display: 'grid', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px' }}>
              <h2 id="relay-servers-title" style={{ margin: 0, fontSize: '16px', letterSpacing: 0 }}>Relay routes</h2>
              <span style={{ color: mobileTheme.colors.lightMuted, fontSize: '12px' }}>{daemonDevices.length}</span>
            </div>
            {daemonDevices.length === 0 ? (
              <div style={{ borderTop: `1px solid ${mobileTheme.colors.lightBorder}`, padding: '18px 2px', color: mobileTheme.colors.lightMuted, fontSize: '13px' }}>
                No daemon has reported under this account.
              </div>
            ) : (
              <div style={{ borderTop: `1px solid ${mobileTheme.colors.lightBorder}` }}>
                {daemonDevices.map((device) => (
                  <div
                    key={device.deviceId}
                    data-testid="relay-daemon-row"
                    style={{
                      minHeight: '64px',
                      padding: '12px 2px',
                      borderBottom: `1px solid ${mobileTheme.colors.lightBorder}`,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                    }}
                  >
                    <span
                      aria-label={device.daemon.connected ? 'Online' : 'Offline'}
                      style={{
                        width: '9px',
                        height: '9px',
                        borderRadius: '50%',
                        backgroundColor: device.daemon.connected ? '#12a965' : '#aeb8c4',
                        flex: '0 0 auto',
                      }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '14px', fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {getDaemonName(device)}
                      </div>
                      <div style={{ marginTop: '4px', color: mobileTheme.colors.lightMuted, fontSize: '12px' }}>
                        {device.daemon.hostId || device.deviceId} · {formatLastSeen(device.daemon.lastSeenAt)}
                      </div>
                    </div>
                    <div style={{ fontSize: '11px', fontWeight: 800, color: device.daemon.connected ? '#087a46' : mobileTheme.colors.lightMuted }}>
                      {device.daemon.connected ? 'ONLINE' : 'OFFLINE'}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : null}
      </div>
    </main>
  );
}
