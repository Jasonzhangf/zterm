import type {
  RemoteWindowStreamTargetManifest,
  RemoteWindowVideoPreference,
  RemoteWindowVideoProfile,
} from './types';

export const REMOTE_WINDOW_VIDEO_PREFERENCE_STORAGE_KEY = 'zterm:remote-window-video-preference-v2';
export const REMOTE_WINDOW_VIDEO_PREFERENCE_GLOBAL_STORAGE_KEY = 'zterm:remote-window-video-preference-global-v2';
export const REMOTE_WINDOW_VIDEO_BITRATE_STORAGE_KEY = 'zterm:remote-window-video-bitrate';
export const REMOTE_WINDOW_VIDEO_BITRATE_GLOBAL_STORAGE_KEY = 'zterm:remote-window-video-bitrate-global';
export const REMOTE_WINDOW_VIDEO_CAP_STORAGE_KEY = 'zterm:remote-window-video-quality-caps-v1';
// Legacy multiplier key: read once for migration, never written again.
export const REMOTE_WINDOW_QUALITY_BITRATE_MULTIPLIER_STORAGE_KEY =
  'zterm:remote-window:quality-bitrate-multiplier-v1';
export const REMOTE_WINDOW_QUALITY_MAX_FRAME_RATE_STORAGE_KEY =
  'zterm:remote-window:quality-max-frame-rate-v1';
export const REMOTE_WINDOW_VIDEO_PREFERENCES: readonly RemoteWindowVideoPreference[] = ['smooth', 'quality'];
export type RemoteWindowVideoQualityTier = 'smooth-720' | 'quality-1080' | 'ultra-2160';
export const REMOTE_WINDOW_VIDEO_QUALITY_TIERS = Object.freeze({
  // Default streaming budget. 2 Mbps at 720p left remote desktop text visibly
  // soft on a phone; the per-preference baseline is 1.5 Mbps x 2 = 3 Mbps.
  'smooth-720': { shortEdge: 720, baseBitrateBps: 1_500_000 },
  'quality-1080': { shortEdge: 1080, baseBitrateBps: 2_000_000 },
  'ultra-2160': { shortEdge: 2160, baseBitrateBps: 8_000_000 },
} as const);
export const REMOTE_WINDOW_VIDEO_BUDGET_MULTIPLIERS = [1, 2, 4] as const;

export type RemoteWindowVideoBudgetMultiplier = typeof REMOTE_WINDOW_VIDEO_BUDGET_MULTIPLIERS[number];
export const REMOTE_WINDOW_QUALITY_FRAME_RATE_OPTIONS = [15, 30, 60] as const;
export const REMOTE_WINDOW_VIDEO_CAP_MIN_MBPS = 0.5;
export const REMOTE_WINDOW_VIDEO_CAP_MAX_MBPS = 25;

/**
 * The user-entered Mbps total cap is a validated range, not a promise that
 * every encoder honours it. Values outside the range are not silently
 * clamped because a typo must not look like a chosen setting.
 */
export function resolveRemoteWindowVideoCapBps(
  mbps: unknown,
): number | null {
  const parsed = typeof mbps === 'number' ? mbps : Number(mbps);
  if (
    !Number.isFinite(parsed)
    || parsed < REMOTE_WINDOW_VIDEO_CAP_MIN_MBPS
    || parsed > REMOTE_WINDOW_VIDEO_CAP_MAX_MBPS
  ) {
    return null;
  }
  return Math.round(parsed * 1_000_000);
}

// The default selection keeps the per-preference baseline budget that
// `buildRemoteWindowVideoProfile` already declares (smooth 2x / quality 4x).
export const REMOTE_WINDOW_BITRATE_MULTIPLIER_AUTO = 'auto' as const;
export type RemoteWindowBitrateMultiplierSelection =
  | RemoteWindowVideoBudgetMultiplier
  | typeof REMOTE_WINDOW_BITRATE_MULTIPLIER_AUTO;

