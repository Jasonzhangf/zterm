import {
  normalizeAppUpdatePreferences,
  type AppUpdateManifestCandidate,
  type AppUpdateManifestSource,
  type AppUpdatePreferences,
} from './app-update';
import { getDefaultBridgeServer, type BridgeSettings } from './bridge-settings';

function replaceRelayWsPathWithUpdatesPath(pathname: string) {
  const segments = pathname.split('/').filter(Boolean);
  const wsIndex = segments.lastIndexOf('ws');
  const baseSegments = wsIndex >= 0 ? segments.slice(0, wsIndex) : [];
  return `/${[...baseSegments, 'updates', 'latest.json'].join('/')}`;
}

export function deriveRelayUpdateManifestUrl(wsHostUrl: string): string {
  const raw = wsHostUrl.trim();
  if (!raw) {
    return '';
  }

  const url = new URL(raw);
  if (url.protocol === 'wss:') {
    url.protocol = 'https:';
  } else if (url.protocol === 'ws:') {
    url.protocol = 'http:';
  } else {
    throw new Error(`Relay wsHostUrl protocol must be ws: or wss:, got ${url.protocol}`);
  }
  url.pathname = replaceRelayWsPathWithUpdatesPath(url.pathname);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function deriveDaemonUpdateManifestUrl(targetHost: string, targetPort: number) {
  const rawHost = targetHost.trim();
  if (!rawHost) {
    return '';
  }

  try {
    const parsed = rawHost.includes('://') ? new URL(rawHost) : new URL(`ws://${rawHost}`);
    const protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
    const port = parsed.port || String(targetPort || 3333);
    return `${protocol}//${parsed.hostname}:${port}/updates/latest.json`;
  } catch {
    return '';
  }
}

function addManifestCandidate(
  candidates: AppUpdateManifestCandidate[],
  seenUrls: Set<string>,
  candidate: AppUpdateManifestCandidate,
) {
  const manifestUrl = candidate.manifestUrl.trim();
  if (!manifestUrl || seenUrls.has(manifestUrl)) {
    return;
  }
  seenUrls.add(manifestUrl);
  candidates.push({ ...candidate, manifestUrl });
}

export function buildAppUpdateManifestCandidates(settings: BridgeSettings): AppUpdateManifestCandidate[] {
  const candidates: AppUpdateManifestCandidate[] = [];
  const seenUrls = new Set<string>();
  const relayWsHostUrl = settings.traversalRelay?.wsHostUrl?.trim() || '';

  if (relayWsHostUrl) {
    try {
      addManifestCandidate(candidates, seenUrls, {
        id: 'relay-public',
        label: 'Relay 公网',
        manifestUrl: deriveRelayUpdateManifestUrl(relayWsHostUrl),
        manifestSource: 'relay-injected',
      });
    } catch {
      // Invalid relay input produces no candidate; direct endpoint truth remains visible.
    }
  }

  const defaultServer = getDefaultBridgeServer(settings);
  const targetHost = settings.targetHost?.trim() || '';
  const directInputs = [
    defaultServer,
    ...settings.servers.filter((server) => server.id !== defaultServer?.id),
    targetHost
      ? {
          id: 'current-target',
          name: '当前 daemon 地址',
          targetHost,
          targetPort: settings.targetPort,
        }
      : null,
  ];

  for (const server of directInputs) {
    if (!server) {
      continue;
    }
    addManifestCandidate(candidates, seenUrls, {
      id: `daemon-${server.id || `${server.targetHost}:${server.targetPort}`}`,
      label: server.name?.trim() || '当前 daemon 地址',
      manifestUrl: deriveDaemonUpdateManifestUrl(server.targetHost, server.targetPort),
      manifestSource: 'server-connected',
    });
  }

  return candidates;
}

function isUserSavedManifest(current: AppUpdatePreferences) {
  return current.manifestUrl.trim() && current.manifestSource === 'user-saved';
}

export function buildRelayInjectedAppUpdatePreferences(
  current: AppUpdatePreferences,
  wsHostUrl: string,
): AppUpdatePreferences {
  if (isUserSavedManifest(current)) {
    return current;
  }
  const manifestUrl = deriveRelayUpdateManifestUrl(wsHostUrl);
  if (!manifestUrl) {
    return current;
  }
  const manifestSource: AppUpdateManifestSource = 'relay-injected';
  if (current.manifestUrl.trim() === manifestUrl && current.manifestSource === manifestSource) {
    return current;
  }
  return normalizeAppUpdatePreferences({
    ...current,
    manifestUrl,
    manifestSource,
    autoCheckOnLaunch: current.autoCheckOnLaunch,
  });
}
