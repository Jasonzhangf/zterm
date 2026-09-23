// @vitest-environment jsdom

/**
 * Submodule tests: remote-window-overlay-storage (client.remote_window_overlay).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REMOTE_WINDOW_ENTRY_POSITION_STORAGE_KEY,
  REMOTE_WINDOW_BROWSER_ENTRY_POSITION_STORAGE_KEY,
  REMOTE_WINDOW_DISPLAY_ORIENTATION_STORAGE_KEY,
  REMOTE_WINDOW_INPUT_MODE_STORAGE_KEY,
  REMOTE_WINDOW_QUALITY_BITRATE_MULTIPLIER_STORAGE_KEY,
  REMOTE_WINDOW_QUALITY_MAX_FRAME_RATE_STORAGE_KEY,
  REMOTE_WINDOW_TOUCH_SCROLL_FRACTION_STORAGE_KEY,
  REMOTE_WINDOW_TOUCH_SCROLL_INVERTED_STORAGE_KEY,
  readRemoteWindowBitrateMultiplier,
  readRemoteWindowDisplayOrientation,
  readRemoteWindowInputMode,
  readRemoteWindowMaxFrameRate,
  readRemoteWindowTouchScrollFraction,
  readRemoteWindowTouchScrollInverted,
  readStoredEntryPosition,
  readStoredBrowserEntryPosition,
  resolveTouchScrollFractionPreset,
  writeRemoteWindowBitrateMultiplier,
  writeRemoteWindowDisplayOrientation,
  writeRemoteWindowInputMode,
  writeRemoteWindowMaxFrameRate,
  writeStoredEntryPosition,
  writeStoredBrowserEntryPosition,
} from './remote-window-overlay-storage';

describe('remote-window-overlay-storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('round-trips the floating entry position', () => {
    expect(readStoredEntryPosition()).toEqual({ x: null, y: null });
    writeStoredEntryPosition({ x: 12, y: 34 });
    expect(readStoredEntryPosition()).toEqual({ x: 12, y: 34 });
  });

  it('returns nulls for corrupt or non-numeric entry positions', () => {
    window.localStorage.setItem(REMOTE_WINDOW_ENTRY_POSITION_STORAGE_KEY, '{corrupt');
    expect(readStoredEntryPosition()).toEqual({ x: null, y: null });
    window.localStorage.setItem(
      REMOTE_WINDOW_ENTRY_POSITION_STORAGE_KEY,
      JSON.stringify({ x: 'abc', y: 5 }),
    );
    expect(readStoredEntryPosition()).toEqual({ x: null, y: 5 });
  });

  it('keeps browser entry position independent from remote entry position', () => {
    writeStoredEntryPosition({ x: 12, y: 34 });
    writeStoredBrowserEntryPosition({ x: 56, y: 78 });
    expect(readStoredEntryPosition()).toEqual({ x: 12, y: 34 });
    expect(readStoredBrowserEntryPosition()).toEqual({ x: 56, y: 78 });
    expect(window.localStorage.getItem(REMOTE_WINDOW_BROWSER_ENTRY_POSITION_STORAGE_KEY)).toContain('56');
  });

  it('resolves touch scroll fraction presets with fallback to default', () => {
    expect(resolveTouchScrollFractionPreset(0.25)).toBe(0.25);
    expect(resolveTouchScrollFractionPreset('0.5')).toBe(0.5);
    expect(resolveTouchScrollFractionPreset(0.3)).toBe(0.25); // default
    expect(resolveTouchScrollFractionPreset(null)).toBe(0.25);
  });

  it('reads touch scroll prefs with documented defaults', () => {
    expect(readRemoteWindowTouchScrollFraction()).toBe(0.25);
    expect(readRemoteWindowTouchScrollInverted()).toBe(true);
    window.localStorage.setItem(REMOTE_WINDOW_TOUCH_SCROLL_FRACTION_STORAGE_KEY, '0.125');
    window.localStorage.setItem(REMOTE_WINDOW_TOUCH_SCROLL_INVERTED_STORAGE_KEY, 'false');
    expect(readRemoteWindowTouchScrollFraction()).toBe(0.125);
    expect(readRemoteWindowTouchScrollInverted()).toBe(false);
  });

  it('round-trips the remote input mode', () => {
    expect(readRemoteWindowInputMode()).toBe('touch');
    writeRemoteWindowInputMode('mouse');
    expect(readRemoteWindowInputMode()).toBe('mouse');
    window.localStorage.setItem(REMOTE_WINDOW_INPUT_MODE_STORAGE_KEY, 'bogus');
    expect(readRemoteWindowInputMode()).toBe('touch');
  });

  it('round-trips display orientation and quality controls with invalid-value fallback', () => {
    expect(readRemoteWindowDisplayOrientation()).toBe('follow-device');
    writeRemoteWindowDisplayOrientation('landscape');
    expect(readRemoteWindowDisplayOrientation()).toBe('landscape');
    window.localStorage.setItem(REMOTE_WINDOW_DISPLAY_ORIENTATION_STORAGE_KEY, 'bogus');
    expect(readRemoteWindowDisplayOrientation()).toBe('follow-device');

    expect(readRemoteWindowBitrateMultiplier()).toBe(1);
    expect(readRemoteWindowMaxFrameRate()).toBe(30);
    writeRemoteWindowBitrateMultiplier(4);
    writeRemoteWindowMaxFrameRate(60);
    expect(readRemoteWindowBitrateMultiplier()).toBe(4);
    expect(readRemoteWindowMaxFrameRate()).toBe(60);
    window.localStorage.setItem(REMOTE_WINDOW_QUALITY_BITRATE_MULTIPLIER_STORAGE_KEY, '3');
    window.localStorage.setItem(REMOTE_WINDOW_QUALITY_MAX_FRAME_RATE_STORAGE_KEY, '24');
    expect(readRemoteWindowBitrateMultiplier()).toBe(1);
    expect(readRemoteWindowMaxFrameRate()).toBe(30);
  });
});
