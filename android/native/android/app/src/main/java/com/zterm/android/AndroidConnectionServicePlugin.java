package com.zterm.android;

import android.content.Intent;
import android.os.Build;

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
        String reason = call.getString("reason", "user-release");
        sendCommand(AndroidConnectionCommand.releaseTarget(reason));
        call.resolve(ok());
    }

    @PluginMethod
    public void openChannel(PluginCall call) {
        String channelId = call.getString("channelId");
        String sessionName = call.getString("sessionName");
        if (channelId == null || channelId.trim().isEmpty()
            || sessionName == null || sessionName.trim().isEmpty()) {
            call.reject("channelId and sessionName are required");
            return;
        }
        sendCommand(AndroidConnectionCommand.openChannel(
            channelId.trim(), sessionName.trim(), call.getObject("options")));
        call.resolve(ok());
    }

    @PluginMethod
    public void sendChannelMessage(PluginCall call) {
        String channelId = call.getString("channelId");
        JSObject messageBody = call.getObject("message");
        if (channelId == null || channelId.trim().isEmpty() || messageBody == null) {
            call.reject("channelId and message are required");
            return;
        }
        try {
            sendCommand(AndroidConnectionCommand.channelMessage(
                channelId.trim(), new JSONObject(messageBody.toString())));
            call.resolve(ok());
        } catch (JSONException error) {
            call.reject("invalid channel message", error);
        }
    }

    @PluginMethod
    public void sendChannelBinary(PluginCall call) {
        String channelId = call.getString("channelId");
        String dataBase64 = call.getString("dataBase64");
        if (channelId == null || channelId.trim().isEmpty()
            || dataBase64 == null || dataBase64.isEmpty()) {
            call.reject("channelId and dataBase64 are required");
            return;
        }
        sendCommand(AndroidConnectionCommand.channelBinary(
            channelId.trim(), dataBase64));
        call.resolve(ok());
    }

    @PluginMethod
    public void closeChannel(PluginCall call) {
        String channelId = call.getString("channelId");
        if (channelId == null || channelId.trim().isEmpty()) {
            call.reject("channelId is required");
            return;
        }
        sendCommand(AndroidConnectionCommand.closeChannel(
            channelId.trim(), call.getString("reason", "user-close")));
        call.resolve(ok());
    }

    @PluginMethod
    public void readSnapshot(PluginCall call) {
        try {
            call.resolve(JSObject.fromJSONObject(
                AndroidConnectionService.lastSnapshotForTests().toJson()));
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
