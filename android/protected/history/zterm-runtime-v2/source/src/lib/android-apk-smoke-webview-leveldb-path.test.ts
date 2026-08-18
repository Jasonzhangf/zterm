import { describe, expect, it } from 'vitest';
import { resolveApkSmokeWebViewLevelDbDirFromRunAsListing } from './android-apk-smoke-webview-leveldb-path';

describe('resolveApkSmokeWebViewLevelDbDirFromRunAsListing', () => {
  it('prefers the Android WebView default profile localStorage LevelDB path used on the real device', () => {
    const listing = `
/data/user/0/com.zterm.android
./app_webview
./app_webview/Default/Local Storage
./app_webview/Default/Local Storage/leveldb
./cache
`.trim();

    expect(resolveApkSmokeWebViewLevelDbDirFromRunAsListing(listing)).toBe(
      './app_webview/Default/Local Storage/leveldb',
    );
  });

  it('falls back to the direct app_webview localStorage LevelDB path when that is the only truth present', () => {
    const listing = `
./files
./app_webview/Local Storage
./app_webview/Local Storage/leveldb
`.trim();

    expect(resolveApkSmokeWebViewLevelDbDirFromRunAsListing(listing)).toBe(
      './app_webview/Local Storage/leveldb',
    );
  });

  it('returns null when no WebView localStorage LevelDB directory exists in the run-as listing', () => {
    expect(resolveApkSmokeWebViewLevelDbDirFromRunAsListing('./files\n./cache')).toBeNull();
  });
});
