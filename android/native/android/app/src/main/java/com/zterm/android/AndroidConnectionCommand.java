package com.zterm.android;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Typed command envelope accepted by AndroidConnectionService.
 *
 * The UI may only mutate connection behavior via these typed commands. No
 * terminal business payload, wire metadata or route diagnostic may be passed
 * through this surface — those data classes own their own channels.
 */
public final class AndroidConnectionCommand {
    public enum Type { SET_ROUTE_POLICY, BIND_TARGET, RELEASE_TARGET, OPEN_CHANNEL, CHANNEL_MESSAGE, CHANNEL_BINARY, CLOSE_CHANNEL }

    public final Type type;
    public final AndroidConnectionServiceRoutePolicy policy;
    public final AndroidConnectionServiceTarget target;
    public final String reason;
    public final String targetKey;
    public final String sessionName;
    public final String channelId;
    public final JSONObject channelMessage;
    public final String channelDataBase64;
    public final JSONObject channelOptions;

    private AndroidConnectionCommand(Type type,
                                    AndroidConnectionServiceRoutePolicy policy,
                                    AndroidConnectionServiceTarget target,
                                    String reason,
                                    String targetKey,
                                    String sessionName,
                                    String channelId,
                                    JSONObject channelMessage,
                                    String channelDataBase64,
                                    JSONObject channelOptions) {
        this.type = type;
        this.policy = policy;
        this.target = target;
        this.reason = reason;
        this.targetKey = targetKey;
        this.sessionName = sessionName;
        this.channelId = channelId;
        this.channelMessage = channelMessage;
        this.channelDataBase64 = channelDataBase64;
        this.channelOptions = channelOptions;
    }

    public static AndroidConnectionCommand setRoutePolicy(AndroidConnectionServiceRoutePolicy policy) {
        return new AndroidConnectionCommand(Type.SET_ROUTE_POLICY, policy, null, null,
            null, null, null, null, null, null);
    }

    public static AndroidConnectionCommand bindTarget(AndroidConnectionServiceTarget target) {
        return new AndroidConnectionCommand(Type.BIND_TARGET, null, target, null,
            null, null, null, null, null, null);
    }

    public static AndroidConnectionCommand releaseTarget(String targetKey, String reason) {
        return new AndroidConnectionCommand(Type.RELEASE_TARGET, null, null,
            reason == null || reason.trim().isEmpty() ? "unspecified" : reason.trim(),
            targetKey, null, null, null, null, null);
    }

    public static AndroidConnectionCommand openChannel(String targetKey, String channelId, String sessionName, JSONObject options) {
        return new AndroidConnectionCommand(Type.OPEN_CHANNEL, null, null, null,
            targetKey, sessionName, channelId, null, null, options);
    }

    public static AndroidConnectionCommand channelMessage(String targetKey, String channelId, JSONObject message) {
        return new AndroidConnectionCommand(Type.CHANNEL_MESSAGE, null, null, null,
            targetKey, null, channelId, message, null, null);
    }

    public static AndroidConnectionCommand channelBinary(String targetKey, String channelId, String dataBase64) {
        return new AndroidConnectionCommand(Type.CHANNEL_BINARY, null, null, null,
            targetKey, null, channelId, null, dataBase64, null);
    }

    public static AndroidConnectionCommand closeChannel(String targetKey, String channelId, String reason) {
        return new AndroidConnectionCommand(Type.CLOSE_CHANNEL, null, null, reason,
            targetKey, null, channelId, null, null, null);
    }

    public JSONObject toJson() throws JSONException {
        JSONObject json = new JSONObject();
        switch (type) {
            case SET_ROUTE_POLICY:
                json.put("type", "set-manual-route-policy");
                if (policy != null) json.put("policy", policy.toJson());
                break;
            case BIND_TARGET:
                json.put("type", "bind-target");
                if (target != null) json.put("target", target.toJson());
                break;
            case RELEASE_TARGET:
                json.put("type", "release-target");
                json.put("targetKey", targetKey);
                json.put("reason", reason);
                break;
            case OPEN_CHANNEL:
                json.put("type", "open-channel");
                json.put("targetKey", targetKey);
                json.put("channelId", channelId);
                json.put("sessionName", sessionName);
                if (channelOptions != null) json.put("options", channelOptions);
                break;
            case CHANNEL_MESSAGE:
                json.put("type", "channel-message");
                json.put("targetKey", targetKey);
                json.put("channelId", channelId);
                json.put("message", channelMessage);
                break;
            case CHANNEL_BINARY:
                json.put("type", "channel-binary");
                json.put("targetKey", targetKey);
                json.put("channelId", channelId);
                json.put("dataBase64", channelDataBase64);
                break;
            case CLOSE_CHANNEL:
                json.put("type", "close-channel");
                json.put("targetKey", targetKey);
                json.put("channelId", channelId);
                json.put("reason", reason);
                break;
        }
        return json;
    }

    public static AndroidConnectionCommand fromJson(JSONObject json) throws JSONException {
        if (json == null) throw new IllegalArgumentException("command payload missing");
        String wireType = json.optString("type", "");
        switch (wireType) {
            case "set-manual-route-policy":
                return setRoutePolicy(AndroidConnectionServiceRoutePolicy.fromJson(json.optJSONObject("policy")));
            case "bind-target":
                return bindTarget(AndroidConnectionServiceTarget.fromJson(json.optJSONObject("target")));
            case "release-target":
                return releaseTarget(requireTargetKey(json), json.optString("reason", "unspecified"));
            case "open-channel":
                return openChannel(requireTargetKey(json), json.optString("channelId", ""),
                    json.optString("sessionName", ""), json.optJSONObject("options"));
            case "channel-message":
                return channelMessage(requireTargetKey(json), json.optString("channelId", ""),
                    json.optJSONObject("message"));
            case "channel-binary":
                return channelBinary(requireTargetKey(json), json.optString("channelId", ""),
                    json.optString("dataBase64", ""));
            case "close-channel":
                return closeChannel(requireTargetKey(json), json.optString("channelId", ""),
                    json.optString("reason", "user-close"));
            default:
                throw new IllegalArgumentException("unknown command type: " + wireType);
        }
    }

    private static String requireTargetKey(JSONObject json) {
        String targetKey = json.optString("targetKey", "").trim();
        if (targetKey.isEmpty()) {
            throw new IllegalArgumentException("channel command targetKey missing");
        }
        return targetKey;
    }

    /**
     * Translate the typed command into the internal typed event the state
     * machine accepts. Commands are user intents; events are state-machine
     * facts.
     */
    public AndroidConnectionServiceEvent toEvent() {
        switch (type) {
            case SET_ROUTE_POLICY:
                return AndroidConnectionServiceEvent.setRoutePolicy(policy);
            case BIND_TARGET:
                return AndroidConnectionServiceEvent.bindTarget(target);
            case RELEASE_TARGET:
                return AndroidConnectionServiceEvent.releaseTarget(reason);
            case OPEN_CHANNEL:
                throw new IllegalStateException("open-channel is not a state-machine event");
            case CHANNEL_MESSAGE:
            case CHANNEL_BINARY:
            case CLOSE_CHANNEL:
                throw new IllegalStateException("channel command is not a state-machine event");
            default:
                throw new IllegalStateException("unhandled command: " + type);
        }
    }
}
