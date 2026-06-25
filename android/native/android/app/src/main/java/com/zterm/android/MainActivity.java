package com.zterm.android;

import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

/**
 * MainActivity - Capacitor main Activity
 */
public class MainActivity extends BridgeActivity {
    private static final String TAG = "ZTermMainActivity";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ImeAnchorPlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        registerPlugin(DeviceClipboardPlugin.class);
        registerPlugin(DebugInputPlugin.class);
        registerPlugin(StoragePermissionPlugin.class);
        super.onCreate(savedInstanceState);
        Log.i(TAG, "onCreate()");
        if (getBridge() != null && getBridge().getWebView() != null) {
            final WebView wv = getBridge().getWebView();
            wv.setOverScrollMode(View.OVER_SCROLL_NEVER);
            wv.setVerticalScrollBarEnabled(false);
            wv.setHorizontalScrollBarEnabled(false);
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

    @Override
    public void onStop() {
        super.onStop();
        Log.i(TAG, "onStop()");
        stopBackgroundService();
    }

    @Override
    public void onStart() {
        super.onStart();
        Log.i(TAG, "onStart()");
        stopBackgroundService();
    }

    @Override
    public void onResume() {
        super.onResume();
        Log.i(TAG, "onResume()");
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().onResume();
            getBridge().getWebView().resumeTimers();
            getBridge().getWebView().postInvalidateOnAnimation();
        }
    }

    @Override
    public void onPause() {
        Log.i(TAG, "onPause()");
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().onPause();
            getBridge().getWebView().pauseTimers();
        }
        super.onPause();
    }

    @Override
    public void onDestroy() {
        stopBackgroundService();
        super.onDestroy();
    }

    public void startBackgroundService(int sessionCount) {
        Intent serviceIntent = new Intent(this, BackgroundService.class);
        serviceIntent.putExtra("sessionCount", sessionCount);
        startForegroundService(serviceIntent);
    }

    public void stopBackgroundService() {
        Intent serviceIntent = new Intent(this, BackgroundService.class);
        stopService(serviceIntent);
    }
}
