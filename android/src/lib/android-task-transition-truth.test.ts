import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const androidRoot = resolve(__dirname, '../../native/android/app/src/main');
const activitySource = readFileSync(
  resolve(androidRoot, 'java/com/zterm/android/MainActivity.java'),
  'utf8',
);
const themeSource = readFileSync(resolve(androidRoot, 'res/values/styles.xml'), 'utf8');

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
});
