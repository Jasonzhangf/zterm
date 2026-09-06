import { useState } from 'react';
import { useTraversalRelayAccount } from '../../hooks/useTraversalRelayAccount';
import {
  canonicalizeBridgeServerPresets,
  describeBridgePresetIdentity,
  resolveBridgePresetDaemonHostId,
  setDefaultBridgeServer,
  sortBridgeServers,
  upsertBridgeServer,
  type BridgeServerPreset,
  type BridgeSettings,
  type TraversalRelayClientSettings,
} from '../../lib/bridge-settings';
import { resolveRelayDaemonCanonicalHostId } from '../../lib/relay-account-directory';
import { listOnlineTraversalRelayDaemonDevices } from '../../lib/traversal-relay-devices';
import { mobileTheme } from '../../lib/mobile-ui';
import { formatTargetBadge } from '../../lib/network-target';
import { getDefaultTraversalRelayBaseUrl } from '../../lib/traversal-relay-client';
import type { TraversalRelayDeviceSnapshot } from '../../lib/types';
import { SettingsSectionTitle, settingsInputStyle, settingsSectionStyle } from './SettingsSection';

interface ConnectionConfigSectionProps {
  settings: BridgeSettings;
  relayDevices: TraversalRelayDeviceSnapshot[];
  onSettingsChange: (updater: (current: BridgeSettings) => BridgeSettings) => void;
  onRemoveDefaultServer: () => void;
  onRelaySettingsChange: (settings: TraversalRelayClientSettings | undefined) => void;
}

interface ConnectionEntry {
  kind: 'bridge-preset';
  server: BridgeServerPreset;
  daemonHostId: string;
  bridgeLabel: string;
  daemonLabel: string;
  targetBadge: string;
  authLabel: string;
  active: boolean;
}

interface RelayOnlineEntry {
  kind: 'relay-online';
  device: TraversalRelayDeviceSnapshot;
  canonicalHostId: string;
  boundBridgePreset: BridgeServerPreset | null;
  displayLabel: string;
  deviceCount: number;
}

type UnifiedEntry = ConnectionEntry | RelayOnlineEntry;

function resolvePresetCanonicalDaemonHostId(
  server: BridgeServerPreset,
  relayDevices: TraversalRelayDeviceSnapshot[],
) {
  return resolveRelayDaemonCanonicalHostId({
    relayHostId: server.relayHostId,
    relayDeviceId: server.relayDeviceId,
    authToken: server.authToken,
    bridgeHost: server.targetHost,
    bridgePort: server.targetPort,
  }, relayDevices) || resolveBridgePresetDaemonHostId(server);
}

function resolveBoundBridgePreset(
  servers: BridgeServerPreset[],
  relayHostId: string,
  relayDevices: TraversalRelayDeviceSnapshot[],
): BridgeServerPreset | null {
  return servers.find((server) => {
    const serverHostId = resolvePresetCanonicalDaemonHostId(server, relayDevices);
    return serverHostId === relayHostId && server.targetHost?.trim() && server.authToken?.trim();
  }) || null;
}

function localizeTargetBadge(label: string) {
  return label === 'Tailscale' ? 'Tailscale 线路' : '局域网直连';
}

