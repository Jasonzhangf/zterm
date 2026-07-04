import type { MacServerDirectoryProjection, MacServerDirectorySession } from './MacServerDirectory';

interface MacServerDirectoryRailProps {
  projection: MacServerDirectoryProjection;
  onOpenSession: (serverId: string, sessionName: string, append: boolean) => void;
  onRefreshServer: (serverId: string) => void;
  onOpenConnectionLauncher: () => void;
}

function sessionSourceLabel(session: MacServerDirectorySession) {
  if (session.isOpen) {
    return 'open';
  }
  return session.source === 'live' ? 'live' : 'saved';
}

export function MacServerDirectoryRail({
  projection,
  onOpenSession,
  onRefreshServer,
  onOpenConnectionLauncher,
}: MacServerDirectoryRailProps) {
  return (
    <aside className="mac-server-rail" data-testid="mac-server-directory">
      <div className="mac-server-rail-header">
        <span>Servers</span>
        <button className="mac-chip-button" type="button" onClick={onOpenConnectionLauncher}>
          +
        </button>
      </div>
      <div className="mac-server-list">
        {projection.servers.length === 0 ? (
          <div className="mac-server-empty">No servers</div>
        ) : null}
        {projection.servers.map((server) => (
          <section
            key={server.id}
            className="mac-server-group"
            data-server-id={server.id}
            data-server-selected={projection.selectedServerId === server.id ? 'true' : 'false'}
          >
            <div className="mac-server-group-title">
              <strong>{server.name}</strong>
              <span>{server.endpointLabel}</span>
              {server.daemonLabel ? <em>{server.daemonLabel}</em> : null}
            </div>
            <div className="mac-server-group-actions">
              <button
                className="mac-server-refresh-button"
                type="button"
                data-testid={`mac-server-refresh-${server.id}`}
                disabled={server.refreshState?.status === 'loading'}
                onClick={() => onRefreshServer(server.id)}
              >
                Refresh
              </button>
              {server.refreshState?.status === 'loading' ? <small>Refreshing</small> : null}
              {server.refreshState?.status === 'ready' ? <small>Live</small> : null}
            </div>
            {server.refreshState?.status === 'error' && server.refreshState.error ? (
              <div className="mac-server-refresh-error" role="status">
                {server.refreshState.error}
              </div>
            ) : null}
            <div className="mac-server-session-list">
              {server.sessions.length === 0 ? (
                <div className="mac-server-empty">No sessions</div>
              ) : null}
              {server.sessions.map((session) => (
                <div className="mac-server-session-row" key={session.id} data-session-name={session.sessionName}>
                  <button
                    className="mac-server-session-button"
                    type="button"
                    onClick={() => onOpenSession(server.id, session.sessionName, false)}
                  >
                    <span>{session.title}</span>
                    <small>{sessionSourceLabel(session)}</small>
                  </button>
                  <button
                    className="mac-server-session-new-tab"
                    type="button"
                    title={`Open ${session.sessionName} in a new tab`}
                    onClick={() => onOpenSession(server.id, session.sessionName, true)}
                  >
                    +
                  </button>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </aside>
  );
}