export function resolveRemoteWindowBitrateMultiplier(
  selection: RemoteWindowBitrateMultiplierSelection,
): RemoteWindowVideoBudgetMultiplier | undefined {
  return selection === REMOTE_WINDOW_BITRATE_MULTIPLIER_AUTO
    ? undefined
    : selection;
}
export type RemoteWindowQualityMaxFrameRate = typeof REMOTE_WINDOW_QUALITY_FRAME_RATE_OPTIONS[number];

export function resolveRemoteWindowQualityStreamSize(
  source: { width: number; height: number },
  tier: RemoteWindowVideoQualityTier,
) {
  const width = Math.max(1, Math.floor(source.width));
  const height = Math.max(1, Math.floor(source.height));
  const shortEdge = Math.min(width, height);
  const targetShortEdge = REMOTE_WINDOW_VIDEO_QUALITY_TIERS[tier].shortEdge;
  if (shortEdge <= targetShortEdge) {
    return { width, height };
  }
  const scale = targetShortEdge / shortEdge;
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

export function applyRemoteWindowMaxFrameRate(
  profile: RemoteWindowVideoProfile,
  maxFrameRateFps: RemoteWindowQualityMaxFrameRate,
): RemoteWindowVideoProfile {
  // The selection bounds the requested ceiling; it never lifts a ceiling the
  // adaptive policy already tightened for network/host/render pressure.
  const adaptiveCeiling = profile.maxFrameRateFps;
  const selectedCeiling = adaptiveCeiling >= 30
    ? maxFrameRateFps
    : Math.min(adaptiveCeiling, maxFrameRateFps);
  return {
    ...profile,
    maxFrameRateFps: selectedCeiling,
  };
}

// Internal ABR guardrails. These are deliberately kept out of the wire
// profile: the daemon receives the resolved max bitrate, while the client
// owns the policy limits used to prevent text quality collapsing under load.
export const REMOTE_WINDOW_VIDEO_BITRATE_BOUNDS: Readonly<Record<RemoteWindowVideoPreference, {
  minBps: number;
  maxBps: number;
}>> = Object.freeze({
  smooth: Object.freeze({ minBps: 750_000, maxBps: 4_000_000 }),
  quality: Object.freeze({ minBps: 3_000_000, maxBps: 10_000_000 }),
});

export interface RemoteWindowNetworkQualityInput {
  effectiveType?: string | null;
  downlinkMbps?: number | null;
  rttMs?: number | null;
  saveData?: boolean | null;
}

export interface RemoteWindowVideoStatsSample {
  sampledAtMs: number;
  lane?: 'focus' | 'overview' | null;
  mediaEpoch?: number | null;
  trackId?: string | null;
  ssrc?: number | null;
  mid?: string | null;
  transportId?: string | null;
  selectedCandidatePairId?: string | null;
  receivedBitrateBps?: number | null;
  rttMs?: number | null;
  availableIncomingBitrateBps?: number | null;
  availableOutgoingBitrateBps?: number | null;
  framesPerSecond?: number | null;
  framesDropped?: number | null;
  freezeCount?: number | null;
  jitterBufferDelayMs?: number | null;
  receivedPacketLossRatio?: number | null;
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
  /**
   * True when this tick could not establish a usable observation of the media
   * link: sample was null (collectStats missing/rejected), first-interval or
   * fps-only (no established received bitrate), identity changed/unknown, or a
   * required cap is unknown. An unknown tick clears the observation window,
   * never advances the applied level, never dispatches, and never consumes a
   * fresh sample slot.
   */
  unknown: boolean;
}

type RemoteWindowVideoPreferenceStorage = {
  version: 2;
  byTarget: Record<string, RemoteWindowVideoPreference>;
  byResolution: Record<string, RemoteWindowVideoPreference>;
};

interface BrowserStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
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
    target?: RemoteWindowStreamTargetManifest;
    qualityTier?: RemoteWindowVideoQualityTier;
    budgetMultiplier?: RemoteWindowVideoBudgetMultiplier;
    maxBitrateCapBps?: number | null;
  } = {},
): RemoteWindowVideoProfile {
  const interactionActive = options.interactionActive === true;
  const cause = options.cause ?? 'none';
  const level = options.level ?? 0;
  const bitrateBounds = REMOTE_WINDOW_VIDEO_BITRATE_BOUNDS[preference];
  const qualityTier = options.qualityTier ?? (preference === 'smooth' ? 'smooth-720' : 'quality-1080');
  const budgetMultiplier = options.budgetMultiplier ?? (preference === 'smooth' ? 2 : 4);
  const maxBitrateCapBps = finitePositiveNumber(options.maxBitrateCapBps);
  const capBitrate = (bps: number) => Math.min(bps, maxBitrateCapBps ?? Number.POSITIVE_INFINITY);
  const targetSize = options.target
    ? resolveRemoteWindowQualityStreamSize(getRemoteWindowSourceRect(options.target), qualityTier)
    : null;
  const tierBitrate = capBitrate(REMOTE_WINDOW_VIDEO_QUALITY_TIERS[qualityTier].baseBitrateBps * budgetMultiplier);
  const base: RemoteWindowVideoProfile = preference === 'smooth'
    ? {
        preference,
        // Smooth mode keeps a phone-sized half-resolution capture and a
        // stable 30fps cadence; interaction changes frame age, not cadence.
        maxBitrateBps: tierBitrate,
        maxFrameRateFps: 30,
        maxCaptureWidth: targetSize?.width ?? 720,
        maxCaptureHeight: targetSize?.height ?? 720,
        maxFrameAgeMs: interactionActive ? 80 : 100,
        interactionActive,
        overviewMaxBitrateBps: capBitrate(interactionActive ? 150_000 : 250_000),
        overviewMaxFrameRateFps: interactionActive ? 1 : 2,
      }
    : {
        preference,
        maxBitrateBps: interactionActive ? capBitrate(bitrateBounds.maxBps) : tierBitrate,
        maxFrameRateFps: 30,
        maxCaptureWidth: targetSize?.width ?? 1920,
        maxCaptureHeight: targetSize?.height ?? 1920,
        maxFrameAgeMs: interactionActive ? 120 : 150,
        interactionActive,
        overviewMaxBitrateBps: capBitrate(interactionActive ? 150_000 : 300_000),
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
        maxBitrateBps: capBitrate(cause === 'network' ? 1_000_000 : 1_500_000),
        maxFrameRateFps: 15,
        maxCaptureWidth: 720,
        maxCaptureHeight: 720,
        maxFrameAgeMs: cause === 'network' ? 120 : 100,
        overviewMaxBitrateBps: 100_000,
        overviewMaxFrameRateFps: 1,
      };
    }
    return {
      ...base,
      maxBitrateBps: capBitrate(2_500_000),
      maxFrameRateFps: 30,
      maxCaptureWidth: 720,
      maxCaptureHeight: 720,
      maxFrameAgeMs: cause === 'network' ? 100 : 90,
      overviewMaxBitrateBps: 150_000,
      overviewMaxFrameRateFps: 1,
    };
  }
  if (level === 2) {
    return {
      ...base,
      maxBitrateBps: capBitrate(cause === 'network' ? 4_000_000 : 5_000_000),
      maxFrameRateFps: 15,
      maxCaptureWidth: base.maxCaptureWidth,
      maxCaptureHeight: base.maxCaptureHeight,
      maxFrameAgeMs: 180,
      overviewMaxBitrateBps: 150_000,
      overviewMaxFrameRateFps: 1,
    };
  }
  return {
    ...base,
    maxBitrateBps: capBitrate(cause === 'network' ? 6_000_000 : 7_000_000),
    maxFrameRateFps: 24,
    maxCaptureWidth: base.maxCaptureWidth,
    maxCaptureHeight: base.maxCaptureHeight,
    maxFrameAgeMs: 150,
    overviewMaxBitrateBps: 200_000,
    overviewMaxFrameRateFps: 2,
  };
}

