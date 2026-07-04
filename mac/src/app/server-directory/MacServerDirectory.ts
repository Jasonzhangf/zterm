import {
  buildBridgeServerPresetIdentityId,
  describeBridgePresetIdentity,
  fetchTmuxSessions,
  formatBridgeEndpoint,
  getResolvedSessionName,
  sortBridgeServers,
  type BridgeServerPreset,
  type BridgeTarget,
  type BridgeSettings,
  type Host,
} from '@zterm/shared';

export type MacServerDirectorySessionSource = 'saved-host' | 'live';

export interface MacServerDirectorySession {
  id: string;
  serverId: string;
  sessionName: string;
  title: string;
  source: MacServerDirectorySessionSource;
  savedHostId?: string;
  isOpen: boolean;
}

export type MacServerDirectoryRefreshStatus = 'loading' | 'ready' | 'error';

export interface MacServerDirectoryRefreshState {
  status: MacServerDirectoryRefreshStatus;
  error?: string;
  refreshedAt?: number;
}

export interface MacServerDirectoryServer {
  id: string;
  name: string;
  endpointLabel: string;
  daemonLabel: string;
  targetHost: string;
  targetPort: number;
  authToken?: string;
  refreshState?: MacServerDirectoryRefreshState;
  sessions: MacServerDirectorySession[];
}

export interface MacServerDirectoryProjection {
  servers: MacServerDirectoryServer[];
  selectedServerId: string | null;
}

export interface MacServerDirectoryLiveSessionSnapshot {
  serverId: string;
  sessionNames: string[];
}

export interface MacServerDirectoryInput {
  bridgeSettings: BridgeSettings;
  hosts: Host[];
  liveSessions?: MacServerDirectoryLiveSessionSnapshot[];
  refreshStates?: Record<string, MacServerDirectoryRefreshState>;
  openSessionKeys?: string[];
  selectedServerId?: string | null;
}

export interface MacServerDirectoryOpenIntent {
  serverId: string;
  sessionName: string;
  target: {
    name: string;
    bridgeHost: string;
    bridgePort: number;
    sessionName: string;
    authToken?: string;
    authType: 'password';
    tags: string[];
    pinned: boolean;
  };
  persistedHostId?: string;
}

export class MacServerDirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MacServerDirectoryError';
  }
}

export type MacServerDirectorySessionFetcher = (target: BridgeTarget) => Promise<string[]>;

function normalizeSessionName(sessionName: string) {
  return sessionName.trim();
}

function buildSessionId(serverId: string, sessionName: string, source: MacServerDirectorySessionSource, savedHostId?: string) {
  return `${serverId}::${source}::${savedHostId || normalizeSessionName(sessionName)}`;
}

export function buildMacServerDirectorySessionKey(serverId: string, sessionName: string) {
  return `${serverId}::${normalizeSessionName(sessionName)}`;
}

function serverFromHost(host: Host): BridgeServerPreset {
  return {
    id: buildBridgeServerPresetIdentityId(host.bridgeHost, host.bridgePort, host.daemonHostId || host.relayHostId),
    name: host.bridgeHost,
    targetHost: host.bridgeHost,
    targetPort: host.bridgePort,
    authToken: host.authToken,
    relayHostId: host.daemonHostId || host.relayHostId,
    relayDeviceId: host.relayDeviceId,
  };
}

function mergeServerPreset(
  current: BridgeServerPreset | undefined,
  incoming: BridgeServerPreset,
): BridgeServerPreset {
  if (!current) {
    return incoming;
  }
  return {
    ...current,
    ...incoming,
    name: current.name || incoming.name,
    authToken: current.authToken || incoming.authToken,
    relayHostId: current.relayHostId || incoming.relayHostId,
    relayDeviceId: current.relayDeviceId || incoming.relayDeviceId,
    relayDeviceName: current.relayDeviceName || incoming.relayDeviceName,
  };
}

function collectServers(settings: BridgeSettings, hosts: Host[]) {
  const servers = new Map<string, BridgeServerPreset>();
  settings.servers.forEach((server) => {
    servers.set(server.id, mergeServerPreset(servers.get(server.id), server));
  });
  hosts.forEach((host) => {
    const server = serverFromHost(host);
    servers.set(server.id, mergeServerPreset(servers.get(server.id), server));
  });
  return sortBridgeServers(Array.from(servers.values()));
}

function collectSavedSessions(serverId: string, hosts: Host[], openSessionKeys: Set<string>) {
  return hosts
    .filter((host) => serverFromHost(host).id === serverId)
    .map((host): MacServerDirectorySession => {
      const sessionName = getResolvedSessionName(host);
      return {
        id: buildSessionId(serverId, sessionName, 'saved-host', host.id),
        serverId,
        sessionName,
        title: host.name || sessionName,
        source: 'saved-host',
        savedHostId: host.id,
        isOpen: openSessionKeys.has(buildMacServerDirectorySessionKey(serverId, sessionName)),
      };
    })
    .sort((left, right) => {
      if (left.isOpen !== right.isOpen) return left.isOpen ? -1 : 1;
      return left.title.localeCompare(right.title);
    });
}

