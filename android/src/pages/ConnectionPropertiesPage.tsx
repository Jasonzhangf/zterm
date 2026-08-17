import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import {
  buildConnectionConfigShareLink,
  resolveEffectiveBridgePort,
  resolveNormalizedBridgeHost,
} from '@zterm/shared';
import { AppearanceSection } from '../components/connection-form/AppearanceSection';
import { AuthSection } from '../components/connection-form/AuthSection';
import { ConnectionSection } from '../components/connection-form/ConnectionSection';
import { ConnectionSectionFields } from '../components/connection-form/ConnectionSectionFields';
import { GeneralSection } from '../components/connection-form/GeneralSection';
import { RelayDevicePicker } from '../components/connection-form/RelayDevicePicker';
import { RemoteAccessSection } from '../components/connection-form/RemoteAccessSection';
import { TerminalSection } from '../components/connection-form/TerminalSection';
import { ZtermDialog } from '../components/terminal/ZtermDialog';
import { useTraversalRelayDaemonDevices } from '../hooks/useTraversalRelayDaemonDevices';
import type { BridgeSettings } from '../lib/bridge-settings';
import { getDefaultBridgeServer, resolveBridgePresetDaemonHostId } from '../lib/bridge-settings';
import { buildBridgeServerPresetViews } from '../lib/bridge-server-presets-view';
import { DEFAULT_BRIDGE_PORT } from '../lib/mobile-config';
import { mobileTheme } from '../lib/mobile-ui';
import { findBridgePresetForDaemonHostId, resolveRelayDeviceBridgeTarget } from '../lib/session-picker';
import { fetchTmuxSessions } from '../lib/tmux-sessions';
import { normalizeRemoteTmuxSessionNames } from '../lib/tmux-session-list';
import type { ConfigShareQuickAction, ConfigShareShortcutAction, Host, TraversalRelayDeviceSnapshot } from '../lib/types';

type ShareScope = 'all' | 'single';

const EMPTY_SHAREABLE_HOSTS: Host[] = [];
const EMPTY_QUICK_ACTIONS: ConfigShareQuickAction[] = [];
const EMPTY_SHORTCUT_ACTIONS: ConfigShareShortcutAction[] = [];

interface ConnectionPropertiesPageProps {
  host?: Host;
  draft?: Partial<Omit<Host, 'id' | 'createdAt'>>;
  shareableHosts?: Host[];
  quickActions?: ConfigShareQuickAction[];
  shortcutActions?: ConfigShareShortcutAction[];
  bridgeSettings: BridgeSettings;
  onImportConnectionLink?: (input: string) => { ok: true; name: string } | { ok: false; error: string };
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
    daemonHostId: host?.daemonHostId || draft?.daemonHostId || host?.relayHostId || draft?.relayHostId || '',
    sessionName: host?.sessionName || draft?.sessionName || '',
    authToken: host?.authToken || draft?.authToken || bridgeSettings.targetAuthToken || '',
    relayHostId: host?.relayHostId || draft?.relayHostId || '',
    relayDeviceId: host?.relayDeviceId || draft?.relayDeviceId || '',
    tailscaleHost: host?.tailscaleHost || draft?.tailscaleHost || '',
    ipv6Host: host?.ipv6Host || draft?.ipv6Host || '',
    ipv4Host: host?.ipv4Host || draft?.ipv4Host || '',
    transportMode: (host?.transportMode || draft?.transportMode || bridgeSettings.transportMode || 'auto') as 'auto' | 'websocket' | 'webrtc',
    authType: 'password' as const,
    password: '',
    privateKey: '',
    autoCommand: host?.autoCommand || draft?.autoCommand || '',
    tags: host?.tags || draft?.tags || [],
    pinned: host?.pinned || draft?.pinned || false,
  };
}

