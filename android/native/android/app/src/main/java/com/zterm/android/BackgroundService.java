package com.zterm.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;

/**
 * BackgroundService - 前台服务通知面
 * 后台状态不得持有 WakeLock；连接保活归客户端 transport owner 管。
 */
public class BackgroundService extends Service {
    private static final String CHANNEL_ID = "wterm_background";
    private static final int NOTIFICATION_ID = 1;

    private int sessionCount = 0;

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
        
        Notification notification = createNotification();
        startForeground(NOTIFICATION_ID, notification);
        
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
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
