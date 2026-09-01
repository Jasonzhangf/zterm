import type {
  RemoteWindowStreamTargetManifest,
  RemoteWindowVideoPreference,
  RemoteWindowVideoProfile,
} from './types';

export const REMOTE_WINDOW_VIDEO_PREFERENCE_STORAGE_KEY = 'zterm:remote-window-video-preference-v2';
export const REMOTE_WINDOW_VIDEO_PREFERENCE_GLOBAL_STORAGE_KEY = 'zterm:remote-window-video-preference-global-v2';
export const REMOTE_WINDOW_VIDEO_BITRATE_STORAGE_KEY = 'zterm:remote-window-video-bitrate';
export const REMOTE_WINDOW_VIDEO_BITRATE_GLOBAL_STORAGE_KEY = 'zterm:remote-window-video-bitrate-global';
export const REMOTE_WINDOW_VIDEO_PREFERENCES: readonly RemoteWindowVideoPreference[] = ['smooth', 'quality'];

// Internal ABR guardrails. These are deliberately kept out of the wire
// profile: the daemon receives the resolved max bitrate, while the client
// owns the policy limits used to prevent text quality collapsing under load.
export const REMOTE_WINDOW_VIDEO_BITRATE_BOUNDS: Readonly<Record<RemoteWindowVideoPreference, {
  minBps: number;
  maxBps: number;
}>> = Object.freeze({
  smooth: Object.freeze({ minBps: 2_000_000, maxBps: 8_000_000 }),
  quality: Object.freeze({ minBps: 6_000_000, maxBps: 18_000_000 }),
});

export interface RemoteWindowNetworkQualityInput {
  effectiveType?: string | null;
  downlinkMbps?: number | null;
  rttMs?: number | null;
  saveData?: boolean | null;
}

export interface RemoteWindowVideoStatsSample {
  sampledAtMs: number;
  rttMs?: number | null;
  availableIncomingBitrateBps?: number | null;
  availableOutgoingBitrateBps?: number | null;
  framesPerSecond?: number | null;
  framesDropped?: number | null;
  freezeCount?: number | null;
  jitterBufferDelayMs?: number | null;
  qualityLimitationReason?: string | null;
}

export type RemoteWindowVideoPressureCause = 'none' | 'network' | 'host' | 'render' | 'latency';

export interface RemoteWindowVideoAdaptiveState {
  pressureCause: RemoteWindowVideoPressureCause;
  level: 0 | 1 | 2;
  consecutivePressureSamples: number;
  stableSinceMs: number | null;
  lastAdjustmentAtMs: number | null;
  lastSample: RemoteWindowVideoStatsSample | null;
}

export interface RemoteWindowVideoAdaptiveDecision {
  state: RemoteWindowVideoAdaptiveState;
  profile: RemoteWindowVideoProfile;
  reason: 'baseline' | 'downgrade' | 'hold' | 'restore';
  cause: RemoteWindowVideoPressureCause;
}

type RemoteWindowVideoPreferenceStorage = {
  version: 2;
  byTarget: Record<string, RemoteWindowVideoPreference>;
  byResolution: Record<string, RemoteWindowVideoPreference>;
};

interface BrowserStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isRemoteWindowVideoPreference(value: unknown): value is RemoteWindowVideoPreference {
  return value === 'smooth' || value === 'quality';
}

function migrateLegacyBitratePreset(value: unknown): RemoteWindowVideoPreference | null {
  if (value === '2mbps' || value === '5mbps') {
    return 'smooth';
  }
  if (value === '10mbps' || value === '20mbps' || value === 'fullscreen') {
    return 'quality';
  }
  return null;
}

function emptyPreferenceStorage(): RemoteWindowVideoPreferenceStorage {
  return { version: 2, byTarget: {}, byResolution: {} };
}

function readPreferenceStorage(
  storage: BrowserStorageLike | null | undefined,
): RemoteWindowVideoPreferenceStorage {
  if (!storage) {
    return emptyPreferenceStorage();
  }
  try {
    const raw = storage.getItem(REMOTE_WINDOW_VIDEO_PREFERENCE_STORAGE_KEY);
    if (!raw) {
      return emptyPreferenceStorage();
    }
    const parsed = JSON.parse(raw) as Partial<RemoteWindowVideoPreferenceStorage>;
    return {
      version: 2,
      byTarget: Object.fromEntries(
        Object.entries(parsed.byTarget || {}).filter(([, value]) => isRemoteWindowVideoPreference(value)),
      ),
      byResolution: Object.fromEntries(
        Object.entries(parsed.byResolution || {}).filter(([, value]) => isRemoteWindowVideoPreference(value)),
      ),
    };
  } catch {
    return emptyPreferenceStorage();
  }
}

