import {
  buildBridgeServerPresetIdentityId,
  DEFAULT_BRIDGE_SETTINGS,
  buildDaemonStartCommand,
  buildServerPresetId,
  describeBridgePresetIdentity,
  formatBridgeTarget,
  getDefaultBridgeServer,
  normalizeBridgeSettings,
  resolveBridgePresetDaemonHostId,
  setDefaultBridgeServer,
  sortBridgeServers,
  upsertBridgeServer,
  type BridgeServerPreset,
  type BridgeSettings,
  type TerminalSessionGroupLayoutMode,
  type TraversalRelayClientSettings,
} from '@zterm/shared';

export {
  DEFAULT_BRIDGE_SETTINGS,
  buildBridgeServerPresetIdentityId,
  buildDaemonStartCommand,
  buildServerPresetId,
  describeBridgePresetIdentity,
  formatBridgeTarget,
  getDefaultBridgeServer,
  normalizeBridgeSettings,
  resolveBridgePresetDaemonHostId,
  setDefaultBridgeServer,
  sortBridgeServers,
  upsertBridgeServer,
};
export type { BridgeServerPreset, BridgeSettings, TerminalSessionGroupLayoutMode, TraversalRelayClientSettings };
export type TraversalPath = 'rtc-direct' | 'tailscale' | 'ipv6' | 'ipv4' | 'rtc-relay';

export const DEFAULT_TRAVERSAL_PATH_PRIORITY: TraversalPath[] = ['tailscale', 'rtc-direct', 'rtc-relay', 'ipv4', 'ipv6'];

export function normalizeTraversalPathPriority(input: unknown): TraversalPath[] {
  const seen = new Set<TraversalPath>();
  const next: TraversalPath[] = [];
  if (Array.isArray(input)) {
    for (const item of input) {
      if (item === 'rtc-direct' || item === 'tailscale' || item === 'ipv6' || item === 'ipv4' || item === 'rtc-relay') {
        if (!seen.has(item)) {
          seen.add(item);
          next.push(item);
        }
      }
    }
  }
  for (const item of DEFAULT_TRAVERSAL_PATH_PRIORITY) {
    if (!seen.has(item)) {
      next.push(item);
    }
  }
  return next;
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
    targetPort: nextDefault?.targetPort || DEFAULT_BRIDGE_SETTINGS.targetPort,
    targetAuthToken: nextDefault?.authToken || '',
  };
}
