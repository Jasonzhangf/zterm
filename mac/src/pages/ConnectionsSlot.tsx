import { formatBridgeEndpoint, formatTargetBadge, getResolvedSessionName, type Host } from '@zterm/shared';

interface ConnectionsSlotProps {
  hosts: Host[];
  selectedHostId: string | null;
  onSelectHost: (hostId: string) => void;
  onOpenHost: (hostId: string) => void;
  onCreateHost: () => void;
  onEditHost: (hostId: string) => void;
  onDeleteHost: (hostId: string) => void;
}

function buildServerSummary(hosts: Host[]) {
  const groups = new Map<string, { endpoint: string; total: number; pinned: number }>();

  for (const host of hosts) {
    const endpoint = formatBridgeEndpoint(host);
    const current = groups.get(endpoint) || { endpoint, total: 0, pinned: 0 };
    current.total += 1;
    current.pinned += host.pinned ? 1 : 0;
    groups.set(endpoint, current);
  }

  return [...groups.values()].sort((a, b) => b.total - a.total || a.endpoint.localeCompare(b.endpoint));
}

export function ConnectionsSlot({
  hosts,
  selectedHostId,
  onSelectHost,
  onOpenHost,
  onCreateHost,
  onEditHost,
  onDeleteHost,
}: ConnectionsSlotProps) {
  const serverGroups = buildServerSummary(hosts);

  return (
    <div className="slot-stack">
      <div className="slot-card sidebar-summary-card">
        <div className="slot-card-header compact">
          <div>
            <div className="slot-card-title">Profiles</div>
            <div className="slot-card-copy">Server-first</div>
          </div>
          <button className="primary-button" type="button" onClick={onCreateHost}>
            +
          </button>
        </div>

        {serverGroups.length > 0 ? (
          <div className="sidebar-server-list">
            {serverGroups.map((group) => (
              <div className="sidebar-server-item" key={group.endpoint}>
                <strong>{group.endpoint}</strong>
                <span className="sidebar-server-meta">
                  {group.total} connection{group.total > 1 ? 's' : ''}
                  {group.pinned > 0 ? ` · ${group.pinned} pinned` : ''}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-copy">还没有保存的 connection。先点 New Connection 创建。</div>
        )}
      </div>

      <div className="list-stack">
        {hosts.map((host) => {
          const active = host.id === selectedHostId;
          return (
            <div className={`list-row sidebar-list-row ${active ? 'active' : ''}`} key={host.id}>
              <button className="list-row-main" type="button" onClick={() => onSelectHost(host.id)}>
                <div className="list-row-title-line">
                  <div className="list-row-title">{host.name}</div>
                  <span className={`target-badge ${formatTargetBadge(host.bridgeHost).toLowerCase()}`}>
                    {formatTargetBadge(host.bridgeHost)}
                  </span>
                  {host.pinned ? <span className="meta-badge">Pinned</span> : null}
                </div>
                <div className="list-row-copy">{formatBridgeEndpoint(host)} · {getResolvedSessionName(host)}</div>
              </button>

              <div className="list-row-actions">
                <button className="ghost-button" type="button" onClick={() => onOpenHost(host.id)}>
                  ↗
                </button>
                <button className="ghost-button" type="button" onClick={() => onEditHost(host.id)}>
                  ⋯
                </button>
                <button className="danger-button" type="button" onClick={() => onDeleteHost(host.id)}>
                  ×
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
