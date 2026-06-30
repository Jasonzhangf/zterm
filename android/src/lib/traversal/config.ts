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

function addDirectCandidate(
  candidates: WebSocketTraversalCandidate[],
  seenUrls: Set<string>,
  path: TraversalResolvedPath,
  bridgeHost: string,
  bridgePort: number,
  authToken?: string,
  overrideUrl?: string,
  candidateId?: string,
) {
  const rawHost = bridgeHost.trim();
  if (!rawHost || (path !== 'tailscale' && path !== 'ipv6' && path !== 'ipv4')) {
    return;
  }
  const resolved = resolveBridgeEndpoint({ bridgeHost: rawHost, bridgePort });
  const url = buildBridgeUrlFromTarget({ bridgeHost: rawHost, bridgePort, authToken }, overrideUrl);
  if (seenUrls.has(url)) {
    return;
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
  endpoint: RelayEndpointCandidate,
  target: TraversalTargetSource,
) {
  if (endpoint.kind !== 'tailscale' && endpoint.kind !== 'ipv6' && endpoint.kind !== 'ipv4') {
    return;
  }
  const host = endpoint.host?.trim()
    || (endpoint.wsUrl ? resolveWsUrlHost(endpoint.wsUrl) : '')
    || '';
  const port = endpoint.port || target.bridgePort;
  addDirectCandidate(
    candidates,
    seenUrls,
    endpoint.kind,
    host,
    port,
    target.authToken,
    endpoint.wsUrl,
    endpoint.id,
  );
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

  if (mode !== 'webrtc') {
    const directCandidates = {
      tailscale: target.tailscaleHost || '',
      ipv6: target.ipv6Host || '',
      ipv4: target.ipv4Host || '',
    };
    for (const path of normalizeTraversalPathPriority(settings.traversalPathPriority || DEFAULT_TRAVERSAL_PATH_PRIORITY)) {
      if (path === 'rtc-relay') {
        continue;
      }
      addDirectCandidate(wsCandidates, seenWsUrls, path, directCandidates[path], target.bridgePort, target.authToken);
      for (const endpoint of target.relayEndpointCandidates || []) {
        if (endpoint.kind === path) {
          addDirectoryDirectCandidate(wsCandidates, seenWsUrls, endpoint, target);
        }
      }
    }
    const legacyPath = inferDirectPath(target.bridgeHost);
    if (legacyPath) {
      addDirectCandidate(wsCandidates, seenWsUrls, legacyPath, target.bridgeHost, target.bridgePort, target.authToken);
    }
  }

  const rtcCandidates: RtcTraversalCandidate[] = [];
  if (mode !== 'websocket') {
    const relaySignalUrl = settings.traversalRelay?.wsClientUrl?.trim() || '';
    const relayAccessToken = settings.traversalRelay?.accessToken?.trim() || '';
    const directoryRelayEndpoint = resolveDirectoryRelayEndpoint(target);
    const relayHostId = target.relayHostId?.trim() || target.daemonHostId?.trim() || directoryRelayEndpoint?.relayHostId?.trim() || '';
    const iceServers = buildIceServers(settings);
    const signalUrl = normalizeSignalUrl(
      relaySignalUrl || target.signalUrl?.trim() || settings.signalUrl?.trim() || '',
      relaySignalUrl ? relayAccessToken : target.authToken,
    );
    if (relaySignalUrl && mode === 'webrtc' && !relayHostId) {
      throw new Error('WebRTC relay mode requires selecting an online relay daemon device');
    }
    if (iceServers.length > 0 && signalUrl && (!relaySignalUrl || relayHostId)) {
      const parsedSignalUrl = new URL(signalUrl);
      if (relaySignalUrl && relayHostId) {
        parsedSignalUrl.searchParams.set('hostId', relayHostId);
      }
      rtcCandidates.push({
        id: directoryRelayEndpoint?.id || `relay-rtc:${relayHostId || parsedSignalUrl.toString()}`,
        kind: 'rtc',
        path: 'rtc-relay',
        endpoint: target.bridgeHost.trim() || target.ipv4Host?.trim() || target.ipv6Host?.trim() || target.tailscaleHost?.trim() || 'rtc',
        signalUrl: parsedSignalUrl.toString(),
        iceServers,
      });
    }
    if (mode === 'webrtc' && rtcCandidates.length === 0) {
      throw new Error('WebRTC mode requires explicit signalUrl and TURN configuration');
    }
  }

  return {
    mode,
    candidates: normalizeTraversalPathPriority(settings.traversalPathPriority || DEFAULT_TRAVERSAL_PATH_PRIORITY)
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