function collectLiveSessions(serverId: string, liveSessions: MacServerDirectoryLiveSessionSnapshot[], openSessionKeys: Set<string>) {
  const snapshot = liveSessions.find((item) => item.serverId === serverId);
  if (!snapshot) {
    return [];
  }
  const uniqueSessionNames = Array.from(new Set(snapshot.sessionNames.map(normalizeSessionName).filter(Boolean)));
  return uniqueSessionNames.map((sessionName): MacServerDirectorySession => ({
    id: buildSessionId(serverId, sessionName, 'live'),
    serverId,
    sessionName,
    title: sessionName,
    source: 'live',
    isOpen: openSessionKeys.has(buildMacServerDirectorySessionKey(serverId, sessionName)),
  }));
}

function uniqueSortedSessionNames(sessionNames: string[]) {
  return Array.from(new Set(sessionNames.map(normalizeSessionName).filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

export async function fetchMacServerDirectoryLiveSessionSnapshot(
  server: MacServerDirectoryServer,
  fetcher: MacServerDirectorySessionFetcher = fetchTmuxSessions,
): Promise<MacServerDirectoryLiveSessionSnapshot> {
  const bridgeHost = server.targetHost.trim();
  const authToken = server.authToken?.trim();
  if (!bridgeHost) {
    throw new MacServerDirectoryError('Server bridge host is required to refresh live sessions');
  }
  if (!authToken) {
    throw new MacServerDirectoryError('Server auth token is required to refresh live sessions');
  }
  const sessionNames = await fetcher({
    bridgeHost,
    bridgePort: server.targetPort,
    authToken,
  });
  return {
    serverId: server.id,
    sessionNames: uniqueSortedSessionNames(sessionNames),
  };
}

function mergeSessions(
  savedSessions: MacServerDirectorySession[],
  liveSessions: MacServerDirectorySession[],
) {
  const sessions = new Map<string, MacServerDirectorySession>();
  savedSessions.forEach((session) => {
    sessions.set(session.sessionName, session);
  });
  liveSessions.forEach((session) => {
    const existing = sessions.get(session.sessionName);
    sessions.set(session.sessionName, existing ? { ...existing, source: existing.source } : session);
  });
  return Array.from(sessions.values()).sort((left, right) => {
    if (left.isOpen !== right.isOpen) return left.isOpen ? -1 : 1;
    if (left.source !== right.source) return left.source === 'saved-host' ? -1 : 1;
    return left.title.localeCompare(right.title);
  });
}

export function projectMacServerDirectory(input: MacServerDirectoryInput): MacServerDirectoryProjection {
  const openSessionKeys = new Set(input.openSessionKeys || []);
  const liveSessions = input.liveSessions || [];
  const refreshStates = input.refreshStates || {};
  const servers = collectServers(input.bridgeSettings, input.hosts).map((server): MacServerDirectoryServer => {
    const identity = describeBridgePresetIdentity(server);
    const savedSessions = collectSavedSessions(server.id, input.hosts, openSessionKeys);
    const projectedLiveSessions = collectLiveSessions(server.id, liveSessions, openSessionKeys);
    return {
      id: server.id,
      name: server.name || server.targetHost,
      endpointLabel: formatBridgeEndpoint({ bridgeHost: server.targetHost, bridgePort: server.targetPort }),
      daemonLabel: identity.daemonLabel,
      targetHost: server.targetHost,
      targetPort: server.targetPort,
      authToken: server.authToken,
      refreshState: refreshStates[server.id],
      sessions: mergeSessions(savedSessions, projectedLiveSessions),
    };
  });
  const selectedServerId = input.selectedServerId && servers.some((server) => server.id === input.selectedServerId)
    ? input.selectedServerId
    : input.bridgeSettings.defaultServerId && servers.some((server) => server.id === input.bridgeSettings.defaultServerId)
      ? input.bridgeSettings.defaultServerId
      : servers[0]?.id ?? null;
  return {
    servers,
    selectedServerId,
  };
}

export function resolveMacServerDirectoryOpenIntent(
  projection: MacServerDirectoryProjection,
  serverId: string,
  sessionName: string,
): MacServerDirectoryOpenIntent {
  const server = projection.servers.find((item) => item.id === serverId);
  if (!server) {
    throw new MacServerDirectoryError(`Unknown Mac server: ${serverId}`);
  }
  const normalizedSessionName = normalizeSessionName(sessionName);
  if (!normalizedSessionName) {
    throw new MacServerDirectoryError('Session name is required to open a server directory entry');
  }
  const session = server.sessions.find((item) => item.sessionName === normalizedSessionName);
  return {
    serverId,
    sessionName: normalizedSessionName,
    target: {
      name: session?.title || normalizedSessionName,
      bridgeHost: server.targetHost,
      bridgePort: server.targetPort,
      sessionName: normalizedSessionName,
      authToken: server.authToken || '',
      authType: 'password',
      tags: [],
      pinned: false,
    },
    persistedHostId: session?.savedHostId,
  };
}
