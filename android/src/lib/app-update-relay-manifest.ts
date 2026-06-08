import {
  normalizeAppUpdatePreferences,
  type AppUpdatePreferences,
} from './app-update';

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
  url.pathname = '/updates/latest.json';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function buildRelayInjectedAppUpdatePreferences(
  current: AppUpdatePreferences,
  wsHostUrl: string,
): AppUpdatePreferences {
  if (current.manifestUrl.trim()) {
    return current;
  }
  const manifestUrl = deriveRelayUpdateManifestUrl(wsHostUrl);
  if (!manifestUrl) {
    return current;
  }
  return normalizeAppUpdatePreferences({
    ...current,
    manifestUrl,
    autoCheckOnLaunch: current.autoCheckOnLaunch,
  });
}
