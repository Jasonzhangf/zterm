import { DEFAULT_BRIDGE_PORT } from './mobile-config';
import { resolveEffectiveBridgePort, resolveNormalizedBridgeHost } from './bridge-endpoint';
import type { EditableHost } from './types';

const CONNECTION_SHARE_KIND = 'zterm.connection-config';
const CONNECTION_SHARE_SCHEMA_VERSION = 1;
const CONNECTION_SHARE_URL_PREFIX = 'zterm://connection/import?payload=';
const CONNECTION_SHARE_WEB_URL_PREFIX = 'https://zterm.app/connection/import?payload=';

export interface ConnectionConfigSharePayload {
  kind: typeof CONNECTION_SHARE_KIND;
  schemaVersion: typeof CONNECTION_SHARE_SCHEMA_VERSION;
  exportedAt: number;
  host: EditableHost;
}

export type ConnectionConfigShareParseResult =
  | { ok: true; payload: ConnectionConfigSharePayload; host: EditableHost }
  | { ok: false; error: string };

function asString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asTags(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
    : [];
}

function toBase64Url(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const btoaFn = globalThis.btoa;
  const base64 = typeof btoaFn === 'function'
    ? btoaFn(binary)
    : (globalThis as unknown as { Buffer: { from(input: Uint8Array): { toString(encoding: string): string } } })
      .Buffer
      .from(bytes)
      .toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const atobFn = globalThis.atob;
  const binary = typeof atobFn === 'function'
    ? atobFn(padded)
    : (globalThis as unknown as { Buffer: { from(input: string, encoding: string): { toString(encoding: string): string } } })
      .Buffer
      .from(padded, 'base64')
      .toString('binary');
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function normalizeConnectionConfigShareHost(input: unknown): EditableHost | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const candidate = input as Partial<EditableHost>;
  const name = asString(candidate.name);
  const rawBridgeHost = asString(candidate.bridgeHost);
  const bridgePort = resolveEffectiveBridgePort({
    bridgeHost: rawBridgeHost,
    bridgePort: asNumber(candidate.bridgePort, DEFAULT_BRIDGE_PORT),
  });
  const bridgeHost = resolveNormalizedBridgeHost({
    bridgeHost: rawBridgeHost,
    bridgePort,
  });

  if (!name || !bridgeHost) {
    return null;
  }

  const relayHostId = asString(candidate.relayHostId);
  const daemonHostId = asString(candidate.daemonHostId) || relayHostId;

  return {
    name,
    bridgeHost,
    bridgePort,
    daemonHostId: daemonHostId || undefined,
    sessionName: asString(candidate.sessionName),
    authToken: asString(candidate.authToken),
    relayHostId: relayHostId || undefined,
    relayDeviceId: asString(candidate.relayDeviceId) || undefined,
    tailscaleHost: asString(candidate.tailscaleHost) || undefined,
    ipv6Host: asString(candidate.ipv6Host) || undefined,
    ipv4Host: asString(candidate.ipv4Host) || undefined,
    signalUrl: asString(candidate.signalUrl) || undefined,
    transportMode:
      candidate.transportMode === 'websocket' || candidate.transportMode === 'webrtc'
        ? candidate.transportMode
        : 'auto',
    authType: 'password',
    tags: asTags(candidate.tags),
    pinned: candidate.pinned === true,
    autoCommand: asString(candidate.autoCommand),
    lastConnected: undefined,
    password: undefined,
    privateKey: undefined,
  };
}

export function buildConnectionConfigSharePayload(options: {
  host: EditableHost;
  exportedAt: number;
}): ConnectionConfigSharePayload {
  const host = normalizeConnectionConfigShareHost(options.host);
  if (!host) {
    throw new Error('invalid connection config share host');
  }
  return {
    kind: CONNECTION_SHARE_KIND,
    schemaVersion: CONNECTION_SHARE_SCHEMA_VERSION,
    exportedAt: options.exportedAt,
    host,
  };
}

export function encodeConnectionConfigSharePayload(payload: ConnectionConfigSharePayload) {
  return toBase64Url(JSON.stringify(payload));
}

export function buildConnectionConfigShareLink(options: {
  host: EditableHost;
  exportedAt: number;
  linkKind?: 'app' | 'web';
}) {
  const payload = buildConnectionConfigSharePayload({
    host: options.host,
    exportedAt: options.exportedAt,
  });
  const encoded = encodeConnectionConfigSharePayload(payload);
  const prefix = options.linkKind === 'web' ? CONNECTION_SHARE_WEB_URL_PREFIX : CONNECTION_SHARE_URL_PREFIX;
  return `${prefix}${encoded}`;
}

function extractEncodedPayload(input: string) {
  const raw = input.trim();
  if (!raw) {
    return null;
  }
  if (!raw.includes('://') && !raw.includes('?')) {
    return raw;
  }
  try {
    const url = new URL(raw);
    const isSupportedUrl = (
      url.protocol === 'zterm:'
      && url.hostname === 'connection'
      && url.pathname === '/import'
    ) || (
      url.protocol === 'https:'
      && url.hostname === 'zterm.app'
      && url.pathname === '/connection/import'
    );
    if (!isSupportedUrl) {
      return null;
    }
    return url.searchParams.get('payload');
  } catch {
    return null;
  }
}

export function parseConnectionConfigShareLink(input: string): ConnectionConfigShareParseResult {
  const encoded = extractEncodedPayload(input);
  if (!encoded) {
    return { ok: false, error: 'connection share link is missing payload' };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(fromBase64Url(encoded));
  } catch (error) {
    return {
      ok: false,
      error: `connection share payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!decoded || typeof decoded !== 'object') {
    return { ok: false, error: 'connection share payload must be an object' };
  }
  const candidate = decoded as Partial<ConnectionConfigSharePayload>;
  if (candidate.kind !== CONNECTION_SHARE_KIND || candidate.schemaVersion !== CONNECTION_SHARE_SCHEMA_VERSION) {
    return { ok: false, error: 'connection share payload schema is unsupported' };
  }
  if (typeof candidate.exportedAt !== 'number' || !Number.isFinite(candidate.exportedAt)) {
    return { ok: false, error: 'connection share payload exportedAt is invalid' };
  }
  const host = normalizeConnectionConfigShareHost(candidate.host);
  if (!host) {
    return { ok: false, error: 'connection share payload host is invalid' };
  }

  return {
    ok: true,
    payload: {
      kind: CONNECTION_SHARE_KIND,
      schemaVersion: CONNECTION_SHARE_SCHEMA_VERSION,
      exportedAt: candidate.exportedAt,
      host,
    },
    host,
  };
}
