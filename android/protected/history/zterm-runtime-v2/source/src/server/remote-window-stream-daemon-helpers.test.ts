/**
 * Submodule tests: remote-window-stream-daemon-helpers (daemon.remote_window_stream).
 */
import { describe, expect, it } from 'vitest';
import {
  buildRemoteWindowTargetCatalogCacheKey,
  convertRgbaToI420Frame,
  formatRemoteWindowVideoBitrateError,
  normalizeIceCandidate,
  normalizeRemoteWindowVideoBitrateConfig,
} from './remote-window-stream-daemon-helpers';

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

  it('normalizes video bitrate configs and rejects mismatches', () => {
    const config = normalizeRemoteWindowVideoBitrateConfig({ preset: '5mbps', bitrateMbps: 5, maxBitrateBps: 5_000_000, maxFrameRateFps: 30 });
    expect(config?.bitrateMbps).toBe(5);
    expect(() => normalizeRemoteWindowVideoBitrateConfig({ preset: '5mbps', bitrateMbps: 5, maxBitrateBps: 6_000_000 })).toThrow();
    expect(normalizeRemoteWindowVideoBitrateConfig(undefined)).toBeNull();
  });

  it('formats bitrate errors with fallbacks', () => {
    expect(formatRemoteWindowVideoBitrateError(new Error('boom'))).toBe('boom');
    expect(formatRemoteWindowVideoBitrateError('')).toContain('could not be applied');
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
});
