package com.zterm.android;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/** Immutable UI projection of AndroidConnectionService state. */
public final class AndroidConnectionServiceSnapshot {
    public enum State {
        IDLE("idle"),
        RESOLVING_TARGET("resolving-target"),
        CONNECTING("connecting"),
        MUX_READY("mux-ready"),
        CHANNELS_READY("channels-ready"),
        HEALTHY("healthy"),
        BACKOFF_RECONNECT("backoff-reconnect"),
        AUTHENTICATION_ERROR("authentication-error"),
        TERMINAL_ERROR("terminal-error");

        private final String wireName;
        State(String wireName) { this.wireName = wireName; }
        public String wireName() { return wireName; }
    }

    public static final class Channel {
        public enum State {
            OPENING("opening"), OPEN("open"), CLOSING("closing"), CLOSED("closed");
            private final String wireName;
            State(String wireName) { this.wireName = wireName; }
            public String wireName() { return wireName; }
        }

        public final String channelId;
        public final State state;

        public Channel(String channelId, State state) {
            this.channelId = channelId;
            this.state = state;
        }

        public JSONObject toJson() throws JSONException {
            JSONObject json = new JSONObject();
            json.put("channelId", channelId);
            json.put("state", state.wireName());
            return json;
        }
    }

    public static final class ErrorValue {
        public final String code;
        public final String message;

        public ErrorValue(String code, String message) {
            this.code = code;
            this.message = message;
        }

        public JSONObject toJson() throws JSONException {
            JSONObject json = new JSONObject();
            json.put("code", code);
            json.put("message", message);
            return json;
        }
    }

    public final State state;
    public final String generation;
    public final AndroidConnectionServiceTarget target;
    public final AndroidConnectionServiceRoutePolicy route;
    public final List<Channel> channels;
    public final Long lastHeartbeatAt;
    public final Long lastActivityAt;
    public final Long nextRetryAt;
    public final ErrorValue error;
    public final String muxReadyPayloadJson;

    private AndroidConnectionServiceSnapshot(Builder b) {
        this.state = b.state;
        this.generation = b.generation;
        this.target = b.target;
        this.route = b.route;
        this.channels = Collections.unmodifiableList(new ArrayList<>(b.channels));
        this.lastHeartbeatAt = b.lastHeartbeatAt;
        this.lastActivityAt = b.lastActivityAt;
        this.nextRetryAt = b.nextRetryAt;
        this.error = b.error;
        this.muxReadyPayloadJson = b.muxReadyPayloadJson;
    }

    public static AndroidConnectionServiceSnapshot empty() {
        return new Builder(State.IDLE).build();
    }

    public static AndroidConnectionServiceSnapshot emptyForTarget(AndroidConnectionServiceTarget target) {
        return new Builder(State.IDLE).target(target).build();
    }

    public Builder toBuilder() {
        return new Builder(state)
            .generation(generation)
            .target(target)
            .route(route)
            .channels(channels)
            .lastHeartbeatAt(lastHeartbeatAt)
            .lastActivityAt(lastActivityAt)
            .nextRetryAt(nextRetryAt)
            .error(error)
            .muxReadyPayloadJson(muxReadyPayloadJson);
    }

    public JSONObject toJson() throws JSONException {
        JSONObject json = new JSONObject();
        json.put("state", state.wireName());
        json.put("generation", generation == null ? JSONObject.NULL : generation);
        json.put("target", target == null ? JSONObject.NULL : target.toJson());
        json.put("route", route == null ? JSONObject.NULL : route.toJson());
        JSONArray channelArray = new JSONArray();
        for (Channel channel : channels) channelArray.put(channel.toJson());
        json.put("channels", channelArray);
        json.put("lastHeartbeatAt", lastHeartbeatAt == null ? JSONObject.NULL : lastHeartbeatAt);
        json.put("lastActivityAt", lastActivityAt == null ? JSONObject.NULL : lastActivityAt);
        json.put("nextRetryAt", nextRetryAt == null ? JSONObject.NULL : nextRetryAt);
        json.put("error", error == null ? JSONObject.NULL : error.toJson());
        json.put("muxReadyPayload", muxReadyPayloadJson == null
            ? JSONObject.NULL : new JSONObject(muxReadyPayloadJson));
        return json;
    }

    @Override
    public boolean equals(Object other) {
        if (!(other instanceof AndroidConnectionServiceSnapshot)) return false;
        AndroidConnectionServiceSnapshot that = (AndroidConnectionServiceSnapshot) other;
        return state == that.state
            && Objects.equals(generation, that.generation)
            && Objects.equals(target, that.target)
            && Objects.equals(route == null ? null : route.mode, that.route == null ? null : that.route.mode)
            && Objects.equals(route == null ? null : route.path, that.route == null ? null : that.route.path)
            && channelsEqual(channels, that.channels)
            && Objects.equals(lastHeartbeatAt, that.lastHeartbeatAt)
            && Objects.equals(lastActivityAt, that.lastActivityAt)
            && Objects.equals(nextRetryAt, that.nextRetryAt)
            && Objects.equals(error == null ? null : error.code, that.error == null ? null : that.error.code)
            && Objects.equals(error == null ? null : error.message, that.error == null ? null : that.error.message)
            && Objects.equals(muxReadyPayloadJson, that.muxReadyPayloadJson);
    }

    private static boolean channelsEqual(List<Channel> a, List<Channel> b) {
        if (a.size() != b.size()) return false;
        for (int i = 0; i < a.size(); i++) {
            if (!Objects.equals(a.get(i).channelId, b.get(i).channelId)
                || a.get(i).state != b.get(i).state) return false;
        }
        return true;
    }

    @Override
    public int hashCode() {
        return Objects.hash(state, generation, target, route == null ? null : route.mode,
            route == null ? null : route.path, channels.size(), lastHeartbeatAt,
            lastActivityAt, nextRetryAt, error == null ? null : error.code,
            error == null ? null : error.message, muxReadyPayloadJson);
    }

    public static final class Builder {
        private State state;
        private String generation;
        private AndroidConnectionServiceTarget target;
        private AndroidConnectionServiceRoutePolicy route;
        private List<Channel> channels = new ArrayList<>();
        private Long lastHeartbeatAt;
        private Long lastActivityAt;
        private Long nextRetryAt;
        private ErrorValue error;
        private String muxReadyPayloadJson;

        public Builder(State state) { this.state = state; }
        public Builder generation(String v) { this.generation = v; return this; }
        public Builder target(AndroidConnectionServiceTarget v) { this.target = v; return this; }
        public Builder route(AndroidConnectionServiceRoutePolicy v) { this.route = v; return this; }
        public Builder channels(List<Channel> v) { this.channels = v == null ? new ArrayList<>() : new ArrayList<>(v); return this; }
        public Builder lastHeartbeatAt(Long v) { this.lastHeartbeatAt = v; return this; }
        public Builder lastActivityAt(Long v) { this.lastActivityAt = v; return this; }
        public Builder nextRetryAt(Long v) { this.nextRetryAt = v; return this; }
        public Builder error(ErrorValue v) { this.error = v; return this; }
        public Builder muxReadyPayloadJson(String v) { this.muxReadyPayloadJson = v; return this; }
        public AndroidConnectionServiceSnapshot build() { return new AndroidConnectionServiceSnapshot(this); }
    }
}
