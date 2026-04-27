import { DEFAULT_BRIDGE_PORT } from './mobile-config';
import type { Host } from './types';

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

export function buildBridgeUrlFromTarget(target: BridgeTargetLike, overrideUrl?: string) {
  if (overrideUrl) {
    const url = new URL(overrideUrl);
    return appendAuthToken(url, target.authToken).toString();
  }

  const rawHost = target.bridgeHost.trim();
  if (/^wss?:\/\//i.test(rawHost)) {
    const url = new URL(rawHost);
    if (!url.port && target.bridgePort) {
      url.port = String(target.bridgePort);
    }
    return appendAuthToken(url, target.authToken).toString();
  }

  return appendAuthToken(new URL(`ws://${rawHost}:${target.bridgePort || DEFAULT_BRIDGE_PORT}`), target.authToken).toString();
}

export function buildBridgeUrl(host: Host, overrideUrl?: string) {
  return buildBridgeUrlFromTarget(host, overrideUrl);
}
