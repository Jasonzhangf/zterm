/**
 * Submodule tests: remote-window-stream-daemon-helpers (daemon.remote_window_stream).
 */
import { describe, expect, it } from 'vitest';
import {
  convertRgbaToI420Frame,
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
});
