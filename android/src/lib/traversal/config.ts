import { DEFAULT_TRAVERSAL_PATH_PRIORITY, normalizeTraversalPathPriority, type BridgeSettings } from '../bridge-settings';
import { resolveBridgeEndpoint } from '@zterm/shared';
import { buildBridgeUrlFromTarget } from '../bridge-url';
import { isLikelyTailscaleHost } from '../network-target';
import type { Host } from '../types';
import type {
  RtcTraversalCandidate,
  TraversalIceServer,
  TraversalPlanCandidate,
  TraversalResolvedPath,
  TraversalSettingsSource,
  TraversalTargetSource,
  TraversalTransportMode,
  WebSocketTraversalCandidate,
} from './types';
import type { RelayEndpointCandidate } from '@zterm/shared/relay-directory';

function resolveTraversalPathOrder(
  mode: TraversalTransportMode,
  settings: TraversalSettingsSource,
) {
  if (mode === 'auto') {
    return DEFAULT_TRAVERSAL_PATH_PRIORITY;
  }
  return normalizeTraversalPathPriority(settings.traversalPathPriority || DEFAULT_TRAVERSAL_PATH_PRIORITY);
}

function isLikelyIpv6Host(host?: string | null) {
  const value = host?.trim() || '';
  if (!value) {
    return false;
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    return true;
  }
  if (value.includes('://')) {
    try {
      const parsed = new URL(value);
      return parsed.hostname.includes(':');
    } catch (error) {
      console.warn('[traversal-config] Failed to parse IPv6 host candidate:', { host: value, error });
      return false;
    }
  }
  return value.includes(':') && !value.includes('.');
}

function inferDirectPath(host?: string | null): 'tailscale' | 'ipv6' | 'ipv4' | null {
  const value = host?.trim() || '';
  if (!value) {
    return null;
  }
  if (isLikelyTailscaleHost(value)) {
    return 'tailscale';
  }
  if (isLikelyIpv6Host(value)) {
    return 'ipv6';
  }
  return 'ipv4';
}

function normalizeTraversalTransportMode(
  target: TraversalTargetSource,
  settings: TraversalSettingsSource,
): TraversalTransportMode {
  if (target.transportMode === 'websocket' || target.transportMode === 'webrtc') {
    return target.transportMode;
  }
  if (settings.transportMode === 'websocket' || settings.transportMode === 'webrtc') {
    return settings.transportMode;
  }
  return 'auto';
}

function normalizeSignalUrl(raw: string, authToken?: string) {
  const value = raw.trim();
  if (!value) {
    return '';
  }

  const parsed = new URL(value.includes('://') ? value : `ws://${value}`);
  if (parsed.protocol === 'http:') {
    parsed.protocol = 'ws:';
  } else if (parsed.protocol === 'https:') {
    parsed.protocol = 'wss:';
  }
  if (authToken?.trim()) {
    parsed.searchParams.set('token', authToken.trim());
  }
  return parsed.toString();
}

function buildIceServers(settings: TraversalSettingsSource): TraversalIceServer[] {
  const turnUrl = settings.traversalRelay?.turnUrl?.trim() || settings.turnServerUrl?.trim() || '';
  if (!turnUrl) {
    return [];
  }
  return [{
    urls: turnUrl,
    username: settings.traversalRelay?.turnUsername?.trim() || settings.turnUsername?.trim() || undefined,
    credential: settings.traversalRelay?.turnCredential || settings.turnCredential || undefined,
  }];
}

function buildDirectIceServers(settings: TraversalSettingsSource): TraversalIceServer[] {
  const turnUrl = settings.traversalRelay?.turnUrl?.trim() || settings.turnServerUrl?.trim() || '';
  if (!turnUrl) {
    return [];
  }
  const stunUrl = turnUrl
    .replace(/^turns:/i, 'stuns:')
    .replace(/^turn:/i, 'stun:')
    .replace(/\?.*$/, '');
  if (stunUrl === turnUrl || !/^stuns?:/i.test(stunUrl)) {
    return [];
  }
  return [{ urls: stunUrl }];
}

