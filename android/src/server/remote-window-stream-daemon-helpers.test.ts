/**
 * Submodule tests: remote-window-stream-daemon-helpers (daemon.remote_window_stream).
 */
import { describe, expect, it } from 'vitest';
import {
  convertRgbaToI420Frame,
  createRemoteWindowLatencyAccumulator,
  formatRemoteWindowVideoProfileError,
  normalizeIceCandidate,
  normalizeRemoteWindowVideoProfile,
} from './remote-window-stream-daemon-helpers';
import { MACOS_REMOTE_WINDOW_INPUT_SWIFT } from './remote-window-scripts';
import { makeRemoteWindowVideoProfileFixture } from './remote-window-video-profile-test-fixture';

describe('remote-window-stream-daemon-helpers', () => {
  it('normalizes ice candidates with toJSON fallback', () => {
    const normalized = normalizeIceCandidate({ toJSON: () => ({ candidate: 'c', sdpMid: '0', sdpMLineIndex: 1, usernameFragment: 'ufrag' }) } as never);
    expect(normalized.candidate).toBe('c');
    expect(normalized.sdpMid).toBe('0');
    expect(normalized.sdpMLineIndex).toBe(1);
  });

  it('normalizes complete video profiles and rejects invalid lane budgets', () => {
    const profile = makeRemoteWindowVideoProfileFixture('smooth');
    expect(normalizeRemoteWindowVideoProfile(profile)).toEqual(profile);
    expect(() => normalizeRemoteWindowVideoProfile({
      ...profile,
      overviewMaxBitrateBps: profile.maxBitrateBps,
    })).toThrow('overviewMaxBitrateBps is out of range');
    expect(normalizeRemoteWindowVideoProfile(undefined)).toBeNull();
  });

  it('formats profile errors with fallbacks', () => {
    expect(formatRemoteWindowVideoProfileError(new Error('boom'))).toBe('boom');
    expect(formatRemoteWindowVideoProfileError('')).toContain('could not be applied');
  });

  it('converts rgba frames to i420 with chroma sizing', () => {
    const converted = convertRgbaToI420Frame(
      { width: 4, height: 4, rgba: new Uint8Array(4 * 4 * 4) } as never,
      (rgba, i420) => { i420.data.set(rgba.data.subarray(0, i420.data.length)); },
    );
    expect(converted.width).toBe(4);
    expect(converted.height).toBe(4);
    expect(converted.data.length).toBe(4 * 4 + 2 * 2 * 2);
  });

  it('requires the daemon input owner to verify the focused target window atomically', () => {
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain(
      'frontmostPidMatches(config.pid) && focusedWindowMatchesTarget(appElement, targetWindowId)',
    );
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('@_silgen_name("_AXUIElementGetWindow")');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('CGWindowID');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).not.toContain('rectScore(');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('try focusTargetWindow(config)');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).not.toContain('skipFocus');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('let isContinuousMotion = config.event.kind == "scroll"');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('if !isContinuousMotion {');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).not.toContain('lastVerifiedFocusAt');
  });

  it('matches the exact CG window when AX frames differ from CG bounds', () => {
    const targetCgBounds = { x: 100, y: 100, width: 800, height: 620 };
    const targetAxFrame = { x: 100, y: 128, width: 800, height: 592 };
    const siblingAxFrame = { x: 104, y: 124, width: 800, height: 596 };
    const oldBoundsScore = (frame: typeof targetAxFrame) =>
      Math.abs(frame.x - targetCgBounds.x)
      + Math.abs(frame.y - targetCgBounds.y)
      + Math.abs(frame.width - targetCgBounds.width)
      + Math.abs(frame.height - targetCgBounds.height);

    expect(oldBoundsScore(siblingAxFrame)).toBeLessThan(oldBoundsScore(targetAxFrame));
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain(
      'return windows.first { axWindowId($0) == targetWindowId }',
    );
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).not.toContain('config.window.title');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).not.toContain('window.pid');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain(
      'throw inputError("remote input target window could not be matched", code: 4)',
    );
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain(
      'throw inputError("remote input target window could not be matched for focus", code: 4)',
    );
  });

  describe('latency accumulator', () => {
    const statsReport = (entries: Array<Record<string, unknown>>) => ({
      forEach: (callback: (entry: unknown) => void) => entries.forEach(callback),
    }) as unknown as RTCStatsReport;

    it('reports nothing until it has observed something', () => {
      const accumulator = createRemoteWindowLatencyAccumulator();
      expect(accumulator.snapshot(10_000)).toBeNull();
    });

    it('witnesses the capture size the source actually produced', () => {
      const accumulator = createRemoteWindowLatencyAccumulator();
      accumulator.recordCaptureArrival(1_000);
      accumulator.recordCaptureSize(1360.4, 720.6);
      const raised = accumulator.snapshot(10_000);
      expect(raised?.captureWidth).toBe(1360);
      expect(raised?.captureHeight).toBe(720);
      // A zoom-aware raise must be visible as a new size, not a stale one.
      accumulator.recordCaptureSize(2720, 1440);
      const zoomed = accumulator.snapshot(10_000);
      expect(zoomed?.captureWidth).toBe(2720);
      expect(zoomed?.captureHeight).toBe(1440);
      // Non-finite or non-positive sizes are refused instead of reported as 0.
      accumulator.recordCaptureSize(Number.NaN, 0);
      const refused = accumulator.snapshot(10_000);
      expect(refused?.captureWidth).toBe(2720);
      expect(refused?.captureHeight).toBe(1440);
    });

    it('keeps the last capture sample and the rolling percentiles', () => {
      const accumulator = createRemoteWindowLatencyAccumulator();
      for (const captureToEncodeMs of [10, 20, 30, 40, 500]) {
        accumulator.recordCapture(1_000, 1_000 + captureToEncodeMs);
      }
      const snapshot = accumulator.snapshot(10_000);
      expect(snapshot?.captureToEncodeMs).toBe(500);
      expect(snapshot?.captureToEncodeP50Ms).toBe(30);
      expect(snapshot?.captureToEncodeP95Ms).toBe(500);
      expect(snapshot?.sampleWindowMs).toBe(10_000);
    });

    it('separates capture arrivals from encoder dispatches', () => {
      const accumulator = createRemoteWindowLatencyAccumulator();
      const now = Date.now();
      // 30 frames arrived from the capture source, but only 3 reached the
      // encoder: the gap is the drop policy, not a slow capture source.
      // Arrivals are recorded in the order the capture source delivers them,
      // so the buffer stays ascending in time.
      for (let index = 29; index >= 0; index -= 1) {
        accumulator.recordCaptureArrival(now - index * 30);
      }
      for (let index = 2; index >= 0; index -= 1) {
        accumulator.recordCapture(now - index * 300 - 5, now - index * 300);
      }
      const snapshot = accumulator.snapshot(1_000);
      expect(snapshot?.capturedFps).toBeGreaterThan(20);
      expect(snapshot?.dispatchedFps).toBeGreaterThan(0);
      expect(snapshot?.dispatchedFps ?? 0).toBeLessThan(snapshot?.capturedFps ?? 0);
    });

    it('derives encoder, pacer and network values from peer connection totals', () => {
      const accumulator = createRemoteWindowLatencyAccumulator();
      accumulator.applySenderStats(statsReport([
        { id: 'codec-1', type: 'codec', mimeType: 'video/VP8' },
        { type: 'outbound-rtp', kind: 'video', codecId: 'codec-1', framesEncoded: 100, totalEncodeTime: 1, totalPacketSendDelay: 0.5, packetsSent: 1_000, bytesSent: 1_000_000 },
        { type: 'remote-inbound-rtp', kind: 'video', roundTripTime: 0.012, jitter: 0.004, packetsLost: 25 },
      ]), 10_000);
      accumulator.applySenderStats(statsReport([
        { id: 'codec-1', type: 'codec', mimeType: 'video/VP8' },
        { type: 'outbound-rtp', kind: 'video', codecId: 'codec-1', framesEncoded: 130, totalEncodeTime: 1.3, totalPacketSendDelay: 0.8, packetsSent: 1_300, bytesSent: 1_250_000 },
        { type: 'remote-inbound-rtp', kind: 'video', roundTripTime: 0.02, jitter: 0.006, packetsLost: 55 },
      ]), 11_000);
      const snapshot = accumulator.snapshot(10_000);
      // 0.3s of encoder time over 30 frames, 0.3s of send delay over 300 packets.
      expect(snapshot?.encodeMsPerFrame).toBeCloseTo(10, 5);
      expect(snapshot?.packetSendDelayMs).toBeCloseTo(1, 5);
      expect(snapshot?.encodedFps).toBeCloseTo(30, 5);
      expect(snapshot?.networkRttMs).toBeCloseTo(20, 5);
      expect(snapshot?.networkJitterMs).toBeCloseTo(6, 5);
      expect(snapshot?.packetLossRatio).toBeCloseTo(55 / 1_300, 6);
      expect(snapshot?.sentBitrateBps).toBeCloseTo(2_000_000, 5);
      expect(snapshot?.codecMimeType).toBe('video/VP8');
    });

    it('summarizes input injection cost and stays bounded', () => {
      const accumulator = createRemoteWindowLatencyAccumulator();
      for (let index = 0; index < 300; index += 1) {
        accumulator.recordInputInjection(index);
      }
      const snapshot = accumulator.snapshot(10_000);
      expect(snapshot?.inputInjectSamples).toBe(240);
      // Only the newest 240 samples survive, so the median is 179 and the
      // nearest-rank p95 is the 228th of 240, i.e. 60 + 227 = 287.
      expect(snapshot?.inputInjectP50Ms).toBe(179);
      expect(snapshot?.inputInjectP95Ms).toBe(287);
    });
  });
});
