import type { EditableHost, Host } from './types';
import { DEFAULT_BRIDGE_PORT } from './mobile-config';
import {
  formatBridgeEndpointLabel,
  resolveEffectiveBridgePort,
  resolveNormalizedBridgeHost,
} from './bridge-endpoint';

interface LegacyStoredHost {
  id?: unknown;
  createdAt?: unknown;
  name?: unknown;
  bridgeHost?: unknown;
  bridgePort?: unknown;
  sessionName?: unknown;
  authToken?: unknown;
  tailscaleHost?: unknown;
  ipv6Host?: unknown;
  ipv4Host?: unknown;
  signalUrl?: unknown;
  transportMode?: unknown;
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

function asString(value: unknown, defaultValue = '') {
  return typeof value === 'string' ? value : defaultValue;
}

function asNumber(value: unknown, defaultValue: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : defaultValue;
}

function buildId() {
  return globalThis.crypto?.randomUUID?.() || `zterm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getResolvedSessionName(target: { sessionName?: string; name?: string }) {
  const explicit = target.sessionName?.trim();
  if (explicit) {
    return explicit;
  }

  const derivedName = target.name?.trim();
  return derivedName || 'zterm';
}

export function formatBridgeEndpoint(target: { bridgeHost: string; bridgePort: number }) {
  return formatBridgeEndpointLabel(target);
}

export function formatBridgeSessionTarget(target: {
  bridgeHost: string;
  bridgePort: number;
  sessionName?: string;
  name?: string;
}) {
  return `${formatBridgeEndpoint(target)} · ${getResolvedSessionName(target)}`;
}

export function normalizeHost(input: unknown): Host | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input as LegacyStoredHost;
  const name = asString(candidate.name).trim();
  const rawBridgeHost = asString(candidate.bridgeHost ?? candidate.host).trim();
  const bridgePort = resolveEffectiveBridgePort({
    bridgeHost: rawBridgeHost,
    bridgePort: asNumber(candidate.bridgePort ?? candidate.port, DEFAULT_BRIDGE_PORT),
  });
  const bridgeHost = resolveNormalizedBridgeHost({
    bridgeHost: rawBridgeHost,
    bridgePort,
  });

  if (!name || !bridgeHost) {
    return null;
  }

  return {
    id: asString(candidate.id).trim() || buildId(),
    createdAt: asNumber(candidate.createdAt, Date.now()),
    name,
    bridgeHost,
    bridgePort,
    sessionName: asString(candidate.sessionName ?? candidate.username).trim(),
    authToken: asString(candidate.authToken).trim(),
    tailscaleHost: asString(candidate.tailscaleHost).trim() || undefined,
    ipv6Host: asString(candidate.ipv6Host).trim() || undefined,
    ipv4Host: asString(candidate.ipv4Host).trim() || undefined,
    signalUrl: asString(candidate.signalUrl).trim() || undefined,
    transportMode:
      candidate.transportMode === 'websocket' || candidate.transportMode === 'webrtc'
        ? candidate.transportMode
        : 'auto',
    authType: candidate.authType === 'key' ? 'key' : 'password',
    password: asString(candidate.password).trim() || undefined,
    privateKey: asString(candidate.privateKey).trim() || undefined,
    tags: Array.isArray(candidate.tags)
      ? candidate.tags.filter((tag): tag is string => typeof tag === 'string')
      : [],
    pinned: candidate.pinned === true,
    lastConnected:
      typeof candidate.lastConnected === 'number' && Number.isFinite(candidate.lastConnected)
        ? candidate.lastConnected
        : undefined,
    autoCommand: asString(candidate.autoCommand),
  };
}

export function buildStoredHost(host: EditableHost): Host {
  const rawBridgeHost = host.bridgeHost.trim();
  const bridgePort = resolveEffectiveBridgePort({
    bridgeHost: rawBridgeHost,
    bridgePort: host.bridgePort,
  });
  const bridgeHost = resolveNormalizedBridgeHost({
    bridgeHost: rawBridgeHost,
    bridgePort,
  });
  return {
    ...host,
    bridgeHost,
    bridgePort,
    tailscaleHost: host.tailscaleHost?.trim() || undefined,
    ipv6Host: host.ipv6Host?.trim() || undefined,
    ipv4Host: host.ipv4Host?.trim() || undefined,
    signalUrl: host.signalUrl?.trim() || undefined,
    transportMode: host.transportMode === 'websocket' || host.transportMode === 'webrtc' ? host.transportMode : 'auto',
    id: buildId(),
    createdAt: Date.now(),
  };
}
