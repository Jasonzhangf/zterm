import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const androidRoot = resolve(__dirname, '../../native/android/app/src/main');

describe('Android screen orientation lock', () => {
  it('registers ScreenOrientationPlugin and locks portrait by default (no auto rotate)', () => {
    const activity = readFileSync(resolve(androidRoot, 'java/com/zterm/android/MainActivity.java'), 'utf8');
    const plugin = readFileSync(resolve(androidRoot, 'java/com/zterm/android/ScreenOrientationPlugin.java'), 'utf8');

    expect(activity).toContain('registerPlugin(ScreenOrientationPlugin.class)');
    // 默认固定竖屏锁定：不随手机姿势自动横竖屏切换（视频播放器式）
    expect(activity).toContain('SCREEN_ORIENTATION_PORTRAIT');
    expect(plugin).toContain('@CapacitorPlugin(name = "ScreenOrientation")');
    // 固定变体（非 SENSOR_PORTRAIT/SENSOR_LANDSCAPE）：彻底锁定，不跟传感器翻转
    expect(plugin).toContain('SCREEN_ORIENTATION_PORTRAIT');
    expect(plugin).toContain('SCREEN_ORIENTATION_LANDSCAPE');
    expect(plugin).not.toContain('SCREEN_ORIENTATION_SENSOR_PORTRAIT');
    expect(plugin).not.toContain('SCREEN_ORIENTATION_SENSOR_LANDSCAPE');
  });

  it('exposes the orientation lock runtime with pose detection', () => {
    const wrapper = readFileSync(
      resolve(__dirname, '../hooks/useScreenOrientationLock.ts'),
      'utf8',
    );
    const pluginTs = readFileSync(
      resolve(__dirname, '../plugins/ScreenOrientationPlugin.ts'),
      'utf8',
    );

    expect(wrapper).toContain('useScreenOrientationLock');
    expect(wrapper).toContain('resolveOrientationFromGamma');
    expect(wrapper).toContain('deviceorientation');
    expect(wrapper).toContain('requestOrientationSwitch');
    expect(pluginTs).toContain("setOrientation(options: { orientation: 'portrait' | 'landscape' })");
  });
});
