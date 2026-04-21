import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_BRIDGE_PORT,
  fetchTmuxSessions,
  formatBridgeEndpoint,
  getDefaultBridgeServer,
  getResolvedSessionName,
  resolveEffectiveBridgePort,
  type BridgeSettings,
  type EditableHost,
  type Host,
} from '@zterm/shared';

interface QuickConnectSheetProps {
  bridgeSettings: BridgeSettings;
  hosts: Host[];
  onClose: () => void;
  onOpen: (hostData: EditableHost, persistedHostId?: string) => void;
  onOpenAdvanced: () => void;
}

interface QuickConnectDraft {
  bridgeHost: string;
  bridgePort: number;
  authToken: string;
  sessionName: string;
}

function sameEndpoint(a: { bridgeHost: string; bridgePort: number }, b: { bridgeHost: string; bridgePort: number }) {
  return a.bridgeHost.trim() === b.bridgeHost.trim() && a.bridgePort === b.bridgePort;
}

function resolveDraftFromSettings(settings: BridgeSettings): QuickConnectDraft {
  const defaultServer = getDefaultBridgeServer(settings) ?? settings.servers[0];
  return {
    bridgeHost: defaultServer?.targetHost || settings.targetHost || '',
    bridgePort: defaultServer?.targetPort || settings.targetPort || DEFAULT_BRIDGE_PORT,
    authToken: defaultServer?.authToken || settings.targetAuthToken || '',
    sessionName: '',
  };
}

function buildEditableHostFromDraft(draft: QuickConnectDraft, existingHost?: Host): EditableHost {
  const sessionName = draft.sessionName.trim();
  const bridgeHost = draft.bridgeHost.trim();
  return {
    name: existingHost?.name || sessionName || bridgeHost,
    bridgeHost,
    bridgePort: draft.bridgePort,
    sessionName,
    authToken: draft.authToken.trim(),
    authType: existingHost?.authType || 'password',
    password: existingHost?.password,
    privateKey: existingHost?.privateKey,
    tags: existingHost?.tags || [],
    pinned: existingHost?.pinned || false,
    lastConnected: existingHost?.lastConnected,
    autoCommand: existingHost?.autoCommand,
  };
}

