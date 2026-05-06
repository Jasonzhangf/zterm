import { DEFAULT_TERMINAL_CACHE_LINES, WTERM_CONFIG_DISPLAY_PATH } from './mobile-config';
import { isLikelyTailscaleHost } from './network-target';
import { DEFAULT_BRIDGE_PORT } from './mobile-config';
import { DEFAULT_TERMINAL_THEME_ID, normalizeTerminalThemeId, type TerminalThemeId } from '../terminal/theme';
import {
  buildBridgeEndpointKey,
  formatBridgeEndpointLabel,
  resolveEffectiveBridgePort,
  resolveNormalizedBridgeHost,
} from './bridge-endpoint';

export interface BridgeServerPreset {
  id: string;
  name: string;
  targetHost: string;
  targetPort: number;
  authToken?: string;
  relayHostId?: string;
  relayDeviceId?: string;
  relayDeviceName?: string;
}

export type TerminalWidthMode = 'adaptive-phone' | 'mirror-fixed';

export interface TraversalRelayClientSettings {
  relayBaseUrl: string;
  accessToken: string;
  userId: string;
  username: string;
  deviceId: string;
  deviceName: string;
  platform: string;
  wsDevicesUrl: string;
  wsHostUrl: string;
  wsClientUrl: string;
  turnUrl: string;
  turnUsername: string;
  turnCredential: string;
  updatedAt: number;
}

export interface BridgeSettings {
  targetHost: string;
  targetPort: number;
  targetAuthToken?: string;
  signalUrl: string;
  turnServerUrl: string;
  turnUsername: string;
  turnCredential: string;
  transportMode: 'auto' | 'websocket' | 'webrtc';
  terminalCacheLines: number;
  terminalThemeId: TerminalThemeId;
  terminalWidthMode: TerminalWidthMode;
  shortcutSmartSort: boolean;
  servers: BridgeServerPreset[];
  defaultServerId?: string;
  traversalRelay?: TraversalRelayClientSettings;
}

const MIN_TERMINAL_CACHE_LINES = 200;
const MAX_TERMINAL_CACHE_LINES = DEFAULT_TERMINAL_CACHE_LINES;

export const DEFAULT_BRIDGE_SETTINGS: BridgeSettings = {
  targetHost: '',
  targetPort: DEFAULT_BRIDGE_PORT,
  targetAuthToken: '',
  signalUrl: '',
  turnServerUrl: '',
  turnUsername: '',
  turnCredential: '',
  transportMode: 'auto',
  terminalCacheLines: DEFAULT_TERMINAL_CACHE_LINES,
  terminalThemeId: DEFAULT_TERMINAL_THEME_ID,
  terminalWidthMode: 'mirror-fixed',
  shortcutSmartSort: true,
  servers: [],
  defaultServerId: undefined,
  traversalRelay: undefined,
};

export function buildDaemonStartCommand(settings: BridgeSettings) {
  const target = settings.targetHost?.trim()
    ? formatBridgeEndpointLabel({
        bridgeHost: settings.targetHost,
        bridgePort: settings.targetPort,
      })
    : '默认监听配置';
  return `zterm-daemon start  # auth from ${WTERM_CONFIG_DISPLAY_PATH} (${target})`;
}

export function formatBridgeTarget(settings: BridgeSettings) {
  if (!settings.targetHost.trim()) {
    return `未设置:${settings.targetPort || DEFAULT_BRIDGE_PORT}`;
  }

  return formatBridgeEndpointLabel({
    bridgeHost: settings.targetHost,
    bridgePort: settings.targetPort,
  });
}

export function buildServerPresetId(targetHost: string, targetPort: number) {
  return buildBridgeEndpointKey({
    bridgeHost: targetHost,
    bridgePort: targetPort,
  });
}

export function resolveBridgePresetDaemonHostId(server?: Pick<BridgeServerPreset, 'relayHostId'> | null) {
  return server?.relayHostId?.trim() || '';
}

export function buildBridgeServerPresetIdentityId(
  targetHost: string,
  targetPort: number,
  relayHostId?: string | null,
) {
  const endpointKey = buildServerPresetId(targetHost, targetPort);
  const daemonHostId = relayHostId?.trim() || '';
  return daemonHostId ? `${endpointKey}::daemon:${daemonHostId}` : endpointKey;
}

export function describeBridgePresetIdentity(server: Pick<BridgeServerPreset, 'targetHost' | 'targetPort' | 'relayHostId'>) {
  const daemonHostId = resolveBridgePresetDaemonHostId(server);
  return {
    daemonHostId,
    bridgeLabel: `Bridge · ${server.targetHost}:${server.targetPort}`,
    daemonLabel: daemonHostId ? `Daemon · ${daemonHostId}` : '',
  };
}

