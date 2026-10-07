import { describe, expect, it } from 'vitest';
import type { RemoteWindowStreamTargetManifest } from './types';
import type { RemoteWindowVideoStatsSample } from './remote-window-video-quality';
import {
  REMOTE_WINDOW_VIDEO_BITRATE_STORAGE_KEY,
  REMOTE_WINDOW_VIDEO_PREFERENCE_STORAGE_KEY,
  applyRemoteWindowMaxFrameRate,
  REMOTE_WINDOW_BITRATE_MULTIPLIER_AUTO,
  resolveRemoteWindowBitrateMultiplier,
  buildRemoteWindowVideoProfile,
  REMOTE_WINDOW_VIDEO_BITRATE_BOUNDS,
  readRemoteWindowVideoPreference,
  REMOTE_WINDOW_QUALITY_BITRATE_MULTIPLIER_STORAGE_KEY,
  REMOTE_WINDOW_VIDEO_CAP_STORAGE_KEY,
  REMOTE_WINDOW_VIDEO_CAP_MAX_MBPS,
  REMOTE_WINDOW_VIDEO_CAP_MIN_MBPS,
  readRemoteWindowVideoQualitySettings,
  resolveRemoteWindowVideoCapBps,
  writeRemoteWindowVideoQualitySettings,
  resolveDefaultRemoteWindowVideoPreference,
  resolveInitialRemoteWindowVideoProfile,
  resolveRemoteWindowDesktopCoverageRatio,
  resolveRemoteWindowVideoAdaptiveDecision,
  resolveRemoteWindowQualityStreamSize,
  resolveRemoteWindowVideoResolutionKey,
  writeRemoteWindowVideoPreference,
} from './remote-window-video-quality';

const KNOWN_CAPS = {
  userMaxBitrateBps: 10_000_000,
  lastAcknowledgedMaxBitrateBps: 10_000_000,
};

function makeTarget(
  width: number,
  height: number,
  overrides: Partial<RemoteWindowStreamTargetManifest['videoTarget']> = {},
  captureOverrides: Partial<RemoteWindowStreamTargetManifest['capture']> = {},
): RemoteWindowStreamTargetManifest {
  return {
    streamTargetId: `target-${width}x${height}`,
    videoTarget: {
      kind: 'app-window',
      appBundleId: 'com.apple.TextEdit',
      pid: 123,
      windowId: 'window-1',
      title: 'TextEdit',
      windowBoundsTopLeftPx: { x: 10, y: 20, width, height },
      cropRectTopLeftPx: { x: 10, y: 20, width, height },
      ...overrides,
    },
    inputTarget: { kind: 'app-window' },
    streamMode: 'interactive',
    focusPolicy: 'bring-to-focus',
    inputRoute: 'os-event',
    capture: {
      source: 'ScreenCaptureKit',
      coordinateSpace: 'macos-top-left-px',
      displayId: 'display-1',
      displayBoundsTopLeftPx: { x: 0, y: 0, width: 1920, height: 1080 },
      scale: 1,
      createdAt: '2026-07-20T00:00:00.000Z',
      ...captureOverrides,
    },
  };
}

function makeStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

function lossSample(
  sampledAtMs: number,
  overrides: Partial<RemoteWindowVideoStatsSample> = {},
): RemoteWindowVideoStatsSample {
  return {
    sampledAtMs,
    receivedBitrateBps: 20_000_000,
    framesDropped: 0,
    freezeCount: 0,
    rttMs: 20,
    receivedPacketLossRatio: 0.08,
    ...overrides,
  };
}

function networkSample(
  sampledAtMs: number,
  overrides: Partial<RemoteWindowVideoStatsSample> = {},
): Parameters<typeof resolveRemoteWindowVideoAdaptiveDecision>[0] {
  return {
    preference: 'quality',
    userMaxBitrateBps: 10_000_000,
    lastAcknowledgedMaxBitrateBps: 10_000_000,
    sample: lossSample(sampledAtMs, overrides),
  };
}