function finiteNumber(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function finitePositiveNumber(value: number | null | undefined) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function applyRemoteWindowVideoTotalCap(
  profile: RemoteWindowVideoProfile,
  capBps: number,
): RemoteWindowVideoProfile {
  const cap = Math.max(0, Math.floor(capBps));
  // `profile.maxBitrateBps` is the group total and `overviewMaxBitrateBps` is a
  // share within it (the daemon derives focus = total - overview in
  // resolveRemoteWindowStreamGroupBudget). Clamp only the total, then keep the
  // overview share inside that total; never subtract the overview first.
  const total = Math.max(0, Math.min(profile.maxBitrateBps, cap));
  const overviewMaxBitrateBps = Math.max(0, Math.min(profile.overviewMaxBitrateBps, total));
  return {
    ...profile,
    maxBitrateBps: total,
    overviewMaxBitrateBps,
  };
}

function classifyRemoteWindowVideoPressure(sample: RemoteWindowVideoStatsSample) {
  // Pressure is diagnosed from gauges and interval deltas the receiver reports
  // (receive-side packet loss, RTT, jitter, drop/freeze deltas). A low FPS is
  // deliberately NOT a signal here: a static low cadence is neither
  // independent pressure nor proof of health. Only an available finite loss
  // ratio >= 5% counts as network pressure; a missing/non-finite loss interval
  // is unknown and must not be read as 0% or healthy.
  const rttMs = finiteNumber(sample.rttMs);
  const droppedDelta = finiteNumber(sample.framesDropped);
  const freezeDelta = finiteNumber(sample.freezeCount);
  const jitterDelayMs = finiteNumber(sample.jitterBufferDelayMs);
  const lossRatio = finiteNumber(sample.receivedPacketLossRatio);
  if (lossRatio !== null && lossRatio >= 0.05) {
    // Usable loss is the highest-priority cause. Its `severe` bit forwards the
    // same sample's genuine severe-render predicate so loss + severe render
    // downgrades immediately through the existing mechanism; no loss-only
    // severe threshold is introduced.
    return {
      cause: 'network' as const,
      severe: (droppedDelta !== null && droppedDelta >= 20) || (freezeDelta !== null && freezeDelta >= 2),
    };
  }
  if (
    (droppedDelta !== null && droppedDelta >= 3)
    || (freezeDelta !== null && freezeDelta > 0)
  ) {
    return {
      cause: 'render' as const,
      severe: (droppedDelta !== null && droppedDelta >= 20) || (freezeDelta !== null && freezeDelta >= 2),
    };
  }
  if ((rttMs !== null && rttMs >= 350) || (jitterDelayMs !== null && jitterDelayMs >= 250)) {
    return { cause: 'latency' as const, severe: false };
  }
  return { cause: 'none' as const, severe: false };
}

export function createRemoteWindowVideoAdaptiveState(): RemoteWindowVideoAdaptiveState {
  return {
    pressureCause: 'none',
    level: 0,
    consecutivePressureSamples: 0,
    stableSinceMs: null,
    lastAdjustmentAtMs: null,
    lastSample: null,
  };
}

// Unknown ticks (no sample, rejected read, first/absent interval, fps-only, or
// an unmatched transport/pair identity) must clear the observation window so a
// restore can never accumulate across a gap. The applied level and its cause
// are retained: an unknown tick never advances or rewinds the applied tier.
export function clearRemoteWindowVideoObservationWindow(
  previous: RemoteWindowVideoAdaptiveState,
): RemoteWindowVideoAdaptiveState {
  return {
    pressureCause: previous.pressureCause,
    level: previous.level,
    consecutivePressureSamples: 0,
    stableSinceMs: null,
    lastAdjustmentAtMs: previous.lastAdjustmentAtMs,
    lastSample: null,
  };
}

export function resolveRemoteWindowVideoAdaptiveDecision(options: {
  preference: RemoteWindowVideoPreference;
  target?: RemoteWindowStreamTargetManifest | null;
  qualityTier?: RemoteWindowVideoQualityTier;
  budgetMultiplier?: RemoteWindowVideoBudgetMultiplier;
  interactionActive?: boolean;
  previous?: RemoteWindowVideoAdaptiveState | null;
  sample?: RemoteWindowVideoStatsSample | null;
  userMaxBitrateBps?: number | null;
  lastAcknowledgedMaxBitrateBps?: number | null;
  pressureSamplesBeforeDowngrade?: number;
  restoreStableMs?: number;
  minimumAdjustmentIntervalMs?: number;
}): RemoteWindowVideoAdaptiveDecision {
  const previous = options.previous ?? createRemoteWindowVideoAdaptiveState();
  const sample = options.sample ?? null;
  const interactionActive = options.interactionActive === true;
  const userMaxBitrateBps = finitePositiveNumber(options.userMaxBitrateBps);
  const lastAcknowledgedMaxBitrateBps = finitePositiveNumber(options.lastAcknowledgedMaxBitrateBps);
  const buildDecisionProfile = (
    level: 0 | 1 | 2,
    cause: RemoteWindowVideoPressureCause,
    capBps: number | null,
  ) => {
    const profile = buildRemoteWindowVideoProfile(options.preference, {
      interactionActive,
      cause,
      level,
      target: options.target ?? undefined,
      qualityTier: options.qualityTier,
      budgetMultiplier: options.budgetMultiplier,
      maxBitrateCapBps: capBps,
    });
    return capBps === null ? profile : applyRemoteWindowVideoTotalCap(profile, capBps);
  };
  if (userMaxBitrateBps === null || lastAcknowledgedMaxBitrateBps === null) {
    const state = clearRemoteWindowVideoObservationWindow(previous);
    return {
      state,
      profile: buildDecisionProfile(
        state.level,
        state.pressureCause,
        userMaxBitrateBps ?? lastAcknowledgedMaxBitrateBps,
      ),
      reason: 'hold',
      cause: state.pressureCause,
      unknown: true,
    };
  }
  const pressureCapBps = Math.min(userMaxBitrateBps, lastAcknowledgedMaxBitrateBps);
  const currentProfile = buildDecisionProfile(previous.level, previous.pressureCause, pressureCapBps);
  if (!sample) {
    const state = clearRemoteWindowVideoObservationWindow(previous);
    return {
      state,
      profile: currentProfile,
      reason: 'hold',
      cause: state.pressureCause,
      unknown: true,
    };
  }
  const pressure = classifyRemoteWindowVideoPressure(sample);
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
      profile: buildDecisionProfile(state.level, state.pressureCause, pressureCapBps),
      reason: shouldDowngrade ? 'downgrade' : state.level > 0 ? 'hold' : 'baseline',
      cause: state.pressureCause,
      unknown: false,
    };
  }
  // No pressure signal. Health/recovery still requires an established interval
  // (receivedBitrateBps is null on the first interval and after an identity
  // change); an fps-only gauge cannot prove recovery. Receive-side loss is
  // also part of that gate: a null/non-finite receivedPacketLossRatio (first
  // interval, identity change, or zero-traffic tick) cannot prove health.
  // Hold and clear the window so a restore never accumulates across this gap.
  if (
    finiteNumber(sample.receivedBitrateBps) === null
    || finiteNumber(sample.receivedPacketLossRatio) === null
  ) {
    const state = clearRemoteWindowVideoObservationWindow(previous);
    return {
      state,
      profile: currentProfile,
      reason: 'hold',
      cause: state.pressureCause,
      unknown: true,
    };
  }
  if (previous.level === 0) {
    const state = { ...createRemoteWindowVideoAdaptiveState(), lastSample: sample };
    return {
      state,
      profile: buildDecisionProfile(0, 'none', pressureCapBps),
      reason: 'baseline',
      cause: 'none',
      unknown: false,
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
      profile: buildDecisionProfile(state.level, state.pressureCause, userMaxBitrateBps),
      reason: 'restore',
      cause: state.pressureCause,
      unknown: false,
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
    profile: buildDecisionProfile(state.level, state.pressureCause, pressureCapBps),
    reason: 'hold',
    cause: state.pressureCause,
    unknown: false,
  };
}