function addDirectCandidate(
  candidates: WebSocketTraversalCandidate[],
  seenUrls: Set<string>,
  directoryEndpointLocations: Set<string>,
  path: TraversalResolvedPath,
  bridgeHost: string,
  bridgePort: number,
  authToken?: string,
  overrideUrl?: string,
  candidateId?: string,
  isDirectoryCandidate = false,
) {
  const rawHost = bridgeHost.trim();
  if (!rawHost || (path !== 'tailscale' && path !== 'ipv6' && path !== 'ipv4')) {
    return;
  }
  const resolved = resolveBridgeEndpoint({ bridgeHost: rawHost, bridgePort });
  const endpointLocation = `${path}:${resolved.displayEndpoint}`;
  if (!isDirectoryCandidate && directoryEndpointLocations.has(endpointLocation)) {
    return;
  }
  const url = buildBridgeUrlFromTarget({ bridgeHost: rawHost, bridgePort, authToken }, overrideUrl);
  if (seenUrls.has(url)) {
    return;
  }
  if (isDirectoryCandidate) {
    directoryEndpointLocations.add(endpointLocation);
  }
  seenUrls.add(url);
  candidates.push({
    id: candidateId || `direct:${path}:${resolved.displayEndpoint}`,
    kind: 'ws',
    path,
    endpoint: resolved.displayEndpoint,
    url,
  });
}

function resolveWsUrlHost(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.host || parsed.hostname;
  } catch {
    return '';
  }
}

function addDirectoryDirectCandidate(
  candidates: WebSocketTraversalCandidate[],
  seenUrls: Set<string>,
  directoryEndpointLocations: Set<string>,
  endpoint: RelayEndpointCandidate,
  target: TraversalTargetSource,
) {
  if (endpoint.kind !== 'lan' && endpoint.kind !== 'tailscale' && endpoint.kind !== 'ipv6' && endpoint.kind !== 'ipv4') {
    return;
  }
  const host = endpoint.host?.trim()
    || (endpoint.wsUrl ? resolveWsUrlHost(endpoint.wsUrl) : '')
    || '';
  const port = endpoint.port || target.bridgePort;
  const path = endpoint.kind === 'lan'
    ? inferDirectPath(host)
    : endpoint.kind;
  if (!path) {
    return;
  }
  addDirectCandidate(
    candidates,
    seenUrls,
    directoryEndpointLocations,
    path,
    host,
    port,
    endpoint.authToken || target.authToken,
    endpoint.wsUrl,
    endpoint.id,
    true,
  );
}

function resolveDirectoryRtcDirectEndpoint(target: TraversalTargetSource) {
  return target.relayEndpointCandidates
    ?.find((endpoint) => endpoint.kind === 'rtc-direct' && endpoint.relayHostId?.trim()) || null;
}

function resolveDirectoryRelayEndpoint(target: TraversalTargetSource) {
  return target.relayEndpointCandidates
    ?.find((endpoint) => endpoint.kind === 'relay-rtc' && endpoint.relayHostId?.trim()) || null;
}

