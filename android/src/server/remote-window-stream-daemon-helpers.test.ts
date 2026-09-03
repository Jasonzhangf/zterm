/**
 * Submodule tests: remote-window-stream-daemon-helpers (daemon.remote_window_stream).
 */
import { describe, expect, it } from 'vitest';
import {
  buildRemoteWindowTargetCatalogCacheKey,
  convertRgbaToI420Frame,
  formatRemoteWindowVideoProfileError,
  normalizeIceCandidate,
  normalizeRemoteWindowVideoProfile,
} from './remote-window-stream-daemon-helpers';
import { MACOS_REMOTE_WINDOW_INPUT_SWIFT } from './remote-window-scripts';
import { makeRemoteWindowVideoProfileFixture } from './remote-window-video-profile-test-fixture';

describe('remote-window-stream-daemon-helpers', () => {
  it('builds catalog cache keys from include flags', () => {
    expect(buildRemoteWindowTargetCatalogCacheKey({} as never)).toBe('app|iterm2');
    expect(buildRemoteWindowTargetCatalogCacheKey({ includeAppWindows: false, includeIterm2: false } as never)).toBe('no-app|no-iterm2');
  });

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
      'frontmostPidMatches(config.pid) && focusedWindowMatchesTarget(appElement, config.window.bounds)',
    );
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('try focusTargetWindow(config)');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).not.toContain('skipFocus');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('remoteWindowContinuousFocusCacheSeconds: TimeInterval = 2.0');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('lastVerifiedFocusAt = now');
  });
});
