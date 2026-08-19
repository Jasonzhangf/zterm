import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const androidRoot = resolve(__dirname, '../../native/android/app/src/main');

describe('Android background power policy', () => {
  it('declares explicit persistent-background execution without battery-optimization bypass', () => {
    const manifest = readFileSync(resolve(androidRoot, 'AndroidManifest.xml'), 'utf8');

    expect(manifest).toContain('android.permission.WAKE_LOCK');
    expect(manifest).toContain('android.permission.FOREGROUND_SERVICE_SPECIAL_USE');
    expect(manifest).toContain('android:foregroundServiceType="specialUse"');
    expect(manifest).not.toContain('android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS');
  });

  it('keeps Android transport and network ownership in the connection service', () => {
    const source = readFileSync(resolve(androidRoot, 'java/com/zterm/android/AndroidConnectionService.java'), 'utf8');

    expect(source).toContain('PowerManager.PARTIAL_WAKE_LOCK');
    expect(source).toContain('setReferenceCounted(false)');
    expect(source).toContain('wakeLock.acquire(timeoutMs)');
    expect(source).toContain('registerNetworkCallback');
    expect(source).toContain('networkGeneration');
    expect(source).toContain('retireForNetworkChange');
    expect(source).toContain('onBind');
    expect(source).toContain('START_REDELIVER_INTENT');
    expect(source).toContain('WebSocket');
  });

  it('does not auto-start native execution for zero sessions from activity stop', () => {
    const source = readFileSync(resolve(androidRoot, 'java/com/zterm/android/MainActivity.java'), 'utf8');

    expect(source).not.toContain('pauseTimers()');
    expect(source).not.toContain('getBridge().getWebView().onPause()');
    expect(source).toContain('setRendererPriorityPolicy');
    expect(source).toContain('RENDERER_PRIORITY_IMPORTANT');
    expect(source).toContain('RENDERER_PRIORITY_IMPORTANT,\n                    false');
    expect(source).not.toContain('getStaticWebView');
  });

  it('does not register the legacy WebView heartbeat owner', () => {
    const source = readFileSync(resolve(androidRoot, 'java/com/zterm/android/MainActivity.java'), 'utf8');

    expect(source).not.toContain('BackgroundService');
  });
});
