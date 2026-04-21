export const APP_UPDATE_STORAGE_KEY = 'zterm:app-update-settings';

export interface AppUpdateManifest {
  versionCode: number;
  versionName: string;
  buildNumber?: number;
  apkUrl: string;
  sha256: string;
  size?: number;
  notes: string[];
  publishedAt?: string;
  channel?: string;
}

export interface AppUpdatePreferences {
  manifestUrl: string;
  autoCheckOnLaunch: boolean;
  skippedVersionCode?: number;
  ignoreUntilManualCheck: boolean;
  lastCheckedAt?: number;
  lastSeenVersionCode?: number;
}

export interface AppUpdateCheckResult {
  manifest: AppUpdateManifest | null;
  updateAvailable: boolean;
  suppressedReason: 'none' | 'skip-version' | 'ignore-until-manual';
}

export const DEFAULT_APP_UPDATE_PREFERENCES: AppUpdatePreferences = {
  manifestUrl: '',
  autoCheckOnLaunch: true,
  skippedVersionCode: undefined,
  ignoreUntilManualCheck: false,
  lastCheckedAt: undefined,
  lastSeenVersionCode: undefined,
};

function toFiniteNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function normalizeAppUpdatePreferences(input: unknown): AppUpdatePreferences {
  if (!input || typeof input !== 'object') {
    return DEFAULT_APP_UPDATE_PREFERENCES;
  }

  const candidate = input as Partial<AppUpdatePreferences>;
  const manifestUrl = typeof candidate.manifestUrl === 'string' ? candidate.manifestUrl.trim() : '';
  const skippedVersionCode = toFiniteNumber(candidate.skippedVersionCode);
  const lastCheckedAt = toFiniteNumber(candidate.lastCheckedAt);
  const lastSeenVersionCode = toFiniteNumber(candidate.lastSeenVersionCode);

  return {
    manifestUrl,
    autoCheckOnLaunch: candidate.autoCheckOnLaunch !== false,
    skippedVersionCode: skippedVersionCode && skippedVersionCode > 0 ? skippedVersionCode : undefined,
    ignoreUntilManualCheck: candidate.ignoreUntilManualCheck === true,
    lastCheckedAt: lastCheckedAt && lastCheckedAt > 0 ? lastCheckedAt : undefined,
    lastSeenVersionCode: lastSeenVersionCode && lastSeenVersionCode > 0 ? lastSeenVersionCode : undefined,
  };
}

export function normalizeAppUpdateManifest(input: unknown): AppUpdateManifest | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input as Partial<AppUpdateManifest>;
  const versionCode = toFiniteNumber(candidate.versionCode);
  const versionName = typeof candidate.versionName === 'string' ? candidate.versionName.trim() : '';
  const apkUrl = typeof candidate.apkUrl === 'string' ? candidate.apkUrl.trim() : '';
  const sha256 = typeof candidate.sha256 === 'string' ? candidate.sha256.trim().toLowerCase() : '';
  const buildNumber = toFiniteNumber(candidate.buildNumber) || undefined;
  const size = toFiniteNumber(candidate.size) || undefined;
  const notes = Array.isArray(candidate.notes)
    ? candidate.notes.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];

  if (!versionCode || versionCode <= 0 || !versionName || !apkUrl || !sha256) {
    return null;
  }

  return {
    versionCode,
    versionName,
    buildNumber,
    apkUrl,
    sha256,
    size,
    notes,
    publishedAt: typeof candidate.publishedAt === 'string' ? candidate.publishedAt : undefined,
    channel: typeof candidate.channel === 'string' ? candidate.channel : undefined,
  };
}

export function shouldSuppressUpdatePrompt(
  manifest: AppUpdateManifest,
  preferences: AppUpdatePreferences,
  options?: { manual?: boolean },
) {
  if (options?.manual) {
    return 'none' as const;
  }
  if (preferences.ignoreUntilManualCheck) {
    return 'ignore-until-manual' as const;
  }
  if (preferences.skippedVersionCode === manifest.versionCode) {
    return 'skip-version' as const;
  }
  return 'none' as const;
}