export function buildConnectionConfigEntries(
  settings: BridgeSettings,
  relayDevices: TraversalRelayDeviceSnapshot[],
): UnifiedEntry[] {
  const entries: UnifiedEntry[] = [];
  const canonicalized = canonicalizeBridgeServerPresets(settings.servers);
  const canonicalizedServers = canonicalized.servers;
  const effectiveDefaultServerId = canonicalized.idAliases.get(settings.defaultServerId || '') || settings.defaultServerId;

  // Online relay devices deduplicated by canonical hostId
  const canonicalDeviceMap = new Map<string, TraversalRelayDeviceSnapshot[]>();
  const onlineDevices = listOnlineTraversalRelayDaemonDevices(relayDevices);
  for (const device of onlineDevices) {
    const hostId = resolveRelayDaemonCanonicalHostId({ relayHostId: device.daemon.hostId }, relayDevices) || device.daemon.hostId.trim();
    if (!hostId) {
      continue;
    }
    const existing = canonicalDeviceMap.get(hostId) || [];
    existing.push(device);
    canonicalDeviceMap.set(hostId, existing);
  }

  // Merge relay online devices
  for (const [canonicalHostId, devices] of canonicalDeviceMap) {
    const primaryDevice = devices[0]!;
    const boundPreset = resolveBoundBridgePreset(canonicalizedServers, canonicalHostId, relayDevices);
    const displayLabel = primaryDevice.deviceName?.trim() || canonicalHostId;
    entries.push({
      kind: 'relay-online',
      device: primaryDevice,
      canonicalHostId,
      boundBridgePreset: boundPreset,
      displayLabel,
      deviceCount: devices.length,
    });
  }

  // Bridge server presets
  const presets = sortBridgeServers(canonicalizedServers);
  const assignedHostIds = new Set(canonicalDeviceMap.keys());
  for (const server of presets) {
    const daemonHostId = resolvePresetCanonicalDaemonHostId(server, relayDevices);
    // Complete presets are shown through the unified relay-online row.
    // Incomplete presets stay visible so their saved target is still manageable.
    const completePreset = Boolean(server.targetHost?.trim() && server.authToken?.trim());
    if (completePreset && daemonHostId && assignedHostIds.has(daemonHostId)) {
      continue;
    }
    const identity = describeBridgePresetIdentity(server);
    const active = server.id === effectiveDefaultServerId;
    entries.push({
      kind: 'bridge-preset',
      server,
      daemonHostId,
      bridgeLabel: `桥接地址（bridgeHost） · ${server.targetHost}:${server.targetPort}`,
      daemonLabel: identity.daemonLabel
        ? `守护进程 ID（daemon） · ${daemonHostId}`
        : '',
      targetBadge: localizeTargetBadge(formatTargetBadge(server.targetHost)),
      authLabel: server.authToken ? '已启用认证' : '暂无令牌',
      active,
    });
  }

  return entries;
}

