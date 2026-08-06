package com.zterm.android;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

/**
 * MainActivity - Capacitor main Activity
 */
public class MainActivity extends BridgeActivity {
    private static final String TAG = "ZTermMainActivity";
    private static final String PREFS_NAME = "zterm_webview_cache_version";
    private static final String PREF_VERSION_CODE = "versionCode";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        clearWebViewAssetCacheAfterUpgrade();
        registerPlugin(ImeAnchorPlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        registerPlugin(DeviceClipboardPlugin.class);
        registerPlugin(DebugInputPlugin.class);
        registerPlugin(StoragePermissionPlugin.class);
        registerPlugin(BackgroundServicePlugin.class);
        registerPlugin(ScreenOrientationPlugin.class);
        super.onCreate(savedInstanceState);
        Log.i(TAG, "onCreate()");
        if (getBridge() != null && getBridge().getWebView() != null) {
            final WebView wv = getBridge().getWebView();
            wv.setOverScrollMode(View.OVER_SCROLL_NEVER);
            wv.setVerticalScrollBarEnabled(false);
            wv.setHorizontalScrollBarEnabled(false);
            WebSettings settings = wv.getSettings();
            settings.setSupportZoom(false);
            settings.setBuiltInZoomControls(false);
            settings.setDisplayZoomControls(false);
            // Use BridgeWebChromeClient (which implements onShowFileChooser)
            // so that <input type="file"> triggers the system file picker.
            // BridgeWebChromeClient already pipes JS console to Capacitor Logger,
            // which appears in logcat with tag "Console".
            wv.setWebChromeClient(new BridgeWebChromeClient(getBridge()));
            // Block Android WebView native long-press so its floating selection
            // ActionMode toolbar (全选 / 剪切 / 复制 / 分享) does NOT appear.
            // JS touch events are received in real-time BEFORE this listener
            // fires, so the 420ms JS long-press timer in copy-mode still runs
            // and shows our app-owned copy menu.
            wv.setLongClickable(true);
            wv.setOnLongClickListener(new View.OnLongClickListener() {
                @Override
                public boolean onLongClick(View v) {
                    return true;
                }
            });
        }
    }

    private long readCurrentVersionCode() throws PackageManager.NameNotFoundException {
        PackageInfo packageInfo = getPackageManager().getPackageInfo(getPackageName(), 0);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return packageInfo.getLongVersionCode();
        }
        return packageInfo.versionCode;
    }

    private void clearWebViewAssetCacheAfterUpgrade() {
        try {
            long currentVersionCode = readCurrentVersionCode();
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            long lastVersionCode = prefs.getLong(PREF_VERSION_CODE, -1L);
            if (lastVersionCode == currentVersionCode) {
                return;
            }

            deleteRecursively(new java.io.File(getCacheDir(), "WebView/Default/HTTP Cache"));
            deleteRecursively(getCodeCacheDir());
            prefs.edit().putLong(PREF_VERSION_CODE, currentVersionCode).apply();
            Log.i(TAG, "cleared WebView asset cache for versionCode=" + currentVersionCode + " previous=" + lastVersionCode);
        } catch (Exception error) {
            Log.e(TAG, "failed to clear WebView asset cache after upgrade", error);
        }
    }

    private void deleteRecursively(java.io.File file) {
        if (file == null || !file.exists()) {
            return;
        }
        if (file.isDirectory()) {
            java.io.File[] children = file.listFiles();
            if (children != null) {
                for (java.io.File child : children) {
                    deleteRecursively(child);
                }
            }
        }
        if (!file.delete() && file.exists()) {
            Log.w(TAG, "failed to delete cache path: " + file.getAbsolutePath());
        }
    }

    @Override
    public void onStop() {
        super.onStop();
        Log.i(TAG, "onStop()");
    }

    @Override
    public void onStart() {
        super.onStart();
        Log.i(TAG, "onStart()");
    }

    @Override
    public void onResume() {
        super.onResume();
        Log.i(TAG, "onResume()");
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().postInvalidateOnAnimation();
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
    }

    public void startBackgroundService(int sessionCount) {
        Intent serviceIntent = new Intent(this, BackgroundService.class);
        serviceIntent.putExtra("sessionCount", sessionCount);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent);
        } else {
            startService(serviceIntent);
        }
    }

    public void stopBackgroundService() {
        Intent serviceIntent = new Intent(this, BackgroundService.class);
        stopService(serviceIntent);
    }
}