function readLegacyPreferenceStorage(
  storage: BrowserStorageLike | null | undefined,
): Pick<RemoteWindowVideoPreferenceStorage, 'byTarget' | 'byResolution'> {
  if (!storage) {
    return { byTarget: {}, byResolution: {} };
  }
  try {
    const raw = storage.getItem(REMOTE_WINDOW_VIDEO_BITRATE_STORAGE_KEY);
    if (!raw) {
      return { byTarget: {}, byResolution: {} };
    }
    const parsed = JSON.parse(raw) as {
      byTarget?: Record<string, unknown>;
      byResolution?: Record<string, unknown>;
    };
    const migrateEntries = (entries: Record<string, unknown> | undefined) => Object.fromEntries(
      Object.entries(entries || {}).flatMap(([key, value]) => {
        const migrated = migrateLegacyBitratePreset(value);
        return migrated ? [[key, migrated]] : [];
      }),
    );
    return {
      byTarget: migrateEntries(parsed.byTarget),
      byResolution: migrateEntries(parsed.byResolution),
    };
  } catch {
    return { byTarget: {}, byResolution: {} };
  }
}

function writePreferenceStorage(
  storage: BrowserStorageLike | null | undefined,
  value: RemoteWindowVideoPreferenceStorage,
) {
  if (!storage) {
    return false;
  }
  storage.setItem(REMOTE_WINDOW_VIDEO_PREFERENCE_STORAGE_KEY, JSON.stringify(value));
  return true;
}

export function getRemoteWindowSourceRect(target: RemoteWindowStreamTargetManifest) {
  return target.videoTarget.cropRectTopLeftPx || target.videoTarget.windowBoundsTopLeftPx;
}

function getRectArea(rect: { width: number; height: number }) {
  return Math.max(1, rect.width) * Math.max(1, rect.height);
}

export function resolveRemoteWindowDesktopCoverageRatio(
  target: RemoteWindowStreamTargetManifest,
) {
  const displayRect = target.capture.displayBoundsTopLeftPx;
  if (!displayRect) {
    return null;
  }
  const displayArea = getRectArea(displayRect);
  const sourceArea = getRectArea(getRemoteWindowSourceRect(target));
  if (!Number.isFinite(displayArea) || displayArea <= 0 || !Number.isFinite(sourceArea) || sourceArea <= 0) {
    return null;
  }
  return Math.max(0, Math.min(1, sourceArea / displayArea));
}

export function resolveRemoteWindowVideoResolutionKey(target: RemoteWindowStreamTargetManifest) {
  const rect = getRemoteWindowSourceRect(target);
  return `${target.videoTarget.kind}:${Math.max(1, Math.round(rect.width))}x${Math.max(1, Math.round(rect.height))}`;
}

export function resolveRemoteWindowVideoTargetKey(target: RemoteWindowStreamTargetManifest) {
  return [
    target.videoTarget.kind,
    target.videoTarget.appBundleId,
    target.videoTarget.windowId,
    target.videoTarget.title,
  ].join('|');
}

export function resolveDefaultRemoteWindowVideoPreference(
  _target: RemoteWindowStreamTargetManifest,
): RemoteWindowVideoPreference {
  return 'smooth';
}

