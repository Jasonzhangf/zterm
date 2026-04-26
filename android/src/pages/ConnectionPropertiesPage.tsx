import { useEffect, useMemo, useState } from 'react';
import { resolveEffectiveBridgePort, resolveNormalizedBridgeHost } from '@zterm/shared';
import { AppearanceSection } from '../components/connection-form/AppearanceSection';
import { AuthSection } from '../components/connection-form/AuthSection';
import { ConnectionSection } from '../components/connection-form/ConnectionSection';
import { ConnectionSectionFields } from '../components/connection-form/ConnectionSectionFields';
import { GeneralSection } from '../components/connection-form/GeneralSection';
import { RemoteAccessSection } from '../components/connection-form/RemoteAccessSection';
import { TerminalSection } from '../components/connection-form/TerminalSection';
import type { BridgeSettings } from '../lib/bridge-settings';
import { getDefaultBridgeServer } from '../lib/bridge-settings';
import { DEFAULT_BRIDGE_PORT } from '../lib/mobile-config';
import { mobileTheme } from '../lib/mobile-ui';
import { fetchTmuxSessions } from '../lib/tmux-sessions';
import type { Host } from '../lib/types';

interface ConnectionPropertiesPageProps {
  host?: Host;
  draft?: Partial<Omit<Host, 'id' | 'createdAt'>>;
  bridgeSettings: BridgeSettings;
  onSave: (hostData: Omit<Host, 'id' | 'createdAt'>) => void;
  onCancel: () => void;
}

function buildInitialState(
  host: Host | undefined,
  draft: Partial<Omit<Host, 'id' | 'createdAt'>> | undefined,
  bridgeSettings: BridgeSettings,
) {
  return {
    name: host?.name || draft?.name || '',
    bridgeHost: host?.bridgeHost || draft?.bridgeHost || bridgeSettings.targetHost || '',
    bridgePort: host?.bridgePort || draft?.bridgePort || bridgeSettings.targetPort || DEFAULT_BRIDGE_PORT,
    sessionName: host?.sessionName || draft?.sessionName || '',
    authToken: host?.authToken || draft?.authToken || bridgeSettings.targetAuthToken || '',
    tailscaleHost: host?.tailscaleHost || draft?.tailscaleHost || '',
    ipv6Host: host?.ipv6Host || draft?.ipv6Host || '',
    ipv4Host: host?.ipv4Host || draft?.ipv4Host || '',
    signalUrl: host?.signalUrl || draft?.signalUrl || bridgeSettings.signalUrl || '',
    transportMode: (host?.transportMode || draft?.transportMode || bridgeSettings.transportMode || 'auto') as 'auto' | 'websocket' | 'webrtc',
    authType: (host?.authType || draft?.authType || 'password') as 'password' | 'key',
    password: host?.password || draft?.password || '',
    privateKey: host?.privateKey || draft?.privateKey || '',
    autoCommand: host?.autoCommand || draft?.autoCommand || '',
    tags: host?.tags || draft?.tags || [],
    pinned: host?.pinned || draft?.pinned || false,
  };
}

