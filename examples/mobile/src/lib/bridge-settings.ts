import { DEFAULT_TERMINAL_CACHE_LINES, WTERM_CONFIG_DISPLAY_PATH } from './mobile-config';
import { isLikelyTailscaleHost } from './network-target';
import { DEFAULT_BRIDGE_PORT } from './types';

export interface BridgeServerPreset {
  id: string;
  name: string;
  targetHost: string;
  targetPort: number;
  authToken?: string;
}

export interface BridgeSettings {
  targetHost: string;
  targetPort: number;
  targetAuthToken?: string;
  terminalCacheLines: number;
  servers: BridgeServerPreset[];
  defaultServerId?: string;
}

export const DEFAULT_BRIDGE_SETTINGS: BridgeSettings = {
  targetHost: '',
  targetPort: DEFAULT_BRIDGE_PORT,
  targetAuthToken: '',
  terminalCacheLines: DEFAULT_TERMINAL_CACHE_LINES,
  servers: [],
  defaultServerId: undefined,
};

export function buildDaemonStartCommand(settings: BridgeSettings) {
  const target = settings.targetHost?.trim() ? `${settings.targetHost.trim()}:${settings.targetPort || DEFAULT_BRIDGE_PORT}` : '默认监听配置';
  return `wterm daemon start  # auth from ${WTERM_CONFIG_DISPLAY_PATH} (${target})`;
}

export function formatBridgeTarget(settings: BridgeSettings) {
  if (!settings.targetHost.trim()) {
    return `未设置:${settings.targetPort || DEFAULT_BRIDGE_PORT}`;
  }

  return `${settings.targetHost.trim()}:${settings.targetPort || DEFAULT_BRIDGE_PORT}`;
}

export function buildServerPresetId(targetHost: string, targetPort: number) {
  return `${targetHost.trim().toLowerCase()}:${targetPort || DEFAULT_BRIDGE_PORT}`;
}

function normalizeServerName(name: string, targetHost: string) {
  return name.trim() || targetHost.trim() || 'Server';
}

export function sortBridgeServers(servers: BridgeServerPreset[]) {
  return [...servers].sort((a, b) => {
    const aTs = isLikelyTailscaleHost(a.targetHost) ? 1 : 0;
    const bTs = isLikelyTailscaleHost(b.targetHost) ? 1 : 0;
    if (aTs !== bTs) {
      return bTs - aTs;
    }
    return a.name.localeCompare(b.name);
  });
}

export function upsertBridgeServer(
  settings: BridgeSettings,
  input: { name?: string; targetHost: string; targetPort: number; authToken?: string },
): BridgeSettings {
  const targetHost = input.targetHost.trim();
  const targetPort = input.targetPort || DEFAULT_BRIDGE_PORT;
  const authToken = input.authToken?.trim() || '';

  if (!targetHost) {
    return settings;
  }

  const id = buildServerPresetId(targetHost, targetPort);
  const preset: BridgeServerPreset = {
    id,
    name: normalizeServerName(input.name || '', targetHost),
    targetHost,
    targetPort,
    authToken,
  };

  const existing = settings.servers.find((server) => server.id === id);
  const servers = sortBridgeServers(
    existing
      ? settings.servers.map((server) => (server.id === id ? { ...server, ...preset } : server))
      : [...settings.servers, preset],
  );

  return {
    ...settings,
    targetHost,
    targetPort,
    targetAuthToken: authToken,
    servers,
    defaultServerId: settings.defaultServerId || id,
  };
}

export function removeBridgeServer(settings: BridgeSettings, serverId: string): BridgeSettings {
  const servers = sortBridgeServers(settings.servers.filter((server) => server.id !== serverId));
  const nextDefaultServerId = settings.defaultServerId === serverId ? servers[0]?.id : settings.defaultServerId;
  const nextDefault = servers.find((server) => server.id === nextDefaultServerId);

  return {
    ...settings,
    servers,
    defaultServerId: nextDefaultServerId,
    targetHost: nextDefault?.targetHost || '',
    targetPort: nextDefault?.targetPort || DEFAULT_BRIDGE_PORT,
    targetAuthToken: nextDefault?.authToken || '',
  };
}

export function setDefaultBridgeServer(settings: BridgeSettings, serverId: string): BridgeSettings {
  const server = settings.servers.find((item) => item.id === serverId);
  if (!server) {
    return settings;
  }

  return {
    ...settings,
    defaultServerId: server.id,
    targetHost: server.targetHost,
    targetPort: server.targetPort,
    targetAuthToken: server.authToken || '',
  };
}

export function getDefaultBridgeServer(settings: BridgeSettings) {
  return settings.servers.find((server) => server.id === settings.defaultServerId);
}
