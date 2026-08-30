import { describe, expect, it } from 'vitest';
import type { RemoteWindowStreamTargetManifest } from './types';
import {
  REMOTE_WINDOW_VIDEO_BITRATE_STORAGE_KEY,
  REMOTE_WINDOW_VIDEO_PREFERENCE_STORAGE_KEY,
  buildRemoteWindowVideoProfile,
  readRemoteWindowVideoPreference,
  resolveDefaultRemoteWindowVideoPreference,
  resolveInitialRemoteWindowVideoProfile,
  resolveRemoteWindowDesktopCoverageRatio,
  resolveRemoteWindowVideoAdaptiveDecision,
  resolveRemoteWindowVideoResolutionKey,
  writeRemoteWindowVideoPreference,
} from './remote-window-video-quality';

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
  };
}

describe('remote-window-video-quality', () => {
  it('defaults to the bounded smooth profile and keeps coverage telemetry independent', () => {
    expect(resolveDefaultRemoteWindowVideoPreference(makeTarget(1920, 1080))).toBe('smooth');
    expect(buildRemoteWindowVideoProfile('smooth')).toEqual({
      preference: 'smooth',
      maxBitrateBps: 6_000_000,
      maxFrameRateFps: 30,
      maxCaptureWidth: 1440,
      maxCaptureHeight: 900,
      maxFrameAgeMs: 100,
      interactionActive: false,
      overviewMaxBitrateBps: 250_000,
      overviewMaxFrameRateFps: 2,
    });
    expect(buildRemoteWindowVideoProfile('quality')).toMatchObject({
      maxBitrateBps: 16_000_000,
      maxFrameRateFps: 30,
      maxCaptureWidth: 1920,
      maxCaptureHeight: 1200,
      maxFrameAgeMs: 150,
    });
    expect(resolveRemoteWindowDesktopCoverageRatio(makeTarget(960, 540))).toBe(0.25);
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

  it('uses interaction burst for frame cadence and age without enabling 1080p60', () => {
    expect(buildRemoteWindowVideoProfile('smooth', { interactionActive: true })).toMatchObject({
      maxBitrateBps: 8_000_000,
      maxFrameRateFps: 45,
      maxCaptureWidth: 1280,
      maxFrameAgeMs: 80,
      overviewMaxFrameRateFps: 1,
    });
    expect(buildRemoteWindowVideoProfile('quality', { interactionActive: true })).toMatchObject({
      maxBitrateBps: 18_000_000,
      maxFrameRateFps: 30,
      maxCaptureWidth: 1920,
      maxFrameAgeMs: 120,
    });
  });

  it('keeps latency-only pressure spatially clear and maps CPU pressure to host, not network', () => {
    const latency = resolveInitialRemoteWindowVideoProfile('quality', {
      effectiveType: '4g',
      downlinkMbps: 30,
      rttMs: 600,
    });
    expect(latency).toMatchObject({
      maxBitrateBps: 16_000_000,
      maxCaptureWidth: 1920,
      maxFrameAgeMs: 120,
    });
    const firstCpu = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      sample: { sampledAtMs: 1_000, qualityLimitationReason: 'cpu' },
    });
    const secondCpu = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      previous: firstCpu.state,
      sample: { sampledAtMs: 3_000, qualityLimitationReason: 'cpu' },
    });
    expect(secondCpu).toMatchObject({ cause: 'host', reason: 'downgrade' });
    expect(secondCpu.profile).toMatchObject({ maxCaptureWidth: 1600, maxBitrateBps: 14_000_000 });
  });

  it('uses counter deltas so old cumulative drops do not fabricate render pressure', () => {
    const first = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'smooth',
      sample: { sampledAtMs: 1_000, framesDropped: 100, freezeCount: 10, framesPerSecond: 30 },
    });
    const second = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'smooth',
      previous: first.state,
      sample: { sampledAtMs: 3_000, framesDropped: 101, freezeCount: 10, framesPerSecond: 30 },
    });
    expect(first.cause).toBe('none');
    expect(second.cause).toBe('none');
    expect(second.state.level).toBe(0);
  });

  it('downgrades one small step after two samples, rate-limits the next step, and restores one step', () => {
    const weak = (sampledAtMs: number) => ({
      sampledAtMs,
      availableOutgoingBitrateBps: 8_000_000,
      qualityLimitationReason: 'bandwidth',
    });
    const first = resolveRemoteWindowVideoAdaptiveDecision({ preference: 'quality', sample: weak(1_000) });
    expect(first.reason).toBe('baseline');
    const degraded = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      previous: first.state,
      sample: weak(3_000),
    });
    expect(degraded).toMatchObject({ reason: 'downgrade', cause: 'network' });
    expect(degraded.state.level).toBe(1);
    expect(degraded.profile.maxBitrateBps).toBe(10_000_000);

    const tooSoon1 = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      previous: degraded.state,
      sample: weak(4_000),
    });
    const tooSoon2 = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      previous: tooSoon1.state,
      sample: weak(5_000),
    });
    expect(tooSoon2.state.level).toBe(1);
    const secondStep = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      previous: tooSoon2.state,
      sample: weak(7_000),
    });
    expect(secondStep.state.level).toBe(2);
    expect(secondStep.profile.maxBitrateBps).toBe(6_000_000);

    const stable = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      previous: secondStep.state,
      sample: { sampledAtMs: 8_000, availableOutgoingBitrateBps: 30_000_000, framesPerSecond: 30 },
    });
    const restored = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      previous: stable.state,
      sample: { sampledAtMs: 20_000, availableOutgoingBitrateBps: 30_000_000, framesPerSecond: 30 },
    });
    expect(restored.reason).toBe('restore');
    expect(restored.state.level).toBe(1);
  });
});