export function ConnectionPropertiesPage({ host, draft, bridgeSettings, onSave, onCancel }: ConnectionPropertiesPageProps) {
  const [form, setForm] = useState(() => buildInitialState(host, draft, bridgeSettings));
  const [tagInput, setTagInput] = useState('');
  const [availableSessions, setAvailableSessions] = useState<string[]>([]);
  const [sessionDiscoveryState, setSessionDiscoveryState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [sessionDiscoveryError, setSessionDiscoveryError] = useState('');

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

  const pageTitle = useMemo(() => (host ? 'Edit Connection' : 'New Connection'), [host]);
  const defaultServer = useMemo(() => getDefaultBridgeServer(bridgeSettings), [bridgeSettings]);

  const handleAddTag = () => {
    const nextTag = tagInput.trim();
    if (!nextTag || form.tags.includes(nextTag)) return;
    setForm((current) => ({ ...current, tags: [...current.tags, nextTag] }));
    setTagInput('');
  };

  const handleBridgeHostChange = (bridgeHost: string) => {
    setForm((current) => ({
      ...current,
      bridgeHost: resolveNormalizedBridgeHost({
        bridgeHost,
        bridgePort: current.bridgePort,
      }),
      bridgePort: resolveEffectiveBridgePort({
        bridgeHost,
        bridgePort: current.bridgePort,
      }),
    }));
  };

  const handleSave = () => {
    if (!form.name.trim() || !form.bridgeHost.trim()) {
      alert('请填写必填字段：名称、bridge 主机地址');
      return;
    }

    onSave({
      name: form.name.trim(),
      bridgeHost: resolveNormalizedBridgeHost({
        bridgeHost: form.bridgeHost.trim(),
        bridgePort: form.bridgePort,
      }),
      bridgePort: resolveEffectiveBridgePort({
        bridgeHost: form.bridgeHost.trim(),
        bridgePort: form.bridgePort,
      }),
      sessionName: form.sessionName.trim(),
      authToken: form.authToken.trim(),
      tailscaleHost: form.tailscaleHost.trim(),
      ipv6Host: form.ipv6Host.trim(),
      ipv4Host: form.ipv4Host.trim(),
      signalUrl: form.signalUrl.trim(),
      transportMode: form.transportMode,
      authType: form.authType,
      password: form.authType === 'password' ? form.password : undefined,
      privateKey: form.authType === 'key' ? form.privateKey : undefined,
      autoCommand: form.autoCommand.trim(),
      tags: form.tags,
      pinned: form.pinned,
      lastConnected: host?.lastConnected ?? draft?.lastConnected,
    });
  };

  const handleDiscoverSessions = async () => {
    const bridgeHost = form.bridgeHost.trim();
    const authToken = form.authToken.trim();

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
      const sessions = await fetchTmuxSessions(
        {
          bridgeHost,
          bridgePort: form.bridgePort,
          authToken: form.authToken,
          tailscaleHost: form.tailscaleHost,
          ipv6Host: form.ipv6Host,
          ipv4Host: form.ipv4Host,
          signalUrl: form.signalUrl,
          transportMode: form.transportMode,
        },
        bridgeSettings,
      );
      setAvailableSessions(sessions);
      setSessionDiscoveryState('done');
      if (!form.sessionName.trim() && sessions.length === 1) {
        setForm((current) => ({ ...current, sessionName: sessions[0] }));
      }
    } catch (error) {
      setAvailableSessions([]);
      setSessionDiscoveryState('error');
      setSessionDiscoveryError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div
      data-testid="connection-properties-scroll"
      style={{
        minHeight: '100dvh',
        maxHeight: '100dvh',
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch',
        backgroundColor: mobileTheme.colors.lightBg,
        color: mobileTheme.colors.lightText,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          padding: `${mobileTheme.safeArea.top} 18px 18px`,
          backgroundColor: 'rgba(237, 242, 246, 0.94)',
          backdropFilter: 'blur(14px)',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          borderBottom: `1px solid ${mobileTheme.colors.lightBorder}`,
        }}
      >
        <button
          onClick={onCancel}
          style={{
            width: '56px',
            height: '56px',
            borderRadius: '20px',
            border: 'none',
            backgroundColor: '#ffffff',
            color: mobileTheme.colors.lightText,
            fontSize: '26px',
            boxShadow: mobileTheme.shadow.soft,
            cursor: 'pointer',
          }}
        >
          ×
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '20px', fontWeight: 800 }}>{pageTitle}</div>
          <div style={{ marginTop: '4px', fontSize: '13px', color: mobileTheme.colors.lightMuted }}>
            先从历史/tmux 预填，再在这里做最后确认。
          </div>
        </div>
        <button
          onClick={handleSave}
          style={{
            minWidth: '92px',
            height: '56px',
            borderRadius: '20px',
            border: 'none',
            backgroundColor: mobileTheme.colors.shell,
            color: '#ffffff',
            fontWeight: 800,
            boxShadow: mobileTheme.shadow.soft,
            cursor: 'pointer',
          }}
        >
          Save
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '18px 18px 32px' }}>
        <GeneralSection
          name={form.name}
          onNameChange={(name) => setForm((current) => ({ ...current, name }))}
          tagInput={tagInput}
          onTagInputChange={setTagInput}
          onAddTag={handleAddTag}
          tags={form.tags}
          onRemoveTag={(tag) => setForm((current) => ({ ...current, tags: current.tags.filter((item) => item !== tag) }))}
        />

        <AuthSection
          sessionName={form.sessionName}
          onSessionNameChange={(sessionName) => setForm((current) => ({ ...current, sessionName }))}
        />

        {bridgeSettings.servers.length > 0 && (
          <ConnectionSection
            title="Remembered Servers"
            description={
              defaultServer
                ? `Saved server list. Default server: ${defaultServer.name} (${defaultServer.targetHost}:${defaultServer.targetPort}).`
                : 'Saved server list. Tap one to fill bridge host and port.'
            }
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
              {bridgeSettings.servers.map((server) => {
                const active = server.targetHost === form.bridgeHost && server.targetPort === form.bridgePort;
                return (
                  <button
                    key={server.id}
                    onClick={() =>
                      setForm((current) => ({
                        ...current,
                        bridgeHost: server.targetHost,
                        bridgePort: server.targetPort,
                        authToken: server.authToken || current.authToken,
                      }))
                    }
                    style={{
                      border: 'none',
                      borderRadius: '16px',
                      padding: '12px 14px',
                      backgroundColor: active ? mobileTheme.colors.shell : '#ffffff',
                      color: active ? '#ffffff' : mobileTheme.colors.lightText,
                      boxShadow: mobileTheme.shadow.soft,
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ fontWeight: 800 }}>{server.name}</div>
                    <div style={{ fontSize: '12px', opacity: 0.8 }}>{server.targetHost}:{server.targetPort}</div>
                  </button>
                );
              })}
            </div>
          </ConnectionSection>
        )}

        <ConnectionSectionFields
          bridgeHost={form.bridgeHost}
          onBridgeHostChange={handleBridgeHostChange}
          bridgePort={form.bridgePort}
          onBridgePortChange={(bridgePort) => setForm((current) => ({ ...current, bridgePort }))}
          authToken={form.authToken}
          onAuthTokenChange={(authToken) => setForm((current) => ({ ...current, authToken }))}
        />

        <RemoteAccessSection
          transportMode={form.transportMode}
          onTransportModeChange={(transportMode) => setForm((current) => ({ ...current, transportMode }))}
          tailscaleHost={form.tailscaleHost}
          onTailscaleHostChange={(tailscaleHost) => setForm((current) => ({ ...current, tailscaleHost }))}
          ipv6Host={form.ipv6Host}
          onIpv6HostChange={(ipv6Host) => setForm((current) => ({ ...current, ipv6Host }))}
          ipv4Host={form.ipv4Host}
          onIpv4HostChange={(ipv4Host) => setForm((current) => ({ ...current, ipv4Host }))}
          signalUrl={form.signalUrl}
          onSignalUrlChange={(signalUrl) => setForm((current) => ({ ...current, signalUrl }))}
          defaults={bridgeSettings}
        />

        <ConnectionSection
          title="Detected Tmux Sessions"
          description="填写好 host + token 后，显式点 Connect / Refresh 才会拉 tmux session。"
        >
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '12px' }}>
            <button
              onClick={() => void handleDiscoverSessions()}
              style={{
                minWidth: '132px',
                minHeight: '42px',
                borderRadius: '14px',
                border: 'none',
                backgroundColor: mobileTheme.colors.shell,
                color: '#ffffff',
                fontWeight: 800,
                cursor: 'pointer',
                boxShadow: mobileTheme.shadow.soft,
              }}
            >
              {sessionDiscoveryState === 'done' ? 'Refresh Sessions' : 'Connect'}
            </button>
          </div>
          <div style={{ color: mobileTheme.colors.lightMuted, lineHeight: 1.6 }}>
            {sessionDiscoveryState === 'idle' && (sessionDiscoveryError || 'Fill bridge host + token, then tap Connect.')}
            {sessionDiscoveryState === 'loading' && 'Loading tmux sessions...'}
            {sessionDiscoveryState === 'error' && `Failed to load tmux sessions: ${sessionDiscoveryError}`}
            {sessionDiscoveryState === 'done' && availableSessions.length === 0 && 'No existing tmux session on this server yet.'}
          </div>

          {availableSessions.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
              {availableSessions.map((session) => {
                const active = session === form.sessionName;
                return (
                  <button
                    key={session}
                    onClick={() => setForm((current) => ({ ...current, sessionName: session }))}
                    style={{
                      border: 'none',
                      borderRadius: '16px',
                      padding: '12px 14px',
                      backgroundColor: active ? mobileTheme.colors.shell : '#ffffff',
                      color: active ? '#ffffff' : mobileTheme.colors.lightText,
                      boxShadow: mobileTheme.shadow.soft,
                      cursor: 'pointer',
                      fontWeight: 700,
                    }}
                  >
                    {session}
                  </button>
                );
              })}
            </div>
          )}
        </ConnectionSection>

        <TerminalSection
          autoCommand={form.autoCommand}
          onAutoCommandChange={(autoCommand) => setForm((current) => ({ ...current, autoCommand }))}
        />

        <AppearanceSection
          pinned={form.pinned}
          onPinnedChange={(pinned) => setForm((current) => ({ ...current, pinned }))}
        />
      </div>
    </div>
  );
}
