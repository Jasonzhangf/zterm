package com.zterm.android;

import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

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
            // Do not consume long-press at the native WebView boundary.
            // Copy-mode blocks native selection/menu inside the DOM so app-owned
            // row long-press can still reach React handlers on real devices.
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
