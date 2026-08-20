package com.zterm.android;

import android.content.Intent;
import android.content.ComponentName;
import android.content.ServiceConnection;
import android.os.Build;
import android.os.IBinder;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Capacitor projection bridge for AndroidConnectionService.
 *
 * The plugin is a typed IPC/projection boundary only. It never owns transport,
 * heartbeat, reconnect, or generation state, and it never schedules WebView
 * timers. Service events are emitted to React through the typed event names
 * below; terminal business payload is kept on the service event side-channel,
 * not in snapshot or route policy JSON.
 */
@CapacitorPlugin(name = "AndroidConnectionService")
public final class AndroidConnectionServicePlugin extends Plugin {
    private boolean serviceBound;
    private final ServiceConnection serviceConnection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            serviceBound = true;
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            serviceBound = false;
        }
    };
    private final AndroidConnectionServiceListener serviceListener = new AndroidConnectionServiceListener() {
        @Override
        public void onEvent(AndroidConnectionServiceEventEnvelope event) {
            try {
                switch (event.kind) {
                    case STATE_CHANGED:
                        notifyListeners("androidConnectionSnapshot",
                            JSObject.fromJSONObject(event.snapshot.toJson()), true);
                        break;
                    case SERVER_FRAME:
                        notifyListeners("androidConnectionServerFrame",
                            JSObject.fromJSONObject(event.serverFrame.toJson()), true);
                        break;
                    case CHANNEL_MESSAGE:
                        notifyListeners("androidConnectionChannelMessage",
                            JSObject.fromJSONObject(event.channelMessage.toJson()), true);
                        break;
                    case CHANNEL_OPENED:
                        notifyListeners("androidConnectionChannelOpened",
                            JSObject.fromJSONObject(event.toJson()), true);
                        break;
                    case CHANNEL_CLOSED:
                        notifyListeners("androidConnectionChannelClosed",
                            JSObject.fromJSONObject(event.toJson()), true);
                        break;
                    case COMMAND_REJECTED:
                    case PHYSICAL_ERROR:
                        notifyListeners("androidConnectionError",
                            JSObject.fromJSONObject(event.toJson()), true);
                        break;
                    default:
                        break;
                }
            } catch (JSONException error) {
                JSObject body = new JSObject();
                body.put("code", "snapshot-serialization");
                body.put("message", error.getMessage());
                notifyListeners("androidConnectionSnapshotError", body, false);
            }
        }

        @Override
        public void onSnapshot(AndroidConnectionServiceSnapshot snapshot) {
            // Kept for legacy test callers; production uses onEvent.
            try {
                notifyListeners("androidConnectionSnapshot",
                    JSObject.fromJSONObject(snapshot.toJson()), true);
            } catch (JSONException error) {
                JSObject body = new JSObject();
                body.put("code", "snapshot-serialization");
                body.put("message", error.getMessage());
                notifyListeners("androidConnectionSnapshotError", body, false);
            }
        }
    };

    @Override
    public void load() {
        AndroidConnectionService.registerListenerForTests(serviceListener);
    }

    @Override
    protected void handleOnDestroy() {
        if (serviceBound) {
            getContext().unbindService(serviceConnection);
            serviceBound = false;
        }
        AndroidConnectionService.unregisterListenerForTests(serviceListener);
        super.handleOnDestroy();
    }

    @PluginMethod
    public void setManualRoutePolicy(PluginCall call) {
        JSObject policyBody = call.getObject("policy");
        if (policyBody == null) {
            call.reject("policy is required");
            return;
        }
        try {
            AndroidConnectionServiceRoutePolicy policy =
                AndroidConnectionServiceRoutePolicy.fromJson(new JSONObject(policyBody.toString()));
            sendCommand(AndroidConnectionCommand.setRoutePolicy(policy));
            call.resolve(ok());
        } catch (JSONException | IllegalArgumentException error) {
            call.reject("invalid route policy", error);
        }
    }

    @PluginMethod
    public void bindTarget(PluginCall call) {
        JSObject targetBody = call.getObject("target");
        if (targetBody == null) {
            call.reject("target is required");
            return;
        }
        try {
            AndroidConnectionServiceTarget target =
                AndroidConnectionServiceTarget.fromJson(new JSONObject(targetBody.toString()));
            sendCommand(AndroidConnectionCommand.bindTarget(target));
            call.resolve(ok());
        } catch (JSONException | IllegalArgumentException error) {
            call.reject("invalid target", error);
        }
    }

    @PluginMethod
    public void releaseTarget(PluginCall call) {
        String targetKey = call.getString("targetKey");
        String reason = call.getString("reason", "user-release");
        if (targetKey == null || targetKey.trim().isEmpty()) {
            call.reject("targetKey is required");
            return;
        }
        sendCommand(AndroidConnectionCommand.releaseTarget(targetKey.trim(), reason));
        call.resolve(ok());
    }

    @PluginMethod
    public void openChannel(PluginCall call) {
        String targetKey = call.getString("targetKey");
        String channelId = call.getString("channelId");
        String sessionName = call.getString("sessionName");
        if (targetKey == null || targetKey.trim().isEmpty()
            || channelId == null || channelId.trim().isEmpty()
            || sessionName == null || sessionName.trim().isEmpty()) {
            call.reject("targetKey, channelId and sessionName are required");
            return;
        }
        sendCommand(AndroidConnectionCommand.openChannel(
            targetKey.trim(), channelId.trim(), sessionName.trim(), call.getObject("options")));
        call.resolve(ok());
    }

    @PluginMethod
    public void sendChannelMessage(PluginCall call) {
        String targetKey = call.getString("targetKey");
        String channelId = call.getString("channelId");
        JSObject messageBody = call.getObject("message");
        if (targetKey == null || targetKey.trim().isEmpty()
            || channelId == null || channelId.trim().isEmpty() || messageBody == null) {
            call.reject("targetKey, channelId and message are required");
            return;
        }
        try {
            sendCommand(AndroidConnectionCommand.channelMessage(
                targetKey.trim(), channelId.trim(), new JSONObject(messageBody.toString())));
            call.resolve(ok());
        } catch (JSONException error) {
            call.reject("invalid channel message", error);
        }
    }

    @PluginMethod
    public void sendChannelBinary(PluginCall call) {
        String targetKey = call.getString("targetKey");
        String channelId = call.getString("channelId");
        String dataBase64 = call.getString("dataBase64");
        if (targetKey == null || targetKey.trim().isEmpty()
            || channelId == null || channelId.trim().isEmpty()
            || dataBase64 == null || dataBase64.isEmpty()) {
            call.reject("targetKey, channelId and dataBase64 are required");
            return;
        }
        sendCommand(AndroidConnectionCommand.channelBinary(
            targetKey.trim(), channelId.trim(), dataBase64));
        call.resolve(ok());
    }

    @PluginMethod
    public void closeChannel(PluginCall call) {
        String targetKey = call.getString("targetKey");
        String channelId = call.getString("channelId");
        if (targetKey == null || targetKey.trim().isEmpty()
            || channelId == null || channelId.trim().isEmpty()) {
            call.reject("targetKey and channelId are required");
            return;
        }
        sendCommand(AndroidConnectionCommand.closeChannel(
            targetKey.trim(), channelId.trim(), call.getString("reason", "user-close")));
        call.resolve(ok());
    }

    @PluginMethod
    public void pulseSessionNotification(PluginCall call) {
        String targetKey = call.getString("targetKey");
        String channelId = call.getString("channelId");
        if (targetKey == null || targetKey.trim().isEmpty()
            || channelId == null || channelId.trim().isEmpty()) {
            call.reject("targetKey and channelId are required");
            return;
        }
        sendCommand(AndroidConnectionCommand.pulseSessionNotification(
            targetKey.trim(), channelId.trim()));
        call.resolve(ok());
    }

    @PluginMethod
    public void sendTargetMessage(PluginCall call) {
        String targetKey = call.getString("targetKey");
        String requestId = call.getString("requestId", "");
        JSObject messageBody = call.getObject("message");
        if (targetKey == null || targetKey.trim().isEmpty() || messageBody == null) {
            call.reject("targetKey and message are required");
            return;
        }
        try {
            sendCommand(AndroidConnectionCommand.targetMessage(
                targetKey.trim(),
                requestId == null ? "" : requestId.trim(),
                new JSONObject(messageBody.toString())));
            call.resolve(ok());
        } catch (JSONException error) {
            call.reject("invalid target message", error);
        }
    }

    @PluginMethod
    public void readSnapshot(PluginCall call) {
        String targetKey = call.getString("targetKey");
        if (targetKey == null || targetKey.trim().isEmpty()) {
            call.reject("targetKey is required");
            return;
        }
        try {
            call.resolve(JSObject.fromJSONObject(
                AndroidConnectionService.lastSnapshotForTests(targetKey.trim()).toJson()));
        } catch (JSONException error) {
            call.reject("snapshot serialization failed", error);
        }
    }

    private void sendCommand(AndroidConnectionCommand command) {
        Intent intent = new Intent(getContext(), AndroidConnectionService.class);
        intent.setAction(AndroidConnectionService.ACTION_COMMAND);
        try {
            intent.putExtra("command", command.toJson().toString());
        } catch (JSONException error) {
            throw new IllegalArgumentException("command serialization failed", error);
        }
        startService(intent);
        bindToStartedService();
    }

    private void bindToStartedService() {
        if (serviceBound) {
            return;
        }
        Intent intent = new Intent(getContext(), AndroidConnectionService.class);
        serviceBound = getContext().bindService(
            intent,
            serviceConnection,
            android.content.Context.BIND_NOT_FOREGROUND);
    }

    private void startService(Intent intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
    }

    private JSObject ok() {
        JSObject result = new JSObject();
        result.put("ok", true);
        return result;
    }
}
