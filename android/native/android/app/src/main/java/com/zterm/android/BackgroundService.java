package com.zterm.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.webkit.WebView;
import androidx.core.app.NotificationCompat;

/**
 * BackgroundService - Android persistent-background execution surface.
 * It keeps the process schedulable only; connection/session truth remains in
 * the client transport runtime.
 *
 * Background JS timers freeze when the WebView is not visible, which stops the
 * 30s mux-ping heartbeat and lets the physical connection die. This service
 * therefore wakes the WebView on a timer (BACKGROUND_HEARTBEAT_INTERVAL_MS)
 * via evaluateJavascript so the JS heartbeat callback keeps firing while the
 * app is in background.
 */
public class BackgroundService extends Service {
    private static final String CHANNEL_ID = "wterm_background";
    private static final int NOTIFICATION_ID = 1;
    /** Must match BACKGROUND_HEARTBEAT_INTERVAL_MS in BackgroundServicePlugin.ts. */
    private static final long BACKGROUND_HEARTBEAT_INTERVAL_MS = 30_000L;

    private int sessionCount = 0;
    private PowerManager.WakeLock wakeLock;
    private final Handler heartbeatHandler = new Handler(Looper.getMainLooper());
    private boolean heartbeatScheduled = false;

    private final Runnable heartbeatWakeRunnable = new Runnable() {
        @Override
        public void run() {
            heartbeatScheduled = false;
            final WebView webView = MainActivity.getStaticWebView();
            if (webView != null) {
                webView.post(new Runnable() {
                    @Override
                    public void run() {
                        webView.evaluateJavascript(
                            "if(window.ztermBackgroundHeartbeatTick) { window.ztermBackgroundHeartbeatTick(); }",
                            null
                        );
                    }
                });
            }
            scheduleHeartbeatWake();
        }
    };

    private void scheduleHeartbeatWake() {
        if (heartbeatScheduled) {
            return;
        }
        heartbeatScheduled = true;
        heartbeatHandler.postDelayed(heartbeatWakeRunnable, BACKGROUND_HEARTBEAT_INTERVAL_MS);
    }

    private void cancelHeartbeatWake() {
        heartbeatScheduled = false;
        heartbeatHandler.removeCallbacks(heartbeatWakeRunnable);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && intent.hasExtra("sessionCount")) {
            sessionCount = intent.getIntExtra("sessionCount", 0);
        }

        if (sessionCount <= 0) {
            releaseWakeLock();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        
        Notification notification = createNotification();
        startForeground(NOTIFICATION_ID, notification);
        acquireWakeLock();
        scheduleHeartbeatWake();

        return START_REDELIVER_INTENT;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        cancelHeartbeatWake();
        releaseWakeLock();
        super.onDestroy();
    }

    private void acquireWakeLock() {
        if (wakeLock == null) {
            PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (powerManager == null) {
                throw new IllegalStateException("power manager unavailable");
            }
            wakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                getPackageName() + ":terminal-background"
            );
            wakeLock.setReferenceCounted(false);
        }
        if (!wakeLock.isHeld()) {
            wakeLock.acquire();
        }
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        wakeLock = null;
    }

    /**
     * 创建通知渠道（Android 8.0+）
     */
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "zterm 后台服务",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("保持终端连接在后台运行");
            channel.setShowBadge(false);
            
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    /**
     * 创建通知
     */
    private Notification createNotification() {
        String contentText = sessionCount > 0 
            ? "已连接 " + sessionCount + " 个会话"
            : "后台运行中";

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("zterm")
            .setContentText(contentText)
            .setSmallIcon(android.R.drawable.ic_menu_manage)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .build();
    }

    /**
     * 更新 Session 数量
     */
    public void updateSessionCount(int count) {
        sessionCount = count;
        Notification notification = createNotification();
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, notification);
        }
    }
}