export function ConnectionConfigSection({
  settings,
  relayDevices,
  onSettingsChange,
  onRemoveDefaultServer,
  onRelaySettingsChange,
}: ConnectionConfigSectionProps) {
  const {
    account,
    relayStatus,
    relayBusy,
    syncRelay,
    logoutRelay,
  } = useTraversalRelayAccount(settings.traversalRelay);

  const loggedIn = Boolean(account?.accessToken || settings.traversalRelay?.accessToken);
  const relayHost = new URL(getDefaultTraversalRelayBaseUrl()).hostname;
  const accountName = account?.user?.username || account?.username || settings.traversalRelay?.username || '未知';
  const deviceCount = relayDevices.length;
  const busy = relayBusy !== null;
  const relayStatusIsError = Boolean(
    relayStatus
    && !relayStatus.includes('已登录')
    && !relayBusy
  );

  // Draft state for adding a new bridge preset
  const [draft, setDraft] = useState({
    name: '',
    targetHost: '',
    targetPort: '3333',
    authToken: '',
    relayHostId: '',
  });

  // Draft state for relay login
  const [loginUsername, setLoginUsername] = useState(
    () => account?.username || settings.traversalRelay?.username || '',
  );
  const [loginPassword, setLoginPassword] = useState('');
  const [expanded, setExpanded] = useState(false);

  // Unified entries
  const canonicalizedSettings = canonicalizeBridgeServerPresets(settings.servers);
  const effectiveDefaultServerId = canonicalizedSettings.idAliases.get(settings.defaultServerId || '') || settings.defaultServerId;
  const entries = buildConnectionConfigEntries(settings, relayDevices);

  const canAddServer = draft.targetHost.trim().length > 0;
  const hasDefaultServer = canonicalizedSettings.servers.some((server) => server.id === effectiveDefaultServerId);
  const defaultServer = canonicalizedSettings.servers.find((server) => server.id === effectiveDefaultServerId) || null;
  const connectionSummary = [
    loggedIn ? `${accountName} 已登录` : 'Relay 未登录',
    defaultServer
      ? `默认 ${defaultServer.relayDeviceName || defaultServer.name || defaultServer.relayHostId || '服务器'}`
      : '无默认直连',
    `${entries.length} 个连接`,
  ].join(' · ');
  const handleAddServer = () => {
    const targetHost = draft.targetHost.trim();
    if (!targetHost) {
      return;
    }
    const targetPort = Number.parseInt(draft.targetPort, 10) || 3333;
    onSettingsChange((current) => upsertBridgeServer(current, {
      name: draft.name,
      targetHost,
      targetPort,
      authToken: draft.authToken,
      relayHostId: draft.relayHostId,
    }));
    setDraft({ name: '', targetHost: '', targetPort: '3333', authToken: '', relayHostId: '' });
  };

  const handleLogin = async () => {
    const result = await syncRelay('login', {
      relayBaseUrl: '',
      username: loginUsername,
      password: loginPassword,
    }, settings.traversalRelay);
    if (!result) {
      return;
    }
    setLoginPassword('');
    onRelaySettingsChange(result.relaySettings);
  };

  const handleLogout = () => {
    logoutRelay();
    setLoginPassword('');
    onRelaySettingsChange(undefined);
  };

  return (
    <div style={settingsSectionStyle()}>
      <button
        type="button"
        data-testid="settings-connection-config-expand"
        onClick={() => setExpanded((current) => !current)}
        style={{
          width: '100%',
          border: '1px solid var(--zterm-settings-border)',
          borderRadius: '18px',
          padding: '14px 16px',
          backgroundColor: 'var(--zterm-settings-surface)',
          color: 'var(--zterm-settings-text)',
          boxShadow: 'var(--zterm-settings-shadow)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          textAlign: 'left',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '15px', fontWeight: 900 }}>连接配置</div>
          <div
            data-testid="settings-connection-config-summary"
            style={{ marginTop: '5px', fontSize: '12px', color: mobileTheme.colors.lightMuted, lineHeight: 1.45 }}
          >
            {connectionSummary}
          </div>
        </div>
        <span style={{ flex: '0 0 auto', fontSize: '12px', fontWeight: 800, color: 'var(--zterm-settings-accent)' }}>
          {expanded ? '收起' : '展开'}
        </span>
      </button>

      {expanded ? (
        <>
      <SettingsSectionTitle>Relay 与直连</SettingsSectionTitle>

      {/* Relay account card */}
      <div
        style={{
          border: `1px solid ${mobileTheme.colors.lightBorder}`,
          borderRadius: '8px',
          backgroundColor: 'var(--zterm-settings-surface)',
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
            borderBottom: '1px solid var(--zterm-settings-border)',
          }}
        >
          <div>
            <div style={{ fontSize: '12px', color: mobileTheme.colors.lightMuted }}>Relay</div>
            <div data-testid="settings-relay-fixed-host" style={{ marginTop: '3px', fontSize: '14px', fontWeight: 800 }}>
              {relayHost}
            </div>
          </div>
          <div style={{ fontSize: '11px', fontWeight: 800, color: loggedIn ? 'var(--zterm-settings-accent)' : 'var(--zterm-settings-muted)' }}>
            {loggedIn ? '已登录' : '可选'}
          </div>
        </div>

        {/* Signed-in panel — shown instead of the form when logged in */}
        {loggedIn ? (
          <div
            data-testid="settings-relay-signed-in-panel"
            style={{
              padding: '12px 16px',
              display: 'grid',
              gap: '8px',
            }}
          >
            <div
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                backgroundColor: 'color-mix(in srgb, var(--zterm-settings-accent) 12%, transparent)',
                border: '1px solid color-mix(in srgb, var(--zterm-settings-accent) 32%, transparent)',
                display: 'grid',
                gap: '4px',
              }}
            >
              <div style={{ fontSize: '11px', fontWeight: 850, color: 'var(--zterm-settings-accent)', textTransform: 'uppercase' }}>
                已登录
              </div>
              <div style={{ fontSize: '15px', fontWeight: 850, color: 'var(--zterm-settings-text)' }}>
                {accountName}
              </div>
              <div style={{ fontSize: '12px', color: mobileTheme.colors.lightMuted }}>
                {deviceCount} 设备
                {relayStatus && !relayStatus.includes('已登录') ? ` · ${relayStatus}` : ''}
              </div>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              disabled={busy}
              style={{
                minHeight: '44px',
                borderRadius: '7px',
                border: '1px solid var(--zterm-settings-border)',
                backgroundColor: 'var(--zterm-settings-surface)',
                color: 'var(--zterm-settings-danger, #a22c3f)',
                fontWeight: 800,
                fontSize: '14px',
                cursor: 'pointer',
              }}
            >
              退出登录
            </button>
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handleLogin();
            }}
            style={{ padding: '16px', display: 'grid', gap: '12px' }}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '88px minmax(0, 1fr)',
                alignItems: 'center',
                gap: '12px',
              }}
            >
              <label htmlFor="relay-account" style={{ fontSize: '13px', fontWeight: 700 }}>
                账号
              </label>
              <input
                id="relay-account"
                aria-label="Relay 账号"
                autoComplete="username"
                value={loginUsername}
                onChange={(event) => setLoginUsername(event.target.value)}
                disabled={busy}
                style={{ ...settingsInputStyle(), minWidth: 0 }}
              />
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '88px minmax(0, 1fr)',
                alignItems: 'center',
                gap: '12px',
              }}
            >
              <label htmlFor="relay-password" style={{ fontSize: '13px', fontWeight: 700 }}>
                密码
              </label>
              <input
                id="relay-password"
                aria-label="Relay 密码"
                type="password"
                autoComplete="current-password"
                value={loginPassword}
                onChange={(event) => setLoginPassword(event.target.value)}
                disabled={busy}
                style={{ ...settingsInputStyle(), minWidth: 0 }}
              />
            </div>
            <button
              type="submit"
              disabled={busy || !loginUsername.trim() || !loginPassword}
              style={{
                minHeight: '44px',
                border: 'none',
                borderRadius: '7px',
                backgroundColor: 'var(--zterm-settings-accent)',
                color: 'var(--zterm-settings-accent-text)',
                fontSize: '14px',
                fontWeight: 800,
                opacity: busy || !loginUsername.trim() || !loginPassword ? 0.55 : 1,
                cursor: busy || !loginUsername.trim() || !loginPassword ? 'not-allowed' : 'pointer',
              }}
            >
              {busy ? '登录中…' : '登录'}
            </button>
            <div
              data-testid="settings-relay-login-status"
              role={relayStatusIsError ? 'alert' : 'status'}
              style={{
                minHeight: '20px',
                fontSize: '12px',
                lineHeight: 1.5,
                color: relayStatusIsError ? 'var(--zterm-settings-danger, #a22c3f)' : 'var(--zterm-settings-muted)',
              }}
            >
              {relayStatus && !relayStatus.includes('已登录') ? relayStatus : '凭据仅发送到固定 Relay 服务'}
            </div>
          </form>
        )}
      </div>

      {/* Add new bridge preset */}
      <div style={{ display: 'grid', gap: '10px' }}>
        <div style={{ fontSize: '15px', fontWeight: 900 }}>添加直连服务器</div>
        <div style={{ display: 'grid', gap: '8px' }}>
          <label style={{ display: 'grid', gap: '5px', fontSize: '13px', fontWeight: 700 }}>
            名称
            <input
              aria-label="服务器名称"
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              placeholder="Mac Studio"
              style={settingsInputStyle()}
            />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 96px', gap: '8px' }}>
            <label style={{ display: 'grid', gap: '5px', fontSize: '13px', fontWeight: 700 }}>
              主机
              <input
                aria-label="服务器地址"
                value={draft.targetHost}
                onChange={(event) => setDraft((current) => ({ ...current, targetHost: event.target.value }))}
                placeholder="100.66.1.82"
                style={settingsInputStyle()}
              />
            </label>
            <label style={{ display: 'grid', gap: '5px', fontSize: '13px', fontWeight: 700 }}>
              端口
              <input
                aria-label="服务器端口"
                inputMode="numeric"
                value={draft.targetPort}
                onChange={(event) => setDraft((current) => ({ ...current, targetPort: event.target.value }))}
                style={settingsInputStyle()}
              />
            </label>
          </div>
          <label style={{ display: 'grid', gap: '5px', fontSize: '13px', fontWeight: 700 }}>
            认证 Token
            <input
              aria-label="服务器认证令牌"
              value={draft.authToken}
              onChange={(event) => setDraft((current) => ({ ...current, authToken: event.target.value }))}
              placeholder="wterm-..."
              style={settingsInputStyle()}
            />
          </label>
          <label style={{ display: 'grid', gap: '5px', fontSize: '13px', fontWeight: 700 }}>
            守护进程 ID（Daemon ID）
            <input
              aria-label="守护进程 ID（Daemon ID）"
              value={draft.relayHostId}
              onChange={(event) => setDraft((current) => ({ ...current, relayHostId: event.target.value }))}
              placeholder="mac-studio"
              style={settingsInputStyle()}
            />
          </label>
          <button
            type="button"
            onClick={handleAddServer}
            disabled={!canAddServer}
            style={{
              minHeight: '48px',
              borderRadius: '16px',
              border: 'none',
              backgroundColor: canAddServer ? 'var(--zterm-settings-accent, #128354)' : 'var(--zterm-settings-field, #d9e1ea)',
              color: canAddServer ? 'var(--zterm-settings-accent-text)' : 'var(--zterm-settings-muted)',
              fontWeight: 800,
              cursor: canAddServer ? 'pointer' : 'not-allowed',
            }}
          >
            添加服务器
          </button>
        </div>
      </div>

      {/* Unified connection entries list */}
      {entries.length === 0 ? (
        <div style={{ color: mobileTheme.colors.lightMuted, fontSize: '13px' }}>
          暂无已配置的连接。
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {entries.map((entry) => {
            if (entry.kind === 'bridge-preset') {
              const active = entry.active;
              return (
                <button
                  key={`preset:${entry.server.id}`}
                  onClick={() => onSettingsChange((current) => setDefaultBridgeServer(current, entry.server.id))}
                  style={{
                    border: 'none',
                    borderRadius: '20px',
                    padding: '14px 16px',
                    textAlign: 'left',
                    backgroundColor: active ? 'var(--zterm-settings-accent)' : 'var(--zterm-settings-surface)',
                    color: active ? 'var(--zterm-settings-accent-text)' : 'var(--zterm-settings-text)',
                    boxShadow: mobileTheme.shadow.soft,
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '12px',
                    alignItems: 'center',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 800, fontSize: '14px' }}>{entry.server.name}</div>
                    <div style={{ fontSize: '12px', opacity: 0.8, marginTop: '3px' }}>{entry.bridgeLabel}</div>
                    {entry.daemonLabel ? (
                      <div style={{ fontSize: '11px', opacity: 0.74, marginTop: '3px' }}>{entry.daemonLabel}</div>
                    ) : null}
                    <div style={{ fontSize: '11px', opacity: 0.74, marginTop: '3px' }}>
                      {entry.targetBadge} · {entry.authLabel}
                    </div>
                  </div>
                  <span style={{ fontSize: '12px', opacity: 0.8, flex: '0 0 auto' }}>
                    {active ? '默认' : '使用'}
                  </span>
                </button>
              );
            }

            // relay-online entry
            const device = entry.device;
            return (
              <div
                key={`relay:${device.deviceId}:${entry.canonicalHostId}`}
                data-testid="settings-relay-online-entry"
                style={{
                  border: '1px solid color-mix(in srgb, var(--zterm-settings-accent) 42%, transparent)',
                  borderRadius: '20px',
                  padding: '14px 16px',
                  textAlign: 'left',
                backgroundColor: 'var(--zterm-settings-surface)',
                color: 'var(--zterm-settings-text)',
                  boxShadow: mobileTheme.shadow.soft,
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '12px',
                  alignItems: 'center',
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{
                      fontSize: '11px',
                      fontWeight: 800,
                      padding: '2px 7px',
                      borderRadius: '999px',
                      backgroundColor: 'color-mix(in srgb, var(--zterm-settings-accent) 18%, transparent)',
                      color: 'var(--zterm-settings-accent)',
                    }}>
                      在线
                    </span>
                    {entry.boundBridgePreset ? (
                      <span style={{ fontSize: '11px', color: 'var(--zterm-settings-accent)' }}>已绑定</span>
                    ) : (
                      <span style={{ fontSize: '11px', color: mobileTheme.colors.lightMuted }}>未绑定</span>
                    )}
                  </div>
                  <div style={{ fontWeight: 800, fontSize: '14px', marginTop: '5px' }}>{entry.displayLabel}</div>
                  <div style={{ fontSize: '11px', opacity: 0.74, marginTop: '3px' }}>
                    守护进程 ID（hostId）: {entry.canonicalHostId}
                  </div>
                  {entry.boundBridgePreset ? (
                    <div style={{ fontSize: '11px', opacity: 0.74, marginTop: '3px' }}>
                      {entry.boundBridgePreset.relayDeviceName
                        || entry.boundBridgePreset.name
                        || entry.boundBridgePreset.relayHostId
                        || '服务器'}
                    </div>
                  ) : null}
                </div>
                <span style={{ fontSize: '11px', opacity: 0.8, flex: '0 0 auto', color: mobileTheme.colors.lightMuted }}>
                  Relay
                </span>
              </div>
            );
          })}
        </div>
      )}

      {hasDefaultServer && (
        <button
          onClick={onRemoveDefaultServer}
          style={{
            height: '52px',
            borderRadius: '18px',
            border: 'none',
            backgroundColor: 'color-mix(in srgb, var(--zterm-settings-danger, #a22c3f) 16%, transparent)',
            color: mobileTheme.colors.danger,
            fontWeight: 800,
            cursor: 'pointer',
          }}
        >
          移除默认服务器
        </button>
      )}
        </>
      ) : null}
    </div>
  );
}
