import {
  buildBridgeServerPresetIdentityId,
  DEFAULT_BRIDGE_SETTINGS,
  TERMINAL_SHELL_SKIN_OPTIONS,
  buildDaemonStartCommand,
  buildServerPresetId,
  canonicalizeBridgeServerPresets,
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
  type TerminalShellSkin,
  type TerminalSessionGroupLayoutMode,
  type TraversalRelayClientSettings,
} from '@zterm/shared';

export {
  DEFAULT_BRIDGE_SETTINGS,
  TERMINAL_SHELL_SKIN_OPTIONS,
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
  canonicalizeBridgeServerPresets,
};
export type { BridgeServerPreset, BridgeSettings, TerminalShellSkin, TerminalSessionGroupLayoutMode, TraversalRelayClientSettings };
export type TraversalPath = 'lan' | 'tailscale' | 'ipv4' | 'ipv6' | 'rtc-direct' | 'rtc-relay';

export const DEFAULT_TRAVERSAL_PATH_PRIORITY: TraversalPath[] = ['lan', 'tailscale', 'ipv6', 'ipv4', 'rtc-direct', 'rtc-relay'];

export function normalizeTraversalPathPriority(input: unknown): TraversalPath[] {
  const seen = new Set<TraversalPath>();
  const next: TraversalPath[] = [];
  if (Array.isArray(input)) {
    for (const item of input) {
      if (item === 'lan' || item === 'tailscale' || item === 'ipv4' || item === 'ipv6' || item === 'rtc-direct' || item === 'rtc-relay') {
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
