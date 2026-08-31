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
  rollbackToPrevious?: AppUpdateRollbackEntry | null;
}

export interface AppUpdateRollbackBackup {
  versionCode: number;
  versionName: string;
  filePath: string;
  sha256: string;
  backedUpAt: number;
}

export interface AppUpdateRollbackEntry {
  versionCode: number;
  versionName: string;
  apkUrl: string;
  sha256: string;
  size?: number;
  sourceVersionCode: number;
  sourceVersionName: string;
}

export type AppUpdateManifestSource =
  | 'user-saved'
  | 'relay-injected'
  | 'server-connected'
  | 'manual-override'
  | 'none';

export interface AppUpdateManifestCandidate {
  id: string;
  label: string;
  manifestUrl: string;
  manifestSource: AppUpdateManifestSource;
}

export interface AppUpdateRouteSnapshot {
  resolvedPath?: 'lan' | 'rtc-direct' | 'tailscale' | 'ipv6' | 'ipv4' | 'rtc-relay' | null;
  resolvedRelayTransport?: 'direct' | 'turn' | null;
  resolvedEndpoint?: string | null;
}

export interface AppUpdateInstallContext {
  manifestUrl: string;
  apkUrl: string;
  versionCode?: number;
  versionName?: string;
  sha256Expected?: string;
  sha256Actual?: string | null;
  httpStatus?: number;
  reason?: string;
  capturedAt: number;
}

export interface AppUpdatePreferences {
  manifestUrl: string;
  manifestSource?: AppUpdateManifestSource;
  autoCheckOnLaunch: boolean;
  skippedVersionCode?: number;
  ignoreUntilManualCheck: boolean;
  lastCheckedAt?: number;
  lastSeenVersionCode?: number;
  rollbackBackup?: AppUpdateRollbackBackup | null;
}

export interface AppUpdateCheckResult {
  manifest: AppUpdateManifest | null;
  updateAvailable: boolean;
  suppressedReason: 'none' | 'skip-version' | 'ignore-until-manual';
}

export const DEFAULT_APP_UPDATE_PREFERENCES: AppUpdatePreferences = {
  manifestUrl: '',
  manifestSource: 'none',
  autoCheckOnLaunch: true,
  skippedVersionCode: undefined,
  ignoreUntilManualCheck: false,
  lastCheckedAt: undefined,
  lastSeenVersionCode: undefined,
};
export const DEFAULT_APP_UPDATE_MANIFEST_SOURCE: AppUpdateManifestSource = 'none';
export const DEFAULT_APP_UPDATE_INSTALL_CONTEXT: AppUpdateInstallContext = {
  manifestUrl: '',
  apkUrl: '',
  capturedAt: 0,
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

function isValidManifestSource(value: unknown): value is AppUpdateManifestSource {
  return value === 'user-saved'
    || value === 'relay-injected'
    || value === 'server-connected'
    || value === 'manual-override'
    || value === 'none';
}

function isPrivateOrLocalHost(hostname: string) {
  const host = hostname.trim().toLowerCase();
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return true;
  }
  const parts = host.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}

function inferLegacyManifestSource(manifestUrl: string): AppUpdateManifestSource {
  if (!manifestUrl) {
    return 'none';
  }
  try {
    const parsed = new URL(manifestUrl);
    if (parsed.hostname === 'relay.codewhisper.cc') {
      return 'relay-injected';
    }
    if (parsed.pathname.endsWith('/updates/latest.json') && isPrivateOrLocalHost(parsed.hostname)) {
      return 'server-connected';
    }
  } catch {
    return 'user-saved';
  }
  return 'user-saved';
}

export function normalizeAppUpdatePreferences(input: unknown): AppUpdatePreferences {
  if (!input || typeof input !== 'object') {
    return DEFAULT_APP_UPDATE_PREFERENCES;
  }

  const candidate = input as Partial<AppUpdatePreferences>;
  const manifestUrl = typeof candidate.manifestUrl === 'string' ? candidate.manifestUrl.trim() : '';
  const manifestSource = manifestUrl
    ? (isValidManifestSource(candidate.manifestSource) && candidate.manifestSource !== 'none'
      ? candidate.manifestSource
      : inferLegacyManifestSource(manifestUrl))
    : 'none';
  const skippedVersionCode = toFiniteNumber(candidate.skippedVersionCode);
  const lastCheckedAt = toFiniteNumber(candidate.lastCheckedAt);
  const lastSeenVersionCode = toFiniteNumber(candidate.lastSeenVersionCode);

  const rollbackBackup = candidate.rollbackBackup && typeof candidate.rollbackBackup === 'object'
    ? (() => {
        const rollbackCandidate = candidate.rollbackBackup as unknown as Record<string, unknown>;
        const versionCode = toFiniteNumber(rollbackCandidate.versionCode);
        const versionName = typeof rollbackCandidate.versionName === 'string' ? rollbackCandidate.versionName.trim() : '';
        const filePath = typeof rollbackCandidate.filePath === 'string' ? rollbackCandidate.filePath.trim() : '';
        const sha256 = typeof rollbackCandidate.sha256 === 'string' ? rollbackCandidate.sha256.trim().toLowerCase() : '';
        const backedUpAt = toFiniteNumber(rollbackCandidate.backedUpAt);
        if (!versionCode || versionCode <= 0 || !versionName || !filePath || !sha256 || !backedUpAt || backedUpAt <= 0) {
          return null;
        }
        return { versionCode, versionName, filePath, sha256, backedUpAt };
      })()
    : null;

  return {
    manifestUrl,
    manifestSource,
    autoCheckOnLaunch: candidate.autoCheckOnLaunch !== false,
    skippedVersionCode: skippedVersionCode && skippedVersionCode > 0 ? skippedVersionCode : undefined,
    ignoreUntilManualCheck: candidate.ignoreUntilManualCheck === true,
    lastCheckedAt: lastCheckedAt && lastCheckedAt > 0 ? lastCheckedAt : undefined,
    lastSeenVersionCode: lastSeenVersionCode && lastSeenVersionCode > 0 ? lastSeenVersionCode : undefined,
    rollbackBackup,
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
    rollbackToPrevious: normalizeAppUpdateRollbackEntry(candidate.rollbackToPrevious),
  };
}

export function normalizeAppUpdateRollbackEntry(input: unknown): AppUpdateRollbackEntry | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const candidate = input as Partial<AppUpdateRollbackEntry>;
  const versionCode = toFiniteNumber(candidate.versionCode);
  const versionName = typeof candidate.versionName === 'string' ? candidate.versionName.trim() : '';
  const apkUrl = typeof candidate.apkUrl === 'string' ? candidate.apkUrl.trim() : '';
  const sha256 = typeof candidate.sha256 === 'string' ? candidate.sha256.trim().toLowerCase() : '';
  const sourceVersionCode = toFiniteNumber(candidate.sourceVersionCode);
  const sourceVersionName = typeof candidate.sourceVersionName === 'string' ? candidate.sourceVersionName.trim() : '';
  const size = toFiniteNumber(candidate.size) || undefined;

  if (!versionCode || versionCode <= 0 || !versionName || !apkUrl || !sha256) {
    return null;
  }
  if (!sourceVersionCode || sourceVersionCode <= 0 || !sourceVersionName) {
    return null;
  }
  if (versionCode <= sourceVersionCode) {
    return null;
  }

  return {
    versionCode,
    versionName,
    apkUrl,
    sha256,
    size,
    sourceVersionCode,
    sourceVersionName,
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
