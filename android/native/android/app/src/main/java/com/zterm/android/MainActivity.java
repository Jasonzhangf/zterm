package com.zterm.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

/**
 * MainActivity - Capacitor main Activity
 */
public class MainActivity extends BridgeActivity {
    private static final String TAG = "ZTermMainActivity";
    private static final String PREFS_NAME = "zterm_webview_cache_version";
    private static final String PREF_VERSION_CODE = "versionCode";


    @Override
    public void onCreate(Bundle savedInstanceState) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            setRecentsScreenshotEnabled(false);
        }
        // 默认固定竖屏锁定：不管手机处于什么姿势都不做横竖屏自动切换；
        // 方向切换只由客户端角落转换按钮（ScreenOrientationPlugin.setOrientation）触发
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        clearWebViewAssetCacheAfterUpgrade();
        registerPlugin(ImeAnchorPlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        registerPlugin(DeviceClipboardPlugin.class);
        registerPlugin(DebugInputPlugin.class);
        registerPlugin(StoragePermissionPlugin.class);
        registerPlugin(AndroidConnectionServicePlugin.class);
        registerPlugin(ScreenOrientationPlugin.class);
        registerPlugin(NetworkIdentityPlugin.class);
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
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                // Do not waive renderer priority when the Activity is not
                // visible. Android/WebView repeatedly cached and collected this
                // renderer, which killed every same-document WebSocket and
                // forced a real reconnect even though the app process stayed
                // alive.
                wv.setRendererPriorityPolicy(
                    WebView.RENDERER_PRIORITY_IMPORTANT,
                    false
                );
            }
            // WebView 自身背景与终端表面一致：内容/首帧未就绪时也不露白屏
            wv.setBackgroundColor(0xFF1E1E1E);
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

}
