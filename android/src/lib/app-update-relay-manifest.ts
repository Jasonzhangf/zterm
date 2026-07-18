import {
  normalizeAppUpdatePreferences,
  type AppUpdateManifestSource,
  type AppUpdatePreferences,
} from './app-update';

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
