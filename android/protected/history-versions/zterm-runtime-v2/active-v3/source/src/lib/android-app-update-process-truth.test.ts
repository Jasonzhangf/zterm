import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const appUpdatePluginSource = readFileSync(
  resolve(__dirname, '../../native/android/app/src/main/java/com/zterm/android/AppUpdatePlugin.java'),
  'utf8',
);

describe('Android app update process truth', () => {
  it('terminates the old WebView process after handing the apk to the system installer', () => {
    expect(appUpdatePluginSource).toContain('terminateCurrentProcessAfterInstallerHandoff();');
    expect(appUpdatePluginSource).toContain('finishAndRemoveTask();');
    expect(appUpdatePluginSource).toContain('android.os.Process.killProcess(android.os.Process.myPid());');
  });

  it('does not clear app storage or localStorage as an update-process workaround', () => {
    expect(appUpdatePluginSource).not.toContain('clearApplicationUserData');
    expect(appUpdatePluginSource).not.toContain('app_webview');
    expect(appUpdatePluginSource).not.toContain('Local Storage');
    expect(appUpdatePluginSource).not.toContain('localStorage');
  });
});