export function QuickConnectSheet({
  bridgeSettings,
  hosts,
  onClose,
  onOpen,
  onOpenAdvanced,
}: QuickConnectSheetProps) {
  const [draft, setDraft] = useState<QuickConnectDraft>(() => resolveDraftFromSettings(bridgeSettings));
  const [sessions, setSessions] = useState<string[]>([]);
  const [discoveryState, setDiscoveryState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [discoveryError, setDiscoveryError] = useState('');

  useEffect(() => {
    setDraft(resolveDraftFromSettings(bridgeSettings));
    setSessions([]);
    setDiscoveryState('idle');
    setDiscoveryError('');
  }, [bridgeSettings]);

  const rememberedHosts = useMemo(
    () => hosts.filter((host) => sameEndpoint(host, draft)),
    [draft, hosts],
  );

  const discoverSessions = async (override?: Partial<QuickConnectDraft>) => {
    const nextDraft = {
      ...draft,
      ...override,
    };
    const bridgeHost = nextDraft.bridgeHost.trim();
    const authToken = nextDraft.authToken.trim();
    if (!bridgeHost) {
      setSessions([]);
      setDiscoveryState('error');
      setDiscoveryError('先填写 IP / host。');
      return;
    }
    if (!authToken) {
      setSessions([]);
      setDiscoveryState('error');
      setDiscoveryError('先填写 token。');
      return;
    }

    setDiscoveryState('loading');
    setDiscoveryError('');

    try {
      const nextSessions = await fetchTmuxSessions({
        bridgeHost,
        bridgePort: nextDraft.bridgePort,
        authToken,
      });
      setSessions(nextSessions);
      setDiscoveryState('done');

      const lastConnectedHost = hosts
        .filter((host) => sameEndpoint(host, nextDraft) && nextSessions.includes(getResolvedSessionName(host)))
        .sort((a, b) => (b.lastConnected || 0) - (a.lastConnected || 0))[0];

      setDraft((current) => ({
        ...current,
        ...override,
        sessionName:
          lastConnectedHost?.lastConnected
            ? getResolvedSessionName(lastConnectedHost)
            : nextSessions.includes(current.sessionName)
              ? current.sessionName
              : '',
      }));
    } catch (error) {
      setSessions([]);
      setDiscoveryState('error');
      setDiscoveryError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleServerPick = (serverId: string) => {
    const server = bridgeSettings.servers.find((item) => item.id === serverId);
    if (!server) {
      return;
    }
    const nextDraft: QuickConnectDraft = {
      bridgeHost: server.targetHost,
      bridgePort: server.targetPort,
      authToken: server.authToken || '',
      sessionName: '',
    };
    setDraft(nextDraft);
    void discoverSessions(nextDraft);
  };

  const canOpen = draft.bridgeHost.trim() && draft.authToken.trim() && draft.sessionName.trim();
  const matchedHost = hosts.find(
    (host) => sameEndpoint(host, draft) && getResolvedSessionName(host) === draft.sessionName.trim(),
  );

  return (
    <div className="shell-overlay-card quick-connect-sheet" onClick={(event) => event.stopPropagation()}>
      <div className="shell-overlay-header">
        <div>
          <strong>Open connection</strong>
          <span>填 IP / 端口 / token，或直接点已记住的服务器，然后选 session 打开。</span>
        </div>
        <button className="shell-pane-icon-button" type="button" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="quick-connect-body">
        <section className="quick-connect-section">
          <div className="quick-connect-section-title">Remembered servers</div>
          {bridgeSettings.servers.length > 0 ? (
            <div className="quick-connect-server-list">
              {bridgeSettings.servers.map((server) => {
                const active = sameEndpoint(
                  { bridgeHost: server.targetHost, bridgePort: server.targetPort },
                  draft,
                );
                return (
                  <button
                    key={server.id}
                    className={`quick-connect-server-item ${active ? 'active' : ''}`}
                    type="button"
                    onClick={() => handleServerPick(server.id)}
                  >
                    <strong>{server.name || server.targetHost}</strong>
                    <span>{formatBridgeEndpoint({ bridgeHost: server.targetHost, bridgePort: server.targetPort })}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="shell-connection-empty">还没有记住的服务器，直接手填下面三项。</div>
          )}
        </section>

        <section className="quick-connect-section">
          <div className="quick-connect-section-title">Server</div>
          <div className="quick-connect-form-grid triple">
            <label className="field-group">
              <span>IP / Host</span>
              <input
                className="input-control"
                value={draft.bridgeHost}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    bridgeHost: event.target.value,
                    sessionName: '',
                  }))
                }
                placeholder="100.86.84.63"
              />
            </label>

            <label className="field-group compact-field">
              <span>Port</span>
              <input
                className="input-control"
                type="number"
                value={draft.bridgePort}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    bridgePort: resolveEffectiveBridgePort({
                      bridgeHost: current.bridgeHost,
                      bridgePort: Number.parseInt(event.target.value, 10) || DEFAULT_BRIDGE_PORT,
                    }),
                    sessionName: '',
                  }))
                }
              />
            </label>

            <label className="field-group">
              <span>Token</span>
              <input
                className="input-control"
                value={draft.authToken}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    authToken: event.target.value,
                    sessionName: '',
                  }))
                }
                placeholder="wterm-xxxx"
              />
            </label>
          </div>

          <div className="quick-connect-actions">
            <button className="ghost-button" type="button" onClick={() => void discoverSessions()}>
              {discoveryState === 'loading' ? 'Loading…' : 'Load sessions'}
            </button>
            <button className="ghost-button" type="button" onClick={onOpenAdvanced}>
              Advanced
            </button>
          </div>
        </section>

        <section className="quick-connect-section">
          <div className="quick-connect-section-title">Sessions</div>
          <div className="quick-connect-status-line">
            {discoveryState === 'idle' && '点击 remembered server 或手填 server 信息后加载 session。'}
            {discoveryState === 'loading' && '正在拉取 tmux sessions…'}
            {discoveryState === 'error' && `拉取失败：${discoveryError}`}
            {discoveryState === 'done' && sessions.length === 0 && '当前服务器没有可用 session。'}
            {discoveryState === 'done' && sessions.length > 0 && `发现 ${sessions.length} 个 session。`}
          </div>

          {sessions.length > 0 ? (
            <div className="quick-connect-session-list">
              {sessions.map((session) => {
                const active = draft.sessionName === session;
                const sessionHost = hosts.find(
                  (host) => sameEndpoint(host, draft) && getResolvedSessionName(host) === session,
                );
                return (
                  <button
                    key={session}
                    className={`quick-connect-session-item ${active ? 'active' : ''}`}
                    type="button"
                    onClick={() => setDraft((current) => ({ ...current, sessionName: session }))}
                  >
                    <strong>{session}</strong>
                    <span>{sessionHost?.lastConnected ? '以前连过' : '首次连接'}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </section>
      </div>

      <div className="shell-overlay-footer quick-connect-footer">
        <div className="quick-connect-selection-summary">
          {draft.sessionName.trim()
            ? `${formatBridgeEndpoint(draft)} · ${draft.sessionName}${matchedHost ? ' · 已保存' : ''}`
            : '还没有选择 session'}
        </div>
        <button
          className="shell-primary-button"
          type="button"
          disabled={!canOpen}
          onClick={() => onOpen(buildEditableHostFromDraft(draft, matchedHost), matchedHost?.id)}
        >
          Open
        </button>
      </div>
    </div>
  );
}
