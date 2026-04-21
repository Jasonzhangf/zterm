import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DEFAULT_BRIDGE_PORT,
  fetchTmuxSessions,
  formatBridgeEndpoint,
  getDefaultBridgeServer,
  resolveEffectiveBridgePort,
  type BridgeSettings,
  type EditableHost,
  type Host,
} from '@zterm/shared';
import type { TerminalConnectionState } from '../lib/terminal-runtime';

interface DetailsSlotProps {
  host?: Host;
  draft?: Partial<EditableHost>;
  bridgeSettings: BridgeSettings;
  bridgeRuntime: TerminalConnectionState;
  isEditing: boolean;
  onSave: (hostData: EditableHost) => void;
  onCancel: () => void;
  onConnectRequested: (hostData: EditableHost) => void;
}

function buildInitialState(
  host: Host | undefined,
  draft: Partial<EditableHost> | undefined,
  bridgeSettings: BridgeSettings,
): EditableHost {
  return {
    name: host?.name || draft?.name || '',
    bridgeHost: host?.bridgeHost || draft?.bridgeHost || bridgeSettings.targetHost || '',
    bridgePort: host?.bridgePort || draft?.bridgePort || bridgeSettings.targetPort || DEFAULT_BRIDGE_PORT,
    sessionName: host?.sessionName || draft?.sessionName || '',
    authToken: host?.authToken || draft?.authToken || bridgeSettings.targetAuthToken || '',
    authType: (host?.authType || draft?.authType || 'password') as 'password' | 'key',
    password: host?.password || draft?.password || '',
    privateKey: host?.privateKey || draft?.privateKey || '',
    autoCommand: host?.autoCommand || draft?.autoCommand || '',
    tags: host?.tags || draft?.tags || [],
    pinned: host?.pinned || draft?.pinned || false,
    lastConnected: host?.lastConnected ?? draft?.lastConnected,
  };
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="form-section">
      <div className="form-section-header">
        <div className="form-section-title">{title}</div>
        <div className="form-section-copy">{description}</div>
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field-group">
      <span>{label}</span>
      {children}
    </label>
  );
}


function resolveDerivedConnectionName(form: Pick<EditableHost, 'name' | 'sessionName' | 'bridgeHost'>) {
  return form.name.trim() || form.sessionName.trim() || form.bridgeHost.trim();
}

function buildTargetKey(host: { bridgeHost: string; bridgePort: number; sessionName?: string; name?: string }) {
  return [
    formatBridgeEndpoint(host).toLowerCase(),
    (host.sessionName?.trim() || host.name?.trim() || '').toLowerCase(),
  ].join('::');
}