export function resolveInitialRemoteWindowVideoProfile(
  preference: RemoteWindowVideoPreference,
  network: RemoteWindowNetworkQualityInput | null | undefined,
  interactionActive = false,
  profileOptions: {
    target?: RemoteWindowStreamTargetManifest;
    qualityTier?: RemoteWindowVideoQualityTier;
    budgetMultiplier?: RemoteWindowVideoBudgetMultiplier;
    maxBitrateCapBps?: number | null;
  } = {},
) {
  if (!network) {
    return buildRemoteWindowVideoProfile(preference, { interactionActive, ...profileOptions });
  }
  const effectiveType = `${network.effectiveType || ''}`.toLowerCase();
  const downlinkMbps = finiteNumber(network.downlinkMbps);
  if (network.saveData || effectiveType === 'slow-2g' || effectiveType === '2g' || (downlinkMbps !== null && downlinkMbps < 2)) {
    return buildRemoteWindowVideoProfile(preference, { interactionActive, cause: 'network', level: 2, ...profileOptions });
  }
  if (effectiveType === '3g' || (downlinkMbps !== null && downlinkMbps < 5)) {
    return buildRemoteWindowVideoProfile(preference, { interactionActive, cause: 'network', level: 1, ...profileOptions });
  }
  if ((finiteNumber(network.rttMs) ?? 0) >= 500) {
    return buildRemoteWindowVideoProfile(preference, { interactionActive, cause: 'latency', level: 1, ...profileOptions });
  }
  return buildRemoteWindowVideoProfile(preference, { interactionActive, ...profileOptions });
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

export interface RemoteWindowVideoQualitySettings {
  preference: RemoteWindowVideoPreference;
  maxBitrateCapMbps: number | null;
  maxFrameRateFps: RemoteWindowQualityMaxFrameRate;
}

interface RemoteWindowVideoCapStorage {
  version: 1;
  byTarget: Record<string, number>;
  byResolution: Record<string, number>;
}

function emptyCapStorage(): RemoteWindowVideoCapStorage {
  return { version: 1, byTarget: {}, byResolution: {} };
}

function resolveLegacyMultiplier(value: unknown): RemoteWindowVideoBudgetMultiplier | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return parsed === 1 || parsed === 2 || parsed === 4 ? parsed : null;
}

