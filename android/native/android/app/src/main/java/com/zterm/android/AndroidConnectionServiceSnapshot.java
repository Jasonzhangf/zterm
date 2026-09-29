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
        public final String sessionName;

        public Channel(String channelId, State state) {
            this.channelId = channelId;
            this.state = state;
            this.sessionName = "";
        }

        public Channel(String channelId, State state, String sessionName) {
            this.channelId = channelId;
            this.state = state;
            this.sessionName = sessionName == null ? "" : sessionName;
        }

        public JSONObject toJson() throws JSONException {
            JSONObject json = new JSONObject();
            json.put("channelId", channelId);
            json.put("state", state.wireName());
            if (!sessionName.isEmpty()) {
                json.put("sessionName", sessionName);
            }
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

    public static final class RouteDiagnostic {
        public final String candidateId;
        public final String path;
        public final String endpoint;
        public final String reason;
        public final Long startedAt;
        public final Long endedAt;
        public final Long elapsedMs;
        public final boolean selected;
        public final String failureCode;

        public RouteDiagnostic(
            String candidateId, String path, String endpoint, String reason,
            Long startedAt, Long endedAt, Long elapsedMs, boolean selected, String failureCode) {
            this.candidateId = candidateId == null ? "" : candidateId;
            this.path = path == null ? "" : path;
            this.endpoint = endpoint == null ? "" : endpoint;
            this.reason = reason == null ? "" : reason;
            this.startedAt = startedAt;
            this.endedAt = endedAt;
            this.elapsedMs = elapsedMs;
            this.selected = selected;
            this.failureCode = failureCode;
        }

        public JSONObject toJson() throws JSONException {
            JSONObject json = new JSONObject();
            json.put("candidateId", candidateId);
            json.put("path", path);
            json.put("endpoint", endpoint);
            json.put("reason", reason);
            json.put("startedAt", startedAt == null ? JSONObject.NULL : startedAt);
            json.put("endedAt", endedAt == null ? JSONObject.NULL : endedAt);
            json.put("elapsedMs", elapsedMs == null ? JSONObject.NULL : elapsedMs);
            json.put("selected", selected);
            if (failureCode != null && !failureCode.isEmpty()) {
                json.put("failureCode", failureCode);
            }
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
    public final String resolvedPath;
    public final String resolvedRelayTransport;
    public final String resolvedEndpoint;
    public final String selectedIcePairJson;
    public final List<RouteDiagnostic> routeDiagnostics;

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
        this.resolvedPath = b.resolvedPath;
        this.resolvedRelayTransport = b.resolvedRelayTransport;
        this.resolvedEndpoint = b.resolvedEndpoint;
        this.selectedIcePairJson = b.selectedIcePairJson;
        this.routeDiagnostics = Collections.unmodifiableList(new ArrayList<>(b.routeDiagnostics));
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
            .muxReadyPayloadJson(muxReadyPayloadJson)
            .resolvedPath(resolvedPath)
            .resolvedRelayTransport(resolvedRelayTransport)
            .resolvedEndpoint(resolvedEndpoint)
            .selectedIcePairJson(selectedIcePairJson)
            .routeDiagnostics(routeDiagnostics);
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
        json.put("resolvedPath", resolvedPath == null ? JSONObject.NULL : resolvedPath);
        json.put("resolvedRelayTransport", resolvedRelayTransport == null
            ? JSONObject.NULL : resolvedRelayTransport);
        json.put("resolvedEndpoint", resolvedEndpoint == null ? JSONObject.NULL : resolvedEndpoint);
        json.put("selectedIcePair", selectedIcePairJson == null
            ? JSONObject.NULL : new JSONObject(selectedIcePairJson));
        JSONArray routeDiagnosticArray = new JSONArray();
        for (RouteDiagnostic diagnostic : routeDiagnostics) routeDiagnosticArray.put(diagnostic.toJson());
        json.put("routeDiagnostics", routeDiagnosticArray);
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
            && Objects.equals(muxReadyPayloadJson, that.muxReadyPayloadJson)
            && Objects.equals(resolvedPath, that.resolvedPath)
            && Objects.equals(resolvedRelayTransport, that.resolvedRelayTransport)
            && Objects.equals(resolvedEndpoint, that.resolvedEndpoint)
            && Objects.equals(selectedIcePairJson, that.selectedIcePairJson)
            && Objects.equals(routeDiagnostics.size(), that.routeDiagnostics.size());
    }

    private static boolean channelsEqual(List<Channel> a, List<Channel> b) {
        if (a.size() != b.size()) return false;
        for (int i = 0; i < a.size(); i++) {
            if (!Objects.equals(a.get(i).channelId, b.get(i).channelId)
                || a.get(i).state != b.get(i).state
                || !Objects.equals(a.get(i).sessionName, b.get(i).sessionName)) return false;
        }
        return true;
    }

    @Override
    public int hashCode() {
        int channelHash = 0;
        for (Channel channel : channels) channelHash = 31 * channelHash + Objects.hashCode(channel.sessionName);
        int routeDiagnosticHash = 0;
        for (RouteDiagnostic diagnostic : routeDiagnostics) routeDiagnosticHash = 31 * routeDiagnosticHash + Objects.hash(
            diagnostic.candidateId, diagnostic.path, diagnostic.endpoint, diagnostic.reason, diagnostic.startedAt,
            diagnostic.endedAt, diagnostic.elapsedMs, diagnostic.selected, diagnostic.failureCode);
        return Objects.hash(state, generation, target, route == null ? null : route.mode,
            route == null ? null : route.path, channels.size(), lastHeartbeatAt,
            lastActivityAt, nextRetryAt, error == null ? null : error.code,
            error == null ? null : error.message, muxReadyPayloadJson, channelHash,
            resolvedPath, resolvedRelayTransport, resolvedEndpoint, selectedIcePairJson,
            routeDiagnosticHash, routeDiagnostics.size());
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
        private String resolvedPath;
        private String resolvedRelayTransport;
        private String resolvedEndpoint;
        private String selectedIcePairJson;
        private List<RouteDiagnostic> routeDiagnostics = new ArrayList<>();

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
        public Builder resolvedPath(String v) { this.resolvedPath = v; return this; }
        public Builder resolvedRelayTransport(String v) { this.resolvedRelayTransport = v; return this; }
        public Builder resolvedEndpoint(String v) { this.resolvedEndpoint = v; return this; }
        public Builder selectedIcePairJson(String v) { this.selectedIcePairJson = v; return this; }
        public Builder routeDiagnostics(List<RouteDiagnostic> v) {
            this.routeDiagnostics = v == null ? new ArrayList<>() : new ArrayList<>(v);
            return this;
        }
        public AndroidConnectionServiceSnapshot build() { return new AndroidConnectionServiceSnapshot(this); }
    }
}