export function DetailsSlot({
  host,
  draft,
  bridgeSettings,
  bridgeRuntime,
  isEditing,
  onSave,
  onCancel,
  onConnectRequested,
}: DetailsSlotProps) {
  const [form, setForm] = useState<EditableHost>(() => buildInitialState(host, draft, bridgeSettings));
  const [tagInput, setTagInput] = useState('');
  const [availableSessions, setAvailableSessions] = useState<string[]>([]);
  const [sessionDiscoveryState, setSessionDiscoveryState] =
    useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [sessionDiscoveryError, setSessionDiscoveryError] = useState('');
  const defaultServer = useMemo(() => getDefaultBridgeServer(bridgeSettings), [bridgeSettings]);
  const currentDraftTargetKey = useMemo(() => buildTargetKey(form), [form]);
  const activeRuntimeTargetKey = useMemo(
    () => (bridgeRuntime.activeTarget ? buildTargetKey(bridgeRuntime.activeTarget) : ''),
    [bridgeRuntime.activeTarget],
  );
  const runtimeMatchesDraft = currentDraftTargetKey.length > 0 && currentDraftTargetKey === activeRuntimeTargetKey;

  useEffect(() => {
    setForm(buildInitialState(host, draft, bridgeSettings));
    setTagInput('');
    setAvailableSessions([]);
    setSessionDiscoveryState('idle');
    setSessionDiscoveryError('');
  }, [host, draft, bridgeSettings]);

  useEffect(() => {
    setAvailableSessions([]);
    setSessionDiscoveryState('idle');
    setSessionDiscoveryError('');
  }, [form.bridgeHost, form.bridgePort, form.authToken]);

  const handleAddTag = () => {
    const nextTag = tagInput.trim();
    if (!nextTag || form.tags.includes(nextTag)) {
      return;
    }

    setForm((current) => ({ ...current, tags: [...current.tags, nextTag] }));
    setTagInput('');
  };

  const handleBridgeHostChange = (bridgeHost: string) => {
    setForm((current) => ({
      ...current,
      bridgeHost,
      bridgePort: resolveEffectiveBridgePort({
        bridgeHost,
        bridgePort: current.bridgePort,
      }),
    }));
  };

  const handleSave = () => {
    const bridgeHost = form.bridgeHost.trim();
    const sessionName = form.sessionName.trim();
    const resolvedName = resolveDerivedConnectionName({
      name: form.name,
      sessionName,
      bridgeHost,
    });

    if (!bridgeHost) {
      window.alert('请填写 bridge 主机地址');
      return;
    }

    if (!resolvedName) {
      window.alert('至少填写 IP，或选择一个 session。');
      return;
    }

    onSave({
      ...form,
      name: resolvedName,
      bridgeHost,
      sessionName,
      authToken: form.authToken?.trim(),
      password: form.authType === 'password' ? form.password : undefined,
      privateKey: form.authType === 'key' ? form.privateKey : undefined,
      autoCommand: form.autoCommand?.trim(),
    });
  };

  const handleDiscoverSessions = async () => {
    const bridgeHost = form.bridgeHost.trim();
    const authToken = form.authToken?.trim();

    if (!bridgeHost) {
      setAvailableSessions([]);
      setSessionDiscoveryState('idle');
      setSessionDiscoveryError('先填写 bridge host，再点击 Connect。');
      return;
    }

    if (!authToken) {
      setAvailableSessions([]);
      setSessionDiscoveryState('idle');
      setSessionDiscoveryError('先填写 auth token，再点击 Connect。');
      return;
    }

    setSessionDiscoveryState('loading');
    setSessionDiscoveryError('');

    try {
      const sessions = await fetchTmuxSessions({
        bridgeHost,
        bridgePort: form.bridgePort,
        authToken,
      });
      setAvailableSessions(sessions);
      setSessionDiscoveryState('done');
    } catch (error) {
      setAvailableSessions([]);
      setSessionDiscoveryState('error');
      setSessionDiscoveryError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleConnect = () => {
    const bridgeHost = form.bridgeHost.trim();
    const sessionName = form.sessionName.trim();
    const resolvedName = resolveDerivedConnectionName({
      name: form.name,
      sessionName,
      bridgeHost,
    });

    if (!bridgeHost) {
      window.alert('先填写 bridge host，再点击 Connect。');
      return;
    }

    if (!sessionName) {
      window.alert('先选择一个 session，再点击 Connect。');
      return;
    }

    onConnectRequested({
      ...form,
      name: resolvedName,
      bridgeHost,
      sessionName,
      authToken: form.authToken?.trim(),
      autoCommand: form.autoCommand?.trim(),
      password: form.authType === 'password' ? form.password : undefined,
      privateKey: form.authType === 'key' ? form.privateKey : undefined,
    });
  };

  const bridgeLine = (() => {
    if (bridgeRuntime.status === 'idle') {
      return runtimeMatchesDraft && bridgeRuntime.error
        ? `Disconnected: ${bridgeRuntime.error}`
        : 'No live bridge connection yet.';
    }
    if (bridgeRuntime.status === 'connecting') {
      return runtimeMatchesDraft
        ? 'Connecting current draft to bridge...'
        : 'Another target is connecting in the terminal pane.';
    }
    if (bridgeRuntime.status === 'connected') {
      if (runtimeMatchesDraft) {
        return `Connected${bridgeRuntime.connectedSessionId ? ` · ${bridgeRuntime.connectedSessionId}` : ''}`;
      }
      const target = bridgeRuntime.activeTarget;
      return target
        ? `Connected to ${formatBridgeEndpoint(target)} · ${target.sessionName}`
        : 'Connected';
    }
    return `Connect failed: ${bridgeRuntime.error}`;
  })();
  const currentSessionLabel = form.sessionName.trim() || form.name.trim() || '未指定';

  return (
    <div className="details-slot">
      <div className="detail-section inspector-summary-card">
        <div className="detail-header">
          <div>
            <div className="detail-title">{host ? 'Edit connection' : 'New connection'}</div>
            <div className="detail-copy">
              连接配置继续复用 shared truth；这里只在需要时弹出，不常驻占空间。
            </div>
          </div>
          <div className="detail-actions">
            {isEditing ? (
              <button className="ghost-button" type="button" onClick={onCancel}>
                Cancel
              </button>
            ) : null}
            <button className="primary-button" type="button" onClick={handleSave}>
              Save
            </button>
          </div>
        </div>

        <div className="inspector-metric-grid">
          <div className="inspector-metric-card">
            <span className="inspector-metric-label">Target</span>
            <strong>{form.name.trim() || 'New connection'}</strong>
            <div className="inspector-metric-copy">{formatBridgeEndpoint({ bridgeHost: form.bridgeHost, bridgePort: form.bridgePort })}</div>
          </div>
          <div className="inspector-metric-card">
            <span className="inspector-metric-label">Session</span>
            <strong>{currentSessionLabel}</strong>
            <div className="inspector-metric-copy">tmux attach target</div>
          </div>
          <div className="inspector-metric-card">
            <span className="inspector-metric-label">Bridge</span>
            <strong className={`inspector-status-text ${bridgeRuntime.status}`}>{bridgeRuntime.status.toUpperCase()}</strong>
            <div className="inspector-metric-copy">{bridgeLine}</div>
          </div>
        </div>
      </div>

      <div className="form-grid">
        <Section title="General" description="Basic identity and grouping for this connection.">
          <Field label="Name">
            <input
              className="input-control"
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="可留空，默认用 session / IP"
            />
          </Field>

          <Field label="Tags">
            <div className="tag-input-row">
              <input
                className="input-control"
                value={tagInput}
                onChange={(event) => setTagInput(event.target.value)}
                placeholder="例如：home-lab"
              />
              <button className="ghost-button" type="button" onClick={handleAddTag}>
                Add
              </button>
            </div>
            <div className="tag-list">
              {form.tags.length > 0 ? (
                form.tags.map((tag) => (
                  <button
                    key={tag}
                    className="tag-button"
                    type="button"
                    onClick={() =>
                      setForm((current) => ({
                        ...current,
                        tags: current.tags.filter((item) => item !== tag),
                      }))
                    }
                  >
                    #{tag} ×
                  </button>
                ))
              ) : (
                <div className="muted-copy">No tags yet</div>
              )}
            </div>
          </Field>
        </Section>

        <Section
          title="Tmux Session"
          description="Optional tmux session name. Leave empty to fall back to the connection name."
        >
          <Field label="Session Name">
            <input
              className="input-control"
              value={form.sessionName}
              onChange={(event) => setForm((current) => ({ ...current, sessionName: event.target.value }))}
              placeholder="例如：fin"
            />
          </Field>
        </Section>

        {bridgeSettings.servers.length > 0 ? (
          <Section
            title="Remembered Servers"
            description={
              defaultServer
                ? `Saved server list. Default: ${defaultServer.name} (${defaultServer.targetHost}:${defaultServer.targetPort}).`
                : 'Saved server list. Click one to fill bridge host and port.'
            }
          >
            <div className="server-chip-list">
              {bridgeSettings.servers.map((server) => {
                const active = server.targetHost === form.bridgeHost && server.targetPort === form.bridgePort;
                return (
                  <button
                    key={server.id}
                    className={`server-chip-button ${active ? 'active' : ''}`}
                    type="button"
                    onClick={() =>
                      setForm((current) => ({
                        ...current,
                        bridgeHost: server.targetHost,
                        bridgePort: server.targetPort,
                        authToken: server.authToken || current.authToken,
                      }))
                    }
                  >
                    <strong>{server.name}</strong>
                    <span>
                      {server.targetHost}:{server.targetPort}
                    </span>
                  </button>
                );
              })}
            </div>
          </Section>
        ) : null}

        <Section title="Connection" description="Bridge address, Tailscale IP priority, and daemon auth token.">
          <Field label="Bridge Host / Tailscale IP *">
            <input
              className="input-control"
              value={form.bridgeHost}
              onChange={(event) => handleBridgeHostChange(event.target.value)}
              placeholder="100.127.23.27 或 macstudio.tailnet"
            />
          </Field>

          <div className="field-inline-grid">
            <Field label="Bridge Port">
              <input
                className="input-control"
                type="number"
                value={form.bridgePort}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    bridgePort: Number.parseInt(event.target.value, 10) || DEFAULT_BRIDGE_PORT,
                  }))
                }
              />
            </Field>

            <Field label="Bridge Auth Token">
              <input
                className="input-control"
                value={form.authToken || ''}
                onChange={(event) => setForm((current) => ({ ...current, authToken: event.target.value }))}
                placeholder="daemon 的共享 token"
              />
            </Field>
          </div>
        </Section>

        <Section
          title="Detected Tmux Sessions"
          description="填写好 host + token 后，显式点 Connect / Refresh 才会拉 tmux session。"
        >
          <div className="detail-actions inline">
            <button className="ghost-button" type="button" onClick={() => void handleDiscoverSessions()}>
              {sessionDiscoveryState === 'done' ? 'Refresh Sessions' : 'Discover Sessions'}
            </button>
            <button className="primary-button" type="button" onClick={handleConnect}>
              {runtimeMatchesDraft && bridgeRuntime.status === 'connected' ? 'Reconnect' : 'Connect'}
            </button>
          </div>
          <div className="status-stack">
            <div className="status-line">
              <strong>Discovery</strong>
              <span>
                {sessionDiscoveryState === 'idle' && (sessionDiscoveryError || 'Fill bridge host + token, then tap Discover Sessions.')}
                {sessionDiscoveryState === 'loading' && 'Loading tmux sessions...'}
                {sessionDiscoveryState === 'error' && `Failed to load tmux sessions: ${sessionDiscoveryError}`}
                {sessionDiscoveryState === 'done' && availableSessions.length === 0 && 'No existing tmux session on this server yet.'}
                {sessionDiscoveryState === 'done' && availableSessions.length > 0 && `Found ${availableSessions.length} session(s).`}
              </span>
            </div>
            <div className="status-line">
              <strong>Bridge</strong>
              <span>{bridgeLine}</span>
            </div>
          </div>
          {availableSessions.length > 0 ? (
            <div className="server-chip-list">
              {availableSessions.map((session) => (
                <button
                  key={session}
                  className={`server-chip-button ${session === form.sessionName ? 'active' : ''}`}
                  type="button"
                  onClick={() => setForm((current) => ({ ...current, sessionName: session }))}
                >
                  <strong>{session}</strong>
                  <span>Attach target</span>
                </button>
              ))}
            </div>
          ) : null}
        </Section>

        <Section title="Terminal" description="Commands to run right after tmux becomes ready.">
          <Field label="Auto Command">
            <input
              className="input-control"
              value={form.autoCommand || ''}
              onChange={(event) => setForm((current) => ({ ...current, autoCommand: event.target.value }))}
              placeholder="例如：tmux attach -t main"
            />
          </Field>
        </Section>

        <Section title="Appearance" description="Visual emphasis and card placement preferences.">
          <button
            className={`toggle-row ${form.pinned ? 'active' : ''}`}
            type="button"
            onClick={() => setForm((current) => ({ ...current, pinned: !current.pinned }))}
          >
            <span>Pin this connection to the top</span>
            <strong>{form.pinned ? 'ON' : 'OFF'}</strong>
          </button>
          <div className="muted-copy">
            Icon theme、preview style 等桌面扩展字段先不展开，这一版优先对齐 Android 的连接配置主链。
          </div>
        </Section>
      </div>
    </div>
  );
}
