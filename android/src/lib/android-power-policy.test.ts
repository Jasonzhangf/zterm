import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const androidRoot = resolve(__dirname, '../../native/android/app/src/main');

describe('Android background power policy', () => {
  it('does not request WakeLock or battery-optimization bypass permissions', () => {
    const manifest = readFileSync(resolve(androidRoot, 'AndroidManifest.xml'), 'utf8');

    expect(manifest).not.toContain('android.permission.WAKE_LOCK');
    expect(manifest).not.toContain('android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS');
  });

  it('keeps the background foreground-service notification free of CPU WakeLock ownership', () => {
    const source = readFileSync(resolve(androidRoot, 'java/com/zterm/android/BackgroundService.java'), 'utf8');

    expect(source).not.toContain('PowerManager.PARTIAL_WAKE_LOCK');
    expect(source).not.toContain('newWakeLock');
    expect(source).not.toContain('acquire(');
  });
});
