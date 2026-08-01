export interface RelayPresence {
  connected: boolean;
  lastSeenAt: string;
}

export type RelayEndpointCandidateKind =
  | 'lan'
  | 'rtc-direct'
  | 'tailscale'
  | 'ipv6'
  | 'ipv4'
  | 'relay-rtc';

export interface RelayEndpointCandidate {
  id: string;
  kind: RelayEndpointCandidateKind;
  host?: string;
  port?: number;
  wsUrl?: string;
  relayHostId?: string;
  authToken?: string;
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

export interface RelayDirectoryUpdatePayload {
  endpoints?: RelayEndpointCandidate[];
  sessions?: RelayTmuxSessionSnapshot[];
  publishedAt?: string;
}

const RELAY_ENDPOINT_KINDS = new Set<RelayEndpointCandidateKind>([
  'lan',
  'rtc-direct',
  'tailscale',
  'ipv6',
  'ipv4',
  'relay-rtc',
]);

function requireControlObject(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(
  object: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new Error(`unknown ${label ? `${label} ` : ''}control field: ${key}`);
    }
  }
}

function validateEndpointCandidate(value: unknown) {
  const endpoint = requireControlObject(value, 'endpoint candidate');
  rejectUnknownFields(
    endpoint,
    new Set(['id', 'kind', 'host', 'port', 'wsUrl', 'relayHostId', 'authToken', 'authRequired', 'lastSeenAt']),
    'endpoint',
  );
  if (typeof endpoint.id !== 'string' || !endpoint.id.trim()) {
    throw new Error('endpoint candidate id is required');
  }
  if (typeof endpoint.kind !== 'string' || !RELAY_ENDPOINT_KINDS.has(endpoint.kind as RelayEndpointCandidateKind)) {
    throw new Error(`unsupported endpoint candidate kind: ${String(endpoint.kind || '')}`);
  }
  if (typeof endpoint.authRequired !== 'boolean') {
    throw new Error('endpoint candidate authRequired must be boolean');
  }
  if (typeof endpoint.lastSeenAt !== 'string' || !endpoint.lastSeenAt.trim()) {
    throw new Error('endpoint candidate lastSeenAt is required');
  }
  for (const field of ['host', 'wsUrl', 'relayHostId', 'authToken'] as const) {
    if (endpoint[field] !== undefined && typeof endpoint[field] !== 'string') {
      throw new Error(`endpoint candidate ${field} must be string`);
    }
  }
  if (
    endpoint.port !== undefined
    && (typeof endpoint.port !== 'number'
      || !Number.isInteger(endpoint.port)
      || endpoint.port < 1
      || endpoint.port > 65_535)
  ) {
    throw new Error('endpoint candidate port is invalid');
  }
}

function validateSessionSnapshot(value: unknown) {
  const session = requireControlObject(value, 'session snapshot');
  rejectUnknownFields(session, new Set(['name', 'cwd', 'title', 'updatedAt']), 'session');
  if (typeof session.name !== 'string' || !session.name.trim()) {
    throw new Error('session snapshot name is required');
  }
  if (typeof session.updatedAt !== 'string' || !session.updatedAt.trim()) {
    throw new Error('session snapshot updatedAt is required');
  }
  for (const field of ['cwd', 'title'] as const) {
    if (session[field] !== undefined && typeof session[field] !== 'string') {
      throw new Error(`session snapshot ${field} must be string`);
    }
  }
}

export function validateRelayDirectoryUpdatePayload(
  value: unknown,
): value is RelayDirectoryUpdatePayload {
  const payload = requireControlObject(value, 'relay directory update');
  rejectUnknownFields(payload, new Set(['endpoints', 'sessions', 'publishedAt']), '');
  if (payload.endpoints !== undefined) {
    if (!Array.isArray(payload.endpoints)) {
      throw new Error('relay directory endpoints must be an array');
    }
    payload.endpoints.forEach(validateEndpointCandidate);
  }
  if (payload.sessions !== undefined) {
    if (!Array.isArray(payload.sessions)) {
      throw new Error('relay directory sessions must be an array');
    }
    payload.sessions.forEach(validateSessionSnapshot);
  }
  if (payload.publishedAt !== undefined && (typeof payload.publishedAt !== 'string' || !payload.publishedAt.trim())) {
    throw new Error('relay directory publishedAt must be a non-empty string');
  }
  return true;
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
      candidate.kind !== 'lan'
      && candidate.kind !== 'rtc-direct'
      && candidate.kind !== 'tailscale'
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
      ...(asString(candidate.authToken) ? { authToken: asString(candidate.authToken) } : {}),
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
