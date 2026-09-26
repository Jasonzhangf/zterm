package com.zterm.android;

/**
 * Internal typed events the {@link AndroidConnectionStateMachine} consumes.
 * These are an internal vocabulary — user-facing inputs are
 * {@link AndroidConnectionCommand}s and are translated into events by
 * {@link AndroidConnectionCommand#toEvent()}.
 */
public final class AndroidConnectionServiceEvent {
    public enum Type {
        BIND_TARGET,
        SET_ROUTE_POLICY,
        RELEASE_TARGET,
        TRANSPORT_OPENING,
        MUX_READY,
        CHANNEL_OPENED,
        CHANNEL_CLOSED,
        HEARTBEAT_PONG,
        SERVER_ACTIVITY,
        HEARTBEAT_MISSED,
        TRANSPORT_RESOLVED,
        TRANSPORT_FAILURE,
        AUTHENTICATION_FAILURE,
        TERMINAL_FAILURE,
        RECONNECT_ATTEMPT,
        BACKOFF_TIMER_FIRED
    }

    public final Type type;
    public final AndroidConnectionServiceTarget target;
    public final AndroidConnectionServiceRoutePolicy policy;
    public final String reason;
    public final String generation;
    public final String channelId;
    public final String sessionName;
    public final Long atMillis;
    public final String message;
    public final String muxReadyPayloadJson;
    public final String resolvedPath;
    public final String resolvedRelayTransport;
    public final String resolvedEndpoint;
    public final String selectedIcePairJson;

    private AndroidConnectionServiceEvent(Builder b) {
        this.type = b.type;
        this.target = b.target;
        this.policy = b.policy;
        this.reason = b.reason;
        this.generation = b.generation;
        this.channelId = b.channelId;
        this.sessionName = b.sessionName;
        this.atMillis = b.atMillis;
        this.message = b.message;
        this.muxReadyPayloadJson = b.muxReadyPayloadJson;
        this.resolvedPath = b.resolvedPath;
        this.resolvedRelayTransport = b.resolvedRelayTransport;
        this.resolvedEndpoint = b.resolvedEndpoint;
        this.selectedIcePairJson = b.selectedIcePairJson;
    }

    public static AndroidConnectionServiceEvent bindTarget(AndroidConnectionServiceTarget target) {
        return new Builder(Type.BIND_TARGET).target(target).build();
    }

    public static AndroidConnectionServiceEvent setRoutePolicy(AndroidConnectionServiceRoutePolicy policy) {
        return new Builder(Type.SET_ROUTE_POLICY).policy(policy).build();
    }

    public static AndroidConnectionServiceEvent releaseTarget(String reason) {
        return new Builder(Type.RELEASE_TARGET).reason(reason).build();
    }

    public static AndroidConnectionServiceEvent transportOpening(String generation) {
        return new Builder(Type.TRANSPORT_OPENING).generation(generation).build();
    }

    public static AndroidConnectionServiceEvent transportResolved(
        String generation,
        String resolvedPath,
        String resolvedRelayTransport,
        String resolvedEndpoint,
        String selectedIcePairJson) {
        return new Builder(Type.TRANSPORT_RESOLVED)
            .generation(generation)
            .resolvedPath(resolvedPath)
            .resolvedRelayTransport(resolvedRelayTransport)
            .resolvedEndpoint(resolvedEndpoint)
            .selectedIcePairJson(selectedIcePairJson)
            .build();
    }

    public static AndroidConnectionServiceEvent muxReady(String generation, String muxReadyPayloadJson) {
        return new Builder(Type.MUX_READY).generation(generation)
            .muxReadyPayloadJson(muxReadyPayloadJson).build();
    }

    public static AndroidConnectionServiceEvent channelOpened(
        String generation, String channelId, String sessionName, long at) {
        return new Builder(Type.CHANNEL_OPENED).generation(generation).channelId(channelId)
            .sessionName(sessionName).at(at).build();
    }

    public static AndroidConnectionServiceEvent channelClosed(String generation, String channelId, String reason) {
        return new Builder(Type.CHANNEL_CLOSED).generation(generation).channelId(channelId).reason(reason).build();
    }

