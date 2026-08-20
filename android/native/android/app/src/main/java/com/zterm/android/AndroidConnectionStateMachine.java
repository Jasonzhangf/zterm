package com.zterm.android;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Pure AndroidConnectionService state machine.
 *
 * All methods are synchronized so production Service callers and JVM tests use
 * the same transition function. No Android framework type is referenced here.
 */
public final class AndroidConnectionStateMachine {
    public interface Listener {
        void onSnapshot(AndroidConnectionServiceSnapshot snapshot);
    }

    private static final int HEARTBEAT_MISSES_BEFORE_RECONNECT = 3;
    private static final long INITIAL_BACKOFF_MS = 1_000L;

    private final Listener listener;
    private final Set<String> retiredGenerations = new HashSet<>();
    private AndroidConnectionServiceSnapshot snapshot = AndroidConnectionServiceSnapshot.empty();
    private int consecutiveHeartbeatMisses = 0;

    public AndroidConnectionStateMachine(Listener listener) {
        this.listener = listener;
    }

    public synchronized AndroidConnectionServiceSnapshot readSnapshot() {
        return snapshot;
    }

    /**
     * @return true if the event was accepted; false when it was stale or
     *         invalid for the current state.
     */
    public synchronized boolean dispatch(AndroidConnectionServiceEvent event, long nowMillis) {
        if (event == null) return false;

        if (event.type == AndroidConnectionServiceEvent.Type.BIND_TARGET) {
            if (event.target == null) return false;
            snapshot = new AndroidConnectionServiceSnapshot.Builder(
                AndroidConnectionServiceSnapshot.State.RESOLVING_TARGET)
                .target(event.target)
                .route(snapshot.route)
                .build();
            retiredGenerations.clear();
            consecutiveHeartbeatMisses = 0;
            publish();
            return true;
        }

        if (event.type == AndroidConnectionServiceEvent.Type.SET_ROUTE_POLICY) {
            if (event.policy == null) return false;
            snapshot = snapshot.toBuilder().route(event.policy).build();
            publish();
            return true;
        }

        if (event.type == AndroidConnectionServiceEvent.Type.RELEASE_TARGET) {
            AndroidConnectionServiceRoutePolicy route = snapshot.route;
            snapshot = new AndroidConnectionServiceSnapshot.Builder(
                AndroidConnectionServiceSnapshot.State.IDLE)
                .route(route)
                .build();
            retiredGenerations.clear();
            consecutiveHeartbeatMisses = 0;
            publish();
            return true;
        }

        if (event.type == AndroidConnectionServiceEvent.Type.TRANSPORT_OPENING) {
            if (event.generation == null || retiredGenerations.contains(event.generation)) return false;
        } else if (requiresGeneration(event.type)) {
            if (event.generation == null
                || snapshot.generation == null
                || !snapshot.generation.equals(event.generation)
                || retiredGenerations.contains(event.generation)) {
                return false;
            }
        }

        switch (event.type) {
            case TRANSPORT_OPENING:
                if (snapshot.state != AndroidConnectionServiceSnapshot.State.RESOLVING_TARGET
                    && snapshot.state != AndroidConnectionServiceSnapshot.State.BACKOFF_RECONNECT) return false;
                consecutiveHeartbeatMisses = 0;
                snapshot = snapshot.toBuilder()
                    .generation(event.generation)
                    .muxReadyPayloadJson(null)
                    .nextRetryAt(null)
                    .error(null)
                    .build();
                snapshot = copyWithState(snapshot, AndroidConnectionServiceSnapshot.State.CONNECTING);
                publish();
                return true;

            case MUX_READY:
                if (snapshot.state != AndroidConnectionServiceSnapshot.State.CONNECTING
                    && snapshot.state != AndroidConnectionServiceSnapshot.State.MUX_READY) return false;
                consecutiveHeartbeatMisses = 0;
                snapshot = copyWithState(snapshot.toBuilder()
                    .error(null)
                    .muxReadyPayloadJson(event.muxReadyPayloadJson)
                    .build(),
                    AndroidConnectionServiceSnapshot.State.MUX_READY);
                publish();
                return true;

            case CHANNEL_OPENED:
                if (snapshot.state != AndroidConnectionServiceSnapshot.State.MUX_READY
                    && snapshot.state != AndroidConnectionServiceSnapshot.State.CHANNELS_READY) return false;
                if (event.channelId == null || event.channelId.trim().isEmpty()) return false;
                List<AndroidConnectionServiceSnapshot.Channel> channels = new ArrayList<>(snapshot.channels);
                boolean exists = false;
                for (AndroidConnectionServiceSnapshot.Channel channel : channels) {
                    if (channel.channelId.equals(event.channelId)) {
                        exists = true;
                        break;
                    }
                }
                if (!exists) {
                    channels.add(new AndroidConnectionServiceSnapshot.Channel(
                        event.channelId,
                        AndroidConnectionServiceSnapshot.Channel.State.OPEN));
                }
                snapshot = copyWithState(snapshot.toBuilder()
                    .channels(channels)
                    .lastActivityAt(event.atMillis == null ? nowMillis : event.atMillis)
                    .error(null)
                    .build(), AndroidConnectionServiceSnapshot.State.CHANNELS_READY);
                publish();
                return true;

            case CHANNEL_CLOSED:
                if (event.channelId == null || event.channelId.trim().isEmpty()) return false;
                List<AndroidConnectionServiceSnapshot.Channel> closedChannels = new ArrayList<>();
                for (AndroidConnectionServiceSnapshot.Channel channel : snapshot.channels) {
                    if (channel.channelId.equals(event.channelId)) {
                        closedChannels.add(new AndroidConnectionServiceSnapshot.Channel(
                            channel.channelId,
                            AndroidConnectionServiceSnapshot.Channel.State.CLOSED));
                    } else {
                        closedChannels.add(channel);
                    }
                }
                snapshot = snapshot.toBuilder().channels(closedChannels).lastActivityAt(nowMillis).build();
                publish();
                return true;

            case HEARTBEAT_PONG:
                if (!isConnectedState(snapshot.state)) return false;
                consecutiveHeartbeatMisses = 0;
                long pongAt = event.atMillis == null ? nowMillis : event.atMillis;
                snapshot = copyWithState(snapshot.toBuilder()
                    .lastHeartbeatAt(pongAt)
                    .lastActivityAt(pongAt)
                    .error(null)
                    .build(), AndroidConnectionServiceSnapshot.State.HEALTHY);
                publish();
                return true;

            case SERVER_ACTIVITY:
                if (!isConnectedState(snapshot.state)) return false;
                consecutiveHeartbeatMisses = 0;
                snapshot = snapshot.toBuilder()
                    .lastActivityAt(event.atMillis == null ? nowMillis : event.atMillis)
                    .error(null)
                    .build();
                publish();
                return true;

            case HEARTBEAT_MISSED:
                if (!isConnectedState(snapshot.state)) return false;
                consecutiveHeartbeatMisses += 1;
                if (consecutiveHeartbeatMisses < HEARTBEAT_MISSES_BEFORE_RECONNECT) {
                    publish();
                    return true;
                }
                retiredGenerations.add(event.generation);
                consecutiveHeartbeatMisses = 0;
                snapshot = new AndroidConnectionServiceSnapshot.Builder(
                    AndroidConnectionServiceSnapshot.State.BACKOFF_RECONNECT)
                    .target(snapshot.target)
                    .route(snapshot.route)
                    .lastActivityAt(nowMillis)
                    .nextRetryAt(nowMillis + INITIAL_BACKOFF_MS)
                    .error(new AndroidConnectionServiceSnapshot.ErrorValue(
                        "heartbeat-timeout", "mux heartbeat budget exhausted"))
                    .build();
                publish();
                return true;

            case TRANSPORT_FAILURE:
                retiredGenerations.add(event.generation);
                consecutiveHeartbeatMisses = 0;
                snapshot = new AndroidConnectionServiceSnapshot.Builder(
                    AndroidConnectionServiceSnapshot.State.BACKOFF_RECONNECT)
                    .target(snapshot.target)
                    .route(snapshot.route)
                    .lastActivityAt(nowMillis)
                    .nextRetryAt(nowMillis + INITIAL_BACKOFF_MS)
                    .error(new AndroidConnectionServiceSnapshot.ErrorValue(
                        "transport", safeMessage(event.message, "physical transport failed")))
                    .build();
                publish();
                return true;

            case AUTHENTICATION_FAILURE:
                retiredGenerations.add(event.generation);
                consecutiveHeartbeatMisses = 0;
                snapshot = copyWithState(snapshot.toBuilder()
                    .generation(null)
                    .nextRetryAt(null)
                    .error(new AndroidConnectionServiceSnapshot.ErrorValue(
                        "authentication", safeMessage(event.message, "authentication rejected")))
                    .build(), AndroidConnectionServiceSnapshot.State.AUTHENTICATION_ERROR);
                publish();
                return true;

            case TERMINAL_FAILURE:
            case WEBRTC_NOT_SUPPORTED:
                retiredGenerations.add(event.generation);
                consecutiveHeartbeatMisses = 0;
                String errorCode = event.type == AndroidConnectionServiceEvent.Type.WEBRTC_NOT_SUPPORTED
                    ? "webrtc-not-supported" : "terminal";
                snapshot = copyWithState(snapshot.toBuilder()
                    .generation(null)
                    .nextRetryAt(null)
                    .error(new AndroidConnectionServiceSnapshot.ErrorValue(
                        errorCode, safeMessage(event.message, "terminal failure")))
                    .build(), AndroidConnectionServiceSnapshot.State.TERMINAL_ERROR);
                publish();
                return true;

            case RECONNECT_ATTEMPT:
            case BACKOFF_TIMER_FIRED:
                if (snapshot.state != AndroidConnectionServiceSnapshot.State.BACKOFF_RECONNECT) return false;
                snapshot = copyWithState(snapshot.toBuilder()
                    .nextRetryAt(null)
                    .error(null)
                    .build(), AndroidConnectionServiceSnapshot.State.RESOLVING_TARGET);
                publish();
                return true;

            default:
                return false;
        }
    }

