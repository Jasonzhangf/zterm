/**
 * Submodule tests: attachment-drawer-helpers (client.runtime).
 */
import { describe, expect, it } from 'vitest';
import {
  clampPanForScale,
  formatFileSize,
  formatRelativeTime,
} from './attachment-drawer-helpers';

describe('attachment-drawer-helpers', () => {
  it('clamps pan within scale bounds', () => {
    expect(clampPanForScale({ x: 1000, y: -1000 }, 2).x).toBeLessThanOrEqual(1000);
    expect(clampPanForScale({ x: 1000, y: -1000 }, 2).y).toBeLessThanOrEqual(0);
    expect(clampPanForScale({ x: 0, y: 0 }, 1)).toEqual({ x: 0, y: 0 });
  });

  it('formats relative time', () => {
    expect(formatRelativeTime(Date.now())).toMatch(/刚刚|秒/);
    expect(formatRelativeTime(Date.now() - 60_000)).toMatch(/分钟/);
  });

  it('formats file sizes', () => {
    expect(formatFileSize(512)).toContain('B');
    expect(formatFileSize(2048)).toContain('KB');
  });
});