/**
 * Legacy multiplier -> explicit Mbps, using the effective preference and the
 * existing tier baselines. This runs once; the multiplier key is removed and
 * never written again.
 */
function migrateLegacyMultiplierToMbps(
  preference: RemoteWindowVideoPreference,
  multiplier: RemoteWindowVideoBudgetMultiplier,
): number {
  const tier: RemoteWindowVideoQualityTier = preference === 'smooth' ? 'smooth-720' : 'quality-1080';
  return REMOTE_WINDOW_VIDEO_QUALITY_TIERS[tier].baseBitrateBps * multiplier / 1_000_000;
}

function readCapStorage(storage: BrowserStorageLike | null | undefined): RemoteWindowVideoCapStorage {
  if (!storage) {
    return emptyCapStorage();
  }
  try {
    const raw = storage.getItem(REMOTE_WINDOW_VIDEO_CAP_STORAGE_KEY);
    if (!raw) {
      return emptyCapStorage();
    }
    const parsed = JSON.parse(raw) as Partial<RemoteWindowVideoCapStorage>;
    const validEntries = (entries: Record<string, unknown> | undefined) => Object.fromEntries(
      Object.entries(entries || {}).flatMap(([key, value]) => {
        const bps = resolveRemoteWindowVideoCapBps(value);
        return bps === null ? [] : [[key, bps / 1_000_000]];
      }),
    );
    return {
      version: 1,
      byTarget: validEntries(parsed.byTarget),
      byResolution: validEntries(parsed.byResolution),
    };
  } catch {
    return emptyCapStorage();
  }
}

