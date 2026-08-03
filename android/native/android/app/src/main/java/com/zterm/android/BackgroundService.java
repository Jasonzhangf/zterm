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
import androidx.core.app.NotificationCompat;

/**
 * BackgroundService - Android persistent-background execution surface.
 * It keeps the process schedulable only; connection/session truth remains in
 * the client transport runtime.
 */
public class BackgroundService extends Service {
    private static final String CHANNEL_ID = "wterm_background";
    private static final int NOTIFICATION_ID = 1;
    private static final long BACKGROUND_HANDOFF_WAKE_LOCK_MS = 5 * 60 * 1000;

    private int sessionCount = 0;
    private final Handler backgroundHandoffHandler = new Handler(Looper.getMainLooper());
    private final Runnable backgroundHandoffTimeoutRunnable = new Runnable() {
        @Override
        public void run() {
            releaseWakeLock();
            stopForeground(true);
            stopSelf();
        }
    };
    private PowerManager.WakeLock wakeLock;

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
        scheduleBackgroundHandoffTimeout();
        
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
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
        wakeLock.acquire(BACKGROUND_HANDOFF_WAKE_LOCK_MS);
    }

    private void scheduleBackgroundHandoffTimeout() {
        backgroundHandoffHandler.removeCallbacks(backgroundHandoffTimeoutRunnable);
        backgroundHandoffHandler.postDelayed(
            backgroundHandoffTimeoutRunnable,
            BACKGROUND_HANDOFF_WAKE_LOCK_MS
        );
    }

    private void releaseWakeLock() {
        backgroundHandoffHandler.removeCallbacks(backgroundHandoffTimeoutRunnable);
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