function normalizeServerName(name: string, targetHost: string) {
  return name.trim() || targetHost.trim() || 'Server';
}

function asString(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function normalizeTraversalRelayClientSettings(input: unknown): TraversalRelayClientSettings | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const candidate = input as Partial<TraversalRelayClientSettings>;
  const relayBaseUrl = asString(candidate.relayBaseUrl).trim();
  const accessToken = asString(candidate.accessToken).trim();
  const wsDevicesUrl = asString(candidate.wsDevicesUrl).trim();
  const wsHostUrl = asString(candidate.wsHostUrl).trim();
  const wsClientUrl = asString(candidate.wsClientUrl).trim();
  if (!relayBaseUrl || !accessToken || !wsDevicesUrl || !wsHostUrl || !wsClientUrl) {
    return undefined;
  }
  return {
    relayBaseUrl,
    accessToken,
    userId: asString(candidate.userId).trim(),
    username: asString(candidate.username).trim(),
    deviceId: asString(candidate.deviceId).trim(),
    deviceName: asString(candidate.deviceName).trim(),
    platform: asString(candidate.platform).trim(),
    wsDevicesUrl,
    wsHostUrl,
    wsClientUrl,
    turnUrl: asString(candidate.turnUrl).trim(),
    turnUsername: asString(candidate.turnUsername),
    turnCredential: asString(candidate.turnCredential),
    updatedAt:
      typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
        ? candidate.updatedAt
        : Date.now(),
  };
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
  input: {
    name?: string;
    targetHost: string;
    targetPort: number;
    authToken?: string;
    relayHostId?: string;
    relayDeviceId?: string;
    relayDeviceName?: string;
  },
): BridgeSettings {
  const rawTargetHost = input.targetHost.trim();
  const targetPort = resolveEffectiveBridgePort({
    bridgeHost: rawTargetHost,
    bridgePort: input.targetPort || DEFAULT_BRIDGE_PORT,
  });
  const targetHost = resolveNormalizedBridgeHost({
    bridgeHost: rawTargetHost,
    bridgePort: targetPort,
  });
  const authToken = input.authToken?.trim() || '';

  if (!targetHost) {
    return settings;
  }

  const relayHostId = input.relayHostId?.trim() || undefined;
  const id = buildBridgeServerPresetIdentityId(targetHost, targetPort, relayHostId);
  const preset: BridgeServerPreset = {
    id,
    name: normalizeServerName(input.name || '', targetHost),
    targetHost,
    targetPort,
    authToken,
    relayHostId,
    relayDeviceId: input.relayDeviceId?.trim() || undefined,
    relayDeviceName: input.relayDeviceName?.trim() || undefined,
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

export function normalizeBridgeSettings(input: unknown): BridgeSettings {
  if (!input || typeof input !== 'object') {
    return DEFAULT_BRIDGE_SETTINGS;
  }

  const candidate = input as Partial<BridgeSettings>;
  const servers: BridgeServerPreset[] = [];

  if (Array.isArray(candidate.servers)) {
    for (const item of candidate.servers) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const server = item as Partial<BridgeServerPreset>;
      const rawTargetHost = typeof server.targetHost === 'string' ? server.targetHost.trim() : '';
      const relayHostId = typeof server.relayHostId === 'string' ? server.relayHostId.trim() || undefined : undefined;
      const targetPort =
        typeof server.targetPort === 'number' && Number.isFinite(server.targetPort)
          ? resolveEffectiveBridgePort({
              bridgeHost: rawTargetHost,
              bridgePort: server.targetPort,
            })
          : DEFAULT_BRIDGE_SETTINGS.targetPort;
      const targetHost = resolveNormalizedBridgeHost({
        bridgeHost: rawTargetHost,
        bridgePort: targetPort,
      });
      if (!targetHost) {
        continue;
      }

      servers.push({
        id:
          typeof server.id === 'string' && server.id.trim()
            ? (
              server.id.trim() === buildServerPresetId(targetHost, targetPort)
                ? buildBridgeServerPresetIdentityId(targetHost, targetPort, relayHostId)
                : server.id.trim()
            )
            : buildBridgeServerPresetIdentityId(targetHost, targetPort, relayHostId),
        name: typeof server.name === 'string' && server.name.trim() ? server.name : targetHost,
        targetHost,
        targetPort,
        authToken: typeof server.authToken === 'string' ? server.authToken : undefined,
        relayHostId,
        relayDeviceId: typeof server.relayDeviceId === 'string' ? server.relayDeviceId.trim() || undefined : undefined,
        relayDeviceName: typeof server.relayDeviceName === 'string' ? server.relayDeviceName.trim() || undefined : undefined,
      });
    }
  }

  const rawTargetHost =
    typeof candidate.targetHost === 'string' ? candidate.targetHost.trim() : DEFAULT_BRIDGE_SETTINGS.targetHost;
  const targetPort =
    typeof candidate.targetPort === 'number' && Number.isFinite(candidate.targetPort)
      ? resolveEffectiveBridgePort({
          bridgeHost: rawTargetHost,
          bridgePort: candidate.targetPort,
        })
      : DEFAULT_BRIDGE_SETTINGS.targetPort;
  const targetHost = resolveNormalizedBridgeHost({
    bridgeHost: rawTargetHost,
    bridgePort: targetPort,
  });
  const targetAuthToken =
    typeof candidate.targetAuthToken === 'string'
      ? candidate.targetAuthToken
      : DEFAULT_BRIDGE_SETTINGS.targetAuthToken;
  const terminalCacheLines =
    typeof candidate.terminalCacheLines === 'number' && Number.isFinite(candidate.terminalCacheLines)
      ? Math.min(MAX_TERMINAL_CACHE_LINES, Math.max(MIN_TERMINAL_CACHE_LINES, Math.floor(candidate.terminalCacheLines)))
      : DEFAULT_TERMINAL_CACHE_LINES;
  const signalUrl =
    typeof candidate.signalUrl === 'string'
      ? candidate.signalUrl.trim()
      : DEFAULT_BRIDGE_SETTINGS.signalUrl;
  const turnServerUrl =
    typeof candidate.turnServerUrl === 'string'
      ? candidate.turnServerUrl.trim()
      : DEFAULT_BRIDGE_SETTINGS.turnServerUrl;
  const turnUsername =
    typeof candidate.turnUsername === 'string'
      ? candidate.turnUsername
      : DEFAULT_BRIDGE_SETTINGS.turnUsername;
  const turnCredential =
    typeof candidate.turnCredential === 'string'
      ? candidate.turnCredential
      : DEFAULT_BRIDGE_SETTINGS.turnCredential;
  const transportMode =
    candidate.transportMode === 'websocket' || candidate.transportMode === 'webrtc'
      ? candidate.transportMode
      : DEFAULT_BRIDGE_SETTINGS.transportMode;
  const terminalThemeId = normalizeTerminalThemeId(candidate.terminalThemeId);
  const terminalWidthMode: TerminalWidthMode =
    candidate.terminalWidthMode === 'adaptive-phone' ? 'adaptive-phone' : 'mirror-fixed';
  const mergedServers =
    targetHost && servers.every((server) => server.targetHost !== targetHost || server.targetPort !== targetPort)
      ? sortBridgeServers([
          ...servers,
          {
            id: buildBridgeServerPresetIdentityId(targetHost, targetPort),
            name: targetHost,
            targetHost,
            targetPort,
            authToken: targetAuthToken || '',
          },
        ])
      : sortBridgeServers(servers);

  const normalizedDefaultServerId =
    typeof candidate.defaultServerId === 'string' && candidate.defaultServerId.trim()
      ? (() => {
          const rawDefaultServerId = candidate.defaultServerId.trim();
          if (mergedServers.some((server) => server.id === rawDefaultServerId)) {
            return rawDefaultServerId;
          }
          const matchingLegacyServers = mergedServers.filter((server) => (
            buildServerPresetId(server.targetHost, server.targetPort) === rawDefaultServerId
          ));
          return matchingLegacyServers.length === 1 ? matchingLegacyServers[0]!.id : undefined;
        })()
      : undefined;

  return {
    targetHost,
    targetPort,
    targetAuthToken,
    signalUrl,
    turnServerUrl,
    turnUsername,
    turnCredential,
    transportMode,
    terminalCacheLines,
    terminalThemeId,
    terminalWidthMode,
    shortcutSmartSort: typeof (candidate as any).shortcutSmartSort === 'boolean' ? (candidate as any).shortcutSmartSort : DEFAULT_BRIDGE_SETTINGS.shortcutSmartSort,
    servers: mergedServers,
    defaultServerId:
      normalizedDefaultServerId
      || mergedServers.find((server) => server.targetHost === targetHost && server.targetPort === targetPort)?.id,
    traversalRelay: normalizeTraversalRelayClientSettings((candidate as { traversalRelay?: unknown }).traversalRelay),
  };
}