describe('remote-window-video-quality', () => {
  it('scales by the source short edge without upsampling or changing aspect ratio', () => {
    expect(resolveRemoteWindowQualityStreamSize({ width: 2560, height: 1440 }, 'smooth-720'))
      .toEqual({ width: 1280, height: 720 });
    expect(resolveRemoteWindowQualityStreamSize({ width: 800, height: 600 }, 'quality-1080'))
      .toEqual({ width: 800, height: 600 });
    expect(resolveRemoteWindowQualityStreamSize({ width: 2160, height: 3840 }, 'ultra-2160'))
      .toEqual({ width: 2160, height: 3840 });
  });

  it('uses target dimensions for portrait and landscape profiles', () => {
    expect(buildRemoteWindowVideoProfile('smooth', { target: makeTarget(1920, 1080) }))
      .toMatchObject({ maxCaptureWidth: 1280, maxCaptureHeight: 720, maxBitrateBps: 3_000_000 });
    expect(buildRemoteWindowVideoProfile('quality', { target: makeTarget(1440, 2560) }))
      .toMatchObject({ maxCaptureWidth: 1080, maxCaptureHeight: 1920, maxBitrateBps: 8_000_000 });
  });

  it('caps the total bitrate at the explicit user Mbps cap without raising the default', () => {
    expect(REMOTE_WINDOW_VIDEO_CAP_MIN_MBPS).toBe(0.5);
    expect(REMOTE_WINDOW_VIDEO_CAP_MAX_MBPS).toBe(25);
    expect(resolveRemoteWindowVideoCapBps(null)).toBeNull();
    expect(resolveRemoteWindowVideoCapBps(0.5)).toBe(500_000);
    expect(resolveRemoteWindowVideoCapBps(25)).toBe(25_000_000);
    expect(resolveRemoteWindowVideoCapBps(0.4)).toBeNull();
    expect(resolveRemoteWindowVideoCapBps(25.1)).toBeNull();

    expect(buildRemoteWindowVideoProfile('smooth', {
      maxBitrateCapBps: resolveRemoteWindowVideoCapBps(3),
    })).toMatchObject({ maxBitrateBps: 3_000_000 });
    expect(buildRemoteWindowVideoProfile('smooth', {
      maxBitrateCapBps: resolveRemoteWindowVideoCapBps(5),
    })).toMatchObject({ maxBitrateBps: 3_000_000 });
    expect(buildRemoteWindowVideoProfile('quality', {
      maxBitrateCapBps: resolveRemoteWindowVideoCapBps(5),
    })).toMatchObject({ maxBitrateBps: 5_000_000 });
    expect(buildRemoteWindowVideoProfile('quality', {
      maxBitrateCapBps: resolveRemoteWindowVideoCapBps(25),
    })).toMatchObject({ maxBitrateBps: 8_000_000 });
  });

  it('persists explicit preference and cap as the desired truth, never a multiplier or applied value', () => {
    const storage = makeStorage();
    const target = makeTarget(640, 360, { windowId: 'cap-window', title: 'Cap Window' });

    expect(writeRemoteWindowVideoQualitySettings(target, {
      preference: 'quality',
      maxBitrateCapMbps: 12.5,
      maxFrameRateFps: 60,
    }, storage)).toBe(true);

    expect(readRemoteWindowVideoQualitySettings(target, storage)).toMatchObject({
      preference: 'quality',
      maxBitrateCapMbps: 12.5,
      maxFrameRateFps: 60,
    });
    expect(storage.getItem(REMOTE_WINDOW_QUALITY_BITRATE_MULTIPLIER_STORAGE_KEY)).toBeNull();

    const rawCap = JSON.parse(storage.getItem(REMOTE_WINDOW_VIDEO_CAP_STORAGE_KEY) || '{}') as {
      version?: number;
      byTarget?: Record<string, unknown>;
      byResolution?: Record<string, unknown>;
    };
    expect(rawCap.version).toBe(1);
    expect(rawCap.byTarget).not.toHaveProperty('applied');
    expect(rawCap.byTarget).not.toHaveProperty('multiplier');
  });

  it('migrates the legacy multiplier once using the old preference and keeps the stored FPS', () => {
    const storage = makeStorage();
    const target = makeTarget(640, 360, { windowId: 'legacy-window', title: 'Legacy Window' });
    storage.setItem('zterm:remote-window:quality-max-frame-rate-v1', '15');
    storage.setItem('zterm:remote-window-video-preference-global-v2', 'quality');
    storage.setItem(REMOTE_WINDOW_QUALITY_BITRATE_MULTIPLIER_STORAGE_KEY, '2');

    const settings = readRemoteWindowVideoQualitySettings(target, storage);
    expect(settings).toMatchObject({
      preference: 'quality',
      maxBitrateCapMbps: 4,
      maxFrameRateFps: 15,
    });
    expect(storage.getItem(REMOTE_WINDOW_QUALITY_BITRATE_MULTIPLIER_STORAGE_KEY)).toBeNull();
    expect(storage.getItem('zterm:remote-window-video-bitrate-global')).toBeNull();

    const smoothStorage = makeStorage();
    const smoothTarget = makeTarget(640, 360, { windowId: 'legacy-smooth', title: 'Legacy Smooth' });
    smoothStorage.setItem('zterm:remote-window-video-preference-global-v2', 'smooth');
    smoothStorage.setItem(REMOTE_WINDOW_QUALITY_BITRATE_MULTIPLIER_STORAGE_KEY, '2');
    expect(readRemoteWindowVideoQualitySettings(smoothTarget, smoothStorage)).toMatchObject({
      preference: 'smooth',
      maxBitrateCapMbps: 3,
    });
  });

  it('leaves the cap unset when the legacy selection was auto', () => {
    const storage = makeStorage();
    const target = makeTarget(640, 360, { windowId: 'auto-window', title: 'Auto Window' });
    expect(readRemoteWindowVideoQualitySettings(target, storage)).toMatchObject({
      preference: 'smooth',
      maxBitrateCapMbps: null,
      maxFrameRateFps: 30,
    });
    expect(storage.getItem(REMOTE_WINDOW_VIDEO_CAP_STORAGE_KEY)).toBeNull();
  });
  it('exposes internal bitrate guardrails for policy tuning without widening the wire contract', () => {
    expect(REMOTE_WINDOW_VIDEO_BITRATE_BOUNDS.smooth).toEqual({ minBps: 750_000, maxBps: 4_000_000 });
    expect(REMOTE_WINDOW_VIDEO_BITRATE_BOUNDS.quality).toEqual({ minBps: 3_000_000, maxBps: 10_000_000 });
    expect(buildRemoteWindowVideoProfile('smooth', { cause: 'network', level: 2 }).maxBitrateBps)
      .toBeGreaterThanOrEqual(REMOTE_WINDOW_VIDEO_BITRATE_BOUNDS.smooth.minBps);
    expect(buildRemoteWindowVideoProfile('quality', { cause: 'network', level: 2 }).maxBitrateBps)
      .toBeGreaterThanOrEqual(REMOTE_WINDOW_VIDEO_BITRATE_BOUNDS.quality.minBps);
  });

  it('defaults to the bounded smooth profile and keeps coverage telemetry independent', () => {
    expect(resolveDefaultRemoteWindowVideoPreference(makeTarget(1920, 1080))).toBe('smooth');
    expect(buildRemoteWindowVideoProfile('smooth')).toEqual({
      preference: 'smooth',
      maxBitrateBps: 3_000_000,
      maxFrameRateFps: 30,
      maxCaptureWidth: 720,
      maxCaptureHeight: 720,
      maxFrameAgeMs: 100,
      interactionActive: false,
      overviewMaxBitrateBps: 250_000,
      overviewMaxFrameRateFps: 2,
    });
    expect(buildRemoteWindowVideoProfile('quality')).toMatchObject({
      maxBitrateBps: 8_000_000,
      maxFrameRateFps: 30,
      maxCaptureWidth: 1920,
      maxCaptureHeight: 1920,
      maxFrameAgeMs: 150,
    });
    expect(resolveRemoteWindowDesktopCoverageRatio(makeTarget(960, 540))).toBe(0.25);
  });

  it('applies the user FPS ceiling without overriding a lower pressure ceiling', () => {
    expect(resolveRemoteWindowBitrateMultiplier(REMOTE_WINDOW_BITRATE_MULTIPLIER_AUTO)).toBeUndefined();
    expect(resolveRemoteWindowBitrateMultiplier(1)).toBe(1);
    expect(buildRemoteWindowVideoProfile('smooth', {
      budgetMultiplier: resolveRemoteWindowBitrateMultiplier(REMOTE_WINDOW_BITRATE_MULTIPLIER_AUTO),
    })).toMatchObject({ maxBitrateBps: 3_000_000 });
    expect(buildRemoteWindowVideoProfile('quality', {
      budgetMultiplier: resolveRemoteWindowBitrateMultiplier(REMOTE_WINDOW_BITRATE_MULTIPLIER_AUTO),
    })).toMatchObject({ maxBitrateBps: 8_000_000 });
    expect(buildRemoteWindowVideoProfile('quality', {
      budgetMultiplier: resolveRemoteWindowBitrateMultiplier(1),
    })).toMatchObject({ maxBitrateBps: 2_000_000 });
    expect(applyRemoteWindowMaxFrameRate(buildRemoteWindowVideoProfile('smooth'), 60))
      .toMatchObject({ maxFrameRateFps: 60 });
    expect(applyRemoteWindowMaxFrameRate(
      buildRemoteWindowVideoProfile('smooth', { cause: 'network', level: 2 }),
      60,
    )).toMatchObject({ maxFrameRateFps: 15 });
    expect(applyRemoteWindowMaxFrameRate(buildRemoteWindowVideoProfile('smooth'), 15))
      .toMatchObject({ maxFrameRateFps: 15 });
  });

  it('migrates the legacy stored preset once and writes only the v2 preference truth', () => {
    const storage = makeStorage();
    const target = makeTarget(640, 360, { windowId: 'window-a', title: 'Window A' });
    storage.setItem(REMOTE_WINDOW_VIDEO_BITRATE_STORAGE_KEY, JSON.stringify({
      version: 1,
      byTarget: {
        'app-window|com.apple.TextEdit|window-a|Window A': '20mbps',
      },
      byResolution: {},
    }));
    expect(readRemoteWindowVideoPreference(target, storage)).toBe('quality');
    expect(JSON.parse(storage.getItem(REMOTE_WINDOW_VIDEO_PREFERENCE_STORAGE_KEY) || '{}').byTarget)
      .toMatchObject({ 'app-window|com.apple.TextEdit|window-a|Window A': 'quality' });
  });

  it('remembers preference per target and seeds the same-resolution preference', () => {
    const storage = makeStorage();
    const first = makeTarget(640, 360, { windowId: 'window-a', title: 'Window A' });
    const sameResolution = makeTarget(640, 360, { windowId: 'window-b', title: 'Window B' });
    expect(writeRemoteWindowVideoPreference(first, 'quality', storage)).toBe(true);
    expect(readRemoteWindowVideoPreference(first, storage)).toBe('quality');
    expect(readRemoteWindowVideoPreference(sameResolution, storage)).toBe('quality');
    const raw = JSON.parse(storage.getItem(REMOTE_WINDOW_VIDEO_PREFERENCE_STORAGE_KEY) || '{}');
    expect(raw.byResolution[resolveRemoteWindowVideoResolutionKey(first)]).toBe('quality');
  });

  it('keeps smooth interaction at 30fps and uses a half-resolution capture', () => {
    expect(buildRemoteWindowVideoProfile('smooth', { interactionActive: true })).toMatchObject({
      maxBitrateBps: 3_000_000,
      maxFrameRateFps: 30,
      maxCaptureWidth: 720,
      maxFrameAgeMs: 80,
      overviewMaxFrameRateFps: 1,
    });
    expect(buildRemoteWindowVideoProfile('quality', { interactionActive: true })).toMatchObject({
      maxBitrateBps: 10_000_000,
      maxFrameRateFps: 30,
      maxCaptureWidth: 1920,
      maxFrameAgeMs: 120,
    });
  });

  it('degrades smooth mode with a bounded 3M -> 2.5M -> 1M bitrate ladder before cutting fps', () => {
    const first = buildRemoteWindowVideoProfile('smooth', { cause: 'network', level: 1 });
    const second = buildRemoteWindowVideoProfile('smooth', { cause: 'network', level: 2 });
    expect(first).toMatchObject({ maxBitrateBps: 2_500_000, maxFrameRateFps: 30 });
    expect(second).toMatchObject({ maxBitrateBps: 1_000_000, maxFrameRateFps: 15 });
    expect(buildRemoteWindowVideoProfile('smooth', { cause: 'network', level: 2 }).maxFrameRateFps)
      .toBe(15);
  });

  it('steps quality mode by reducing frame rate while retaining full capture resolution', () => {
    const first = buildRemoteWindowVideoProfile('quality', { cause: 'network', level: 1 });
    const second = buildRemoteWindowVideoProfile('quality', { cause: 'network', level: 2 });
    expect(first).toMatchObject({ maxBitrateBps: 6_000_000, maxFrameRateFps: 24, maxCaptureWidth: 1920 });
    expect(second).toMatchObject({ maxBitrateBps: 4_000_000, maxFrameRateFps: 15, maxCaptureWidth: 1920 });
  });

  it('keeps latency-only pressure spatially clear and keeps host unreachable without a host signal', () => {
    const latency = resolveInitialRemoteWindowVideoProfile('quality', {
      effectiveType: '4g',
      downlinkMbps: 30,
      rttMs: 600,
    });
    expect(latency).toMatchObject({
      maxBitrateBps: 8_000_000,
      maxCaptureWidth: 1920,
      maxFrameAgeMs: 120,
    });
    // No producer reports a sender-side host limitation any more, so a clean
    // interval cannot be attributed to host pressure.
    const firstClean = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      ...KNOWN_CAPS,
      sample: lossSample(1_000, { receivedPacketLossRatio: 0 }),
    });
    const secondClean = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      ...KNOWN_CAPS,
      previous: firstClean.state,
      sample: lossSample(3_000, { receivedPacketLossRatio: 0 }),
    });
    expect(secondClean).toMatchObject({ cause: 'none', reason: 'baseline' });
    expect(secondClean.profile).toMatchObject({ maxCaptureWidth: 1920, maxBitrateBps: 8_000_000 });
  });

  it('consumes receiver interval drops once instead of double-diffing them', () => {
    const first = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'smooth',
      ...KNOWN_CAPS,
      sample: { sampledAtMs: 1_000, framesDropped: 3, freezeCount: 1, framesPerSecond: 30 },
    });
    const second = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'smooth',
      ...KNOWN_CAPS,
      previous: first.state,
      sample: { sampledAtMs: 3_000, framesDropped: 3, freezeCount: 1, framesPerSecond: 30 },
    });
    expect(first.cause).toBe('render');
    expect(second.cause).toBe('render');
    expect(second.reason).toBe('downgrade');
    expect(second.state.level).toBe(1);
  });

  it('downgrades one small step after two samples, rate-limits the next step, and restores one step', () => {
    const weak = (sampledAtMs: number) => lossSample(sampledAtMs, {
      availableOutgoingBitrateBps: 8_000_000,
    });
    const first = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      ...KNOWN_CAPS,
      sample: weak(1_000),
    });
    expect(first.reason).toBe('baseline');
    const degraded = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      ...KNOWN_CAPS,
      previous: first.state,
      sample: weak(3_000),
    });
    expect(degraded).toMatchObject({ reason: 'downgrade', cause: 'network' });
    expect(degraded.state.level).toBe(1);
    expect(degraded.profile.maxBitrateBps).toBe(6_000_000);

    const tooSoon1 = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      ...KNOWN_CAPS,
      previous: degraded.state,
      sample: weak(4_000),
    });
    const tooSoon2 = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      ...KNOWN_CAPS,
      previous: tooSoon1.state,
      sample: weak(5_000),
    });
    expect(tooSoon2.state.level).toBe(1);
    const secondStep = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      ...KNOWN_CAPS,
      previous: tooSoon2.state,
      sample: weak(7_000),
    });
    expect(secondStep.state.level).toBe(2);
    expect(secondStep.profile.maxBitrateBps).toBe(4_000_000);

    const stable = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      ...KNOWN_CAPS,
      previous: secondStep.state,
      sample: {
        sampledAtMs: 8_000,
        receivedBitrateBps: 30_000_000,
        availableOutgoingBitrateBps: 30_000_000,
        receivedPacketLossRatio: 0,
        framesPerSecond: 30,
      },
    });
    const restored = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      ...KNOWN_CAPS,
      previous: stable.state,
      sample: {
        sampledAtMs: 20_000,
        receivedBitrateBps: 30_000_000,
        availableOutgoingBitrateBps: 30_000_000,
        receivedPacketLossRatio: 0,
        framesPerSecond: 30,
      },
    });
    expect(restored.reason).toBe('restore');
    expect(restored.state.level).toBe(1);
  });

  it('holds when either required bitrate cap is unknown and never invents an applied value', () => {
    const unknownUserCap = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'smooth',
      userMaxBitrateBps: null,
      lastAcknowledgedMaxBitrateBps: 3_000_000,
      sample: lossSample(1_000),
    });
    const unknownAcknowledgedCap = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'smooth',
      userMaxBitrateBps: 3_000_000,
      lastAcknowledgedMaxBitrateBps: null,
      sample: lossSample(1_000),
    });
    expect(unknownUserCap.reason).toBe('hold');
    expect(unknownAcknowledgedCap.reason).toBe('hold');
    expect(unknownUserCap.state.level).toBe(0);
    expect(unknownAcknowledgedCap.state.level).toBe(0);
  });

  it('bounds pressure by min(user, acknowledged) and leaves focus non-negative', () => {
    const first = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      userMaxBitrateBps: 10_000_000,
      lastAcknowledgedMaxBitrateBps: 2_000_000,
      sample: lossSample(1_000),
    });
    const pressured = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      userMaxBitrateBps: 10_000_000,
      lastAcknowledgedMaxBitrateBps: 2_000_000,
      previous: first.state,
      sample: lossSample(3_000),
    });
    expect(pressured.reason).toBe('downgrade');
    expect(pressured.profile.maxBitrateBps).toBeGreaterThanOrEqual(0);
    expect(pressured.profile.overviewMaxBitrateBps).toBeLessThanOrEqual(2_000_000);
    // maxBitrateBps is the group total; overview is a share inside it.
    expect(pressured.profile.maxBitrateBps).toBeLessThanOrEqual(2_000_000);
    expect(pressured.profile.overviewMaxBitrateBps).toBeLessThanOrEqual(pressured.profile.maxBitrateBps);

    const smoothSameCap = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'smooth',
      userMaxBitrateBps: 3_000_000,
      lastAcknowledgedMaxBitrateBps: 3_000_000,
      sample: lossSample(1_000),
    });
    const qualitySameCap = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      userMaxBitrateBps: 3_000_000,
      lastAcknowledgedMaxBitrateBps: 3_000_000,
      sample: lossSample(1_000),
    });
    expect(smoothSameCap.profile.maxBitrateBps).toBeLessThanOrEqual(3_000_000);
    expect(smoothSameCap.profile.overviewMaxBitrateBps).toBeLessThanOrEqual(smoothSameCap.profile.maxBitrateBps);
    expect(qualitySameCap.profile.maxBitrateBps).toBeLessThanOrEqual(3_000_000);
    expect(qualitySameCap.profile.overviewMaxBitrateBps).toBeLessThanOrEqual(qualitySameCap.profile.maxBitrateBps);
  });

  it('recovers toward the user cap after the stable window even when the last ACK is lower', () => {
    const previous = {
      pressureCause: 'network' as const,
      level: 1 as const,
      consecutivePressureSamples: 0,
      stableSinceMs: 1_000,
      lastAdjustmentAtMs: 1_000,
      lastSample: null,
    };
    const recovered = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      userMaxBitrateBps: 10_000_000,
      lastAcknowledgedMaxBitrateBps: 2_000_000,
      previous,
      sample: lossSample(2_000, { receivedPacketLossRatio: 0, framesPerSecond: 30 }),
      restoreStableMs: 1_000,
    });
    expect(recovered.reason).toBe('restore');
    expect(recovered.profile.maxBitrateBps + recovered.profile.overviewMaxBitrateBps)
      .toBeGreaterThan(2_000_000);
    expect(recovered.profile.maxBitrateBps + recovered.profile.overviewMaxBitrateBps)
      .toBeLessThanOrEqual(10_000_000);
  });

  it('treats profile maxBitrateBps as the group total with overview as a share, never pre-deducting it', () => {
    // The r3 budget contract: maxBitrateBps is the group total and the
    // overview is a share inside it (focus is derived only by the daemon). An
    // 8Mbps user cap with a .3Mbps overview must keep max=8M, not 7.7M.
    const decision = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      userMaxBitrateBps: 8_000_000,
      lastAcknowledgedMaxBitrateBps: 8_000_000,
      sample: {
        sampledAtMs: 1_000,
        availableOutgoingBitrateBps: 30_000_000,
        framesPerSecond: 30,
        receivedBitrateBps: 30_000_000,
        receivedPacketLossRatio: 0,
      },
    });
    expect(decision.profile).toMatchObject({
      maxBitrateBps: 8_000_000,
      overviewMaxBitrateBps: 300_000,
    });
    expect(decision.profile.overviewMaxBitrateBps).toBeLessThanOrEqual(decision.profile.maxBitrateBps);
  });

  it('does not treat a static low FPS as independent render pressure when the media link is healthy', () => {
    const lowFps = (sampledAtMs: number) => ({
      sampledAtMs,
      receivedBitrateBps: 30_000_000,
      framesPerSecond: 5,
      rttMs: 20,
      framesDropped: 0,
      freezeCount: 0,
      receivedPacketLossRatio: 0,
    });
    const first = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'smooth',
      userMaxBitrateBps: 8_000_000,
      lastAcknowledgedMaxBitrateBps: 8_000_000,
      sample: lowFps(1_000),
    });
    const second = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'smooth',
      userMaxBitrateBps: 8_000_000,
      lastAcknowledgedMaxBitrateBps: 8_000_000,
      previous: first.state,
      sample: lowFps(3_000),
    });
    expect(second.reason).not.toBe('downgrade');
    expect(second.state.level).toBe(0);
    expect(second.cause).not.toBe('render');
  });

  it('clears the stable window on unknown so restore never spans an unknown gap', () => {
    const weak = (sampledAtMs: number) => lossSample(sampledAtMs, {
      availableOutgoingBitrateBps: 8_000_000,
    });
    const healthyInterval = (sampledAtMs: number) => ({
      sampledAtMs,
      receivedBitrateBps: 30_000_000,
      framesPerSecond: 30,
      rttMs: 20,
      receivedPacketLossRatio: 0,
    });
    const p1 = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      userMaxBitrateBps: 10_000_000,
      lastAcknowledgedMaxBitrateBps: 10_000_000,
      sample: weak(1_000),
    });
    const degraded = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      userMaxBitrateBps: 10_000_000,
      lastAcknowledgedMaxBitrateBps: 10_000_000,
      previous: p1.state,
      sample: weak(3_000),
    });
    expect(degraded.reason).toBe('downgrade');
    const healthy = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      userMaxBitrateBps: 10_000_000,
      lastAcknowledgedMaxBitrateBps: 10_000_000,
      previous: degraded.state,
      sample: healthyInterval(4_000),
    });
    const unknown = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      userMaxBitrateBps: 10_000_000,
      lastAcknowledgedMaxBitrateBps: 10_000_000,
      previous: healthy.state,
      sample: null,
    });
    expect(unknown.reason).toBe('hold');
    const afterGap = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      userMaxBitrateBps: 10_000_000,
      lastAcknowledgedMaxBitrateBps: 10_000_000,
      previous: unknown.state,
      sample: healthyInterval(20_000),
    });
    expect(afterGap.reason).not.toBe('restore');

    // A first-interval/fps-only sample is also unknown for restore purposes: it
    // has no established receivedBitrateBps interval, so it must not accumulate.
    const afterFpsOnly = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      userMaxBitrateBps: 10_000_000,
      lastAcknowledgedMaxBitrateBps: 10_000_000,
      previous: healthy.state,
      sample: { sampledAtMs: 20_000, framesPerSecond: 30 },
    });
    expect(afterFpsOnly.reason).not.toBe('restore');
  });

  it('gives usable receive loss the highest priority and immediately downgrades severe render', () => {
    const lossAndSevereRender = resolveRemoteWindowVideoAdaptiveDecision(networkSample(1_000, {
      framesDropped: 22,
    }));
    expect(lossAndSevereRender).toMatchObject({ cause: 'network', reason: 'downgrade' });
    expect(lossAndSevereRender.profile).toMatchObject({ maxBitrateBps: 6_000_000, maxCaptureWidth: 1920 });
  });

  it('classifies render and latency after the loss gate and keeps all four outcomes distinct', () => {
    const lossOnly = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      ...KNOWN_CAPS,
      sample: lossSample(1_000),
    });
    expect(lossOnly).toMatchObject({ cause: 'network', reason: 'baseline' });

    const renderOnly = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      ...KNOWN_CAPS,
      sample: lossSample(1_000, { receivedPacketLossRatio: 0, framesDropped: 5 }),
    });
    expect(renderOnly).toMatchObject({ cause: 'render', reason: 'baseline' });
    expect(renderOnly.profile).toMatchObject({ maxBitrateBps: 8_000_000, maxCaptureWidth: 1920 });

    const latencyOnly = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      ...KNOWN_CAPS,
      sample: lossSample(1_000, { receivedPacketLossRatio: 0, rttMs: 360 }),
    });
    expect(latencyOnly).toMatchObject({ cause: 'latency', reason: 'baseline' });
    expect(latencyOnly.profile).toMatchObject({
      maxBitrateBps: 8_000_000,
      maxCaptureWidth: 1920,
    });

    const clean = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      ...KNOWN_CAPS,
      sample: lossSample(1_000, { receivedPacketLossRatio: 0 }),
    });
    expect(clean).toMatchObject({ cause: 'none', reason: 'baseline' });
  });

  it('treats a non-finite receive loss interval as unknown instead of healthy or 0%', () => {
    const previous = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      ...KNOWN_CAPS,
      sample: lossSample(1_000, { receivedPacketLossRatio: 0 }),
    }).state;
    for (const receivedPacketLossRatio of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const decision = resolveRemoteWindowVideoAdaptiveDecision({
        preference: 'quality',
        ...KNOWN_CAPS,
        previous,
        sample: lossSample(3_000, {
          receivedPacketLossRatio,
        }),
      });
      expect(decision).toMatchObject({ reason: 'hold', unknown: true });
      expect(decision.state.level).toBe(0);
      expect(decision.state.stableSinceMs).toBeNull();
      expect(decision.state.lastSample).toBeNull();
    }
  });
});
