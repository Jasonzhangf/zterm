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

  it('keeps one persistent process wake lock while retained sessions need background protection', () => {
    const source = readFileSync(resolve(androidRoot, 'java/com/zterm/android/BackgroundService.java'), 'utf8');

    expect(source).toContain('PowerManager.PARTIAL_WAKE_LOCK');
    expect(source).toContain('setReferenceCounted(false)');
    expect(source).toContain('wakeLock.acquire()');
    expect(source).not.toContain('BACKGROUND_HANDOFF_WAKE_LOCK_MS');
    expect(source).not.toContain('backgroundHandoffHandler');
    expect(source).not.toContain('backgroundHandoffTimeoutRunnable');
    expect(source).not.toContain('BACKGROUND_WAKE_LOCK_RENEW_MS');
    expect(source).not.toContain('scheduleWakeLockRenewal');
    expect(source).toContain('wakeLock.release()');
    expect(source).toContain('if (sessionCount <= 0)');
    expect(source).toContain('stopForeground(true)');
    expect(source).toContain('stopSelf()');
    expect(source).toContain('START_REDELIVER_INTENT');
    expect(source).not.toContain('WebSocket');
    expect(source).not.toContain('PeerConnection');
  });

  it('does not auto-start native execution for zero sessions from activity stop', () => {
    const source = readFileSync(resolve(androidRoot, 'java/com/zterm/android/MainActivity.java'), 'utf8');

    expect(source).not.toContain('startBackgroundService(0);');
    expect(source).toContain('startService(serviceIntent);');
    expect(source).not.toContain('pauseTimers()');
    expect(source).not.toContain('getBridge().getWebView().onPause()');
  });

  it('leaves foreground service shutdown to the JavaScript lifecycle owner', () => {
    const source = readFileSync(resolve(androidRoot, 'java/com/zterm/android/MainActivity.java'), 'utf8');

    expect(source).toContain('public void onStart()');
    expect(source).not.toContain('Log.i(TAG, "onStart()");\n        stopBackgroundService();');
  });

  it('exposes a Capacitor plugin as the only native background-service start owner', () => {
    const activity = readFileSync(resolve(androidRoot, 'java/com/zterm/android/MainActivity.java'), 'utf8');
    const plugin = readFileSync(resolve(androidRoot, 'java/com/zterm/android/BackgroundServicePlugin.java'), 'utf8');

    expect(activity).toContain('registerPlugin(BackgroundServicePlugin.class)');
    expect(plugin).toContain('@CapacitorPlugin(name = "BackgroundService")');
    expect(plugin).toContain('call.getInt("sessionCount", 0)');
    expect(plugin).toContain('if (sessionCount <= 0)');
    expect(plugin).toContain('stopService()');
    expect(plugin).toContain('startForegroundService(serviceIntent)');
  });
});