function writeCapStorage(
  storage: BrowserStorageLike | null | undefined,
  value: RemoteWindowVideoCapStorage,
): boolean {
  if (!storage) {
    return false;
  }
  storage.setItem(REMOTE_WINDOW_VIDEO_CAP_STORAGE_KEY, JSON.stringify(value));
  return true;
}

export function readRemoteWindowMaxFrameRateStored(
  storage: BrowserStorageLike | null | undefined = typeof window === 'undefined' ? null : window.localStorage,
): RemoteWindowQualityMaxFrameRate {
  if (!storage) {
    return 30;
  }
  const parsed = Number(storage.getItem(REMOTE_WINDOW_QUALITY_MAX_FRAME_RATE_STORAGE_KEY));
  return (REMOTE_WINDOW_QUALITY_FRAME_RATE_OPTIONS as readonly number[]).includes(parsed)
    ? parsed as RemoteWindowQualityMaxFrameRate
    : 30;
}

function writeRemoteWindowMaxFrameRateStored(
  frameRate: RemoteWindowQualityMaxFrameRate,
  storage: BrowserStorageLike | null | undefined,
) {
  if (!storage) {
    return;
  }
  if (!(REMOTE_WINDOW_QUALITY_FRAME_RATE_OPTIONS as readonly number[]).includes(frameRate)) {
    return;
  }
  storage.setItem(REMOTE_WINDOW_QUALITY_MAX_FRAME_RATE_STORAGE_KEY, String(frameRate));
}

