// @vitest-environment jsdom

/**
 * Submodule tests: terminal-quickbar-storage (client.input_runtime).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLIPBOARD_HISTORY_STORAGE_KEY,
  FLOATING_BUBBLE_POSITION_STORAGE_KEY,
  MAX_CLIPBOARD_HISTORY,
  dedupeClipboardHistory,
  normalizeClipboardHistory,
  readStoredBubblePosition,
  readStoredClipboardHistory,
  writeStoredBubblePosition,
  writeStoredClipboardHistory,
} from './terminal-quickbar-storage';

describe('terminal-quickbar-storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('normalizes clipboard history to trimmed strings within the cap', () => {
    expect(normalizeClipboardHistory(null)).toEqual([]);
    expect(normalizeClipboardHistory([1, 'a', '', 'b'])).toEqual(['a', 'b']);
    const many = Array.from({ length: MAX_CLIPBOARD_HISTORY + 10 }, (_, i) => `item-${i}`);
    expect(normalizeClipboardHistory(many).length).toBe(MAX_CLIPBOARD_HISTORY);
  });

  it('dedupes clipboard history while preserving order and cap', () => {
    expect(dedupeClipboardHistory(['a', 'b', 'a', 'c'])).toEqual(['a', 'b', 'c']);
    expect(dedupeClipboardHistory(['', '  '])).toEqual(['  ']); // 只滤空串，保留空白串
  });

  it('round-trips clipboard history through storage', () => {
    writeStoredClipboardHistory(['a', 'b']);
    expect(readStoredClipboardHistory()).toEqual(['a', 'b']);
    window.localStorage.setItem(CLIPBOARD_HISTORY_STORAGE_KEY, '{corrupt');
    expect(readStoredClipboardHistory()).toEqual([]);
  });

  it('round-trips the floating bubble position and removes on null', () => {
    expect(readStoredBubblePosition()).toEqual({ x: null, y: null });
    writeStoredBubblePosition({ x: 10, y: 20 });
    expect(readStoredBubblePosition()).toEqual({ x: 10, y: 20 });
    writeStoredBubblePosition({ x: null, y: null });
    expect(window.localStorage.getItem(FLOATING_BUBBLE_POSITION_STORAGE_KEY)).toBeNull();
    window.localStorage.setItem(FLOATING_BUBBLE_POSITION_STORAGE_KEY, '{corrupt');
    expect(readStoredBubblePosition()).toEqual({ x: null, y: null });
  });
});