    private static boolean requiresGeneration(AndroidConnectionServiceEvent.Type type) {
        switch (type) {
            case MUX_READY:
            case CHANNEL_OPENED:
            case CHANNEL_CLOSED:
            case HEARTBEAT_PONG:
            case SERVER_ACTIVITY:
            case HEARTBEAT_MISSED:
            case TRANSPORT_FAILURE:
            case AUTHENTICATION_FAILURE:
            case TERMINAL_FAILURE:
            case WEBRTC_NOT_SUPPORTED:
                return true;
            default:
                return false;
        }
    }

    private static boolean isConnectedState(AndroidConnectionServiceSnapshot.State state) {
        return state == AndroidConnectionServiceSnapshot.State.MUX_READY
            || state == AndroidConnectionServiceSnapshot.State.CHANNELS_READY
            || state == AndroidConnectionServiceSnapshot.State.HEALTHY;
    }

    private static AndroidConnectionServiceSnapshot copyWithState(
        AndroidConnectionServiceSnapshot source,
        AndroidConnectionServiceSnapshot.State state) {
        return new AndroidConnectionServiceSnapshot.Builder(state)
            .generation(source.generation)
            .target(source.target)
            .route(source.route)
            .channels(source.channels)
            .lastHeartbeatAt(source.lastHeartbeatAt)
            .lastActivityAt(source.lastActivityAt)
            .nextRetryAt(source.nextRetryAt)
            .error(source.error)
            .muxReadyPayloadJson(source.muxReadyPayloadJson)
            .build();
    }

    private static String safeMessage(String message, String fallback) {
        return message == null || message.trim().isEmpty() ? fallback : message;
    }

    private void publish() {
        if (listener != null) listener.onSnapshot(snapshot);
    }
}
