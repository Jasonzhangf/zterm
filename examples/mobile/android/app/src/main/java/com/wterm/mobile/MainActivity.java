package com.wterm.mobile;

import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import com.getcapacitor.BridgeActivity;

/**
 * MainActivity - Capacitor 主 Activity
 * 包含后台服务启动/停止逻辑
 */
public class MainActivity extends BridgeActivity {
    private static final String TAG = "WTermMainActivity";
    
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ImeAnchorPlugin.class);
        super.onCreate(savedInstanceState);
        Log.i(TAG, "onCreate()");
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().setOverScrollMode(View.OVER_SCROLL_NEVER);
            getBridge().getWebView().setVerticalScrollBarEnabled(false);
            getBridge().getWebView().setHorizontalScrollBarEnabled(false);
        }
    }
    
    /**
     * 当 Activity 进入后台时启动前台服务
     */
    @Override
    public void onStop() {
        super.onStop();
        Log.i(TAG, "onStop()");
        // 如果有活跃的 WebSocket 连接，启动后台服务保持连接
        startBackgroundService(1);
    }
    
    /**
     * 当 Activity 回到前台时
     */
    @Override
    public void onStart() {
        super.onStart();
        Log.i(TAG, "onStart()");
        // 回到前台时可以停止通知，但保持服务运行以维持连接
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
    
    /**
     * 启动后台服务
     */
    public void startBackgroundService(int sessionCount) {
        Intent serviceIntent = new Intent(this, BackgroundService.class);
        serviceIntent.putExtra("sessionCount", sessionCount);
        startForegroundService(serviceIntent);
    }
    
    /**
     * 停止后台服务
     */
    public void stopBackgroundService() {
        Intent serviceIntent = new Intent(this, BackgroundService.class);
        stopService(serviceIntent);
    }
}
