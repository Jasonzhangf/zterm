import { describe, expect, it } from 'vitest';
import type { RemoteWindowStreamTargetManifest } from './types';
import {
  REMOTE_WINDOW_VIDEO_BITRATE_STORAGE_KEY,
  buildRemoteWindowVideoBitrateConfig,
  readRemoteWindowVideoBitratePreset,
  resolveEffectiveRemoteWindowVideoBitratePreset,
  resolveDefaultRemoteWindowVideoBitratePreset,
  resolveRemoteWindowVideoResolutionKey,
  writeRemoteWindowVideoBitratePreset,
} from './remote-window-video-quality';

function makeTarget(width: number, height: number, overrides: Partial<RemoteWindowStreamTargetManifest['videoTarget']> = {}): RemoteWindowStreamTargetManifest {
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
      scale: 1,
      createdAt: '2026-07-20T00:00:00.000Z',
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
  it('derives default bitrate presets from target resolution with fullscreen width at 20 Mbps', () => {
    expect(resolveDefaultRemoteWindowVideoBitratePreset(makeTarget(320, 240))).toBe('2mbps');
    expect(resolveDefaultRemoteWindowVideoBitratePreset(makeTarget(640, 360))).toBe('5mbps');
    expect(resolveDefaultRemoteWindowVideoBitratePreset(makeTarget(960, 540))).toBe('10mbps');
    expect(resolveDefaultRemoteWindowVideoBitratePreset(makeTarget(1200, 780))).toBe('fullscreen');
    expect(buildRemoteWindowVideoBitrateConfig('fullscreen')).toEqual({
      preset: 'fullscreen',
      bitrateMbps: 20,
      maxBitrateBps: 20_000_000,
    });
  });

  it('remembers bitrate per window and also seeds the same-resolution default', () => {
    const storage = makeStorage();
    const firstWindow = makeTarget(640, 360, { windowId: 'window-a', title: 'Window A' });
    const secondWindowSameResolution = makeTarget(640, 360, { windowId: 'window-b', title: 'Window B' });

    expect(readRemoteWindowVideoBitratePreset(firstWindow, storage)).toBe('5mbps');
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
    expect(readRemoteWindowVideoBitratePreset(otherWindowSameNewResolution, storage)).toBe('fullscreen');
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
});
