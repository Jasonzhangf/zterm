import type { BridgeSettings } from '../bridge-settings';
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
    kind: 'ws',
    path,
    endpoint: resolved.displayEndpoint,
    url,
  });
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
    addDirectCandidate(wsCandidates, seenWsUrls, 'tailscale', target.tailscaleHost || '', target.bridgePort, target.authToken);
    addDirectCandidate(wsCandidates, seenWsUrls, 'ipv6', target.ipv6Host || '', target.bridgePort, target.authToken);
    addDirectCandidate(wsCandidates, seenWsUrls, 'ipv4', target.ipv4Host || '', target.bridgePort, target.authToken);

    const legacyPath = inferDirectPath(target.bridgeHost);
    if (legacyPath) {
      addDirectCandidate(wsCandidates, seenWsUrls, legacyPath, target.bridgeHost, target.bridgePort, target.authToken);
    }
  }

  const rtcCandidates: RtcTraversalCandidate[] = [];
  if (mode !== 'websocket') {
    const relaySignalUrl = settings.traversalRelay?.wsClientUrl?.trim() || '';
    const relayAccessToken = settings.traversalRelay?.accessToken?.trim() || '';
    const relayHostId = target.relayHostId?.trim() || '';
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
    candidates: [...wsCandidates, ...rtcCandidates],
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
      signalUrl: host.signalUrl,
      transportMode: host.transportMode,
    } satisfies TraversalTargetSource,
    settings: {
      signalUrl: settings.signalUrl,
      turnServerUrl: settings.turnServerUrl,
      turnUsername: settings.turnUsername,
      turnCredential: settings.turnCredential,
      transportMode: settings.transportMode,
      traversalRelay: settings.traversalRelay,
    } satisfies TraversalSettingsSource,
  };
}