export function ConnectionPropertiesPage({
  host,
  draft,
  shareableHosts = EMPTY_SHAREABLE_HOSTS,
  quickActions = EMPTY_QUICK_ACTIONS,
  shortcutActions = EMPTY_SHORTCUT_ACTIONS,
  bridgeSettings,
  onImportConnectionLink,
  onSave,
  onCancel,
}: ConnectionPropertiesPageProps) {
  const [form, setForm] = useState(() => buildInitialState(host, draft, bridgeSettings));
  const [tagInput, setTagInput] = useState('');
  const [availableSessions, setAvailableSessions] = useState<string[]>([]);
  const [sessionDiscoveryState, setSessionDiscoveryState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [sessionDiscoveryError, setSessionDiscoveryError] = useState('');
  const [connectionImportInput, setConnectionImportInput] = useState('');
  const [connectionImportStatus, setConnectionImportStatus] = useState('');
  const [shareScope, setShareScope] = useState<ShareScope>('all');
  const [selectedShareHostId, setSelectedShareHostId] = useState('');
  const [shareQrSvg, setShareQrSvg] = useState('');
  const [shareState, setShareState] = useState<'idle' | 'copied' | 'error'>('idle');
  const [shareError, setShareError] = useState('');
  const [formDialog, setFormDialog] = useState<string | null>(null);
  const { devices: relayDevices, refresh: refreshRelayDevices } = useTraversalRelayDaemonDevices(
    Boolean(bridgeSettings.traversalRelay?.accessToken),
  );
  useEffect(() => {
    setForm(buildInitialState(host, draft, bridgeSettings));
    setTagInput('');
    setAvailableSessions([]);
    setSessionDiscoveryState('idle');
    setSessionDiscoveryError('');
    refreshRelayDevices();
  }, [host, draft, bridgeSettings, refreshRelayDevices]);

  useEffect(() => {
    setAvailableSessions([]);
    setSessionDiscoveryState('idle');
    setSessionDiscoveryError('');
  }, [form.bridgeHost, form.bridgePort, form.authToken, form.daemonHostId, form.relayHostId, form.relayDeviceId]);

  const pageTitle = useMemo(() => (host ? 'Edit Connection' : 'New Connection'), [host]);
  const selectedShareHost = useMemo(
    () => shareableHosts.find((candidate) => candidate.id === selectedShareHostId),
    [selectedShareHostId, shareableHosts],
  );
  const shareSourceHosts = useMemo(() => {
    if (host) {
      return [host];
    }
    if (shareScope === 'single' && selectedShareHost) {
      return [selectedShareHost];
    }
    return shareableHosts;
  }, [host, selectedShareHost, shareScope, shareableHosts]);
  const shareExportedAt = useMemo(
    () => Math.max(...shareSourceHosts.map((candidate) => candidate.lastConnected || candidate.createdAt || 0), 0),
    [shareSourceHosts],
  );
  const shareLink = useMemo(
    () => shareSourceHosts.length > 0
      ? buildConnectionConfigShareLink({
          hosts: shareSourceHosts,
          quickActions: host || shareScope === 'single' ? [] : quickActions,
          shortcutActions: host || shareScope === 'single' ? [] : shortcutActions,
          exportedAt: shareExportedAt,
        })
      : '',
    [host, quickActions, shareExportedAt, shareScope, shareSourceHosts, shortcutActions],
  );
  const shareTitle = host
    ? 'Share Current Connection'
    : shareScope === 'single' && selectedShareHost
      ? `Share Single Connection: ${selectedShareHost.name}`
      : `Share All Connections: ${shareableHosts.length}`;
  const defaultServer = useMemo(() => getDefaultBridgeServer(bridgeSettings), [bridgeSettings]);
  const rememberedServerViews = useMemo(() => buildBridgeServerPresetViews(bridgeSettings.servers), [bridgeSettings.servers]);
  const selectedDaemonHostId = (form.daemonHostId || form.relayHostId).trim();
  const daemonBoundServer = useMemo(
    () => findBridgePresetForDaemonHostId(bridgeSettings.servers, selectedDaemonHostId),
    [bridgeSettings.servers, selectedDaemonHostId],
  );

  useEffect(() => {
    if (host || shareScope !== 'single' || !selectedShareHostId) {
      return;
    }
    if (!shareableHosts.some((candidate) => candidate.id === selectedShareHostId)) {
      setSelectedShareHostId('');
      setShareScope('all');
    }
  }, [host, selectedShareHostId, shareScope, shareableHosts]);

  useEffect(() => {
    let cancelled = false;
    setShareQrSvg('');
    setShareState('idle');
    setShareError('');
    if (!shareLink) {
      return () => {
        cancelled = true;
      };
    }
    QRCode.toString(shareLink, {
      type: 'svg',
      margin: 1,
      width: 192,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#101218',
        light: '#ffffff',
      },
    })
      .then((svg) => {
        if (!cancelled) {
          setShareQrSvg(svg);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setShareState('error');
          setShareError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [shareLink]);

  const applyDaemonSelection = (device: TraversalRelayDeviceSnapshot) => {
    const mappedTarget = resolveRelayDeviceBridgeTarget(bridgeSettings.servers, device);
    setForm((current) => ({
      ...current,
      daemonHostId: device.daemon.hostId.trim(),
      relayHostId: device.daemon.hostId.trim(),
      relayDeviceId: device.deviceId.trim(),
      bridgeHost: mappedTarget?.bridgeHost || '',
      bridgePort: mappedTarget?.bridgePort || DEFAULT_BRIDGE_PORT,
      authToken: mappedTarget?.authToken || '',
    }));
  };

  const clearDaemonSelection = () => {
    setForm((current) => ({
      ...current,
      daemonHostId: '',
      relayHostId: '',
      relayDeviceId: '',
      bridgeHost: '',
      bridgePort: DEFAULT_BRIDGE_PORT,
      authToken: '',
    }));
  };

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
    if (!form.name.trim()) {
      setFormDialog('请填写必填字段：名称');
      return;
    }

    if (!form.bridgeHost.trim()) {
      setFormDialog('请填写必填字段：bridge 主机地址');
      return;
    }

    if (
      form.transportMode === 'webrtc'
      && bridgeSettings.traversalRelay?.accessToken
      && !form.relayHostId.trim()
    ) {
      setFormDialog('RTC First 模式下请先选择一个在线的 Relay Daemon 设备');
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
      daemonHostId: form.daemonHostId.trim() || form.relayHostId.trim(),
      sessionName: form.sessionName.trim(),
      authToken: form.authToken.trim(),
      relayHostId: form.relayHostId.trim(),
      relayDeviceId: form.relayDeviceId.trim(),
      tailscaleHost: form.tailscaleHost.trim(),
      ipv6Host: form.ipv6Host.trim(),
      ipv4Host: form.ipv4Host.trim(),
      transportMode: form.transportMode,
      authType: 'password',
      password: undefined,
      privateKey: undefined,
      autoCommand: form.autoCommand.trim(),
      tags: form.tags,
      pinned: form.pinned,
      lastConnected: host?.lastConnected ?? draft?.lastConnected,
    });
  };

  const handleCopyShareLink = async () => {
    if (!shareLink) return;
    if (!navigator.clipboard?.writeText) {
      setShareState('error');
      setShareError('系统剪贴板不可用，无法复制分享链接。');
      return;
    }
    try {
      await navigator.clipboard.writeText(shareLink);
      setShareState('copied');
      setShareError('');
    } catch (error) {
      setShareState('error');
      setShareError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleImportConnectionLink = () => {
    if (!onImportConnectionLink) {
      setConnectionImportStatus('当前版本未启用连接导入入口。');
      return;
    }
    const result = onImportConnectionLink(connectionImportInput);
    if (!result.ok) {
      setConnectionImportStatus(`Import failed: ${result.error}`);
      return;
    }
    setConnectionImportInput('');
    setConnectionImportStatus(`Imported ${result.name}`);
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

    if (
      form.transportMode === 'webrtc'
      && bridgeSettings.traversalRelay?.accessToken
      && !form.relayHostId.trim()
    ) {
      setAvailableSessions([]);
      setSessionDiscoveryState('idle');
      setSessionDiscoveryError('RTC First 模式下请先在 Relay Daemon 区选择一个在线设备。');
      return;
    }

    setSessionDiscoveryState('loading');
    setSessionDiscoveryError('');
    try {
      const sessions = normalizeRemoteTmuxSessionNames(await fetchTmuxSessions(
        {
          bridgeHost,
          bridgePort: form.bridgePort,
          daemonHostId: form.daemonHostId,
          authToken: form.authToken,
          relayHostId: form.relayHostId,
          relayDeviceId: form.relayDeviceId,
          tailscaleHost: form.tailscaleHost,
          ipv6Host: form.ipv6Host,
          ipv4Host: form.ipv4Host,
          transportMode: form.transportMode,
        },
        bridgeSettings,
      ));
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
    <>
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
        {!host && (
          <ConnectionSection
            title="Import / Share Existing"
            description="从另一台设备粘贴分享链接导入，或选择当前已有连接生成同一份二维码/链接。"
          >
            <div style={{ display: 'grid', gap: '14px' }}>
              <div style={{ display: 'grid', gap: '10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: '15px', fontWeight: 900 }}>Import Connection</div>
                    <div style={{ marginTop: '4px', fontSize: '12px', color: mobileTheme.colors.lightMuted }}>
                      Paste a zterm share link from another device.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleImportConnectionLink}
                    style={{
                      border: 'none',
                      borderRadius: '16px',
                      minHeight: '42px',
                      padding: '0 14px',
                      backgroundColor: mobileTheme.colors.shell,
                      color: '#ffffff',
                      fontWeight: 900,
                      cursor: 'pointer',
                    }}
                  >
                    Import
                  </button>
                </div>
                <textarea
                  aria-label="Connection share link"
                  value={connectionImportInput}
                  onChange={(event) => {
                    setConnectionImportInput(event.target.value);
                    setConnectionImportStatus('');
                  }}
                  placeholder="zterm://connection/import?payload=..."
                  rows={3}
                  style={{
                    width: '100%',
                    border: `1px solid ${mobileTheme.colors.lightBorder}`,
                    borderRadius: '18px',
                    padding: '12px 14px',
                    backgroundColor: '#f6f8fb',
                    color: mobileTheme.colors.lightText,
                    boxSizing: 'border-box',
                    resize: 'vertical',
                  }}
                />
                {connectionImportStatus && (
                  <div
                    role="status"
                    style={{
                      fontSize: '12px',
                      color: connectionImportStatus.startsWith('Import failed')
                        ? mobileTheme.colors.danger
                        : mobileTheme.colors.lightMuted,
                    }}
                  >
                    {connectionImportStatus}
                  </div>
                )}
              </div>

              <div style={{ display: 'grid', gap: '10px' }}>
                <div>
                  <div style={{ fontSize: '15px', fontWeight: 900 }}>Share Existing Connections</div>
                  <div style={{ marginTop: '4px', fontSize: '12px', color: mobileTheme.colors.lightMuted }}>
                    By default this shares all saved connections. Select one only when you need a narrowed single-connection link.
                  </div>
                </div>
                {shareableHosts.length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                    {shareableHosts.map((candidate) => {
                      const active = candidate.id === selectedShareHostId;
                      return (
                        <button
                          key={candidate.id}
                          type="button"
                          onClick={() => {
                            setShareScope('single');
                            setSelectedShareHostId(candidate.id);
                          }}
                          style={{
                            border: 'none',
                            borderRadius: '16px',
                            padding: '12px 14px',
                            backgroundColor: active ? mobileTheme.colors.shell : '#ffffff',
                            color: active ? '#ffffff' : mobileTheme.colors.lightText,
                            boxShadow: mobileTheme.shadow.soft,
                            cursor: 'pointer',
                            textAlign: 'left',
                          }}
                        >
                          <div style={{ fontWeight: 800 }}>{candidate.name}</div>
                          <div style={{ fontSize: '12px', opacity: 0.8 }}>
                            {candidate.bridgeHost}:{candidate.bridgePort}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ fontSize: '13px', color: mobileTheme.colors.lightMuted }}>
                    No saved connection available to share yet.
                  </div>
                )}
              </div>
            </div>
          </ConnectionSection>
        )}

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

        {rememberedServerViews.length > 0 && (
          <ConnectionSection
            title="Remembered Servers"
            description={
              defaultServer
                ? `Saved bridge entrypoints. Default: ${defaultServer.name}${resolveBridgePresetDaemonHostId(defaultServer) ? ` · daemon ${resolveBridgePresetDaemonHostId(defaultServer)}` : ''} (${defaultServer.targetHost}:${defaultServer.targetPort}).`
                : 'Saved bridge entrypoints. Tap one to fill bridge host and port.'
            }
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
              {rememberedServerViews.map(({ server, daemonHostId, bridgeLabel, daemonLabel }) => {
                const active = server.targetHost === form.bridgeHost && server.targetPort === form.bridgePort;
                return (
                  <button
                    key={server.id}
                    onClick={() =>
                      setForm((current) => ({
                        ...current,
                        bridgeHost: server.targetHost,
                        bridgePort: server.targetPort,
                        daemonHostId: daemonHostId || current.daemonHostId,
                        authToken: server.authToken || current.authToken,
                        relayHostId: daemonHostId || current.relayHostId,
                        relayDeviceId: server.relayDeviceId || current.relayDeviceId,
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
                    <div style={{ fontSize: '12px', opacity: 0.8 }}>{bridgeLabel}</div>
                    {daemonHostId ? (
                      <div style={{ fontSize: '11px', opacity: 0.74 }}>{daemonLabel}</div>
                    ) : null}
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

        {selectedDaemonHostId ? (
          <ConnectionSection
            title="Daemon Bridge Binding"
            description={daemonBoundServer
              ? '当前 daemon 已绑定 bridge preset；直连字段仍可手工修改。'
              : '当前 daemon 尚未绑定 bridge preset；直连字段保存后会写入连接列表。'}
          >
            {daemonBoundServer ? (
              <div
                style={{
                  borderRadius: '18px',
                  backgroundColor: '#ffffff',
                  padding: '14px 16px',
                  display: 'grid',
                  gap: '6px',
                  boxShadow: mobileTheme.shadow.soft,
                  fontSize: '12px',
                  color: mobileTheme.colors.lightMuted,
                }}
              >
                <div style={{ fontSize: '14px', fontWeight: 800, color: mobileTheme.colors.lightText }}>
                  当前绑定：{daemonBoundServer.name}
                </div>
                <div>daemonHostId: {selectedDaemonHostId}</div>
                <div>bridgeHost: {daemonBoundServer.targetHost}</div>
                <div>bridgePort: {daemonBoundServer.targetPort}</div>
                <div>authToken: {daemonBoundServer.authToken?.trim() ? '已绑定' : '未绑定'}</div>
              </div>
            ) : (
              <div style={{ fontSize: '13px', color: mobileTheme.colors.lightMuted, lineHeight: 1.6 }}>
                当前选中的 daemon 还没有绑定 bridge preset。请在上方填写 bridge host 和 token，保存后会写入连接列表。
              </div>
            )}
          </ConnectionSection>
        ) : null}

        <RemoteAccessSection
          transportMode={form.transportMode}
          onTransportModeChange={(transportMode) => setForm((current) => ({ ...current, transportMode }))}
          relayBound={Boolean(bridgeSettings.traversalRelay?.accessToken)}
          tailscaleHost={form.tailscaleHost}
          onTailscaleHostChange={(tailscaleHost) => setForm((current) => ({ ...current, tailscaleHost }))}
          ipv6Host={form.ipv6Host}
          onIpv6HostChange={(ipv6Host) => setForm((current) => ({ ...current, ipv6Host }))}
          ipv4Host={form.ipv4Host}
          onIpv4HostChange={(ipv4Host) => setForm((current) => ({ ...current, ipv4Host }))}
        />

        <RelayDevicePicker
          relayEnabled={Boolean(bridgeSettings.traversalRelay?.accessToken)}
          devices={relayDevices}
          selectedRelayHostId={form.relayHostId}
          selectedRelayDeviceId={form.relayDeviceId}
          onSelect={applyDaemonSelection}
          onClear={clearDaemonSelection}
        />

        <ConnectionSection
          title="Detected Tmux Sessions"
          description={'填写好 host + token 后，显式点 Connect / Refresh 才会拉 tmux session。'}
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

        {shareLink && (
          <ConnectionSection
            title="Share Connection"
            description={host
              ? '生成当前连接的分享链接；二维码只是这条链接的投影，不包含密码或私钥。'
              : '默认生成全部已保存连接和快捷指令配置的分享链接；二维码只是这条链接的投影，不包含密码或私钥。'}
          >
            <div style={{ display: 'grid', gap: '14px' }}>
              <div style={{ fontSize: '15px', fontWeight: 900, color: mobileTheme.colors.lightText }}>
                {shareTitle}
              </div>
              {shareQrSvg ? (
                <div
                  data-testid="connection-share-qr"
                  aria-label="Connection share QR code"
                  style={{
                    width: '216px',
                    minHeight: '216px',
                    borderRadius: '24px',
                    backgroundColor: '#ffffff',
                    boxShadow: mobileTheme.shadow.soft,
                    border: `1px solid ${mobileTheme.colors.lightBorder}`,
                    display: 'grid',
                    placeItems: 'center',
                    padding: '12px',
                    overflow: 'hidden',
                  }}
                  dangerouslySetInnerHTML={{ __html: shareQrSvg }}
                />
              ) : (
                <div
                  data-testid="connection-share-qr"
                  aria-label="Connection share QR code"
                  style={{
                    width: '216px',
                    minHeight: '216px',
                    borderRadius: '24px',
                    backgroundColor: '#ffffff',
                    boxShadow: mobileTheme.shadow.soft,
                    border: `1px solid ${mobileTheme.colors.lightBorder}`,
                    display: 'grid',
                    placeItems: 'center',
                    padding: '12px',
                    overflow: 'hidden',
                  }}
                >
                  <span style={{ color: mobileTheme.colors.lightMuted, fontSize: '12px' }}>
                    QR building...
                  </span>
                </div>
              )}
              <textarea
                data-testid="connection-share-link"
                readOnly
                value={shareLink}
                rows={4}
                style={{
                  width: '100%',
                  border: `1px solid ${mobileTheme.colors.lightBorder}`,
                  borderRadius: '18px',
                  padding: '12px 14px',
                  backgroundColor: '#ffffff',
                  color: mobileTheme.colors.lightText,
                  fontSize: '12px',
                  lineHeight: 1.5,
                  resize: 'vertical',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                {!host && shareScope === 'single' && shareableHosts.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setShareScope('all')}
                    style={{
                      minHeight: '42px',
                      borderRadius: '14px',
                      border: `1px solid ${mobileTheme.colors.lightBorder}`,
                      backgroundColor: '#ffffff',
                      color: mobileTheme.colors.lightText,
                      fontWeight: 800,
                      padding: '0 16px',
                      cursor: 'pointer',
                    }}
                  >
                    Share All Connections
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void handleCopyShareLink()}
                  style={{
                    minHeight: '42px',
                    borderRadius: '14px',
                    border: 'none',
                    backgroundColor: mobileTheme.colors.shell,
                    color: '#ffffff',
                    fontWeight: 800,
                    padding: '0 16px',
                    cursor: 'pointer',
                    boxShadow: mobileTheme.shadow.soft,
                  }}
                >
                  Copy Link
                </button>
                {shareState === 'copied' && (
                  <span style={{ color: mobileTheme.colors.lightMuted, fontSize: '13px' }}>Copied</span>
                )}
                {shareState === 'error' && (
                  <span style={{ color: mobileTheme.colors.danger, fontSize: '13px' }}>
                    {shareError || 'Share link failed'}
                  </span>
                )}
              </div>
            </div>
          </ConnectionSection>
        )}
      </div>
    </div>
    <ZtermDialog
      open={formDialog !== null}
      tone="warning"
      title="保存连接"
      message={formDialog || ''}
      confirmLabel="知道了"
      onConfirm={() => setFormDialog(null)}
    />
    </>
  );
}
