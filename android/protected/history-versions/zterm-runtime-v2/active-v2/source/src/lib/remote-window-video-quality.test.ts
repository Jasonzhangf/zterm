import { describe, expect, it } from 'vitest';
import type { RemoteWindowStreamTargetManifest } from './types';
import {
  REMOTE_WINDOW_VIDEO_BITRATE_STORAGE_KEY,
  buildRemoteWindowVideoBitrateConfig,
  resolveRemoteWindowVideoAdaptiveDecision,
  readRemoteWindowVideoBitratePreset,
  resolveAdaptiveRemoteWindowVideoBitratePreset,
  resolveRemoteWindowDesktopCoverageRatio,
  resolveEffectiveRemoteWindowVideoBitratePreset,
  resolveDefaultRemoteWindowVideoBitratePreset,
  resolveRemoteWindowVideoResolutionKey,
  writeRemoteWindowVideoBitratePreset,
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
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

describe('remote-window-video-quality', () => {
  it('keeps untouched default bitrate conservative at 2mbps while preserving coverage telemetry', () => {
    expect(resolveDefaultRemoteWindowVideoBitratePreset(makeTarget(320, 240))).toBe('2mbps');
    expect(resolveDefaultRemoteWindowVideoBitratePreset(makeTarget(640, 360))).toBe('2mbps');
    expect(resolveDefaultRemoteWindowVideoBitratePreset(makeTarget(960, 540))).toBe('2mbps');
    expect(resolveDefaultRemoteWindowVideoBitratePreset(makeTarget(1200, 780))).toBe('2mbps');
    expect(resolveDefaultRemoteWindowVideoBitratePreset(makeTarget(1800, 980))).toBe('2mbps');
    expect(resolveDefaultRemoteWindowVideoBitratePreset(makeTarget(1920, 1080))).toBe('2mbps');
    expect(resolveRemoteWindowDesktopCoverageRatio(makeTarget(960, 540))).toBe(0.25);
    expect(buildRemoteWindowVideoBitrateConfig('fullscreen')).toEqual({
      preset: 'fullscreen',
      bitrateMbps: 20,
      maxBitrateBps: 20_000_000,
      maxFrameRateFps: 60,
    });
    expect(buildRemoteWindowVideoBitrateConfig('2mbps')).toMatchObject({
      maxBitrateBps: 2_000_000,
      maxFrameRateFps: 30,
    });
  });

  it('keeps missing desktop display-area truth conservative instead of treating Android fullscreen as desktop fullscreen', () => {
    expect(resolveDefaultRemoteWindowVideoBitratePreset(
      makeTarget(1920, 1080, {}, { displayBoundsTopLeftPx: undefined, displayId: undefined }),
    )).toBe('2mbps');
  });

  it('remembers bitrate per window and also seeds the same-resolution default', () => {
    const storage = makeStorage();
    const firstWindow = makeTarget(640, 360, { windowId: 'window-a', title: 'Window A' });
    const secondWindowSameResolution = makeTarget(640, 360, { windowId: 'window-b', title: 'Window B' });

    expect(readRemoteWindowVideoBitratePreset(firstWindow, storage)).toBe('2mbps');
    expect(writeRemoteWindowVideoBitratePreset(firstWindow, '20mbps', storage)).toBe(true);
    expect(readRemoteWindowVideoBitratePreset(firstWindow, storage)).toBe('20mbps');
    expect(readRemoteWindowVideoBitratePreset(secondWindowSameResolution, storage)).toBe('20mbps');

    const raw = JSON.parse(storage.getItem(REMOTE_WINDOW_VIDEO_BITRATE_STORAGE_KEY) || '{}');
    expect(raw.byResolution[resolveRemoteWindowVideoResolutionKey(firstWindow)]).toBe('20mbps');
  });

  it('keeps the same window bitrate memory when the source rectangle is resized', () => {
    const storage = makeStorage();
    const initialWindow = makeTarget(640, 360, { windowId: 'window-a', title: 'Window A' });
    const resizedWindow = makeTarget(1280, 720, { windowId: 'window-a', title: 'Window A' });
    const otherWindowSameNewResolution = makeTarget(1280, 720, { windowId: 'window-b', title: 'Window B' });

    expect(writeRemoteWindowVideoBitratePreset(initialWindow, '5mbps', storage)).toBe(true);

    expect(readRemoteWindowVideoBitratePreset(resizedWindow, storage)).toBe('5mbps');
    expect(readRemoteWindowVideoBitratePreset(otherWindowSameNewResolution, storage)).toBe('2mbps');
  });

  it('uses floating preview bitrate separately from the fullscreen selected preset', () => {
    expect(resolveEffectiveRemoteWindowVideoBitratePreset('fullscreen', {
      mode: 'floating',
      fullscreenScale: 1,
    })).toBe('2mbps');
    expect(resolveEffectiveRemoteWindowVideoBitratePreset('20mbps', {
      mode: 'fullscreen',
      fullscreenScale: 1,
    })).toBe('20mbps');
    expect(resolveEffectiveRemoteWindowVideoBitratePreset('10mbps', {
      mode: 'fullscreen',
      fullscreenScale: 1,
    })).toBe('10mbps');
    expect(resolveEffectiveRemoteWindowVideoBitratePreset('2mbps', {
      mode: 'fullscreen',
      fullscreenScale: 1,
    })).toBe('2mbps');
    expect(resolveEffectiveRemoteWindowVideoBitratePreset('fullscreen', {
      mode: 'fullscreen',
      fullscreenScale: 1.4,
    })).toBe('fullscreen');
  });

  it('caps selected quality by network grade without upgrading a lower user preset', () => {
    expect(resolveAdaptiveRemoteWindowVideoBitratePreset('fullscreen', {
      effectiveType: '4g',
      downlinkMbps: 1.4,
      rttMs: 120,
    })).toBe('5mbps');
    expect(resolveAdaptiveRemoteWindowVideoBitratePreset('20mbps', {
      effectiveType: '4g',
      downlinkMbps: 0.5,
      rttMs: 900,
    })).toBe('2mbps');
    expect(resolveAdaptiveRemoteWindowVideoBitratePreset('2mbps', {
      effectiveType: '4g',
      downlinkMbps: 20,
      rttMs: 30,
    })).toBe('2mbps');
    expect(resolveAdaptiveRemoteWindowVideoBitratePreset('fullscreen', {
      effectiveType: '4g',
      downlinkMbps: 20,
      rttMs: 30,
    })).toBe('fullscreen');
  });

  it('downgrades on weak WebRTC stats and restores only after a stable window', () => {
    const baseline = buildRemoteWindowVideoBitrateConfig('20mbps');
    const firstWeak = resolveRemoteWindowVideoAdaptiveDecision({
      baseline,
      sample: {
        sampledAtMs: 1_000,
        availableOutgoingBitrateBps: 2_000_000,
        rttMs: 420,
        framesPerSecond: 9,
        framesDropped: 12,
        qualityLimitationReason: 'bandwidth',
      },
    });

    expect(firstWeak.reason).toBe('baseline');
    expect(firstWeak.state).toEqual({
      mode: 'normal',
      degradedAtMs: null,
      stableSinceMs: null,
      weakSampleCount: 1,
    });

    const weak = resolveRemoteWindowVideoAdaptiveDecision({
      baseline,
      previous: firstWeak.state,
      sample: {
        sampledAtMs: 3_000,
        availableIncomingBitrateBps: 2_000_000,
        rttMs: 420,
        framesPerSecond: 9,
        framesDropped: 12,
        qualityLimitationReason: 'bandwidth',
      },
    });

    expect(weak.reason).toBe('downgrade');
    expect(weak.state).toEqual({ mode: 'degraded', degradedAtMs: 3_000, stableSinceMs: null, weakSampleCount: 2 });
    expect(weak.config).toMatchObject({
      preset: '20mbps',
      bitrateMbps: 20,
      maxBitrateBps: 5_000_000,
      maxFrameRateFps: 15,
    });

    const hold = resolveRemoteWindowVideoAdaptiveDecision({
      baseline,
      previous: weak.state,
      sample: {
        sampledAtMs: 4_000,
        availableOutgoingBitrateBps: 30_000_000,
        rttMs: 45,
        framesPerSecond: 30,
        framesDropped: 0,
        qualityLimitationReason: 'none',
      },
    });
    expect(hold.reason).toBe('hold');
    expect(hold.state).toEqual({ mode: 'degraded', degradedAtMs: 3_000, stableSinceMs: 4_000, weakSampleCount: 0 });
    expect(hold.config.maxBitrateBps).toBe(5_000_000);

    const restored = resolveRemoteWindowVideoAdaptiveDecision({
      baseline,
      previous: hold.state,
      sample: {
        sampledAtMs: 12_000,
        availableOutgoingBitrateBps: 30_000_000,
        rttMs: 45,
        framesPerSecond: 30,
        framesDropped: 0,
        qualityLimitationReason: 'none',
      },
    });
    expect(restored.reason).toBe('restore');
    expect(restored.state).toEqual({ mode: 'normal', degradedAtMs: null, stableSinceMs: null, weakSampleCount: 0 });
    expect(restored.config).toEqual(baseline);
  });
});