export function buildTraversalPlan(
  target: TraversalTargetSource,
  settings: TraversalSettingsSource,
  overrideUrl?: string,
): {
  mode: TraversalTransportMode;
  candidates: TraversalPlanCandidate[];
} {
  const mode = normalizeTraversalTransportMode(target, settings);

  if (overrideUrl) {
    return {
      mode,
      candidates: [{
        id: `override:${overrideUrl}`,
        kind: 'ws',
        path: inferDirectPath(target.bridgeHost) || 'ipv4',
        endpoint: overrideUrl,
        url: buildBridgeUrlFromTarget({
          bridgeHost: target.bridgeHost,
          bridgePort: target.bridgePort,
          authToken: target.authToken,
        }, overrideUrl),
      }],
    };
  }

  const wsCandidates: WebSocketTraversalCandidate[] = [];
  const seenWsUrls = new Set<string>();
  const directoryEndpointLocations = new Set<string>();

  if (mode !== 'webrtc') {
    const directCandidates = {
      tailscale: target.tailscaleHost || '',
      ipv6: target.ipv6Host || '',
      ipv4: target.ipv4Host || '',
    };
    for (const path of resolveTraversalPathOrder(mode, settings)) {
      if (path === 'rtc-direct' || path === 'rtc-relay') {
        continue;
      }
      for (const endpoint of target.relayEndpointCandidates || []) {
        if (
          endpoint.kind === path
          || (endpoint.kind === 'lan' && inferDirectPath(endpoint.host) === path)
        ) {
          addDirectoryDirectCandidate(wsCandidates, seenWsUrls, directoryEndpointLocations, endpoint, target);
        }
      }
      addDirectCandidate(wsCandidates, seenWsUrls, directoryEndpointLocations, path, directCandidates[path], target.bridgePort, target.authToken);
    }
    const legacyPath = inferDirectPath(target.bridgeHost);
    if (legacyPath) {
      addDirectCandidate(wsCandidates, seenWsUrls, directoryEndpointLocations, legacyPath, target.bridgeHost, target.bridgePort, target.authToken);
    }
  }

  const rtcCandidates: RtcTraversalCandidate[] = [];
  if (mode !== 'websocket') {
    const relaySignalUrl = settings.traversalRelay?.wsClientUrl?.trim() || '';
    const relayAccessToken = settings.traversalRelay?.accessToken?.trim() || '';
    const relayDeviceId = settings.traversalRelay?.deviceId?.trim() || '';
    const directoryRtcDirectEndpoint = resolveDirectoryRtcDirectEndpoint(target);
    const directoryRelayEndpoint = resolveDirectoryRelayEndpoint(target);
    const relayHostId = target.relayHostId?.trim()
      || target.daemonHostId?.trim()
      || directoryRtcDirectEndpoint?.relayHostId?.trim()
      || directoryRelayEndpoint?.relayHostId?.trim()
      || '';
    const relayIceServers = buildIceServers(settings);
    const directIceServers = buildDirectIceServers(settings);
    const signalUrl = normalizeSignalUrl(
      relaySignalUrl || target.signalUrl?.trim() || settings.signalUrl?.trim() || '',
      relaySignalUrl ? relayAccessToken : target.authToken,
    );
    if (relaySignalUrl && mode === 'webrtc' && !relayHostId) {
      throw new Error('WebRTC relay mode requires selecting an online relay daemon device');
    }
    if (signalUrl && (!relaySignalUrl || relayHostId)) {
      const parsedSignalUrl = new URL(signalUrl);
      if (relaySignalUrl && relayHostId) {
        parsedSignalUrl.searchParams.set('hostId', relayHostId);
      }
      if (relayDeviceId) {
        parsedSignalUrl.searchParams.set('deviceId', relayDeviceId);
      }
      rtcCandidates.push({
        id: directoryRtcDirectEndpoint?.id || (relayHostId ? `rtc-direct:${relayHostId}` : `rtc-direct:${parsedSignalUrl.toString()}`),
        kind: 'rtc',
        path: 'rtc-direct',
        endpoint: directoryRtcDirectEndpoint?.host && directoryRtcDirectEndpoint.port
          ? `${directoryRtcDirectEndpoint.host}:${directoryRtcDirectEndpoint.port}`
          : relayHostId
            ? `rtc-direct:${relayHostId}`
            : 'rtc-direct',
        signalUrl: parsedSignalUrl.toString(),
        iceServers: directIceServers,
        iceTransportPolicy: 'all',
      });
    }
    if (relayIceServers.length > 0 && signalUrl && (!relaySignalUrl || relayHostId)) {
      const parsedSignalUrl = new URL(signalUrl);
      if (relaySignalUrl && relayHostId) {
        parsedSignalUrl.searchParams.set('hostId', relayHostId);
      }
      if (relayDeviceId) {
        parsedSignalUrl.searchParams.set('deviceId', relayDeviceId);
      }
      rtcCandidates.push({
        id: directoryRelayEndpoint?.id || `relay-rtc:${relayHostId || parsedSignalUrl.toString()}`,
        kind: 'rtc',
        path: 'rtc-relay',
        endpoint: relayHostId ? `relay:${relayHostId}` : 'relay',
        signalUrl: parsedSignalUrl.toString(),
        iceServers: relayIceServers,
        iceTransportPolicy: 'relay',
      });
    }
    if (mode === 'webrtc' && rtcCandidates.length === 0) {
      throw new Error('WebRTC mode requires explicit signalUrl and relay daemon target');
    }
  }

  return {
    mode,
    candidates: resolveTraversalPathOrder(mode, settings)
      .flatMap((path) => [...wsCandidates, ...rtcCandidates].filter((candidate) => candidate.path === path)),
  };
}

export function resolveTraversalConfigFromHost(
  host: Host,
  settings: BridgeSettings,
) {
  return {
    target: {
      bridgeHost: host.bridgeHost,
      bridgePort: host.bridgePort,
      authToken: host.authToken,
      relayHostId: host.relayHostId,
      tailscaleHost: host.tailscaleHost,
      ipv6Host: host.ipv6Host,
      ipv4Host: host.ipv4Host,
      relayEndpointCandidates: host.relayEndpointCandidates,
      signalUrl: host.signalUrl,
      transportMode: host.transportMode,
    } satisfies TraversalTargetSource,
    settings: {
      signalUrl: settings.signalUrl,
      turnServerUrl: settings.turnServerUrl,
      turnUsername: settings.turnUsername,
      turnCredential: settings.turnCredential,
      transportMode: settings.transportMode,
      traversalPathPriority: settings.traversalPathPriority,
      traversalRelay: settings.traversalRelay,
    } satisfies TraversalSettingsSource,
  };
}
