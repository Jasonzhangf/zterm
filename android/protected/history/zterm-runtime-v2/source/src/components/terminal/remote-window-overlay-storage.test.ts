// @vitest-environment jsdom

/**
 * Submodule tests: remote-window-overlay-storage (client.remote_window_overlay).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REMOTE_WINDOW_ENTRY_POSITION_STORAGE_KEY,
  REMOTE_WINDOW_INPUT_MODE_STORAGE_KEY,
  REMOTE_WINDOW_TOUCH_SCROLL_FRACTION_STORAGE_KEY,
  REMOTE_WINDOW_TOUCH_SCROLL_INVERTED_STORAGE_KEY,
  readRemoteWindowInputMode,
  readRemoteWindowTouchScrollFraction,
  readRemoteWindowTouchScrollInverted,
  readStoredEntryPosition,
  resolveTouchScrollFractionPreset,
  writeRemoteWindowInputMode,
  writeStoredEntryPosition,
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
});
