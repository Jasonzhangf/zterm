import type { Host } from './types';
import { DEFAULT_BRIDGE_PORT } from './mobile-config';
import { resolveBridgeEndpoint } from './bridge-endpoint';

interface BridgeTargetLike {
  bridgeHost: string;
  bridgePort: number;
  authToken?: string;
}

function appendAuthToken(url: URL, authToken?: string) {
  const token = authToken?.trim();
  if (token) {
    url.searchParams.set('token', token);
  } else {
    url.searchParams.delete('token');
  }
  return url;
}

function normalizeWsHostLiteral(rawHost: string) {
  const host = rawHost.trim();
  if (!host) {
    return host;
  }
  if (host.includes('://')) {
    return host;
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    return host;
  }
  if (host.includes(':') && !host.includes('.')) {
    return `[${host}]`;
  }
  return host;
}

export function buildBridgeUrlFromTarget(target: BridgeTargetLike, overrideUrl?: string) {
  if (overrideUrl) {
    const url = new URL(overrideUrl);
    return appendAuthToken(url, target.authToken).toString();
  }

  const rawHost = target.bridgeHost.trim();
  const resolved = resolveBridgeEndpoint(target);
  if (resolved.usesExplicitUrl) {
    const url = new URL(rawHost);
    if (!url.port) {
      url.port = String(resolved.effectivePort);
    }
    return appendAuthToken(url, target.authToken).toString();
  }

  return appendAuthToken(
    new URL(`ws://${normalizeWsHostLiteral(resolved.normalizedHost)}:${resolved.effectivePort || DEFAULT_BRIDGE_PORT}`),
    target.authToken,
  ).toString();
}

export function buildBridgeUrl(host: Host, overrideUrl?: string) {
  return buildBridgeUrlFromTarget(host, overrideUrl);
}
