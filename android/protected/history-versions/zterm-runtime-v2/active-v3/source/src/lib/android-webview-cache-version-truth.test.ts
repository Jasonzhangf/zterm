import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const mainActivitySource = readFileSync(
  resolve(__dirname, '../../native/android/app/src/main/java/com/zterm/android/MainActivity.java'),
  'utf8',
);

describe('Android WebView asset cache version truth', () => {
  it('clears only WebView asset caches after native versionCode changes', () => {
    expect(mainActivitySource).toContain('clearWebViewAssetCacheAfterUpgrade();');
    expect(mainActivitySource).toContain('getLongVersionCode()');
    expect(mainActivitySource).toContain('PREF_VERSION_CODE');
    expect(mainActivitySource).toContain('WebView/Default/HTTP Cache');
    expect(mainActivitySource).toContain('getCodeCacheDir()');
  });

  it('does not delete WebView localStorage or app data while invalidating stale assets', () => {
    expect(mainActivitySource).not.toContain('app_webview');
    expect(mainActivitySource).not.toContain('Local Storage');
    expect(mainActivitySource).not.toContain('getDataDir()');
    expect(mainActivitySource).not.toContain('clearApplicationUserData');
  });
});
