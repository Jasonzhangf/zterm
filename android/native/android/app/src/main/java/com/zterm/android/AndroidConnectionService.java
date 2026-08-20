package com.zterm.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Binder;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * AndroidConnectionService - native Android foreground service that owns the
 * Android client physical connection lifecycle.
 *
 * The service owns, per daemon target:
 *   - bind/release target (typed command)
 *   - desired route policy (typed command)
 *   - WebSocket URL and auth query construction
 *   - WebSocket open, frame send, close
 *   - mux handshake (mux-hello / mux-ready)
 *   - target-level heartbeat (mux-ping / mux-pong and activity)
 *   - generation retire/reject
 *   - reconnect/backoff timer
 *
 * The service does NOT own:
 *   - Activity/WebView lifecycle
 *   - terminal channel business payload
 *   - buffer/render/input/file/remote-window semantics
 *   - WebRTC native signaling (explicit webrtc-not-supported error)
 *
 * UI/React consumes snapshots and typed server-frame/channel events. The only
 * UI command that may change route behavior is
 * {@link AndroidConnectionCommand.Type#SET_ROUTE_POLICY}.
 */
public class AndroidConnectionService extends Service {
    private static final String TAG = "ZTermConnSvc";
    private static final String CHANNEL_ID = "zterm_android_connection";
    private static final int NOTIFICATION_ID = 0x7ACA;

    static final String ACTION_COMMAND = "com.zterm.android.CONNECTION_COMMAND";
    static final String ACTION_BIND = "com.zterm.android.CONNECTION_BIND";
    static final String ACTION_RELEASE = "com.zterm.android.CONNECTION_RELEASE";
    static final String ACTION_ROUTE_POLICY = "com.zterm.android.CONNECTION_ROUTE_POLICY";
    static final String ACTION_STOP = "com.zterm.android.CONNECTION_STOP";

    static final String EXTRA_TARGET = "target";
    static final String EXTRA_ROUTE_POLICY = "routePolicy";
    static final String EXTRA_REASON = "reason";

    private static final long HEARTBEAT_INTERVAL_MS = 30_000L;
    private static final int HEARTBEAT_MISSES_BEFORE_RECONNECT = 3;
    private static final long INITIAL_BACKOFF_MS = 1_000L;
    private static final long MAX_BACKOFF_MS = 30_000L;
    private static final int MUX_PROTOCOL_VERSION = 1;
    private static final int MAX_NOTIFICATION_SESSION_ACTIONS = 3;
    private static final int NOTIFICATION_PULSE_UPDATES = 6;
    private static final long NOTIFICATION_PULSE_INTERVAL_MS = 350L;

    private static final Object LISTENER_LOCK = new Object();
    private static final List<AndroidConnectionServiceListener> STATIC_LISTENERS = new ArrayList<>();
    private static final Map<String, AndroidConnectionServiceSnapshot> LAST_SNAPSHOTS =
        new ConcurrentHashMap<>();

    private Handler workerHandler;
    private HandlerThread workerThread;
    private NotificationManager notificationManager;
    private PowerManager.WakeLock wakeLock;
    private PowerManager powerManager;
    private android.net.ConnectivityManager connectivityManager;
    private android.net.ConnectivityManager.NetworkCallback networkCallback;
    private android.net.Network activeDefaultNetwork;
    private long networkGeneration;
    private OkHttpClient httpClient;
    private final Map<String, TargetRuntime> targets = new ConcurrentHashMap<>();
    private final Map<String, String> policyByTargetKey = new ConcurrentHashMap<>();
    private final Map<String, Integer> notificationPulseUpdateCounts = new ConcurrentHashMap<>();
    private final Map<String, Long> notificationPulseGenerations = new ConcurrentHashMap<>();
    private String clientInstanceId;

    @Override
    public void onCreate() {
        super.onCreate();
        workerThread = new HandlerThread("zterm-conn-svc-worker");
        workerThread.start();
        workerHandler = new Handler(workerThread.getLooper());
        powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
        connectivityManager = (android.net.ConnectivityManager)
            getSystemService(Context.CONNECTIVITY_SERVICE);
        notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        registerNetworkCallback();
        ensureNotificationChannel();
        httpClient = new OkHttpClient.Builder()
            .connectTimeout(12, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(0, TimeUnit.MILLISECONDS)
            .build();
        clientInstanceId = "android-service-" + UUID.randomUUID();
        publishServiceIdle();
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        startForeground(NOTIFICATION_ID, createNotification());
        if (intent == null || intent.getAction() == null) {
            return START_REDELIVER_INTENT;
        }
        switch (intent.getAction()) {
            case ACTION_COMMAND:
            case ACTION_BIND:
            case ACTION_ROUTE_POLICY:
            case ACTION_RELEASE:
                handleCommandIntent(intent);
                break;
            case ACTION_STOP:
                stopForeground(true);
                releaseWakeLock();
                stopSelf();
                break;
            default:
                Log.w(TAG, "ignored unknown action=" + intent.getAction());
        }
        return START_REDELIVER_INTENT;
    }

    @Override
    public void onDestroy() {
        for (TargetRuntime runtime : targets.values()) {
            runtime.close("service-destroy");
        }
        targets.clear();
        unregisterNetworkCallback();
        publishServiceIdle();
        releaseWakeLock();
        if (workerThread != null) {
            Looper looper = workerThread.getLooper();
            if (looper != null) {
                looper.quitSafely();
            }
        }
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return new LocalBinder();
    }

    /**
     * Binding is only the UI observer lifetime. The started service and its
     * retained targets outlive this binder and are released only by an
     * explicit release-target command.
     */
    public final class LocalBinder extends Binder {
        public AndroidConnectionService getService() {
            return AndroidConnectionService.this;
        }
    }

    /** Typed entry used by the Capacitor plugin and tests. */
    public boolean applyCommand(AndroidConnectionCommand command) {
        if (command == null) {
            return false;
        }
        postToWorker(() -> dispatch(command));
        return true;
    }

    private void handleCommandIntent(Intent intent) {
        String action = intent.getAction();
        try {
            switch (action == null ? "" : action) {
                case ACTION_BIND: {
                    String targetJson = intent.getStringExtra(EXTRA_TARGET);
                    if (targetJson == null) {
                        publishEvent(AndroidConnectionServiceEventEnvelope.physicalError(
                            "invalid-command", "bind with no target extra"));
                        return;
                    }
                    AndroidConnectionServiceTarget target =
                        AndroidConnectionServiceTarget.fromJson(new JSONObject(targetJson));
                    postToWorker(() -> dispatch(AndroidConnectionCommand.bindTarget(target)));
                    break;
                }
                case ACTION_ROUTE_POLICY: {
                    String policyJson = intent.getStringExtra(EXTRA_ROUTE_POLICY);
                    if (policyJson == null) {
                        publishEvent(AndroidConnectionServiceEventEnvelope.physicalError(
                            "invalid-command", "route policy with no extra"));
                        return;
                    }
                    AndroidConnectionServiceRoutePolicy policy =
                        AndroidConnectionServiceRoutePolicy.fromJson(new JSONObject(policyJson));
                    postToWorker(() -> dispatch(AndroidConnectionCommand.setRoutePolicy(policy)));
                    break;
                }
                case ACTION_RELEASE: {
                    String targetKey = intent.getStringExtra("targetKey");
                    String reason = intent.getStringExtra(EXTRA_REASON);
                    if (targetKey == null || targetKey.trim().isEmpty()) {
                        publishEvent(AndroidConnectionServiceEventEnvelope.physicalError(
                            "invalid-command", "release with no target key"));
                        return;
                    }
                    if (reason == null || reason.trim().isEmpty()) reason = "unspecified";
                    String releaseTargetKey = targetKey.trim();
                    String releaseReason = reason;
                    postToWorker(() -> dispatch(
                        AndroidConnectionCommand.releaseTarget(releaseTargetKey, releaseReason)));
                    break;
                }
                case ACTION_COMMAND: {
                    String body = intent.getStringExtra("command");
                    if (body == null) {
                        publishEvent(AndroidConnectionServiceEventEnvelope.physicalError(
                            "invalid-command", "command intent missing body"));
                        return;
                    }
                    AndroidConnectionCommand command = AndroidConnectionCommand.fromJson(new JSONObject(body));
                    postToWorker(() -> dispatch(command));
                    break;
                }
                default:
                    Log.w(TAG, "handleCommandIntent unknown action=" + action);
            }
        } catch (JSONException | IllegalArgumentException error) {
            publishEvent(AndroidConnectionServiceEventEnvelope.physicalError(
                "invalid-command", String.valueOf(error.getMessage())));
        }
    }

    private void postToWorker(Runnable runnable) {
        if (workerHandler == null) {
            return;
        }
        workerHandler.post(runnable);
    }

    private void registerNetworkCallback() {
        if (connectivityManager == null || networkCallback != null) {
            return;
        }
        networkCallback = new android.net.ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(android.net.Network network) {
                onDefaultNetworkAvailable(network);
            }

            @Override
            public void onLost(android.net.Network network) {
                onDefaultNetworkLost(network);
            }

            @Override
            public void onCapabilitiesChanged(
                android.net.Network network,
                android.net.NetworkCapabilities capabilities) {
                // Capability changes (validated, metered, bandwidth, VPN
                // metadata) do not replace the physical default network.
                // Rebuilding every target here caused healthy Relay sockets
                // to reconnect during ordinary capability updates.
            }
        };
        try {
            connectivityManager.registerDefaultNetworkCallback(networkCallback, workerHandler);
        } catch (RuntimeException error) {
            Log.w(TAG, "network callback registration rejected: " + error.getMessage());
            networkCallback = null;
        }
    }

    private void unregisterNetworkCallback() {
        if (connectivityManager == null || networkCallback == null) {
            return;
        }
        try {
            connectivityManager.unregisterNetworkCallback(networkCallback);
        } catch (RuntimeException error) {
            Log.w(TAG, "network callback unregister rejected: " + error.getMessage());
        }
        networkCallback = null;
        activeDefaultNetwork = null;
    }

    private void onDefaultNetworkAvailable(android.net.Network network) {
        postToWorker(() -> {
            if (Objects.equals(activeDefaultNetwork, network)) {
                return;
            }
            activeDefaultNetwork = network;
            networkGeneration += 1L;
            acquireWakeLock(10_000L);
            for (TargetRuntime runtime : targets.values()) {
                runtime.retireForNetworkChange("default-network-changed");
            }
        });
    }

    private void onDefaultNetworkLost(android.net.Network network) {
        postToWorker(() -> {
            if (!Objects.equals(activeDefaultNetwork, network)) {
                return;
            }
            activeDefaultNetwork = null;
            networkGeneration += 1L;
            acquireWakeLock(10_000L);
            for (TargetRuntime runtime : targets.values()) {
                runtime.retireForNetworkChange("default-network-lost");
            }
        });
    }

    private void dispatch(AndroidConnectionCommand command) {
        try {
            switch (command.type) {
                case SET_ROUTE_POLICY:
                    applyRoutePolicy(command.policy);
                    break;
                case BIND_TARGET:
                    bindTarget(command.target);
                    break;
                case RELEASE_TARGET:
                    releaseTarget(command.targetKey, command.reason);
                    break;
                case OPEN_CHANNEL:
                    handleOpenChannel(command);
                    break;
                case CHANNEL_MESSAGE:
                    handleChannelMessageCommand(command);
                    break;
                case CHANNEL_BINARY:
                    handleChannelBinaryCommand(command);
                    break;
                case CLOSE_CHANNEL:
                    handleCloseChannel(command);
                    break;
                case PULSE_SESSION_NOTIFICATION:
                    handlePulseSessionNotification(command);
                    break;
                case TARGET_MESSAGE:
                    handleTargetMessageCommand(command);
                    break;
                default:
                    rejectCommand(command, "invalid-command", "unsupported command type");
            }
        } catch (RuntimeException error) {
            rejectCommand(command, "invalid-command", String.valueOf(error.getMessage()));
        }
    }

    private void applyRoutePolicy(AndroidConnectionServiceRoutePolicy policy) {
        if (policy == null) {
            return;
        }
        String policyKey = policyKey(policy);
        boolean anyChanged = false;
        for (TargetRuntime runtime : targets.values()) {
            String current = policyByTargetKey.get(runtime.target.targetKey);
            if (Objects.equals(current, policyKey)) {
                continue;
            }
            policyByTargetKey.put(runtime.target.targetKey, policyKey);
            runtime.setRoutePolicy(policy);
            anyChanged = true;
        }
        if (!anyChanged) {
            if (stateMachineForTests() != null) {
                stateMachineForTests().dispatch(
                    AndroidConnectionServiceEvent.setRoutePolicy(policy), System.currentTimeMillis());
            }
        }
    }

    private void bindTarget(AndroidConnectionServiceTarget target) {
        if (target == null) {
            return;
        }
        TargetRuntime existing = targets.get(target.targetKey);
        if (existing != null && existing.target.equals(target)) {
            existing.startOrContinue();
            refreshNotification();
            return;
        }
        if (existing != null) {
            existing.close("target-rebind");
            targets.remove(target.targetKey);
        }
        String policyKey = policyByTargetKey.get(target.targetKey);
        AndroidConnectionServiceRoutePolicy policy = parsePolicyKey(policyKey);
        TargetRuntime runtime = new TargetRuntime(target, policy);
        targets.put(target.targetKey, runtime);
        runtime.startOrContinue();
        refreshNotification();
    }

    private AndroidConnectionStateMachine stateMachineForTests() {
        for (TargetRuntime runtime : targets.values()) {
            if (runtime.stateMachine != null) {
                return runtime.stateMachine;
            }
        }
        return null;
    }

    private void releaseTarget(String targetKey, String reason) {
        TargetRuntime runtime = targetRuntime(targetKey);
        if (runtime == null) {
            publishEvent(AndroidConnectionServiceEventEnvelope.physicalError(
                "unknown-target", "release-target target is not bound"));
            return;
        }
        runtime.close(reason);
        cancelSessionNotificationPulses(targetKey);
        targets.remove(targetKey);
        policyByTargetKey.remove(targetKey);
        LAST_SNAPSHOTS.remove(targetKey);
        if (targets.isEmpty()) {
            releaseWakeLock();
            publishServiceIdle();
            stopForeground(true);
            stopSelf();
            return;
        }
        for (TargetRuntime candidate : targets.values()) {
            publishSnapshot(candidate.snapshot());
        }
        refreshNotification();
    }

    private void rejectCommand(AndroidConnectionCommand command, String code, String message) {
        publishEvent(AndroidConnectionServiceEventEnvelope.commandRejected(command, code, message));
    }

    private void handleOpenChannel(AndroidConnectionCommand command) {
        TargetRuntime runtime = targetRuntime(command.targetKey);
        if (runtime == null) {
            rejectCommand(command, "unknown-target", "open-channel target is not bound");
            return;
        }
        runtime.sendChannelOpen(command);
        refreshNotification();
    }

    private void handleChannelMessageCommand(AndroidConnectionCommand command) {
        TargetRuntime runtime = targetRuntime(command.targetKey);
        if (runtime == null) {
            rejectCommand(command, "unknown-target", "channel command requires a bound target");
            return;
        }
        runtime.sendChannelMessage(command.channelId, command.channelMessage);
    }

    private void handleChannelBinaryCommand(AndroidConnectionCommand command) {
        TargetRuntime runtime = targetRuntime(command.targetKey);
        if (runtime == null) {
            rejectCommand(command, "unknown-target", "channel command requires a bound target");
            return;
        }
        runtime.sendChannelBinary(command.channelId, command.channelDataBase64);
    }

    private void handleCloseChannel(AndroidConnectionCommand command) {
        TargetRuntime runtime = targetRuntime(command.targetKey);
        if (runtime == null) {
            rejectCommand(command, "unknown-target", "close-channel requires a bound target");
            return;
        }
        runtime.sendCloseChannel(command);
        cancelSessionNotificationPulse(command.targetKey, command.channelId);
        refreshNotification();
    }

    private void handlePulseSessionNotification(AndroidConnectionCommand command) {
        TargetRuntime runtime = targetRuntime(command.targetKey);
        if (runtime == null || !runtime.hasNotificationChannel(command.channelId)) {
            rejectCommand(command, "unknown-channel",
                "pulse-session-notification requires a connected projected channel");
            return;
        }
        pulseSessionNotification(command.targetKey, command.channelId);
    }

    private void handleTargetMessageCommand(AndroidConnectionCommand command) {
        TargetRuntime runtime = targetRuntime(command.targetKey);
        if (runtime == null) {
            rejectCommand(command, "unknown-target", "target-message requires a bound target");
            return;
        }
        if (command.targetMessage == null) {
            rejectCommand(command, "invalid-command", "target-message payload is missing");
            return;
        }
        runtime.sendTargetMessage(command.requestId, command.targetMessage);
    }

    private TargetRuntime targetRuntime(String targetKey) {
        if (targetKey == null || targetKey.trim().isEmpty()) {
            return null;
        }
        return targets.get(targetKey.trim());
    }

    private static JSONObject buildBinaryFrame(String channelId, String channelDataBase64) {
        JSONObject frame = new JSONObject();
        try {
            frame.put("type", "mux-channel-binary");
            JSONObject payload = new JSONObject();
            payload.put("channelId", channelId);
            payload.put("dataBase64", channelDataBase64);
            frame.put("payload", payload);
        } catch (JSONException error) {
            throw new IllegalArgumentException("channel binary serialization failed", error);
        }
        return frame;
    }

    private static String policyKey(AndroidConnectionServiceRoutePolicy policy) {
        if (policy.mode == AndroidConnectionServiceRoutePolicy.Mode.MANUAL) {
            return "manual:" + policy.path.wireName();
        }
        return "auto";
    }

    private static AndroidConnectionServiceRoutePolicy parsePolicyKey(String key) {
        if (key == null || key.equals("auto")) {
            return AndroidConnectionServiceRoutePolicy.auto();
        }
        if (key.startsWith("manual:")) {
            return AndroidConnectionServiceRoutePolicy.manual(
                AndroidConnectionServiceRoutePolicy.Path.fromWireName(key.substring("manual:".length())));
        }
        return AndroidConnectionServiceRoutePolicy.auto();
    }

    private void publishSnapshot(AndroidConnectionServiceSnapshot snapshot) {
        if (snapshot.target != null && snapshot.target.targetKey != null) {
            LAST_SNAPSHOTS.put(snapshot.target.targetKey, snapshot);
        }
        publishEvent(AndroidConnectionServiceEventEnvelope.stateChanged(snapshot));
    }

    private void publishServiceIdle() {
        LAST_SNAPSHOTS.clear();
        notificationPulseUpdateCounts.clear();
        notificationPulseGenerations.clear();
        publishEvent(AndroidConnectionServiceEventEnvelope.stateChanged(
            AndroidConnectionServiceSnapshot.empty()));
    }

    private void publishEvent(AndroidConnectionServiceEventEnvelope event) {
        List<AndroidConnectionServiceListener> listeners;
        synchronized (LISTENER_LOCK) {
            listeners = new ArrayList<>(STATIC_LISTENERS);
        }
        for (AndroidConnectionServiceListener listener : listeners) {
            try {
                listener.onEvent(event);
            } catch (RuntimeException error) {
                Log.w(TAG, "listener event rejected: " + error.getMessage());
            }
        }
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "zterm 连接服务", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("保持终端连接在系统后台运行");
            channel.setShowBadge(false);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private Notification createNotification() {
        List<NotificationSessionAction> sessions = new ArrayList<>();
        for (TargetRuntime runtime : targets.values()) {
            if (!runtime.isMuxReady()) {
                continue;
            }
            for (TargetRuntime.ChannelIntent channel : runtime.desiredChannels.values()) {
                if (channel.opened && nonEmpty(channel.sessionName)) {
                    sessions.add(new NotificationSessionAction(
                        runtime.target.targetKey, channel.channelId, channel.sessionName));
                }
            }
        }
        sessions.sort((left, right) -> {
            boolean leftPulsing = notificationPulseUpdateCounts.containsKey(
                notificationPulseKey(left.targetKey, left.channelId));
            boolean rightPulsing = notificationPulseUpdateCounts.containsKey(
                notificationPulseKey(right.targetKey, right.channelId));
            if (leftPulsing != rightPulsing) {
                return leftPulsing ? -1 : 1;
            }
            int targetComparison = left.targetKey.compareTo(right.targetKey);
            return targetComparison != 0
                ? targetComparison
                : left.channelId.compareTo(right.channelId);
        });

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("zterm")
            .setContentText(sessions.isEmpty()
                ? "连接服务运行中"
                : sessions.size() + " 个会话已连接")
            .setSmallIcon(com.zterm.android.R.drawable.ic_notification_logo)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(buildAppPendingIntent())
            .setOngoing(true);

        int actionCount = Math.min(MAX_NOTIFICATION_SESSION_ACTIONS, sessions.size());
        for (int index = 0; index < actionCount; index += 1) {
            NotificationSessionAction session = sessions.get(index);
            String pulseKey = notificationPulseKey(session.targetKey, session.channelId);
            Integer pulseCount = notificationPulseUpdateCounts.get(pulseKey);
            boolean pulseOn = pulseCount != null && pulseCount % 2 == 0;
            String title = pulseOn ? "● " + session.sessionName : session.sessionName;
            builder.addAction(new NotificationCompat.Action.Builder(
                com.zterm.android.R.drawable.ic_notification_logo,
                title,
                buildSessionPendingIntent(session))
                .build());
        }
        return builder.build();
    }

    private PendingIntent buildAppPendingIntent() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(this, NOTIFICATION_ID, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private PendingIntent buildSessionPendingIntent(NotificationSessionAction session) {
        Uri uri = Uri.parse("zterm://session/open?targetKey=" + Uri.encode(session.targetKey)
            + "&channelId=" + Uri.encode(session.channelId)
            + "&sessionName=" + Uri.encode(session.sessionName));
        Intent intent = new Intent(this, MainActivity.class);
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(uri);
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int requestCode = (session.targetKey + "\n" + session.channelId).hashCode();
        return PendingIntent.getActivity(this, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void refreshNotification() {
        if (notificationManager != null) {
            notificationManager.notify(NOTIFICATION_ID, createNotification());
        }
    }

    private void pulseSessionNotification(String targetKey, String channelId) {
        String pulseKey = notificationPulseKey(targetKey, channelId);
        long pulseGeneration = notificationPulseGenerations.getOrDefault(pulseKey, 0L) + 1L;
        notificationPulseGenerations.put(pulseKey, pulseGeneration);
        notificationPulseUpdateCounts.put(pulseKey, 0);
        refreshNotification();
        scheduleNotificationPulseStep(targetKey, channelId, pulseKey, pulseGeneration);
    }

    private void scheduleNotificationPulseStep(
        String targetKey,
        String channelId,
        String pulseKey,
        long pulseGeneration) {
        if (workerHandler == null) {
            return;
        }
        workerHandler.postDelayed(() -> {
            if (notificationPulseGenerations.getOrDefault(pulseKey, 0L) != pulseGeneration) {
                return;
            }
            TargetRuntime runtime = targetRuntime(targetKey);
            if (runtime == null || !runtime.hasNotificationChannel(channelId)) {
                notificationPulseUpdateCounts.remove(pulseKey);
                notificationPulseGenerations.remove(pulseKey);
                refreshNotification();
                return;
            }
            int updateCount = notificationPulseUpdateCounts.getOrDefault(pulseKey, 0) + 1;
            if (updateCount >= NOTIFICATION_PULSE_UPDATES) {
                notificationPulseUpdateCounts.remove(pulseKey);
                notificationPulseGenerations.remove(pulseKey);
                refreshNotification();
                return;
            }
            notificationPulseUpdateCounts.put(pulseKey, updateCount);
            refreshNotification();
            scheduleNotificationPulseStep(targetKey, channelId, pulseKey, pulseGeneration);
        }, NOTIFICATION_PULSE_INTERVAL_MS);
    }

    private void cancelSessionNotificationPulse(String targetKey, String channelId) {
        String pulseKey = notificationPulseKey(targetKey, channelId);
        notificationPulseUpdateCounts.remove(pulseKey);
        notificationPulseGenerations.remove(pulseKey);
    }

    private void cancelSessionNotificationPulses(String targetKey) {
        String prefix = targetKey + "\n";
        notificationPulseUpdateCounts.keySet().removeIf(key -> key.startsWith(prefix));
        notificationPulseGenerations.keySet().removeIf(key -> key.startsWith(prefix));
    }

    private static String notificationPulseKey(String targetKey, String channelId) {
        return targetKey + "\n" + channelId;
    }

    private static final class NotificationSessionAction {
        final String targetKey;
        final String channelId;
        final String sessionName;

        NotificationSessionAction(String targetKey, String channelId, String sessionName) {
            this.targetKey = targetKey;
            this.channelId = channelId;
            this.sessionName = sessionName;
        }
    }

    private void acquireWakeLock(long timeoutMs) {
        if (powerManager == null || wakeLock != null && wakeLock.isHeld()) {
            return;
        }
        try {
            wakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                getPackageName() + ":android-connection");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(timeoutMs);
        } catch (RuntimeException error) {
            Log.w(TAG, "wake lock acquire rejected: " + error.getMessage());
            wakeLock = null;
        }
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            try {
                wakeLock.release();
            } catch (RuntimeException error) {
                Log.w(TAG, "wake lock release rejected: " + error.getMessage());
            }
        }
        wakeLock = null;
    }

    private final class TargetRuntime extends WebSocketListener {
        final AndroidConnectionServiceTarget target;
        volatile AndroidConnectionServiceRoutePolicy routePolicy;
        volatile AndroidConnectionStateMachine stateMachine;
        volatile WebSocket socket;
        volatile String generation;
        volatile int candidateIndex;
        volatile long nextRetryAt;
        volatile int backoffIndex;
        volatile int heartbeatMisses;
        volatile long lastActivityAt;
        volatile long lastPingAt;
        volatile long transportNetworkGeneration;
        volatile boolean stopped;
        final Map<String, ChannelIntent> desiredChannels = new LinkedHashMap<>();

        TargetRuntime(AndroidConnectionServiceTarget target, AndroidConnectionServiceRoutePolicy routePolicy) {
            this.target = target;
            this.routePolicy = routePolicy == null ? AndroidConnectionServiceRoutePolicy.auto() : routePolicy;
        }

        void startOrContinue() {
            if (stopped) {
                return;
            }
            if (stateMachine != null && isConnectedState(stateMachine.readSnapshot().state)) {
                return;
            }
            if (stateMachine != null && stateMachine.readSnapshot().state
                == AndroidConnectionServiceSnapshot.State.BACKOFF_RECONNECT) {
                scheduleBackoff();
                return;
            }
            startAttempt();
        }

        void setRoutePolicy(AndroidConnectionServiceRoutePolicy policy) {
            routePolicy = policy;
            if (stopped) {
                return;
            }
            closeCurrent("route-policy");
            resetAttemptState();
            startAttempt();
        }

        void startAttempt() {
            if (stopped) {
                return;
            }
            ensureStateMachine();
            if (routePolicy.mode == AndroidConnectionServiceRoutePolicy.Mode.MANUAL
                && (routePolicy.path == AndroidConnectionServiceRoutePolicy.Path.RTC_DIRECT
                    || routePolicy.path == AndroidConnectionServiceRoutePolicy.Path.RTC_RELAY)) {
                terminalFailure("webrtc-not-supported",
                    "WebRTC route requires a separate native WebRTC owner slice");
                return;
            }
            String nextGeneration = "gen-" + UUID.randomUUID();
            if (!stateMachine.dispatch(AndroidConnectionServiceEvent.transportOpening(nextGeneration),
                System.currentTimeMillis())) {
                return;
            }
            generation = nextGeneration;
            transportNetworkGeneration = networkGeneration;
            candidateIndex = 0;
            heartbeatMisses = 0;
            lastActivityAt = System.currentTimeMillis();
            lastPingAt = 0L;
            openCandidate();
        }

        private void ensureStateMachine() {
            if (stateMachine != null) {
                return;
            }
            stateMachine = new AndroidConnectionStateMachine(snapshot -> publishSnapshot(snapshot));
            stateMachine.dispatch(AndroidConnectionServiceEvent.bindTarget(target),
                System.currentTimeMillis());
            stateMachine.dispatch(AndroidConnectionServiceEvent.setRoutePolicy(routePolicy),
                System.currentTimeMillis());
        }

        private void openCandidate() {
            if (stopped || generation == null) {
                return;
            }
            RouteCandidate candidate = nextCandidate();
            if (candidate == null) {
                scheduleBackoff();
                return;
            }
            Request request = new Request.Builder().url(candidate.url).build();
            try {
                socket = httpClient.newWebSocket(request, this);
                Log.i(TAG, "opening " + candidate.path + " for " + target.targetKey);
            } catch (RuntimeException error) {
                transportFailure("websocket-open-rejected", String.valueOf(error.getMessage()));
            }
        }

        private RouteCandidate nextCandidate() {
            List<RouteCandidate> candidates = buildCandidates();
            if (candidates.isEmpty()) {
                return null;
            }
            if (candidateIndex >= candidates.size()) {
                candidateIndex = 0;
            }
            int index = candidateIndex % candidates.size();
            candidateIndex += 1;
            return candidates.get(index);
        }

        private List<RouteCandidate> buildCandidates() {
            List<RouteCandidate> candidates = new ArrayList<>();
            if (routePolicy.mode == AndroidConnectionServiceRoutePolicy.Mode.MANUAL) {
                addCandidate(candidates, routePolicy.path);
                return candidates;
            }
            addCandidate(candidates, AndroidConnectionServiceRoutePolicy.Path.TAILSCALE);
            addCandidate(candidates, AndroidConnectionServiceRoutePolicy.Path.IPV6);
            addCandidate(candidates, AndroidConnectionServiceRoutePolicy.Path.IPV4);
            return candidates;
        }

        private void addCandidate(List<RouteCandidate> candidates,
                                  AndroidConnectionServiceRoutePolicy.Path path) {
            String host = hostFor(path);
            if (host == null || host.trim().isEmpty()) {
                return;
            }
            String url = buildWebSocketUrl(host, target.bridgePort, target.authToken);
            if (url != null) {
                candidates.add(new RouteCandidate(path.wireName(), url));
            }
        }

        private String hostFor(AndroidConnectionServiceRoutePolicy.Path path) {
            switch (path) {
                case TAILSCALE:
                    if (nonEmpty(target.tailscaleHost)) return target.tailscaleHost;
                    if (isLikelyTailscale(target.bridgeHost)) return target.bridgeHost;
                    return null;
                case IPV6:
                    if (nonEmpty(target.ipv6Host)) return target.ipv6Host;
                    if (isLikelyIpv6(target.bridgeHost)) return target.bridgeHost;
                    return null;
                case IPV4:
                    if (nonEmpty(target.ipv4Host)) return target.ipv4Host;
                    if (!isLikelyTailscale(target.bridgeHost) && !isLikelyIpv6(target.bridgeHost)) {
                        return target.bridgeHost;
                    }
                    return null;
                default:
                    return null;
            }
        }

        private String buildWebSocketUrl(String host, int port, String authToken) {
            String scheme = host.toLowerCase(Locale.ROOT).startsWith("https://") ? "wss"
                : host.toLowerCase(Locale.ROOT).startsWith("http://") ? "ws" : "ws";
            String hostPart = host;
            if (!hostPart.contains("://")) {
                if (isLikelyIpv6(hostPart) && !hostPart.startsWith("[")) {
                    hostPart = "[" + hostPart + "]";
                }
                hostPart = scheme + "://" + hostPart + ":" + port;
            }
            try {
                URI uri = new URI(hostPart);
                String query = uri.getRawQuery();
                String auth = authToken == null || authToken.trim().isEmpty() ? "" : authToken.trim();
                String separator = query == null || query.isEmpty() ? "" : "&";
                String encodedAuth = auth.isEmpty() ? "" : "token=" + encodeQuery(auth);
                String nextQuery = query == null ? "" : query;
                if (!encodedAuth.isEmpty()) {
                    nextQuery = nextQuery + separator + encodedAuth;
                }
                return new URI(uri.getScheme(), uri.getUserInfo(), uri.getHost(), uri.getPort(),
                    uri.getPath(), nextQuery, uri.getFragment()).toString();
            } catch (URISyntaxException error) {
                transportFailure("invalid-websocket-url", String.valueOf(error.getMessage()));
                return null;
            }
        }

        private String encodeQuery(String value) {
            StringBuilder out = new StringBuilder();
            for (byte b : value.getBytes(java.nio.charset.StandardCharsets.UTF_8)) {
                int c = b & 0xff;
                if (c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9'
                    || c == '-' || c == '_' || c == '.' || c == '~') {
                    out.append((char) c);
                } else {
                    out.append(String.format(Locale.ROOT, "%%%02X", c));
                }
            }
            return out.toString();
        }

        @Override
        public void onOpen(WebSocket webSocket, Response response) {
            if (stopped || socket != webSocket || generation == null
                || transportNetworkGeneration != networkGeneration) {
                closeQuietly(webSocket);
                return;
            }
            sendMuxHello();
            scheduleHeartbeat();
            scheduleBackoffReset();
        }

        @Override
        public void onMessage(WebSocket webSocket, String text) {
            if (stopped || socket != webSocket || generation == null
                || transportNetworkGeneration != networkGeneration) {
                return;
            }
            try {
                handleServerText(text);
            } catch (JSONException | IllegalArgumentException error) {
                transportFailure("invalid-mux-frame", String.valueOf(error.getMessage()));
            }
        }

        @Override
        public void onMessage(WebSocket webSocket, ByteString bytes) {
            if (stopped || socket != webSocket || generation == null
                || transportNetworkGeneration != networkGeneration) {
                return;
            }
            transportFailure("binary-server-frame-not-supported",
                "mux server frames must be JSON text");
        }

        @Override
        public void onFailure(WebSocket webSocket, Throwable throwable, @Nullable Response response) {
            if (stopped || socket != webSocket || transportNetworkGeneration != networkGeneration) {
                return;
            }
            String message = throwable == null ? "websocket failure" : String.valueOf(throwable.getMessage());
            // Auth failure from HTTP 401/403 response body
            if (response != null) {
                int code = response.code();
                if (code == 401 || code == 403) {
                    authFailure("auth-http-" + code, message);
                    return;
                }
            }
            transportFailure("websocket", message);
        }

        @Override
        public void onClosed(WebSocket webSocket, int code, String reason) {
            if (stopped || socket != webSocket || transportNetworkGeneration != networkGeneration) {
                return;
            }
            String reasonText = reason == null ? "closed" : reason;
            // Auth close codes: 4001=bridge token, 4003=auth, 4401=unauthorized, 4403=forbidden
            if (code == 4001 || code == 4003 || code == 4401 || code == 4403
                    || reasonText.toLowerCase(java.util.Locale.ROOT).matches(".*(unauthorized|forbidden|token.*invalid|auth.*fail).*")) {
                authFailure("auth-close-" + code, reasonText);
                return;
            }
            transportFailure("websocket-closed", reasonText);
        }

        private void sendMuxHello() {
            JSONObject payload = new JSONObject();
            try {
                payload.put("version", MUX_PROTOCOL_VERSION);
                payload.put("clientInstanceId", clientInstanceId);
            } catch (JSONException ignored) {
                // JSON primitive put cannot fail for these values.
            }
            JSONObject frame = new JSONObject();
            try {
                frame.put("type", "mux-hello");
                frame.put("payload", payload);
            } catch (JSONException error) {
                transportFailure("mux-hello", String.valueOf(error.getMessage()));
                return;
            }
            send(frame);
        }

        private void scheduleHeartbeat() {
            workerHandler.postDelayed(() -> {
                if (stopped || generation == null || socket == null) {
                    return;
                }
                heartbeatTick();
            }, HEARTBEAT_INTERVAL_MS);
        }

        void heartbeatTick() {
            long now = System.currentTimeMillis();
            if (lastPingAt != 0L && now - lastPingAt >= HEARTBEAT_INTERVAL_MS) {
                heartbeatMisses += 1;
                if (heartbeatMisses >= HEARTBEAT_MISSES_BEFORE_RECONNECT) {
                    transportFailure("heartbeat-timeout", "mux heartbeat budget exhausted");
                    return;
                }
            }
            lastPingAt = now;
            JSONObject payload = new JSONObject();
            try {
                payload.put("sentAt", now);
            } catch (JSONException ignored) {
            }
            JSONObject frame = new JSONObject();
            try {
                frame.put("type", "mux-ping");
                frame.put("payload", payload);
            } catch (JSONException error) {
                transportFailure("mux-ping", String.valueOf(error.getMessage()));
                return;
            }
            send(frame);
            scheduleHeartbeat();
        }

        private void handleServerText(String text) throws JSONException {
            JSONObject frame = new JSONObject(text);
            String type = frame.optString("type", "");
            JSONObject payload = frame.optJSONObject("payload");
            if (payload == null) {
                throw new IllegalArgumentException("mux frame payload missing");
            }
            recordServerActivity();
            switch (type) {
                case "mux-ready":
                    handleMuxReady(payload);
                    break;
                case "mux-pong":
                    heartbeatMisses = 0;
                    lastPingAt = 0L;
                    stateMachine.dispatch(AndroidConnectionServiceEvent.heartbeatPong(
                        generation, System.currentTimeMillis()), System.currentTimeMillis());
                    break;
                case "mux-channel-opened":
                    handleChannelOpened(payload);
                    break;
                case "mux-channel-message":
                    handleChannelMessage(payload);
                    break;
                case "mux-channel-closed":
                    handleChannelClosed(payload);
                    break;
                case "mux-target-message":
                    publishServerFrame(AndroidConnectionServiceServerFrameEvent.Kind.MUX_TARGET_MESSAGE, payload);
                    break;
                case "mux-error":
                    handleMuxError(payload);
                    break;
                default:
                    throw new IllegalArgumentException("unsupported mux server frame: " + type);
            }
        }

        private void handleMuxReady(JSONObject payload) throws JSONException {
            if (payload.optInt("version", -1) != MUX_PROTOCOL_VERSION) {
                transportFailure("mux-version", "unsupported mux protocol version");
                return;
            }
            JSONObject capabilities = payload.optJSONObject("capabilities");
            if (capabilities == null
                || capabilities.optBoolean("channelEnvelope", false) == false
                || capabilities.optBoolean("targetMessages", false) == false) {
                transportFailure("mux-capabilities", "mux capabilities missing");
                return;
            }
            stateMachine.dispatch(AndroidConnectionServiceEvent.muxReady(
                generation, payload.toString()),
                System.currentTimeMillis());
            publishServerFrame(AndroidConnectionServiceServerFrameEvent.Kind.MUX_READY, payload);
            replayDesiredChannels();
            refreshNotification();
        }

        private void handleChannelOpened(JSONObject payload) throws JSONException {
            String channelId = payload.optString("channelId", "");
            if (channelId.trim().isEmpty()) {
                throw new IllegalArgumentException("mux channel-opened channelId missing");
            }
            stateMachine.dispatch(AndroidConnectionServiceEvent.channelOpened(
                generation, channelId, System.currentTimeMillis()), System.currentTimeMillis());
            ChannelIntent channel = desiredChannels.get(channelId);
            if (channel != null) {
                channel.opened = true;
            }
            publishEvent(AndroidConnectionServiceEventEnvelope.channelOpened(
                target.targetKey, generation, channelId, stateMachine.readSnapshot()));
            refreshNotification();
        }

        private void handleChannelMessage(JSONObject payload) throws JSONException {
            String channelId = payload.optString("channelId", "");
            JSONObject message = payload.optJSONObject("message");
            if (channelId.trim().isEmpty() || message == null) {
                throw new IllegalArgumentException("mux channel-message envelope invalid");
            }
            publishEvent(AndroidConnectionServiceEventEnvelope.channelMessage(
                new AndroidConnectionServiceChannelMessageEvent.Builder()
                    .targetKey(target.targetKey)
                    .generation(generation)
                    .channelId(channelId)
                    .message(message)
                    .build()));
        }

        private void handleChannelClosed(JSONObject payload) throws JSONException {
            String channelId = payload.optString("channelId", "");
            if (channelId.trim().isEmpty()) {
                throw new IllegalArgumentException("mux channel-closed channelId missing");
            }
            stateMachine.dispatch(AndroidConnectionServiceEvent.channelClosed(
                generation, channelId, payload.optString("reason", "closed")),
                System.currentTimeMillis());
            ChannelIntent channel = desiredChannels.get(channelId);
            if (channel != null) {
                channel.opened = false;
            }
            cancelSessionNotificationPulse(target.targetKey, channelId);
            publishEvent(AndroidConnectionServiceEventEnvelope.channelClosed(
                target.targetKey, generation, channelId));
            refreshNotification();
        }

        private void handleMuxError(JSONObject payload) {
            String code = payload.optString("code", "mux-error");
            String message = payload.optString("message", "mux error");
            if ("mux_version_unsupported".equals(code)
                || "daemon_multiplex_upgrade_required".equals(code)) {
                transportFailure("mux-version", message);
                return;
            }
            // Auth mux errors do not retry
            if ("unauthorized".equals(code) || "forbidden".equals(code)
                    || "token_invalid".equals(code) || "auth_failure".equals(code)) {
                authFailure("mux-auth-" + code, message);
                return;
            }
            publishServerFrame(AndroidConnectionServiceServerFrameEvent.Kind.MUX_ERROR, payload);
        }

        private void recordServerActivity() {
            heartbeatMisses = 0;
            lastActivityAt = System.currentTimeMillis();
            stateMachine.dispatch(AndroidConnectionServiceEvent.serverActivity(
                generation, lastActivityAt), lastActivityAt);
        }

        private void send(JSONObject frame) {
            WebSocket current = socket;
            if (current == null || generation == null
                || transportNetworkGeneration != networkGeneration) {
                return;
            }
            try {
                boolean enqueued = current.send(frame.toString());
                if (!enqueued) {
                    transportFailure("websocket-send", "mux frame not enqueued");
                }
            } catch (RuntimeException error) {
                transportFailure("websocket-send", String.valueOf(error.getMessage()));
            }
        }

        void sendChannelOpen(AndroidConnectionCommand command) {
            desiredChannels.put(command.channelId,
                new ChannelIntent(command.channelId, command.sessionName, command.channelOptions));
            if (!isMuxReady()) {
                return;
            }
            sendChannelOpenFrame(command.channelId, command.sessionName, command.channelOptions);
        }

        private void sendChannelOpenFrame(String channelId, String sessionName, JSONObject options) {
            JSONObject frame = new JSONObject();
            try {
                frame.put("type", "mux-channel-open");
                JSONObject payload = new JSONObject();
                payload.put("channelId", channelId);
                payload.put("sessionName", sessionName);
                if (options != null) {
                    for (java.util.Iterator<String> keys = options.keys(); keys.hasNext(); ) {
                        String key = keys.next();
                        payload.put(key, options.get(key));
                    }
                }
                frame.put("payload", payload);
            } catch (JSONException error) {
                throw new IllegalArgumentException("channel-open serialization failed", error);
            }
            send(frame);
        }

        private boolean isMuxReady() {
            if (stateMachine == null) {
                return false;
            }
            AndroidConnectionServiceSnapshot.State state = stateMachine.readSnapshot().state;
            return state == AndroidConnectionServiceSnapshot.State.MUX_READY
                || state == AndroidConnectionServiceSnapshot.State.CHANNELS_READY
                || state == AndroidConnectionServiceSnapshot.State.HEALTHY;
        }

        private void replayDesiredChannels() {
            if (!isMuxReady()) {
                return;
            }
            for (ChannelIntent channel : desiredChannels.values()) {
                channel.opened = false;
                sendChannelOpenFrame(channel.channelId, channel.sessionName, channel.options);
            }
        }


        void sendChannelMessage(String channelId, JSONObject message) {
            if (message == null) {
                throw new IllegalArgumentException("channel message is required");
            }
            JSONObject frame = new JSONObject();
            try {
                frame.put("type", "mux-channel-message");
                JSONObject payload = new JSONObject();
                payload.put("channelId", channelId);
                payload.put("message", message);
                frame.put("payload", payload);
            } catch (JSONException error) {
                transportFailure("channel-message", String.valueOf(error.getMessage()));
                return;
            }
            send(frame);
        }

        void sendTargetMessage(String requestId, JSONObject message) {
            if (message == null) {
                throw new IllegalArgumentException("target message is required");
            }
            JSONObject frame = new JSONObject();
            try {
                frame.put("type", "mux-target-message");
                JSONObject payload = new JSONObject();
                if (requestId != null && !requestId.trim().isEmpty()) {
                    payload.put("requestId", requestId.trim());
                }
                payload.put("message", message);
                frame.put("payload", payload);
            } catch (JSONException error) {
                transportFailure("target-message", String.valueOf(error.getMessage()));
                return;
            }
            send(frame);
        }

        void sendChannelBinary(String channelId, String dataBase64) {
            if (dataBase64 == null || dataBase64.isEmpty()) {
                throw new IllegalArgumentException("channel binary data is required");
            }
            send(buildBinaryFrame(channelId, dataBase64));
        }
        void sendCloseChannel(AndroidConnectionCommand command) {
            desiredChannels.remove(command.channelId);
            if (!isMuxReady()) {
                return;
            }
            JSONObject frame = new JSONObject();
            try {
                frame.put("type", "mux-channel-close");
                JSONObject payload = new JSONObject();
                payload.put("channelId", command.channelId);
                payload.put("reason", command.reason);
                frame.put("payload", payload);
            } catch (JSONException error) {
                throw new IllegalArgumentException("channel-close serialization failed", error);
            }
            send(frame);
        }

        private void scheduleBackoff() {
            if (stopped) {
                return;
            }
            long delay = Math.min(INITIAL_BACKOFF_MS * (1L << Math.min(backoffIndex, 5)), MAX_BACKOFF_MS);
            backoffIndex += 1;
            nextRetryAt = System.currentTimeMillis() + delay;
            workerHandler.postDelayed(() -> {
                if (stopped) {
                    return;
                }
                AndroidConnectionServiceSnapshot current = stateMachine == null
                    ? AndroidConnectionServiceSnapshot.empty() : stateMachine.readSnapshot();
                if (current.state != AndroidConnectionServiceSnapshot.State.BACKOFF_RECONNECT) {
                    return;
                }
                stateMachine.dispatch(AndroidConnectionServiceEvent.backoffTimerFired(
                    System.currentTimeMillis()), System.currentTimeMillis());
                startAttempt();
            }, delay);
        }

        private void scheduleBackoffReset() {
            workerHandler.postDelayed(() -> backoffIndex = 0, HEARTBEAT_INTERVAL_MS);
        }

        private void transportFailure(String code, String message) {
            if (stopped || generation == null) {
                return;
            }
            closeQuietly(socket);
            socket = null;
            String failedGeneration = generation;
            generation = null;
            stateMachine.dispatch(AndroidConnectionServiceEvent.transportFailure(
                failedGeneration, message), System.currentTimeMillis());
            publishEvent(AndroidConnectionServiceEventEnvelope.physicalError(code, message));
            scheduleBackoff();
        }

        void retireForNetworkChange(String reason) {
            if (stopped) {
                return;
            }
            closeCurrent(reason);
            if (generation == null) {
                startOrContinue();
                return;
            }
            String failedGeneration = generation;
            generation = null;
            stateMachine.dispatch(AndroidConnectionServiceEvent.transportFailure(
                failedGeneration, reason), System.currentTimeMillis());
            scheduleBackoff();
        }

        private void terminalFailure(String code, String message) {
            if (stopped || generation == null) {
                return;
            }
            closeQuietly(socket);
            socket = null;
            String failedGeneration = generation;
            generation = null;
            if ("webrtc-not-supported".equals(code)) {
                stateMachine.dispatch(AndroidConnectionServiceEvent.webrtcNotSupported(
                    failedGeneration, message), System.currentTimeMillis());
            } else {
                stateMachine.dispatch(AndroidConnectionServiceEvent.terminalFailure(
                    failedGeneration, message), System.currentTimeMillis());
            }
            publishEvent(AndroidConnectionServiceEventEnvelope.physicalError(code, message));
        }

        /** Auth failures stop reconnect — no backoff retry. */
        private void authFailure(String code, String message) {
            if (stopped || generation == null) {
                return;
            }
            closeQuietly(socket);
            socket = null;
            String failedGeneration = generation;
            generation = null;
            stateMachine.dispatch(AndroidConnectionServiceEvent.authenticationFailure(
                failedGeneration, message), System.currentTimeMillis());
            publishEvent(AndroidConnectionServiceEventEnvelope.physicalError(code, message));
            // no scheduleBackoff() — auth failures are terminal
        }

        private void publishServerFrame(AndroidConnectionServiceServerFrameEvent.Kind kind, JSONObject payload) {
            publishEvent(AndroidConnectionServiceEventEnvelope.serverFrame(
                new AndroidConnectionServiceServerFrameEvent.Builder(kind)
                    .targetKey(target.targetKey)
                    .generation(generation)
                    .receivedAt(System.currentTimeMillis())
                    .payload(payload)
                    .build()));
        }

        private void resetAttemptState() {
            generation = null;
            socket = null;
            candidateIndex = 0;
            backoffIndex = 0;
            heartbeatMisses = 0;
            lastPingAt = 0L;
            nextRetryAt = 0L;
            if (stateMachine != null) {
                stateMachine = null;
            }
        }

        void close(String reason) {
            stopped = true;
            desiredChannels.clear();
            closeQuietly(socket);
            socket = null;
            generation = null;
        }

        private void closeCurrent(String reason) {
            WebSocket current = socket;
            socket = null;
            if (current != null) {
                try {
                    current.close(1000, reason);
                } catch (RuntimeException ignored) {
                    current.cancel();
                }
            }
        }

        private void closeQuietly(WebSocket webSocket) {
            if (webSocket == null) {
                return;
            }
            try {
                webSocket.close(1000, "service-close");
            } catch (RuntimeException ignored) {
                webSocket.cancel();
            }
        }

        AndroidConnectionServiceSnapshot snapshot() {
            return stateMachine == null
                ? AndroidConnectionServiceSnapshot.empty()
                : stateMachine.readSnapshot();
        }

        final class ChannelIntent {
            final String channelId;
            final String sessionName;
            final JSONObject options;
            volatile boolean opened;

            ChannelIntent(String channelId, String sessionName, JSONObject options) {
                this.channelId = channelId;
                this.sessionName = sessionName;
                this.options = options;
                this.opened = false;
            }
        }

        boolean hasNotificationChannel(String channelId) {
            ChannelIntent channel = desiredChannels.get(channelId);
            return channel != null && channel.opened && isMuxReady();
        }
    }

    private static final class RouteCandidate {
        final String path;
        final String url;

        RouteCandidate(String path, String url) {
            this.path = path;
            this.url = url;
        }
    }

    private static boolean isConnectedState(AndroidConnectionServiceSnapshot.State state) {
        return state == AndroidConnectionServiceSnapshot.State.MUX_READY
            || state == AndroidConnectionServiceSnapshot.State.CHANNELS_READY
            || state == AndroidConnectionServiceSnapshot.State.HEALTHY;
    }

    private static boolean nonEmpty(String value) {
        return value != null && !value.trim().isEmpty();
    }

    private static boolean isLikelyTailscale(String host) {
        if (host == null) return false;
        String value = host.trim();
        if (value.isEmpty()) return false;
        if (value.startsWith("http://") || value.startsWith("https://")
            || value.startsWith("ws://") || value.startsWith("wss://")) {
            String hostOnly = value.replaceFirst("^[a-z]+://", "").split("/", 2)[0];
            return hostOnly.startsWith("100.") || hostOnly.startsWith("fd7a:115c:a1e0:");
        }
        return value.startsWith("100.") || value.startsWith("fd7a:115c:a1e0:");
    }

    private static boolean isLikelyIpv6(String host) {
        if (host == null) return false;
        String value = host.trim();
        if (value.startsWith("[")) return true;
        return value.contains(":") && !value.contains("://");
    }

    static void resetForTests() {
        synchronized (LISTENER_LOCK) {
            STATIC_LISTENERS.clear();
            LAST_SNAPSHOTS.clear();
        }
    }

    static AndroidConnectionServiceSnapshot lastSnapshotForTests(String targetKey) {
        if (targetKey == null || targetKey.trim().isEmpty()) {
            return AndroidConnectionServiceSnapshot.empty();
        }
        AndroidConnectionServiceSnapshot snapshot = LAST_SNAPSHOTS.get(targetKey.trim());
        return snapshot == null ? AndroidConnectionServiceSnapshot.empty() : snapshot;
    }

    static void registerListenerForTests(AndroidConnectionServiceListener listener) {
        synchronized (LISTENER_LOCK) {
            if (!STATIC_LISTENERS.contains(listener)) {
                STATIC_LISTENERS.add(listener);
            }
        }
    }

    static void unregisterListenerForTests(AndroidConnectionServiceListener listener) {
        synchronized (LISTENER_LOCK) {
            STATIC_LISTENERS.remove(listener);
        }
    }

    static JSONArray snapshotListenersForTests() throws JSONException {
        JSONArray out = new JSONArray();
        synchronized (LISTENER_LOCK) {
            for (AndroidConnectionServiceListener listener : STATIC_LISTENERS) {
                out.put(listener.toString());
            }
        }
        return out;
    }
}
