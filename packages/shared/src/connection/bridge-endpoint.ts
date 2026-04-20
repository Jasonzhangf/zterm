import { DEFAULT_BRIDGE_PORT } from './mobile-config';

export interface BridgeEndpointLike {
  bridgeHost: string;
  bridgePort: number;
}

function resolveFallbackPort(port: number) {
  return Number.isFinite(port) && port > 0 ? Math.floor(port) : DEFAULT_BRIDGE_PORT;
}

function buildUrlDisplay(url: URL) {
  const path = url.pathname && url.pathname !== '/' ? url.pathname : '';
  return `${url.protocol}//${url.host}${path}`;
}

export function resolveBridgeEndpoint(target: BridgeEndpointLike) {
  const bridgeHost = target.bridgeHost.trim();
  const fallbackPort = resolveFallbackPort(target.bridgePort);

  if (!bridgeHost) {
    return {
      bridgeHost,
      effectivePort: fallbackPort,
      displayEndpoint: `:${fallbackPort}`,
      key: `:${fallbackPort}`.toLowerCase(),
      usesExplicitUrl: false,
    };
  }

  if (/^wss?:\/\//i.test(bridgeHost)) {
    try {
      const url = new URL(bridgeHost);
      if (!url.port) {
        url.port = String(fallbackPort);
      }
      const effectivePort = resolveFallbackPort(Number.parseInt(url.port, 10));
      const displayEndpoint = buildUrlDisplay(url);
      return {
        bridgeHost,
        effectivePort,
        displayEndpoint,
        key: displayEndpoint.toLowerCase(),
        usesExplicitUrl: true,
      };
    } catch {
      return {
        bridgeHost,
        effectivePort: fallbackPort,
        displayEndpoint: `${bridgeHost}:${fallbackPort}`,
        key: `${bridgeHost}:${fallbackPort}`.toLowerCase(),
        usesExplicitUrl: false,
      };
    }
  }

  const displayEndpoint = `${bridgeHost}:${fallbackPort}`;
  return {
    bridgeHost,
    effectivePort: fallbackPort,
    displayEndpoint,
    key: displayEndpoint.toLowerCase(),
    usesExplicitUrl: false,
  };
}

export function formatBridgeEndpointLabel(target: BridgeEndpointLike) {
  return resolveBridgeEndpoint(target).displayEndpoint;
}

export function buildBridgeEndpointKey(target: BridgeEndpointLike) {
  return resolveBridgeEndpoint(target).key;
}

export function resolveEffectiveBridgePort(target: BridgeEndpointLike) {
  return resolveBridgeEndpoint(target).effectivePort;
}
