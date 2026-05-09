export interface AppUpdateProjectionPreferences {
  manifestUrl: string;
  autoCheckOnLaunch: boolean;
  skippedVersionCode?: number;
  ignoreUntilManualCheck: boolean;
  lastCheckedAt?: number;
  lastSeenVersionCode?: number;
}

export interface AppUpdateProjectionManifest {
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

export interface AppUpdateProjectionInput {
  preferences: AppUpdateProjectionPreferences;
  latestManifest: AppUpdateProjectionManifest | null;
  availableManifest: AppUpdateProjectionManifest | null;
  checking: boolean;
  installing: boolean;
  lastError: string | null;
  updateStage: string;
  runtimeVersionCode: number;
}

export interface AppUpdateProjection {
  preferences: AppUpdateProjectionPreferences;
  runtimeVersionCode: number;
  latestManifest: AppUpdateProjectionManifest | null;
  availableManifest: AppUpdateProjectionManifest | null;
  checking: boolean;
  installing: boolean;
  lastError: string | null;
  updateStage: string;
  hasNewVersion: boolean;
  hasUpdateIgnorePolicy: boolean;
  updateManifestUrlConfigured: boolean;
}

export function deriveAppUpdateProjection(input: AppUpdateProjectionInput): AppUpdateProjection {
  return {
    preferences: input.preferences,
    runtimeVersionCode: input.runtimeVersionCode,
    latestManifest: input.latestManifest,
    availableManifest: input.availableManifest,
    checking: input.checking,
    installing: input.installing,
    lastError: input.lastError,
    updateStage: input.updateStage,
    hasNewVersion: Boolean(input.latestManifest && input.latestManifest.versionCode > input.runtimeVersionCode),
    hasUpdateIgnorePolicy: Boolean(
      input.preferences.ignoreUntilManualCheck
      || input.preferences.skippedVersionCode,
    ),
    updateManifestUrlConfigured: Boolean(input.preferences.manifestUrl.trim()),
  };
}
