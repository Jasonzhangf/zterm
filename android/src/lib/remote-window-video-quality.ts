import type {
  RemoteWindowStreamTargetManifest,
  RemoteWindowVideoBitrateConfig,
  RemoteWindowVideoBitratePreset,
} from './types';

export const REMOTE_WINDOW_VIDEO_BITRATE_STORAGE_KEY = 'zterm:remote-window-video-bitrate';

export const REMOTE_WINDOW_VIDEO_BITRATE_PRESETS: RemoteWindowVideoBitratePreset[] = [
  '2mbps',
  '5mbps',
  '10mbps',
  '20mbps',
  'fullscreen',
];

export interface RemoteWindowNetworkQualityInput {
  effectiveType?: string | null;
  downlinkMbps?: number | null;
  rttMs?: number | null;
  saveData?: boolean | null;
}

type RemoteWindowVideoBitrateStorage = {
  version: 1;
  byTarget: Record<string, RemoteWindowVideoBitratePreset>;
  byResolution: Record<string, RemoteWindowVideoBitratePreset>;
};

interface BrowserStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isRemoteWindowVideoBitratePreset(value: unknown): value is RemoteWindowVideoBitratePreset {
  return typeof value === 'string'
    && (REMOTE_WINDOW_VIDEO_BITRATE_PRESETS as string[]).includes(value);
}

function readStorage(storage: BrowserStorageLike | null | undefined): RemoteWindowVideoBitrateStorage {
  if (!storage) {
    return { version: 1, byTarget: {}, byResolution: {} };
  }
  try {
    const raw = storage.getItem(REMOTE_WINDOW_VIDEO_BITRATE_STORAGE_KEY);
    if (!raw) {
      return { version: 1, byTarget: {}, byResolution: {} };
    }
    const parsed = JSON.parse(raw) as Partial<RemoteWindowVideoBitrateStorage>;
    return {
      version: 1,
      byTarget: Object.fromEntries(
        Object.entries(parsed.byTarget || {}).filter(([, value]) => isRemoteWindowVideoBitratePreset(value)),
      ),
      byResolution: Object.fromEntries(
        Object.entries(parsed.byResolution || {}).filter(([, value]) => isRemoteWindowVideoBitratePreset(value)),
      ),
    };
  } catch {
    return { version: 1, byTarget: {}, byResolution: {} };
  }
}

function writeStorage(
  storage: BrowserStorageLike | null | undefined,
  value: RemoteWindowVideoBitrateStorage,
) {
  if (!storage) {
    return false;
  }
  storage.setItem(REMOTE_WINDOW_VIDEO_BITRATE_STORAGE_KEY, JSON.stringify(value));
  return true;
}

export function getRemoteWindowSourceRect(target: RemoteWindowStreamTargetManifest) {
  return target.videoTarget.cropRectTopLeftPx || target.videoTarget.windowBoundsTopLeftPx;
}

export function resolveRemoteWindowVideoResolutionKey(target: RemoteWindowStreamTargetManifest) {
  const rect = getRemoteWindowSourceRect(target);
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  return `${target.videoTarget.kind}:${width}x${height}`;
}

export function resolveRemoteWindowVideoTargetKey(target: RemoteWindowStreamTargetManifest) {
  return [
    target.videoTarget.kind,
    target.videoTarget.appBundleId,
    target.videoTarget.windowId,
    target.videoTarget.title,
  ].join('|');
}

export function resolveDefaultRemoteWindowVideoBitratePreset(
  target: RemoteWindowStreamTargetManifest,
): RemoteWindowVideoBitratePreset {
  const rect = getRemoteWindowSourceRect(target);
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const pixels = width * height;
  if (width >= 1000 || pixels >= 900_000) {
    return 'fullscreen';
  }
  if (pixels >= 480_000) {
    return '10mbps';
  }
  if (pixels >= 180_000) {
    return '5mbps';
  }
  return '2mbps';
}

