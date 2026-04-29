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
  onOpenRemoteSessions: (items: Array<{ hostData: EditableHost; persistedHostId?: string }>) => void;
  onOpenLocalTmuxSessions: (sessionNames: string[]) => void;
  onOpenAdvanced: () => void;
}

interface QuickConnectDraft {
  bridgeHost: string;
  bridgePort: number;
  authToken: string;
}

type QuickConnectMode = 'pick' | 'local' | 'remote';

function sameEndpoint(a: { bridgeHost: string; bridgePort: number }, b: { bridgeHost: string; bridgePort: number }) {
  return a.bridgeHost.trim() === b.bridgeHost.trim() && a.bridgePort === b.bridgePort;
}

function resolveDraftFromSettings(settings: BridgeSettings): QuickConnectDraft {
  const defaultServer = getDefaultBridgeServer(settings) ?? settings.servers[0];
  return {
    bridgeHost: defaultServer?.targetHost || settings.targetHost || '',
    bridgePort: defaultServer?.targetPort || settings.targetPort || DEFAULT_BRIDGE_PORT,
    authToken: defaultServer?.authToken || settings.targetAuthToken || '',
  };
}

function buildEditableHostFromDraft(draft: QuickConnectDraft, sessionName: string, existingHost?: Host): EditableHost {
  const trimmedSessionName = sessionName.trim();
  const bridgeHost = draft.bridgeHost.trim();
  return {
    name: existingHost?.name || trimmedSessionName || bridgeHost,
    bridgeHost,
    bridgePort: draft.bridgePort,
    sessionName: trimmedSessionName,
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

function toggleSelection(current: string[], value: string) {
  return current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
}

export function QuickConnectSheet({
  bridgeSettings,
  hosts,
  onClose,
  onOpenRemoteSessions,
  onOpenLocalTmuxSessions,
  onOpenAdvanced,
}: QuickConnectSheetProps) {
  const [mode, setMode] = useState<QuickConnectMode>('pick');
  const [draft, setDraft] = useState<QuickConnectDraft>(() => resolveDraftFromSettings(bridgeSettings));
  const [sessions, setSessions] = useState<string[]>([]);
  const [selectedRemoteSessions, setSelectedRemoteSessions] = useState<string[]>([]);
  const [localSessions, setLocalSessions] = useState<string[]>([]);
  const [selectedLocalSessions, setSelectedLocalSessions] = useState<string[]>([]);
  const [localState, setLocalState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [localError, setLocalError] = useState('');
  const [discoveryState, setDiscoveryState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [discoveryError, setDiscoveryError] = useState('');

  useEffect(() => {
    setDraft(resolveDraftFromSettings(bridgeSettings));
    setSessions([]);
    setSelectedRemoteSessions([]);
    setDiscoveryState('idle');
    setDiscoveryError('');
  }, [bridgeSettings]);

  // T-A1: auto-discover remote sessions when entering remote mode with valid credentials
  useEffect(() => {
    if (mode !== 'remote') {
      return;
    }
    if (!draft.bridgeHost.trim() || !draft.authToken.trim()) {
      return;
    }
    if (discoveryState !== 'idle') {
      return;
    }
    void discoverSessions(draft);
  }, [mode]);

  const refreshLocalSessions = () => {
    setLocalState('loading');
    setLocalError('');
    void window.ztermMac.localTmux.listSessions()
      .then((nextSessions) => {
        setLocalSessions(nextSessions);
        setSelectedLocalSessions((current) => current.filter((session) => nextSessions.includes(session)));
        setLocalState('done');
      })
      .catch((error) => {
        setLocalSessions([]);
        setSelectedLocalSessions([]);
        setLocalState('error');
        setLocalError(error instanceof Error ? error.message : String(error));
      });
  };

  useEffect(() => {
    let cancelled = false;
    setLocalState('loading');
    setLocalError('');
    void window.ztermMac.localTmux.listSessions()
      .then((nextSessions) => {
        if (cancelled) {
          return;
        }
        setLocalSessions(nextSessions);
        setLocalState('done');
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setLocalSessions([]);
        setLocalState('error');
        setLocalError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
      setSelectedRemoteSessions([]);
      setDiscoveryState('error');
      setDiscoveryError('先填写 IP / host。');
      return;
    }
    if (!authToken) {
      setSessions([]);
      setSelectedRemoteSessions([]);
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

      setSelectedRemoteSessions(lastConnectedHost ? [getResolvedSessionName(lastConnectedHost)] : []);
    } catch (error) {
      setSessions([]);
      setSelectedRemoteSessions([]);
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
    };
    setDraft(nextDraft);
    setMode('remote');
    void discoverSessions(nextDraft);
  };

  const remoteSelectionSummary = selectedRemoteSessions.length > 0
    ? `${formatBridgeEndpoint(draft)} · 已选 ${selectedRemoteSessions.length} 个 session`
    : '还没有选择 remote session';
  const localSelectionSummary = selectedLocalSessions.length > 0
    ? `已选 ${selectedLocalSessions.length} 个本地 session`
    : '还没有选择本地 session';

  const handleOpenRemote = () => {
    if (selectedRemoteSessions.length === 0) {
      return;
    }
    const items = selectedRemoteSessions.map((sessionName) => {
      const existingHost = hosts.find(
        (host) => sameEndpoint(host, draft) && getResolvedSessionName(host) === sessionName,
      );
      return {
        hostData: buildEditableHostFromDraft(draft, sessionName, existingHost),
        persistedHostId: existingHost?.id,
      };
    });
    onOpenRemoteSessions(items);
  };

  const handleOpenLocal = () => {
    if (selectedLocalSessions.length === 0) {
      return;
    }
    onOpenLocalTmuxSessions(selectedLocalSessions);
  };

  return (
    <div className="shell-overlay-card quick-connect-sheet" onClick={(event) => event.stopPropagation()}>
      <div className="shell-overlay-header">
        <div>
          <strong>Open connection</strong>
          <span>
            {mode === 'pick'
              ? '先选 Local 还是 Remote，再进入第二级选择 session。'
              : mode === 'local'
                ? 'Local：直接勾选 session，一次打开多个 tab。'
                : 'Remote：先选 server / 输入鉴权，再勾选 session 打开。'}
          </span>
        </div>
        <div className="quick-connect-header-actions">
          {mode !== 'pick' ? (
            <button className="ghost-button" type="button" onClick={() => setMode('pick')}>
              Back
            </button>
          ) : null}
          <button className="shell-pane-icon-button" type="button" onClick={onClose}>
            ×
          </button>
        </div>
      </div>

      <div className="quick-connect-body">
        {mode === 'pick' ? (
          <div className="quick-connect-entry-grid">
            <button className="quick-connect-entry-card" type="button" onClick={() => setMode('local')}>
              <strong>Local</strong>
              <span>本机 tmux sessions</span>
              <em>{localState === 'done' ? `${localSessions.length} 个 session` : '读取本地 session'}</em>
            </button>
            <button className="quick-connect-entry-card" type="button" onClick={() => setMode('remote')}>
              <strong>Remote</strong>
              <span>远程 bridge / tmux sessions</span>
              <em>{bridgeSettings.servers.length} 个 remembered servers</em>
            </button>
          </div>
        ) : null}

        {mode === 'local' ? (
          <div className="quick-connect-mode-stack">
            <section className="quick-connect-section">
              <div className="quick-connect-section-head">
                <div>
                  <div className="quick-connect-section-title">Local sessions</div>
                  <div className="quick-connect-section-copy">勾选后一次打开多个 tab。</div>
                </div>
                <button className="ghost-button" type="button" onClick={refreshLocalSessions}>
                  Refresh
                </button>
              </div>

              {localState === 'loading' ? <div className="shell-connection-empty">正在拉取本地 tmux sessions…</div> : null}
              {localState === 'error' ? <div className="shell-connection-empty">{localError || '读取本地 tmux sessions 失败。'}</div> : null}
              {localState === 'done' && localSessions.length === 0 ? <div className="shell-connection-empty">本机当前没有 tmux session。</div> : null}

              {localSessions.length > 0 ? (
                <div className="quick-connect-checklist">
                  {localSessions.map((session) => {
                    const checked = selectedLocalSessions.includes(session);
                    return (
                      <label key={session} className={`quick-connect-check-item ${checked ? 'active' : ''}`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => setSelectedLocalSessions((current) => toggleSelection(current, session))}
                        />
                        <div className="quick-connect-check-copy">
                          <strong>{session}</strong>
                          <span>Open local tmux session as tab</span>
                        </div>
                      </label>
                    );
                  })}
                </div>
              ) : null}
            </section>
          </div>
        ) : null}

        {mode === 'remote' ? (
          <div className="quick-connect-mode-stack">
            <section className="quick-connect-section">
              <div className="quick-connect-section-head">
                <div>
                  <div className="quick-connect-section-title">Remembered servers</div>
                  <div className="quick-connect-section-copy">先点记住的 server，或者手填下面的远程信息。</div>
                </div>
              </div>

              {bridgeSettings.servers.length > 0 ? (
                <div className="quick-connect-card-grid">
                  {bridgeSettings.servers.map((server) => {
                    const active = sameEndpoint(
                      { bridgeHost: server.targetHost, bridgePort: server.targetPort },
                      draft,
                    );
                    return (
                      <button
                        key={server.id}
                        className={`quick-connect-mini-card ${active ? 'active' : ''}`}
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
              <div className="quick-connect-section-head">
                <div>
                  <div className="quick-connect-section-title">Remote bridge</div>
                  <div className="quick-connect-section-copy">只填 IP / 端口 / token，然后拉 session 列表。</div>
                </div>
                <div className="quick-connect-actions">
                  <button className="ghost-button" type="button" onClick={() => void discoverSessions()}>
                    {discoveryState === 'loading' ? 'Loading…' : 'Load sessions'}
                  </button>
                  <button className="ghost-button" type="button" onClick={onOpenAdvanced}>
                    Advanced
                  </button>
                </div>
              </div>

              <div className="quick-connect-form-grid triple">
                <label className="field-group">
                  <span>IP / Host</span>
                  <input
                    className="input-control"
                    value={draft.bridgeHost}
                    onChange={(event) => {
                      setDraft((current) => ({
                        ...current,
                        bridgeHost: event.target.value,
                      }));
                      setSelectedRemoteSessions([]);
                    }}
                    placeholder="100.86.84.63"
                  />
                </label>

                <label className="field-group compact-field">
                  <span>Port</span>
                  <input
                    className="input-control"
                    type="number"
                    value={draft.bridgePort}
                    onChange={(event) => {
                      setDraft((current) => ({
                        ...current,
                        bridgePort: resolveEffectiveBridgePort({
                          bridgeHost: current.bridgeHost,
                          bridgePort: Number.parseInt(event.target.value, 10) || DEFAULT_BRIDGE_PORT,
                        }),
                      }));
                      setSelectedRemoteSessions([]);
                    }}
                  />
                </label>

                <label className="field-group">
                  <span>Token</span>
                  <input
                    className="input-control"
                    value={draft.authToken}
                    onChange={(event) => {
                      setDraft((current) => ({
                        ...current,
                        authToken: event.target.value,
                      }));
                      setSelectedRemoteSessions([]);
                    }}
                    placeholder="wterm-xxxx"
                  />
                </label>
              </div>
            </section>

            <section className="quick-connect-section">
              <div className="quick-connect-section-head">
                <div>
                  <div className="quick-connect-section-title">Remote sessions</div>
                  <div className="quick-connect-section-copy">
                    {discoveryState === 'idle' && '先选 remembered server 或填好远程参数，再加载 session。'}
                    {discoveryState === 'loading' && '正在拉取 tmux sessions…'}
                    {discoveryState === 'error' && `拉取失败：${discoveryError}`}
                    {discoveryState === 'done' && sessions.length === 0 && '当前服务器没有可用 session。'}
                    {discoveryState === 'done' && sessions.length > 0 && `发现 ${sessions.length} 个 session。`}
                  </div>
                </div>
              </div>

              {sessions.length > 0 ? (
                <div className="quick-connect-checklist">
                  {sessions.map((session) => {
                    const checked = selectedRemoteSessions.includes(session);
                    const sessionHost = hosts.find(
                      (host) => sameEndpoint(host, draft) && getResolvedSessionName(host) === session,
                    );
                    return (
                      <label key={session} className={`quick-connect-check-item ${checked ? 'active' : ''}`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => setSelectedRemoteSessions((current) => toggleSelection(current, session))}
                        />
                        <div className="quick-connect-check-copy">
                          <strong>{session}</strong>
                          <span>{sessionHost?.lastConnected ? '以前连过' : '首次连接'}</span>
                        </div>
                      </label>
                    );
                  })}
                </div>
              ) : null}
            </section>
          </div>
        ) : null}
      </div>

      <div className="shell-overlay-footer quick-connect-footer">
        <div className="quick-connect-selection-summary">
          {mode === 'local' ? localSelectionSummary : mode === 'remote' ? remoteSelectionSummary : '选择 Local 或 Remote 进入下一层。'}
        </div>
        {mode === 'local' ? (
          <button
            className="shell-primary-button"
            type="button"
            disabled={selectedLocalSessions.length === 0}
            onClick={handleOpenLocal}
          >
            Open selected
          </button>
        ) : mode === 'remote' ? (
          <button
            className="shell-primary-button"
            type="button"
            disabled={selectedRemoteSessions.length === 0}
            onClick={handleOpenRemote}
          >
            Open selected
          </button>
        ) : (
          <button className="shell-primary-button" type="button" disabled>
            Open selected
          </button>
        )}
      </div>
    </div>
  );
}