    public static AndroidConnectionServiceEvent heartbeatPong(String generation, long at) {
        return new Builder(Type.HEARTBEAT_PONG).generation(generation).at(at).build();
    }

    public static AndroidConnectionServiceEvent serverActivity(String generation, long at) {
        return new Builder(Type.SERVER_ACTIVITY).generation(generation).at(at).build();
    }

    public static AndroidConnectionServiceEvent heartbeatMissed(String generation) {
        return new Builder(Type.HEARTBEAT_MISSED).generation(generation).build();
    }

    public static AndroidConnectionServiceEvent transportFailure(String generation, String message) {
        return new Builder(Type.TRANSPORT_FAILURE).generation(generation).message(message).build();
    }

    public static AndroidConnectionServiceEvent authenticationFailure(String generation, String message) {
        return new Builder(Type.AUTHENTICATION_FAILURE).generation(generation).message(message).build();
    }

    public static AndroidConnectionServiceEvent terminalFailure(String generation, String message) {
        return new Builder(Type.TERMINAL_FAILURE).generation(generation).message(message).build();
    }

    public static AndroidConnectionServiceEvent reconnectAttempt(String generation, long at) {
        return new Builder(Type.RECONNECT_ATTEMPT).generation(generation).at(at).build();
    }

    public static AndroidConnectionServiceEvent backoffTimerFired(long at) {
        return new Builder(Type.BACKOFF_TIMER_FIRED).at(at).build();
    }

    public static final class Builder {
        private final Type type;
        private AndroidConnectionServiceTarget target;
        private AndroidConnectionServiceRoutePolicy policy;
        private String reason;
        private String generation;
        private String channelId;
        private String sessionName;
        private Long atMillis;
        private String message;
        private String muxReadyPayloadJson;
        private String resolvedPath;
        private String resolvedRelayTransport;
        private String resolvedEndpoint;
        private String selectedIcePairJson;

        public Builder(Type type) { this.type = type; }

        public Builder target(AndroidConnectionServiceTarget v) { this.target = v; return this; }
        public Builder policy(AndroidConnectionServiceRoutePolicy v) { this.policy = v; return this; }
        public Builder reason(String v) { this.reason = v; return this; }
        public Builder generation(String v) { this.generation = v; return this; }
        public Builder channelId(String v) { this.channelId = v; return this; }
        public Builder sessionName(String v) { this.sessionName = v; return this; }
        public Builder at(long v) { this.atMillis = v; return this; }
        public Builder message(String v) { this.message = v; return this; }
        public Builder muxReadyPayloadJson(String v) { this.muxReadyPayloadJson = v; return this; }
        public Builder resolvedPath(String v) { this.resolvedPath = v; return this; }
        public Builder resolvedRelayTransport(String v) { this.resolvedRelayTransport = v; return this; }
        public Builder resolvedEndpoint(String v) { this.resolvedEndpoint = v; return this; }
        public Builder selectedIcePairJson(String v) { this.selectedIcePairJson = v; return this; }

        public AndroidConnectionServiceEvent build() {
            if (generation == null && (type == Type.TRANSPORT_OPENING
                || type == Type.MUX_READY
                || type == Type.CHANNEL_OPENED
                || type == Type.CHANNEL_CLOSED
                || type == Type.HEARTBEAT_PONG
                || type == Type.SERVER_ACTIVITY
                || type == Type.HEARTBEAT_MISSED
                || type == Type.TRANSPORT_RESOLVED
                || type == Type.TRANSPORT_FAILURE
                || type == Type.AUTHENTICATION_FAILURE
                || type == Type.TERMINAL_FAILURE
                || type == Type.RECONNECT_ATTEMPT)) {
                throw new IllegalArgumentException("event " + type + " requires generation");
            }
            if (type == Type.MUX_READY
                && (muxReadyPayloadJson == null || muxReadyPayloadJson.trim().isEmpty())) {
                throw new IllegalArgumentException("event MUX_READY requires exact payload");
            }
            if (type == Type.CHANNEL_OPENED
                && (sessionName == null || sessionName.trim().isEmpty())) {
                throw new IllegalArgumentException("event CHANNEL_OPENED requires sessionName");
            }
            return new AndroidConnectionServiceEvent(this);
        }
    }
}