export function buildRemoteWindowVideoBitrateConfig(
  preset: RemoteWindowVideoBitratePreset,
): RemoteWindowVideoBitrateConfig {
  const bitrateMbps = preset === '2mbps'
    ? 2
    : preset === '5mbps'
      ? 5
      : preset === '10mbps'
        ? 10
        : 20;
  const maxFrameRateFps = preset === '2mbps'
    ? 5
    : preset === '5mbps'
      ? 8
      : 12;
  return {
    preset,
    bitrateMbps,
    maxBitrateBps: bitrateMbps * 1_000_000,
    maxFrameRateFps,
  };
}

export function resolveEffectiveRemoteWindowVideoBitratePreset(
  selectedPreset: RemoteWindowVideoBitratePreset,
  projection: { mode: 'floating' | 'fullscreen'; fullscreenScale?: number },
): RemoteWindowVideoBitratePreset {
  if (projection.mode === 'floating') {
    return '2mbps';
  }
  return selectedPreset;
}

function bitrateRank(preset: RemoteWindowVideoBitratePreset) {
  switch (preset) {
    case '2mbps':
      return 0;
    case '5mbps':
      return 1;
    case '10mbps':
      return 2;
    case '20mbps':
      return 3;
    case 'fullscreen':
      return 4;
    default:
      return 0;
  }
}

function minBitratePreset(
  selectedPreset: RemoteWindowVideoBitratePreset,
  capPreset: RemoteWindowVideoBitratePreset,
) {
  return bitrateRank(selectedPreset) <= bitrateRank(capPreset)
    ? selectedPreset
    : capPreset;
}

export function resolveAdaptiveRemoteWindowVideoBitratePreset(
  selectedPreset: RemoteWindowVideoBitratePreset,
  network: RemoteWindowNetworkQualityInput | null | undefined,
): RemoteWindowVideoBitratePreset {
  if (!network) {
    return selectedPreset;
  }
  const effectiveType = `${network.effectiveType || ''}`.toLowerCase();
  const downlinkMbps = typeof network.downlinkMbps === 'number' && Number.isFinite(network.downlinkMbps)
    ? network.downlinkMbps
    : null;
  const rttMs = typeof network.rttMs === 'number' && Number.isFinite(network.rttMs)
    ? network.rttMs
    : null;

  if (
    network.saveData
    || effectiveType === 'slow-2g'
    || effectiveType === '2g'
    || (downlinkMbps !== null && downlinkMbps < 0.8)
    || (rttMs !== null && rttMs >= 800)
  ) {
    return minBitratePreset(selectedPreset, '2mbps');
  }

  if (
    effectiveType === '3g'
    || (downlinkMbps !== null && downlinkMbps < 2)
    || (rttMs !== null && rttMs >= 500)
  ) {
    return minBitratePreset(selectedPreset, '5mbps');
  }

  if (
    (downlinkMbps !== null && downlinkMbps < 5)
    || (rttMs !== null && rttMs >= 250)
  ) {
    return minBitratePreset(selectedPreset, '10mbps');
  }

  return selectedPreset;
}

export function readRemoteWindowVideoBitratePreset(
  target: RemoteWindowStreamTargetManifest,
  storage: BrowserStorageLike | null | undefined = typeof window === 'undefined' ? null : window.localStorage,
): RemoteWindowVideoBitratePreset {
  const snapshot = readStorage(storage);
  const targetKey = resolveRemoteWindowVideoTargetKey(target);
  const resolutionKey = resolveRemoteWindowVideoResolutionKey(target);
  return snapshot.byTarget[targetKey]
    || snapshot.byResolution[resolutionKey]
    || resolveDefaultRemoteWindowVideoBitratePreset(target);
}

export function writeRemoteWindowVideoBitratePreset(
  target: RemoteWindowStreamTargetManifest,
  preset: RemoteWindowVideoBitratePreset,
  storage: BrowserStorageLike | null | undefined = typeof window === 'undefined' ? null : window.localStorage,
) {
  if (!isRemoteWindowVideoBitratePreset(preset)) {
    return false;
  }
  const snapshot = readStorage(storage);
  snapshot.byTarget[resolveRemoteWindowVideoTargetKey(target)] = preset;
  snapshot.byResolution[resolveRemoteWindowVideoResolutionKey(target)] = preset;
  return writeStorage(storage, snapshot);
}