export function readRemoteWindowVideoQualitySettings(
  target: RemoteWindowStreamTargetManifest,
  storage: BrowserStorageLike | null | undefined = typeof window === 'undefined' ? null : window.localStorage,
): RemoteWindowVideoQualitySettings {
  const preference = readRemoteWindowVideoPreference(target, storage);
  const maxFrameRateFps = readRemoteWindowMaxFrameRateStored(storage);
  const targetKey = resolveRemoteWindowVideoTargetKey(target);
  const resolutionKey = resolveRemoteWindowVideoResolutionKey(target);
  const capStorage = readCapStorage(storage);
  const directCap = capStorage.byTarget[targetKey] ?? capStorage.byResolution[resolutionKey];
  if (typeof directCap === 'number') {
    return { preference, maxBitrateCapMbps: directCap, maxFrameRateFps };
  }
  const legacyMultiplier = resolveLegacyMultiplier(
    storage?.getItem(REMOTE_WINDOW_QUALITY_BITRATE_MULTIPLIER_STORAGE_KEY),
  );
  if (legacyMultiplier === null) {
    return { preference, maxBitrateCapMbps: null, maxFrameRateFps };
  }
  const migratedMbps = migrateLegacyMultiplierToMbps(preference, legacyMultiplier);
  if (writeRemoteWindowVideoQualitySettings(target, {
    preference,
    maxBitrateCapMbps: migratedMbps,
    maxFrameRateFps,
  }, storage)) {
    storage?.removeItem(REMOTE_WINDOW_QUALITY_BITRATE_MULTIPLIER_STORAGE_KEY);
  }
  return { preference, maxBitrateCapMbps: migratedMbps, maxFrameRateFps };
}

export function writeRemoteWindowVideoQualitySettings(
  target: RemoteWindowStreamTargetManifest,
  settings: {
    preference: RemoteWindowVideoPreference;
    maxBitrateCapMbps: number | null;
    maxFrameRateFps: RemoteWindowQualityMaxFrameRate;
  },
  storage: BrowserStorageLike | null | undefined = typeof window === 'undefined' ? null : window.localStorage,
): boolean {
  if (!storage || !isRemoteWindowVideoPreference(settings.preference)) {
    return false;
  }
  if (!(REMOTE_WINDOW_QUALITY_FRAME_RATE_OPTIONS as readonly number[]).includes(settings.maxFrameRateFps)) {
    return false;
  }
  if (settings.maxBitrateCapMbps !== null && resolveRemoteWindowVideoCapBps(settings.maxBitrateCapMbps) === null) {
    return false;
  }
  // Validate every field before the first write so a rejected Apply cannot
  // half-commit (preference saved, cap refused).
  if (!writeRemoteWindowVideoPreference(target, settings.preference, storage)) {
    return false;
  }
  const targetKey = resolveRemoteWindowVideoTargetKey(target);
  const resolutionKey = resolveRemoteWindowVideoResolutionKey(target);
  const capStorage = readCapStorage(storage);
  if (settings.maxBitrateCapMbps === null) {
    delete capStorage.byTarget[targetKey];
    delete capStorage.byResolution[resolutionKey];
  } else {
    capStorage.byTarget[targetKey] = settings.maxBitrateCapMbps;
    capStorage.byResolution[resolutionKey] = settings.maxBitrateCapMbps;
  }
  writeCapStorage(storage, capStorage);
  writeRemoteWindowMaxFrameRateStored(settings.maxFrameRateFps, storage);
  return true;
}