export function buildRemoteWindowVideoProfile(
  preference: RemoteWindowVideoPreference,
  options: {
    interactionActive?: boolean;
    cause?: RemoteWindowVideoPressureCause;
    level?: 0 | 1 | 2;
  } = {},
): RemoteWindowVideoProfile {
  const interactionActive = options.interactionActive === true;
  const cause = options.cause ?? 'none';
  const level = options.level ?? 0;
  const bitrateBounds = REMOTE_WINDOW_VIDEO_BITRATE_BOUNDS[preference];
  const base: RemoteWindowVideoProfile = preference === 'smooth'
    ? {
        preference,
        maxBitrateBps: interactionActive ? bitrateBounds.maxBps : 6_000_000,
        maxFrameRateFps: interactionActive ? 45 : 30,
        maxCaptureWidth: interactionActive ? 1280 : 1440,
        maxCaptureHeight: interactionActive ? 800 : 900,
        maxFrameAgeMs: interactionActive ? 80 : 100,
        interactionActive,
        overviewMaxBitrateBps: interactionActive ? 150_000 : 250_000,
        overviewMaxFrameRateFps: interactionActive ? 1 : 2,
      }
    : {
        preference,
        maxBitrateBps: interactionActive ? bitrateBounds.maxBps : 16_000_000,
        maxFrameRateFps: 30,
        maxCaptureWidth: 1920,
        maxCaptureHeight: 1200,
        maxFrameAgeMs: interactionActive ? 120 : 150,
        interactionActive,
        overviewMaxBitrateBps: interactionActive ? 150_000 : 300_000,
        overviewMaxFrameRateFps: interactionActive ? 1 : 2,
      };
  if (level === 0 || cause === 'none') {
    return base;
  }
  if (cause === 'latency') {
    return {
      ...base,
      maxFrameAgeMs: preference === 'smooth' ? 80 : 120,
      overviewMaxBitrateBps: Math.min(base.overviewMaxBitrateBps, 150_000),
      overviewMaxFrameRateFps: 1,
    };
  }
  if (preference === 'smooth') {
    if (level === 2) {
      return {
        ...base,
        maxBitrateBps: cause === 'network' ? 2_000_000 : 3_000_000,
        maxFrameRateFps: 30,
        maxCaptureWidth: 960,
        maxCaptureHeight: 600,
        maxFrameAgeMs: cause === 'network' ? 120 : 100,
        overviewMaxBitrateBps: 100_000,
        overviewMaxFrameRateFps: 1,
      };
    }
    return {
      ...base,
      maxBitrateBps: cause === 'network' ? 4_000_000 : 5_000_000,
      maxFrameRateFps: cause === 'network' && interactionActive ? 45 : 30,
      maxCaptureWidth: 1280,
      maxCaptureHeight: 800,
      maxFrameAgeMs: cause === 'network' ? 100 : 90,
      overviewMaxBitrateBps: 150_000,
      overviewMaxFrameRateFps: 1,
    };
  }
  if (level === 2) {
    return {
      ...base,
      maxBitrateBps: cause === 'network' ? 6_000_000 : 10_000_000,
      maxFrameRateFps: 24,
      maxCaptureWidth: 1280,
      maxCaptureHeight: 800,
      maxFrameAgeMs: 180,
      overviewMaxBitrateBps: 150_000,
      overviewMaxFrameRateFps: 1,
    };
  }
  return {
    ...base,
    maxBitrateBps: cause === 'network' ? 10_000_000 : 14_000_000,
    maxFrameRateFps: 30,
    maxCaptureWidth: 1600,
    maxCaptureHeight: 1000,
    maxFrameAgeMs: 150,
    overviewMaxBitrateBps: 200_000,
    overviewMaxFrameRateFps: 2,
  };
}

