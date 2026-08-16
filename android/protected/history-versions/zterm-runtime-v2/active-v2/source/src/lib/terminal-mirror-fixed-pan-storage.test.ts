// @vitest-environment jsdom

/**
 * Red test: mirror-fixed horizontal pan offset persistence must live in the
 * storage owner (client.app_shell lib), NOT inside the renderer.
 *
 * Gate doc: docs/audits/2026-08-13-terminal-render-layer-decoupling.md §8.3
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MIRROR_FIXED_HORIZONTAL_OFFSET_STORAGE_KEY,
  clampHorizontalOffset,
  readStoredHorizontalOffset,
  writeStoredHorizontalOffset,
} from './terminal-mirror-fixed-pan-storage';

describe('terminal-mirror-fixed-pan-storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('clamps offsets to [0, max] and rounds', () => {
    expect(clampHorizontalOffset(10.4, 100)).toBe(10);
    expect(clampHorizontalOffset(-5, 100)).toBe(0);
    expect(clampHorizontalOffset(250, 100)).toBe(100);
    expect(clampHorizontalOffset(Number.NaN, 100)).toBe(0);
    expect(clampHorizontalOffset(Number.POSITIVE_INFINITY, 100)).toBe(0);
  });

  it('round-trips a stored offset per session', () => {
    writeStoredHorizontalOffset('s1', 42);
    expect(readStoredHorizontalOffset('s1')).toBe(42);
  });

  it('keeps offsets of distinct sessions separate (merged map)', () => {
    writeStoredHorizontalOffset('s1', 10);
    writeStoredHorizontalOffset('s2', 30);
    expect(readStoredHorizontalOffset('s1')).toBe(10);
    expect(readStoredHorizontalOffset('s2')).toBe(30);
  });

  it('ignores writes without a session id', () => {
    writeStoredHorizontalOffset(null, 10);
    expect(window.localStorage.getItem(MIRROR_FIXED_HORIZONTAL_OFFSET_STORAGE_KEY)).toBeNull();
    writeStoredHorizontalOffset('', 10);
    expect(window.localStorage.getItem(MIRROR_FIXED_HORIZONTAL_OFFSET_STORAGE_KEY)).toBeNull();
  });

  it('returns 0 for missing / corrupt / non-object stored data', () => {
    expect(readStoredHorizontalOffset('s1')).toBe(0);
    window.localStorage.setItem(MIRROR_FIXED_HORIZONTAL_OFFSET_STORAGE_KEY, '{corrupt');
    expect(readStoredHorizontalOffset('s1')).toBe(0);
    window.localStorage.setItem(MIRROR_FIXED_HORIZONTAL_OFFSET_STORAGE_KEY, JSON.stringify([1, 2]));
    expect(readStoredHorizontalOffset('s1')).toBe(0);
    window.localStorage.setItem(MIRROR_FIXED_HORIZONTAL_OFFSET_STORAGE_KEY, JSON.stringify({ s1: 'abc' }));
    expect(readStoredHorizontalOffset('s1')).toBe(0);
  });

  it('clamps stored writes and never stores negative offsets', () => {
    writeStoredHorizontalOffset('s1', -20);
    expect(readStoredHorizontalOffset('s1')).toBe(0);
    writeStoredHorizontalOffset('s2', 1e9);
    expect(readStoredHorizontalOffset('s2')).toBeGreaterThanOrEqual(0);
  });
});
