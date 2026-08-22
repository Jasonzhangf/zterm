import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error pngjs is runtime-tested here but has no bundled declaration.
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

const androidRoot = resolve(__dirname, '../../native/android/app/src/main');
const activitySource = readFileSync(
  resolve(androidRoot, 'java/com/zterm/android/MainActivity.java'),
  'utf8',
);
const themeSource = readFileSync(resolve(androidRoot, 'res/values/styles.xml'), 'utf8');

const splashLogoPaths = [
  'drawable/splash_logo.png',
  'drawable-mdpi/splash_logo.png',
  'drawable-hdpi/splash_logo.png',
  'drawable-xhdpi/splash_logo.png',
  'drawable-xxhdpi/splash_logo.png',
  'drawable-xxxhdpi/splash_logo.png',
];

function findLogoBounds(path: string) {
  const image = PNG.sync.read(readFileSync(resolve(androidRoot, 'res', path)));
  const background = { red: 255, green: 255, blue: 255 };
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      const distance = Math.max(
        Math.abs(image.data[offset] - background.red),
        Math.abs(image.data[offset + 1] - background.green),
        Math.abs(image.data[offset + 2] - background.blue),
      );
      if (distance < 8) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }

  return {
    width: right - left + 1,
    height: bottom - top + 1,
    centerX: (left + right) / 2,
    centerY: (top + bottom) / 2,
    canvasCenterX: (image.width - 1) / 2,
    canvasCenterY: (image.height - 1) / 2,
  };
}

describe('Android task transition truth', () => {
  it('disables stopped-activity task screenshots before Capacitor creates the window', () => {
    const policyIndex = activitySource.indexOf('setRecentsScreenshotEnabled(false)');
    const bridgeCreateIndex = activitySource.indexOf('super.onCreate(savedInstanceState)');

    expect(activitySource).toContain(
      'if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)',
    );
    expect(policyIndex).toBeGreaterThan(-1);
    expect(policyIndex).toBeLessThan(bridgeCreateIndex);
  });

  it('uses one opaque runtime theme when Android needs a task representation', () => {
    expect(themeSource).toContain('<item name="android:windowBackground">#FF1E1E1E</item>');
    expect(themeSource).toContain('<item name="android:colorBackground">#FF1E1E1E</item>');
    expect(themeSource).toContain(
      '<item name="windowSplashScreenAnimatedIcon">@drawable/splash_logo</item>',
    );
    expect(existsSync(resolve(androidRoot, 'res/drawable/splash_logo.png'))).toBe(true);
    expect(themeSource).toContain(
      '<item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>',
    );
  });

  it('does not replace task-snapshot policy with FLAG_SECURE or JavaScript compensation', () => {
    expect(activitySource).not.toContain('FLAG_SECURE');
  });

  it('keeps the foreground logo aspect ratio and centered safe bounds at every density', () => {
    for (const path of splashLogoPaths) {
      const bounds = findLogoBounds(path);
      const aspectRatio = bounds.width / bounds.height;

      expect(aspectRatio, path).toBeGreaterThan(1.1);
      expect(aspectRatio, path).toBeLessThan(1.2);
      expect(Math.abs(bounds.centerX - bounds.canvasCenterX), path).toBeLessThanOrEqual(1);
      expect(Math.abs(bounds.centerY - bounds.canvasCenterY), path).toBeLessThanOrEqual(1);
    }
  });

  it('never stretches a fullscreen bitmap as the launch window background', () => {
    // Warm/background starts show the launch theme before the SplashScreen
    // icon; a bitmap here is stretched to the window, so only a solid color
    // is allowed.
    expect(themeSource).not.toContain('@drawable/splash"');
  });
});
