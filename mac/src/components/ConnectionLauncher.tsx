import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_HOST_DRAFT,
  type BridgeSettings,
  type EditableHost,
  type Host,
} from '@zterm/shared';

interface ConnectionLauncherProps {
  open: boolean;
  hosts: Host[];
  bridgeSettings: BridgeSettings;
  onClose: () => void;
  onOpenHost: (host: Host, append: boolean) => void;
  onSaveDraft: (draft: EditableHost, editingHostId?: string, connectAfterSave?: boolean) => void;
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
  onSaveDraft,
}: ConnectionLauncherProps) {
  const [editingHostId, setEditingHostId] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState<EditableHost>(() => buildDraftFromSettings(bridgeSettings));

  useEffect(() => {
    if (!open) {
      return;
    }
    setEditingHostId(undefined);
    setDraft(buildDraftFromSettings(bridgeSettings));
  }, [open, bridgeSettings]);

  const sortedHosts = useMemo(
    () => [...hosts].sort((left, right) => (right.lastConnected || 0) - (left.lastConnected || 0)),
    [hosts],
  );

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
          </section>

          <section className="mac-launcher-editor">
            <div className="mac-section-title">{editingHostId ? 'Edit host' : 'New host'}</div>
            <label className="mac-field">
              <span>Name</span>
              <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
            </label>
            <label className="mac-field">
              <span>Bridge host</span>
              <input value={draft.bridgeHost} onChange={(event) => setDraft((current) => ({ ...current, bridgeHost: event.target.value }))} />
            </label>
            <div className="mac-field-row">
              <label className="mac-field">
                <span>Bridge port</span>
                <input
                  value={String(draft.bridgePort || '')}
                  onChange={(event) => {
                    const value = Number.parseInt(event.target.value || '0', 10);
                    setDraft((current) => ({
                      ...current,
                      bridgePort: Number.isFinite(value) && value > 0 ? value : DEFAULT_HOST_DRAFT.bridgePort,
                    }));
                  }}
                />
              </label>
              <label className="mac-field">
                <span>Session name</span>
                <input value={draft.sessionName} onChange={(event) => setDraft((current) => ({ ...current, sessionName: event.target.value }))} />
              </label>
            </div>
            <label className="mac-field">
              <span>Auth token</span>
              <input value={draft.authToken || ''} onChange={(event) => setDraft((current) => ({ ...current, authToken: event.target.value }))} />
            </label>
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
              <button className="mac-secondary-button" type="button" onClick={() => onSaveDraft(draft, editingHostId, false)}>
                Save
              </button>
              <button className="mac-primary-button" type="button" onClick={() => onSaveDraft(draft, editingHostId, true)}>
                Save & connect
              </button>
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}
