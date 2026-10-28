import { describe, expect, it } from 'vitest';
import {
  applyRemoteWindowMaxFrameRate,
  applyRemoteWindowZoomCaptureProfile,
  resolveRemoteWindowZoomCaptureFactor,
} from './remote-window-video-quality';

describe('B-2 zoom-aware capture resolution', () => {
  const baseProfile = {
    preference: 'smooth' as const,
    maxBitrateBps: 1_500_000,
    maxFrameRateFps: 30,
    maxCaptureWidth: 600,
    maxCaptureHeight: 400,
    maxFrameAgeMs: 100,
    interactionActive: false,
    overviewMaxBitrateBps: 250_000,
    overviewMaxFrameRateFps: 2,
  };

  it('engages only at the two-times threshold', () => {
    expect(resolveRemoteWindowZoomCaptureFactor(1, 1.99)).toBe(1);
    expect(resolveRemoteWindowZoomCaptureFactor(1, 2)).toBe(2);
    expect(resolveRemoteWindowZoomCaptureFactor(2, 2.4)).toBe(2);
    expect(resolveRemoteWindowZoomCaptureFactor(2, 3.9)).toBe(3);
    // The factor is clamped so a request can never exceed the capture budget
    // that already exists for the 4x tier.
    expect(resolveRemoteWindowZoomCaptureFactor(3, 8)).toBe(3);
  });

  it('keeps the raised factor between release and engage, then disengages below the release band', () => {
    // 1.85 stays inside the band: release is 1.6, engage is 2.0.
    expect(resolveRemoteWindowZoomCaptureFactor(2, 1.85)).toBe(2);
    expect(resolveRemoteWindowZoomCaptureFactor(2, 1.99)).toBe(2);
    expect(resolveRemoteWindowZoomCaptureFactor(2, 1.5)).toBe(1);
    // Below the release band the previous factor must not resurrect itself.
    expect(resolveRemoteWindowZoomCaptureFactor(3, 1.5)).toBe(1);
  });

  it('never raises the capture ceiling above the real source pixels', () => {
    const raised = applyRemoteWindowZoomCaptureProfile(baseProfile, {
      factor: 3,
      source: { width: 600, height: 400 },
    });
    expect(raised.maxCaptureWidth).toBe(600);
    expect(raised.maxCaptureHeight).toBe(400);
    expect(raised.maxBitrateBps).toBe(4_500_000);
  });

  it('raises resolution and bitrate together, and honours the user cap', () => {
    const raised = applyRemoteWindowZoomCaptureProfile(baseProfile, {
      factor: 2,
      source: { width: 3000, height: 2000 },
    });
    expect(raised.maxCaptureWidth).toBe(1200);
    expect(raised.maxCaptureHeight).toBe(800);
    expect(raised.maxBitrateBps).toBe(3_000_000);

    const capped = applyRemoteWindowZoomCaptureProfile(baseProfile, {
      factor: 3,
      source: { width: 3000, height: 2000 },
      maxBitrateCapBps: 2_000_000,
    });
    expect(capped.maxBitrateBps).toBe(2_000_000);

    const noOp = applyRemoteWindowZoomCaptureProfile(baseProfile, { factor: 1 });
    expect(noOp).toBe(baseProfile);
  });

  it('leaves frame rate and interaction policy untouched', () => {
    const adaptive = applyRemoteWindowMaxFrameRate(baseProfile, 15);
    const raised = applyRemoteWindowZoomCaptureProfile(adaptive, {
      factor: 2,
      source: { width: 3000, height: 2000 },
    });
    expect(raised.maxFrameRateFps).toBe(15);
    expect(raised.maxFrameAgeMs).toBe(100);
  });

  it('uses the crop rect (not the window bounds) as the source pixel budget', () => {
    const profile = {
      ...baseProfile,
      maxCaptureWidth: 720,
      maxCaptureHeight: 405,
    };
    const raised = applyRemoteWindowZoomCaptureProfile(profile, {
      factor: 2,
      source: { width: 597, height: 385 },
    });
    expect(raised.maxCaptureWidth).toBe(597);
    expect(raised.maxCaptureHeight).toBe(385);
  });

  it('drops the zoom raise again when the user zoom returns to the base band', () => {
    let factor = resolveRemoteWindowZoomCaptureFactor(1, 3);
    const raised = applyRemoteWindowZoomCaptureProfile(baseProfile, { factor });
    expect(raised.maxCaptureWidth).toBe(1800);
    factor = resolveRemoteWindowZoomCaptureFactor(factor, 1.4);
    expect(factor).toBe(1);
    expect(applyRemoteWindowZoomCaptureProfile(baseProfile, { factor })).toBe(baseProfile);
  });
});
