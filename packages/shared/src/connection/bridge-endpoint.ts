import { DEFAULT_BRIDGE_PORT } from './mobile-config';

export interface BridgeEndpointLike {
  bridgeHost: string;
  bridgePort: number;
}

interface ParsedRawHostLiteral {
  normalizedHost: string;
  embeddedPort: number | null;
}

function normalizeBridgePort(port: number) {
  return Number.isFinite(port) && port > 0 ? Math.floor(port) : DEFAULT_BRIDGE_PORT;
}

function buildUrlDisplay(url: URL) {
  const path = url.pathname && url.pathname !== '/' ? url.pathname : '';
  return `${url.protocol}//${url.host}${path}`;
}

function parseRawHostLiteral(rawHost: string): ParsedRawHostLiteral {
  if (!rawHost) {
    return {
      normalizedHost: rawHost,
      embeddedPort: null,
    };
  }

  if (rawHost.startsWith('[')) {
    const bracketedMatch = rawHost.match(/^(\[[^\]]+\])(?::(\d+))?$/);
    if (bracketedMatch) {
      return {
        normalizedHost: bracketedMatch[1],
        embeddedPort: bracketedMatch[2] ? normalizeBridgePort(Number.parseInt(bracketedMatch[2], 10)) : null,
      };
    }
  }

  const colonMatches = rawHost.match(/:/g) || [];
  if (colonMatches.length === 1) {
    const separatorIndex = rawHost.lastIndexOf(':');
    const hostLiteral = rawHost.slice(0, separatorIndex).trim();
    const portLiteral = rawHost.slice(separatorIndex + 1).trim();
    if (hostLiteral && /^\d+$/.test(portLiteral)) {
      return {
        normalizedHost: hostLiteral,
        embeddedPort: normalizeBridgePort(Number.parseInt(portLiteral, 10)),
      };
    }
  }

  return {
    normalizedHost: rawHost,
    embeddedPort: null,
  };
}

export function resolveBridgeEndpoint(target: BridgeEndpointLike) {
  const bridgeHost = target.bridgeHost.trim();
  const normalizedPort = normalizeBridgePort(target.bridgePort);

  if (!bridgeHost) {
    return {
      bridgeHost,
      normalizedHost: bridgeHost,
      effectivePort: normalizedPort,
      displayEndpoint: `:${normalizedPort}`,
      key: `:${normalizedPort}`.toLowerCase(),
      usesExplicitUrl: false,
    };
  }

  if (/^wss?:\/\//i.test(bridgeHost)) {
    try {
      const url = new URL(bridgeHost);
      if (!url.port) {
        url.port = String(normalizedPort);
      }
      const effectivePort = normalizeBridgePort(Number.parseInt(url.port, 10));
      const displayEndpoint = buildUrlDisplay(url);
      return {
        bridgeHost,
        normalizedHost: bridgeHost,
        effectivePort,
        displayEndpoint,
        key: displayEndpoint.toLowerCase(),
        usesExplicitUrl: true,
      };
    } catch (error) {
      return {
        bridgeHost,
        normalizedHost: bridgeHost,
        effectivePort: normalizedPort,
        displayEndpoint: bridgeHost,
        key: bridgeHost.toLowerCase(),
        usesExplicitUrl: true,
        parseError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const parsedRawHost = parseRawHostLiteral(bridgeHost);
  const effectivePort = parsedRawHost.embeddedPort ?? normalizedPort;
  const displayEndpoint = `${parsedRawHost.normalizedHost}:${effectivePort}`;
  return {
    bridgeHost,
    normalizedHost: parsedRawHost.normalizedHost,
    effectivePort,
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

export function resolveNormalizedBridgeHost(target: BridgeEndpointLike) {
  return resolveBridgeEndpoint(target).normalizedHost;
}