function finiteNumber(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function counterDelta(current: number | null | undefined, previous: number | null | undefined) {
  const currentValue = finiteNumber(current);
  const previousValue = finiteNumber(previous);
  if (currentValue === null || previousValue === null || currentValue < previousValue) {
    return 0;
  }
  return currentValue - previousValue;
}

function classifyRemoteWindowVideoPressure(options: {
  profile: RemoteWindowVideoProfile;
  sample: RemoteWindowVideoStatsSample;
  previousSample: RemoteWindowVideoStatsSample | null;
}) {
  const { profile, sample, previousSample } = options;
  const availableBitrate = finiteNumber(sample.availableIncomingBitrateBps)
    ?? finiteNumber(sample.availableOutgoingBitrateBps);
  const rttMs = finiteNumber(sample.rttMs);
  const fps = finiteNumber(sample.framesPerSecond);
  const droppedDelta = counterDelta(sample.framesDropped, previousSample?.framesDropped);
  const freezeDelta = counterDelta(sample.freezeCount, previousSample?.freezeCount);
  const jitterDelayMs = finiteNumber(sample.jitterBufferDelayMs) ?? 0;
  const limitation = `${sample.qualityLimitationReason || ''}`.toLowerCase();
  const severeNetwork = availableBitrate !== null && availableBitrate < profile.maxBitrateBps * 0.35;
  if (limitation === 'bandwidth' || (availableBitrate !== null && availableBitrate < profile.maxBitrateBps * 0.7)) {
    return { cause: 'network' as const, severe: severeNetwork };
  }
  if (limitation === 'cpu') {
    return { cause: 'host' as const, severe: false };
  }
  if (droppedDelta >= 3 || freezeDelta > 0 || (fps !== null && fps < profile.maxFrameRateFps * 0.65)) {
    return { cause: 'render' as const, severe: droppedDelta >= 20 || freezeDelta >= 2 };
  }
  if ((rttMs !== null && rttMs >= 350) || jitterDelayMs >= 250) {
    return { cause: 'latency' as const, severe: false };
  }
  return { cause: 'none' as const, severe: false };
}

function createAdaptiveState(): RemoteWindowVideoAdaptiveState {
  return {
    pressureCause: 'none',
    level: 0,
    consecutivePressureSamples: 0,
    stableSinceMs: null,
    lastAdjustmentAtMs: null,
    lastSample: null,
  };
}

export function resolveRemoteWindowVideoAdaptiveDecision(options: {
  preference: RemoteWindowVideoPreference;
  interactionActive?: boolean;
  previous?: RemoteWindowVideoAdaptiveState | null;
  sample?: RemoteWindowVideoStatsSample | null;
  pressureSamplesBeforeDowngrade?: number;
  restoreStableMs?: number;
  minimumAdjustmentIntervalMs?: number;
}): RemoteWindowVideoAdaptiveDecision {
  const previous = options.previous ?? createAdaptiveState();
  const sample = options.sample ?? null;
  const interactionActive = options.interactionActive === true;
  if (!sample) {
    return {
      state: previous,
      profile: buildRemoteWindowVideoProfile(options.preference, {
        interactionActive,
        cause: previous.pressureCause,
        level: previous.level,
      }),
      reason: previous.level > 0 ? 'hold' : 'baseline',
      cause: previous.pressureCause,
    };
  }
  const currentProfile = buildRemoteWindowVideoProfile(options.preference, {
    interactionActive,
    cause: previous.pressureCause,
    level: previous.level,
  });
  const pressure = classifyRemoteWindowVideoPressure({
    profile: currentProfile,
    sample,
    previousSample: previous.lastSample,
  });
  if (pressure.cause !== 'none') {
    const sameCause = pressure.cause === previous.pressureCause;
    const consecutivePressureSamples = sameCause ? previous.consecutivePressureSamples + 1 : 1;
    const requiredSamples = Math.max(1, Math.floor(options.pressureSamplesBeforeDowngrade ?? 2));
    const minimumAdjustmentIntervalMs = Math.max(1, Math.floor(options.minimumAdjustmentIntervalMs ?? 4_000));
    const intervalReady = previous.lastAdjustmentAtMs === null
      || sample.sampledAtMs - previous.lastAdjustmentAtMs >= minimumAdjustmentIntervalMs;
    const shouldDowngrade = intervalReady && (pressure.severe || consecutivePressureSamples >= requiredSamples);
    const level = shouldDowngrade ? Math.min(2, Math.max(1, previous.level + 1)) as 1 | 2 : previous.level;
    const state: RemoteWindowVideoAdaptiveState = {
      pressureCause: pressure.cause,
      level,
      consecutivePressureSamples: shouldDowngrade ? 0 : consecutivePressureSamples,
      stableSinceMs: null,
      lastAdjustmentAtMs: shouldDowngrade ? sample.sampledAtMs : previous.lastAdjustmentAtMs,
      lastSample: sample,
    };
    return {
      state,
      profile: buildRemoteWindowVideoProfile(options.preference, {
        interactionActive,
        cause: state.pressureCause,
        level: state.level,
      }),
      reason: shouldDowngrade ? 'downgrade' : state.level > 0 ? 'hold' : 'baseline',
      cause: state.pressureCause,
    };
  }
  if (previous.level === 0) {
    const state = { ...createAdaptiveState(), lastSample: sample };
    return {
      state,
      profile: buildRemoteWindowVideoProfile(options.preference, { interactionActive }),
      reason: 'baseline',
      cause: 'none',
    };
  }
  const stableSinceMs = previous.stableSinceMs ?? sample.sampledAtMs;
  const restoreStableMs = Math.max(1, Math.floor(options.restoreStableMs ?? 12_000));
  if (sample.sampledAtMs - stableSinceMs >= restoreStableMs) {
    const level = Math.max(0, previous.level - 1) as 0 | 1;
    const state: RemoteWindowVideoAdaptiveState = {
      pressureCause: level === 0 ? 'none' : previous.pressureCause,
      level,
      consecutivePressureSamples: 0,
      stableSinceMs: level === 0 ? null : sample.sampledAtMs,
      lastAdjustmentAtMs: sample.sampledAtMs,
      lastSample: sample,
    };
    return {
      state,
      profile: buildRemoteWindowVideoProfile(options.preference, {
        interactionActive,
        cause: state.pressureCause,
        level: state.level,
      }),
      reason: 'restore',
      cause: state.pressureCause,
    };
  }
  const state = {
    ...previous,
    consecutivePressureSamples: 0,
    stableSinceMs,
    lastSample: sample,
  };
  return {
    state,
    profile: buildRemoteWindowVideoProfile(options.preference, {
      interactionActive,
      cause: state.pressureCause,
      level: state.level,
    }),
    reason: 'hold',
    cause: state.pressureCause,
  };
}

export function resolveInitialRemoteWindowVideoProfile(
  preference: RemoteWindowVideoPreference,
  network: RemoteWindowNetworkQualityInput | null | undefined,
  interactionActive = false,
) {
  if (!network) {
    return buildRemoteWindowVideoProfile(preference, { interactionActive });
  }
  const effectiveType = `${network.effectiveType || ''}`.toLowerCase();
  const downlinkMbps = finiteNumber(network.downlinkMbps);
  if (network.saveData || effectiveType === 'slow-2g' || effectiveType === '2g' || (downlinkMbps !== null && downlinkMbps < 2)) {
    return buildRemoteWindowVideoProfile(preference, { interactionActive, cause: 'network', level: 2 });
  }
  if (effectiveType === '3g' || (downlinkMbps !== null && downlinkMbps < 5)) {
    return buildRemoteWindowVideoProfile(preference, { interactionActive, cause: 'network', level: 1 });
  }
  if ((finiteNumber(network.rttMs) ?? 0) >= 500) {
    return buildRemoteWindowVideoProfile(preference, { interactionActive, cause: 'latency', level: 1 });
  }
  return buildRemoteWindowVideoProfile(preference, { interactionActive });
}

export function readRemoteWindowVideoPreference(
  target: RemoteWindowStreamTargetManifest,
  storage: BrowserStorageLike | null | undefined = typeof window === 'undefined' ? null : window.localStorage,
): RemoteWindowVideoPreference {
  const targetKey = resolveRemoteWindowVideoTargetKey(target);
  const resolutionKey = resolveRemoteWindowVideoResolutionKey(target);
  const snapshot = readPreferenceStorage(storage);
  const current = snapshot.byTarget[targetKey]
    || snapshot.byResolution[resolutionKey]
    || readRemoteWindowVideoPreferenceGlobalDefault(storage);
  if (current) {
    return current;
  }
  const legacy = readLegacyPreferenceStorage(storage);
  const migrated = legacy.byTarget[targetKey]
    || legacy.byResolution[resolutionKey]
    || migrateLegacyBitratePreset(storage?.getItem(REMOTE_WINDOW_VIDEO_BITRATE_GLOBAL_STORAGE_KEY));
  if (migrated) {
    writeRemoteWindowVideoPreference(target, migrated, storage);
    return migrated;
  }
  return resolveDefaultRemoteWindowVideoPreference(target);
}

export function readRemoteWindowVideoPreferenceGlobalDefault(
  storage: BrowserStorageLike | null | undefined = typeof window === 'undefined' ? null : window.localStorage,
): RemoteWindowVideoPreference | null {
  if (!storage) {
    return null;
  }
  try {
    const current = storage.getItem(REMOTE_WINDOW_VIDEO_PREFERENCE_GLOBAL_STORAGE_KEY);
    if (isRemoteWindowVideoPreference(current)) {
      return current;
    }
    const migrated = migrateLegacyBitratePreset(storage.getItem(REMOTE_WINDOW_VIDEO_BITRATE_GLOBAL_STORAGE_KEY));
    if (migrated) {
      storage.setItem(REMOTE_WINDOW_VIDEO_PREFERENCE_GLOBAL_STORAGE_KEY, migrated);
    }
    return migrated;
  } catch {
    return null;
  }
}

export function writeRemoteWindowVideoPreferenceGlobalDefault(
  preference: RemoteWindowVideoPreference,
  storage: BrowserStorageLike | null | undefined = typeof window === 'undefined' ? null : window.localStorage,
) {
  if (!storage || !isRemoteWindowVideoPreference(preference)) {
    return false;
  }
  storage.setItem(REMOTE_WINDOW_VIDEO_PREFERENCE_GLOBAL_STORAGE_KEY, preference);
  return true;
}

export function writeRemoteWindowVideoPreference(
  target: RemoteWindowStreamTargetManifest,
  preference: RemoteWindowVideoPreference,
  storage: BrowserStorageLike | null | undefined = typeof window === 'undefined' ? null : window.localStorage,
) {
  if (!isRemoteWindowVideoPreference(preference)) {
    return false;
  }
  const snapshot = readPreferenceStorage(storage);
  snapshot.byTarget[resolveRemoteWindowVideoTargetKey(target)] = preference;
  snapshot.byResolution[resolveRemoteWindowVideoResolutionKey(target)] = preference;
  return writePreferenceStorage(storage, snapshot);
}
