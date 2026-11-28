import {
  buildBridgeServerPresetIdentityId,
  DEFAULT_BRIDGE_SETTINGS,
  TERMINAL_FONT_SIZE_OPTIONS,
  TERMINAL_SHELL_SKIN_OPTIONS,
  buildDaemonStartCommand,
  buildServerPresetId,
  canonicalizeBridgeServerPresets,
  describeBridgePresetIdentity,
  formatBridgeTarget,
  getDefaultBridgeServer,
  normalizeBridgeSettings,
  resolveTerminalFontSizePx,
  resolveBridgePresetDaemonHostId,
  setDefaultBridgeServer,
  sortBridgeServers,
  upsertBridgeServer,
  type BridgeServerPreset,
  type BridgeSettings,
  type SessionDrawerFilterSettings,
  type TerminalFontSize,
  type TerminalShellSkin,
  type TerminalSessionGroupLayoutMode,
  type TraversalRelayClientSettings,
} from '@zterm/shared';

export {
  DEFAULT_BRIDGE_SETTINGS,
  TERMINAL_FONT_SIZE_OPTIONS,
  TERMINAL_SHELL_SKIN_OPTIONS,
  buildBridgeServerPresetIdentityId,
  buildDaemonStartCommand,
  buildServerPresetId,
  describeBridgePresetIdentity,
  formatBridgeTarget,
  getDefaultBridgeServer,
  normalizeBridgeSettings,
  resolveTerminalFontSizePx,
  resolveBridgePresetDaemonHostId,
  setDefaultBridgeServer,
  sortBridgeServers,
  upsertBridgeServer,
  canonicalizeBridgeServerPresets,
};
export type { BridgeServerPreset, BridgeSettings, SessionDrawerFilterSettings, TerminalFontSize, TerminalShellSkin, TerminalSessionGroupLayoutMode, TraversalRelayClientSettings };
export {
  DEFAULT_TRAVERSAL_PATH_PRIORITY,
  normalizeTraversalPathPriority,
} from '../../../packages/shared/src/connection/traversal/policy';
export type { TraversalResolvedPath as TraversalPath } from '../../../packages/shared/src/connection/traversal/types';

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
