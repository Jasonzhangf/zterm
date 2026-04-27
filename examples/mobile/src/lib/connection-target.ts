import { DEFAULT_BRIDGE_PORT, type Host, type Session } from './types';

interface LegacyStoredHost {
  id?: unknown;
  createdAt?: unknown;
  name?: unknown;
  bridgeHost?: unknown;
  bridgePort?: unknown;
  sessionName?: unknown;
  authToken?: unknown;
  host?: unknown;
  port?: unknown;
  username?: unknown;
  authType?: unknown;
  password?: unknown;
  privateKey?: unknown;
  tags?: unknown;
  pinned?: unknown;
  lastConnected?: unknown;
  autoCommand?: unknown;
}

function asString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function getResolvedSessionName(target: { sessionName?: string; name?: string }) {
  const explicit = target.sessionName?.trim();
  if (explicit) {
    return explicit;
  }

  const fallbackName = target.name?.trim();
  return fallbackName || 'wterm-mobile';
}

export function formatBridgeEndpoint(target: { bridgeHost: string; bridgePort: number }) {
  return `${target.bridgeHost.trim()}:${target.bridgePort || DEFAULT_BRIDGE_PORT}`;
}

export function formatBridgeSessionTarget(target: { bridgeHost: string; bridgePort: number; sessionName?: string; name?: string }) {
  return `${formatBridgeEndpoint(target)} · ${getResolvedSessionName(target)}`;
}

export function normalizeHost(input: unknown): Host | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input as LegacyStoredHost;
  const name = asString(candidate.name).trim();
  const bridgeHost = asString(candidate.bridgeHost ?? candidate.host).trim();

  if (!name || !bridgeHost) {
    return null;
  }

  return {
    id: asString(candidate.id).trim() || crypto.randomUUID(),
    createdAt: asNumber(candidate.createdAt, Date.now()),
    name,
    bridgeHost,
    bridgePort: asNumber(candidate.bridgePort ?? candidate.port, DEFAULT_BRIDGE_PORT),
    sessionName: asString(candidate.sessionName ?? candidate.username).trim(),
    authToken: asString(candidate.authToken).trim(),
    authType: candidate.authType === 'key' ? 'key' : 'password',
    password: asString(candidate.password).trim() || undefined,
    privateKey: asString(candidate.privateKey).trim() || undefined,
    tags: Array.isArray(candidate.tags) ? candidate.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    pinned: candidate.pinned === true,
    lastConnected:
      typeof candidate.lastConnected === 'number' && Number.isFinite(candidate.lastConnected)
        ? candidate.lastConnected
        : undefined,
    autoCommand: asString(candidate.autoCommand),
  };
}

export function buildStoredHost(host: Omit<Host, 'id' | 'createdAt'>): Host {
  return {
    ...host,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };
}

export function getSessionConnectionLabel(session: Pick<Session, 'customName' | 'connectionName'>) {
  return session.customName?.trim() || session.connectionName;
}
