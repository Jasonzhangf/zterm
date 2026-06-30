export interface RelayPresence {
  connected: boolean;
  lastSeenAt: string;
}

export type RelayEndpointCandidateKind = 'tailscale' | 'ipv6' | 'ipv4' | 'relay-rtc';

export interface RelayEndpointCandidate {
  id: string;
  kind: RelayEndpointCandidateKind;
  host?: string;
  port?: number;
  wsUrl?: string;
  relayHostId?: string;
  authRequired: boolean;
  lastSeenAt: string;
}

export interface RelayTmuxSessionSnapshot {
  name: string;
  cwd?: string;
  title?: string;
  updatedAt: string;
}

export interface RelayDirectoryDaemon {
  hostId: string;
  version: string;
  presence: RelayPresence;
  endpoints: RelayEndpointCandidate[];
  sessions: RelayTmuxSessionSnapshot[];
  lastPublishedAt: string;
}

export interface RelayDirectoryDevice {
  deviceId: string;
  deviceName: string;
  platform: string;
  appVersion: string;
  client: RelayPresence;
  daemon: RelayDirectoryDaemon | null;
}

export interface RelayAccountDirectory {
  schemaVersion: 1;
  user: {
    id: string;
    username: string;
  };
  devices: RelayDirectoryDevice[];
  updatedAt: string;
}

function asString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function asBoolean(value: unknown, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function asPositiveInteger(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export function normalizeRelayEndpointCandidates(input: unknown, now: string): RelayEndpointCandidate[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const seen = new Set<string>();
  const endpoints: RelayEndpointCandidate[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const candidate = item as Partial<RelayEndpointCandidate>;
    if (
      candidate.kind !== 'tailscale'
      && candidate.kind !== 'ipv6'
      && candidate.kind !== 'ipv4'
      && candidate.kind !== 'relay-rtc'
    ) {
      continue;
    }
    const id = asString(candidate.id) || `${candidate.kind}:${asString(candidate.host) || asString(candidate.wsUrl) || asString(candidate.relayHostId)}`;
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    endpoints.push({
      id,
      kind: candidate.kind,
      ...(asString(candidate.host) ? { host: asString(candidate.host) } : {}),
      ...(asPositiveInteger(candidate.port) ? { port: asPositiveInteger(candidate.port) } : {}),
      ...(asString(candidate.wsUrl) ? { wsUrl: asString(candidate.wsUrl) } : {}),
      ...(asString(candidate.relayHostId) ? { relayHostId: asString(candidate.relayHostId) } : {}),
      authRequired: asBoolean(candidate.authRequired, true),
      lastSeenAt: asString(candidate.lastSeenAt) || now,
    });
  }
  return endpoints;
}

export function normalizeRelayTmuxSessionSnapshots(input: unknown, now: string): RelayTmuxSessionSnapshot[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const seen = new Set<string>();
  const sessions: RelayTmuxSessionSnapshot[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const candidate = item as Partial<RelayTmuxSessionSnapshot>;
    const name = asString(candidate.name);
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    sessions.push({
      name,
      ...(asString(candidate.cwd) ? { cwd: asString(candidate.cwd) } : {}),
      ...(asString(candidate.title) ? { title: asString(candidate.title) } : {}),
      updatedAt: asString(candidate.updatedAt) || now,
    });
  }
  return sessions;
}
