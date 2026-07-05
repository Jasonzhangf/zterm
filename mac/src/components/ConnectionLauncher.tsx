import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_HOST_DRAFT,
  fetchTmuxSessions,
  type BridgeSettings,
  type BridgeTarget,
  type EditableHost,
  type Host,
} from '@zterm/shared';

interface ConnectionLauncherProps {
  open: boolean;
  hosts: Host[];
  bridgeSettings: BridgeSettings;
  onClose: () => void;
  onOpenHost: (host: Host, append: boolean) => void;
  onOpenLocalTmuxSession: (sessionName: string, append: boolean) => void;
  onSaveDraft: (draft: EditableHost, editingHostId?: string, connectAfterSave?: boolean) => void;
  sessionFetcher?: (target: BridgeTarget) => Promise<string[]>;
}

function buildDraftFromSettings(settings: BridgeSettings): EditableHost {
  return {
    ...DEFAULT_HOST_DRAFT,
    bridgeHost: settings.targetHost || '',
    bridgePort: settings.targetPort || DEFAULT_HOST_DRAFT.bridgePort,
    authToken: settings.targetAuthToken || '',
  };
}

export function ConnectionLauncher({
  open,
  hosts,
  bridgeSettings,
  onClose,
  onOpenHost,
  onOpenLocalTmuxSession,
  onSaveDraft,
  sessionFetcher = fetchTmuxSessions,
}: ConnectionLauncherProps) {
  const [editingHostId, setEditingHostId] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState<EditableHost>(() => buildDraftFromSettings(bridgeSettings));
  const [localTmuxSessions, setLocalTmuxSessions] = useState<string[]>([]);
  const [localTmuxError, setLocalTmuxError] = useState('');
  const [remoteSessions, setRemoteSessions] = useState<string[]>([]);
  const [selectedRemoteSession, setSelectedRemoteSession] = useState('');
  const [remoteDiscoveryState, setRemoteDiscoveryState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [remoteDiscoveryError, setRemoteDiscoveryError] = useState('');

  useEffect(() => {
    if (!open) {
      return;
    }
    setEditingHostId(undefined);
    setDraft(buildDraftFromSettings(bridgeSettings));
    setLocalTmuxError('');
    setRemoteSessions([]);
    setSelectedRemoteSession('');
    setRemoteDiscoveryState('idle');
    setRemoteDiscoveryError('');
    void window.ztermMac.localTmux.listSessions()
      .then((sessions) => setLocalTmuxSessions([...sessions].sort((left, right) => left.localeCompare(right))))
      .catch((error) => {
        setLocalTmuxSessions([]);
        setLocalTmuxError(error instanceof Error ? error.message : String(error));
      });
  }, [open, bridgeSettings]);

  const sortedHosts = useMemo(
    () => [...hosts].sort((left, right) => (right.lastConnected || 0) - (left.lastConnected || 0)),
    [hosts],
  );

  const clearRemoteDiscovery = () => {
    setRemoteSessions([]);
    setSelectedRemoteSession('');
    setRemoteDiscoveryState('idle');
    setRemoteDiscoveryError('');
  };

  const clearDiscoveredDraftSession = (current: EditableHost): EditableHost => {
    const discoveredSession = selectedRemoteSession.trim();
    if (!discoveredSession || current.sessionName.trim() !== discoveredSession) {
      return current;
    }
    return {
      ...current,
      sessionName: '',
      name: current.name.trim() === discoveredSession ? '' : current.name,
    };
  };

  const discoverRemoteSessions = async () => {
    const bridgeHost = draft.bridgeHost.trim();
    const authToken = draft.authToken?.trim() || '';
    if (!bridgeHost) {
      setRemoteSessions([]);
      setSelectedRemoteSession('');
      setRemoteDiscoveryState('error');
      setRemoteDiscoveryError('Bridge host is required to discover sessions');
      return;
    }
    if (!authToken) {
      setRemoteSessions([]);
      setSelectedRemoteSession('');
      setRemoteDiscoveryState('error');
      setRemoteDiscoveryError('Auth token is required to discover sessions');
      return;
    }

    setRemoteDiscoveryState('loading');
    setRemoteDiscoveryError('');
    try {
      const fetched = await sessionFetcher({
        bridgeHost,
        bridgePort: Math.max(1, Math.floor(draft.bridgePort || DEFAULT_HOST_DRAFT.bridgePort)),
        authToken,
      });
      const unique = Array.from(new Set(fetched.map((session) => session.trim()).filter(Boolean)))
        .sort((left, right) => left.localeCompare(right));
      const latestSaved = sortedHosts.find((host) =>
        host.bridgeHost.trim() === bridgeHost
        && host.bridgePort === Math.max(1, Math.floor(draft.bridgePort || DEFAULT_HOST_DRAFT.bridgePort))
        && unique.includes(host.sessionName.trim()),
      );
      const selected = latestSaved?.sessionName.trim() || unique[0] || '';
      setRemoteSessions(unique);
      setSelectedRemoteSession(selected);
      if (selected) {
        setDraft((current) => ({
          ...current,
          sessionName: selected,
          name: current.name?.trim() ? current.name : selected,
        }));
      }
      setRemoteDiscoveryState('done');
    } catch (error) {
      setRemoteSessions([]);
      setSelectedRemoteSession('');
      setRemoteDiscoveryState('error');
      setRemoteDiscoveryError(error instanceof Error ? error.message : String(error));
    }
  };

  const openDraft = (connectAfterSave: boolean) => {
    const selectedSession = selectedRemoteSession.trim() || draft.sessionName.trim();
    onSaveDraft({
      ...draft,
      sessionName: selectedSession,
      name: draft.name?.trim() || selectedSession || draft.bridgeHost.trim(),
    }, editingHostId, connectAfterSave);
  };

  if (!open) {
    return null;
  }

  return (
    <div className="mac-launcher-backdrop" role="presentation" onClick={onClose}>
      <section className="mac-launcher" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <header className="mac-launcher-header">
          <div>
            <h2>Open connection</h2>
            <p>先选 saved host，或者直接新建一个 target。</p>
          </div>
          <button className="mac-secondary-button" type="button" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="mac-launcher-grid">
          <section className="mac-launcher-saved">
            <div className="mac-section-title">Saved hosts</div>
            <div className="mac-saved-list">
              {sortedHosts.length === 0 ? (
                <div className="mac-empty-copy">还没有 saved host，右侧直接新建。</div>
              ) : null}
              {sortedHosts.map((host) => (
                <article className="mac-saved-card" key={host.id}>
                  <button className="mac-saved-open" type="button" onClick={() => onOpenHost(host, false)}>
                    <strong>{host.name || host.sessionName || host.bridgeHost}</strong>
                    <span>{host.bridgeHost}:{host.bridgePort} · {host.sessionName || 'session pending'}</span>
                  </button>
                  <div className="mac-saved-actions">
                    <button className="mac-chip-button" type="button" onClick={() => onOpenHost(host, true)}>
                      New tab
                    </button>
                    <button
                      className="mac-chip-button"
                      type="button"
                      onClick={() => {
                        setEditingHostId(host.id);
                        setDraft({
                          name: host.name,
                          bridgeHost: host.bridgeHost,
                          bridgePort: host.bridgePort,
                          sessionName: host.sessionName,
                          authToken: host.authToken || '',
                          authType: host.authType,
                          password: host.password || '',
                          privateKey: host.privateKey || '',
                          tags: host.tags,
                          pinned: host.pinned,
                          lastConnected: host.lastConnected,
                          autoCommand: host.autoCommand || '',
                        });
                      }}
                    >
                      Edit
                    </button>
                  </div>
                </article>
              ))}
            </div>

            <div className="mac-section-title">Local tmux</div>
            <div className="mac-saved-list">
              {localTmuxError ? <div className="mac-empty-copy">{localTmuxError}</div> : null}
              {!localTmuxError && localTmuxSessions.length === 0 ? (
                <div className="mac-empty-copy">没有可枚举的本地 tmux session。</div>
              ) : null}
              {localTmuxSessions.map((sessionName) => (
                <article className="mac-saved-card" key={sessionName}>
                  <button className="mac-saved-open" type="button" onClick={() => onOpenLocalTmuxSession(sessionName, false)}>
                    <strong>{sessionName}</strong>
                    <span>Local tmux session</span>
                  </button>
                  <div className="mac-saved-actions">
                    <button className="mac-chip-button" type="button" onClick={() => onOpenLocalTmuxSession(sessionName, true)}>
                      New tab
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="mac-launcher-editor">
            <div className="mac-section-title">{editingHostId ? 'Edit host' : 'New host'}</div>
            <label className="mac-field">
              <span>Name</span>
              <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
            </label>
            <label className="mac-field">
              <span>Bridge host</span>
              <input
                value={draft.bridgeHost}
                onChange={(event) => {
                  clearRemoteDiscovery();
                  setDraft((current) => ({
                    ...clearDiscoveredDraftSession(current),
                    bridgeHost: event.target.value,
                  }));
                }}
              />
            </label>
            <div className="mac-field-row">
              <label className="mac-field">
                <span>Bridge port</span>
                <input
                  value={String(draft.bridgePort || '')}
                  onChange={(event) => {
                    clearRemoteDiscovery();
                    const value = Number.parseInt(event.target.value || '0', 10);
                    setDraft((current) => ({
                      ...clearDiscoveredDraftSession(current),
                      bridgePort: Number.isFinite(value) && value > 0 ? value : DEFAULT_HOST_DRAFT.bridgePort,
                    }));
                  }}
                />
              </label>
              <label className="mac-field">
                <span>Session name</span>
                <input
                  value={draft.sessionName}
                  onChange={(event) => {
                    setSelectedRemoteSession('');
                    setRemoteDiscoveryError('');
                    setDraft((current) => ({ ...current, sessionName: event.target.value }));
                  }}
                />
              </label>
            </div>
            <label className="mac-field">
              <span>Auth token</span>
              <input
                value={draft.authToken || ''}
                onChange={(event) => {
                  clearRemoteDiscovery();
                  setDraft((current) => ({
                    ...clearDiscoveredDraftSession(current),
                    authToken: event.target.value,
                  }));
                }}
              />
            </label>
            <div className="mac-discovery-panel">
              <button
                className="mac-secondary-button"
                type="button"
                onClick={() => void discoverRemoteSessions()}
                disabled={remoteDiscoveryState === 'loading'}
              >
                {remoteDiscoveryState === 'loading' ? 'Discovering…' : 'Discover sessions'}
              </button>
              {remoteDiscoveryError ? <div className="mac-empty-copy">{remoteDiscoveryError}</div> : null}
              {remoteDiscoveryState === 'done' && remoteSessions.length === 0 ? (
                <div className="mac-empty-copy">No remote tmux sessions returned.</div>
              ) : null}
              {remoteSessions.length > 0 ? (
                <div className="mac-saved-list">
                  {remoteSessions.map((sessionName) => (
                    <label className="mac-saved-card" key={sessionName}>
                      <input
                        name={`mac-quick-session-${sessionName}`}
                        type="radio"
                        checked={selectedRemoteSession === sessionName}
                        onChange={() => {
                          setSelectedRemoteSession(sessionName);
                          setDraft((current) => ({
                            ...current,
                            sessionName,
                            name: current.name?.trim() ? current.name : sessionName,
                          }));
                        }}
                      />
                      <strong>{sessionName}</strong>
                      <span>Remote tmux session</span>
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
            <label className="mac-field">
              <span>Auto command</span>
              <input value={draft.autoCommand || ''} onChange={(event) => setDraft((current) => ({ ...current, autoCommand: event.target.value }))} />
            </label>
            <div className="mac-launcher-actions">
              {editingHostId ? (
                <button
                  className="mac-secondary-button"
                  type="button"
                  onClick={() => {
                    setEditingHostId(undefined);
                    setDraft(buildDraftFromSettings(bridgeSettings));
                  }}
                >
                  Reset
                </button>
              ) : null}
              <button className="mac-secondary-button" type="button" onClick={() => openDraft(false)}>
                Save
              </button>
              <button className="mac-primary-button" type="button" onClick={() => openDraft(true)}>
                Save & connect
              </button>
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}
