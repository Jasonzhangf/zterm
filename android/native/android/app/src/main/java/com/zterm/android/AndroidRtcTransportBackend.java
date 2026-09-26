package com.zterm.android;

import android.content.Context;
import android.util.Log;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.webrtc.DataChannel;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * Native WebRTC physical transport for AndroidConnectionService.
 *
 * Owns only the candidate-specific PeerConnection / ICE / DataChannel and the
 * relay signaling socket. It does not own route policy, generation, retry,
 * mux channel registry, heartbeat, or reconnect; those remain in
 * AndroidConnectionService.
 */
public final class AndroidRtcTransportBackend extends WebSocketListener {
    private static final String TAG = "ZTermRtcBackend";
    static final long RTC_DIRECT_OPEN_STABILITY_MS = 1_000L;

    public interface Listener {
        void onRtcOpen();
        void onRtcText(String text);
        void onRtcError(String message);
        void onRtcClosed(int code, String reason);
    }

    private final Context context;
    private final OkHttpClient httpClient;
    private final String signalUrl;
    private final JSONArray iceServers;
    private final String iceTransportPolicy;
    private final boolean direct;
    private final long directOpenStabilityMs;
    private final Listener listener;
    private final ScheduledExecutorService stabilityScheduler;

    private WebSocket signalSocket;
    private PeerConnectionFactory peerConnectionFactory;
    private PeerConnection peerConnection;
    private DataChannel dataChannel;
    private volatile DataChannel.State dataChannelState = DataChannel.State.CONNECTING;
    private boolean disposed;
    private boolean openPublished;
    private ScheduledFuture<?> stabilityFuture;
    private static final int MAX_PENDING_REMOTE_ICE_CANDIDATES = 64;
    private final List<IceCandidate> pendingRemoteIceCandidates = new ArrayList<>();

    public AndroidRtcTransportBackend(
        Context context,
        OkHttpClient httpClient,
        String signalUrl,
        JSONArray iceServers,
        String iceTransportPolicy,
        boolean direct,
        Listener listener
    ) {
        this(context, httpClient, signalUrl, iceServers, iceTransportPolicy, direct,
            RTC_DIRECT_OPEN_STABILITY_MS, listener);
    }

    AndroidRtcTransportBackend(
        Context context,
        OkHttpClient httpClient,
        String signalUrl,
        JSONArray iceServers,
        String iceTransportPolicy,
        boolean direct,
        long directOpenStabilityMs,
        Listener listener
    ) {
        this.context = context;
        this.httpClient = httpClient;
        this.signalUrl = signalUrl;
        this.iceServers = iceServers == null ? new JSONArray() : iceServers;
        this.iceTransportPolicy = iceTransportPolicy == null || iceTransportPolicy.trim().isEmpty()
            ? "all" : iceTransportPolicy.trim().toLowerCase(Locale.ROOT);
        this.direct = direct;
        this.directOpenStabilityMs = Math.max(0L, directOpenStabilityMs);
        this.listener = listener;
        this.stabilityScheduler = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "zterm-rtc-stability");
            thread.setDaemon(true);
            return thread;
        });
    }

    public void open() {
        if (signalUrl == null || signalUrl.trim().isEmpty()) {
            listener.onRtcError("rtc signal url missing");
            return;
        }
        Request request = new Request.Builder().url(signalUrl.trim()).build();
        try {
            signalSocket = httpClient.newWebSocket(request, this);
        } catch (RuntimeException error) {
            listener.onRtcError("rtc signal websocket open rejected: " + error.getMessage());
        }
    }

    public boolean isOpen() {
        return !disposed && openPublished && dataChannelState == DataChannel.State.OPEN;
    }

    public boolean sendText(String text) {
        if (!isOpen()) {
            return false;
        }
        if (dataChannel == null) {
            return false;
        }
        return dataChannel.send(new DataChannel.Buffer(
            ByteBuffer.wrap(text.getBytes(StandardCharsets.UTF_8)), false));
    }

    public void closeQuietly(String reason) {
        if (disposed) {
            return;
        }
        disposed = true;
        openPublished = false;
        cancelStabilityFuture();
        stabilityScheduler.shutdownNow();
        DataChannel channel = dataChannel;
        PeerConnection peer = peerConnection;
        WebSocket signal = signalSocket;
        dataChannel = null;
        peerConnection = null;
        signalSocket = null;
        if (channel != null) {
            channel.unregisterObserver();
            try {
                channel.close();
            } catch (RuntimeException ignored) {
                // best-effort teardown
            }
            channel.dispose();
        }
        if (peer != null) {
            peer.close();
            peer.dispose();
        }
        if (signal != null) {
            signal.close(1000, reason);
        }
        if (peerConnectionFactory != null) {
            peerConnectionFactory.dispose();
            peerConnectionFactory = null;
        }
    }

    @Override
    public void onOpen(WebSocket webSocket, Response response) {
        if (disposed || signalSocket != webSocket) {
            return;
        }
        initializePeerConnection();
    }

    @Override
    public void onMessage(WebSocket webSocket, String text) {
        if (disposed || signalSocket != webSocket) {
            return;
        }
        handleSignalMessage(text);
    }

    @Override
    public void onMessage(WebSocket webSocket, ByteString bytes) {
        if (disposed || signalSocket != webSocket) {
            return;
        }
        handleSignalMessage(bytes.utf8());
    }

    @Override
    public void onFailure(WebSocket webSocket, Throwable throwable, @Nullable Response response) {
        if (disposed || signalSocket != webSocket) {
            return;
        }
        listener.onRtcError(throwable == null ? "rtc signaling websocket failure"
            : "rtc signaling websocket failure: " + throwable.getMessage());
        closeQuietly("rtc signaling websocket failure");
    }

    @Override
    public void onClosed(WebSocket webSocket, int code, String reason) {
        if (disposed || signalSocket != webSocket) {
            return;
        }
        if (isOpen()) {
            return;
        }
        listener.onRtcClosed(code, reason == null ? "rtc signaling websocket closed" : reason);
        closeQuietly(reason == null ? "rtc signaling websocket closed" : reason);
    }

    private void initializePeerConnection() {
        try {
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions());
            peerConnectionFactory = PeerConnectionFactory.builder().createPeerConnectionFactory();

            PeerConnection.RTCConfiguration configuration =
                new PeerConnection.RTCConfiguration(parseIceServers());
            configuration.iceTransportsType = resolveIceTransportsType(iceTransportPolicy);
            peerConnection = peerConnectionFactory.createPeerConnection(configuration, peerObserver);
            if (peerConnection == null) {
                throw new IllegalStateException("peer connection factory returned null");
            }

            DataChannel.Init init = new DataChannel.Init();
            init.ordered = true;
            dataChannel = peerConnection.createDataChannel("zterm", init);
            dataChannel.registerObserver(dataObserver);

            boolean initSent = sendSignal("rtc-init", payload -> {
                payload.put("iceServers", iceServers);
                payload.put("iceTransportPolicy", iceTransportPolicy);
                return payload;
            });
            if (!initSent) {
                throw new IllegalStateException("rtc signaling websocket closed before init");
            }
            peerConnection.createOffer(sdpObserver, new MediaConstraints());
        } catch (RuntimeException | JSONException error) {
            listener.onRtcError(error.getMessage() == null ? "rtc init error" : error.getMessage());
            closeQuietly("rtc init error");
        }
    }

    void handleSignalMessage(String raw) {
        try {
            JSONObject message = new JSONObject(raw);
            String type = message.optString("type", "");
            JSONObject payload = message.optJSONObject("payload");
            if ("rtc-error".equals(type)) {
                String reason = payload == null || payload.isNull("message")
                    ? "rtc signaling error" : payload.optString("message", "rtc signaling error");
                listener.onRtcClosed(4004, reason);
                closeQuietly(reason);
                return;
            }
            if ("rtc-answer".equals(type) && payload != null) {
                if (peerConnection == null) {
                    listener.onRtcError("rtc answer before peer init");
                    return;
                }
                String sdp = payload.optString("sdp", "");
                peerConnection.setRemoteDescription(answerObserver,
                    new SessionDescription(SessionDescription.Type.ANSWER, sdp));
                flushPendingIceCandidates();
                return;
            }
            if ("rtc-candidate".equals(type) && payload != null) {
                IceCandidate candidate = parseIceCandidate(payload);
                if (candidate == null) {
                    return;
                }
                if (!isRelay() && !shouldAcceptIceCandidate(candidate.sdp)) {
                    return;
                }
                if (peerConnection == null || peerConnection.getRemoteDescription() == null) {
                    if (pendingRemoteIceCandidates.size() >= MAX_PENDING_REMOTE_ICE_CANDIDATES) {
                        listener.onRtcError("rtc remote ICE candidate queue full before answer");
                        closeQuietly("rtc remote ICE candidate queue full");
                        return;
                    }
                    pendingRemoteIceCandidates.add(candidate);
                    return;
                }
                peerConnection.addIceCandidate(candidate);
            }
        } catch (JSONException error) {
            listener.onRtcError("rtc signaling parse error: " + error.getMessage());
        }
    }

    private void flushPendingIceCandidates() {
        if (peerConnection == null || peerConnection.getRemoteDescription() == null) {
            return;
        }
        for (IceCandidate candidate : pendingRemoteIceCandidates) {
            peerConnection.addIceCandidate(candidate);
        }
        pendingRemoteIceCandidates.clear();
    }

    private List<PeerConnection.IceServer> parseIceServers() {
        List<PeerConnection.IceServer> servers = new ArrayList<>();
        for (int i = 0; i < iceServers.length(); i++) {
            JSONObject server = iceServers.optJSONObject(i);
            if (server == null) {
                continue;
            }
            String username = server.optString("username", "");
            String credential = server.optString("credential", "");
            JSONArray urls = server.optJSONArray("urls");
            if (urls != null) {
                for (int j = 0; j < urls.length(); j++) {
                    String url = urls.optString(j, "");
                    if (!url.trim().isEmpty()) {
                        addIceServer(servers, url.trim(), username, credential);
                    }
                }
            } else {
                String url = server.optString("url", "");
                if (!url.trim().isEmpty()) {
                    addIceServer(servers, url.trim(), username, credential);
                }
            }
        }
        return servers;
    }

    private static void addIceServer(List<PeerConnection.IceServer> servers,
                                     String url,
                                     String username,
                                     String credential) {
        PeerConnection.IceServer.Builder builder = PeerConnection.IceServer.builder(url.trim());
        if (username != null && !username.trim().isEmpty()) {
            builder.setUsername(username);
        }
        if (credential != null && !credential.trim().isEmpty()) {
            builder.setPassword(credential);
        }
        servers.add(builder.createIceServer());
    }

    private static IceCandidate parseIceCandidate(JSONObject payload) throws JSONException {
        String candidate = payload.optString("candidate", "");
        if (candidate.trim().isEmpty()) {
            return null;
        }
        String sdpMid = payload.optString("sdpMid", "");
        int sdpMLineIndex = payload.optInt("sdpMLineIndex", 0);
        return new IceCandidate(sdpMid, sdpMLineIndex, candidate);
    }

    private boolean sendSignal(String type, PayloadWriter writer) throws JSONException {
        if (signalSocket == null) {
            return false;
        }
        JSONObject message = new JSONObject();
        message.put("type", type);
        JSONObject payload = writer.write(new JSONObject());
        message.put("payload", payload);
        return signalSocket.send(message.toString());
    }

    private interface PayloadWriter {
        JSONObject write(JSONObject payload) throws JSONException;
    }

    private final SdpObserver sdpObserver = new SdpObserver() {
        @Override
        public void onCreateSuccess(SessionDescription sessionDescription) {
            if (disposed || peerConnection == null) {
                return;
            }
            peerConnection.setLocalDescription(setLocalObserver, sessionDescription);
        }

        @Override
        public void onSetSuccess() {
        }

        @Override
        public void onCreateFailure(String s) {
            listener.onRtcError("rtc create offer failure: " + s);
            closeQuietly("rtc create offer failure");
        }

        @Override
        public void onSetFailure(String s) {
            listener.onRtcError("rtc set offer failure: " + s);
            closeQuietly("rtc set offer failure");
        }
    };

    private final SdpObserver setLocalObserver = new SdpObserver() {
        @Override
        public void onCreateSuccess(SessionDescription sessionDescription) {
        }

        @Override
        public void onSetSuccess() {
            try {
                SessionDescription description = peerConnection.getLocalDescription();
                boolean sent = sendSignal("rtc-offer", payload -> {
                    payload.put("sdp", isRelay() ? description.description : stripDirectSdp(description.description));
                    payload.put("type", description.type.canonicalForm());
                    return payload;
                });
                if (!sent) {
                    listener.onRtcError("rtc signaling websocket closed before offer");
                    closeQuietly("rtc signaling websocket closed before offer");
                }
            } catch (JSONException error) {
                listener.onRtcError("rtc offer serialization failure: " + error.getMessage());
                closeQuietly("rtc offer serialization failure");
            }
        }

        @Override
        public void onCreateFailure(String s) {
        }

        @Override
        public void onSetFailure(String s) {
            listener.onRtcError("rtc set local offer failure: " + s);
            closeQuietly("rtc set local offer failure");
        }
    };

    private final SdpObserver answerObserver = new SdpObserver() {
        @Override
        public void onCreateSuccess(SessionDescription sessionDescription) {
        }

        @Override
        public void onSetSuccess() {
            flushPendingIceCandidates();
        }

        @Override
        public void onCreateFailure(String s) {
        }

        @Override
        public void onSetFailure(String s) {
            listener.onRtcError("rtc set remote answer failure: " + s);
            closeQuietly("rtc set remote answer failure");
        }
    };

    private final PeerConnection.Observer peerObserver = new PeerConnection.Observer() {
        @Override
        public void onSignalingChange(PeerConnection.SignalingState signalingState) {
        }

        @Override
        public void onIceConnectionChange(PeerConnection.IceConnectionState iceConnectionState) {
            if (iceConnectionState == PeerConnection.IceConnectionState.FAILED
                || iceConnectionState == PeerConnection.IceConnectionState.CLOSED) {
                listener.onRtcClosed(1006, "rtc ice connection " + iceConnectionState.name().toLowerCase(Locale.ROOT));
                closeQuietly("rtc ice connection " + iceConnectionState.name().toLowerCase(Locale.ROOT));
            }
        }

        @Override
        public void onIceConnectionReceivingChange(boolean b) {
        }

        @Override
        public void onIceGatheringChange(PeerConnection.IceGatheringState iceGatheringState) {
        }

        @Override
        public void onIceCandidate(IceCandidate iceCandidate) {
            if (disposed || signalSocket == null) {
                return;
            }
            if (!isRelay() && !shouldSignalIceCandidate(iceCandidate)) {
                return;
            }
            try {
                boolean sent = sendSignal("rtc-candidate", payload -> {
                    payload.put("candidate", iceCandidate.sdp);
                    payload.put("sdpMid", iceCandidate.sdpMid);
                    payload.put("sdpMLineIndex", iceCandidate.sdpMLineIndex);
                    return payload;
                });
                if (!sent) {
                    Log.w(TAG, "rtc signaling websocket closed before candidate");
                }
            } catch (JSONException error) {
                Log.w(TAG, "failed to serialize ice candidate", error);
            }
        }

        @Override
        public void onIceCandidatesRemoved(IceCandidate[] iceCandidates) {
        }

        @Override
        public void onAddStream(org.webrtc.MediaStream mediaStream) {
        }

        @Override
        public void onRemoveStream(org.webrtc.MediaStream mediaStream) {
        }

        @Override
        public void onDataChannel(DataChannel channel) {
        }

        @Override
        public void onRenegotiationNeeded() {
        }
    };

    private final DataChannel.Observer dataObserver = new DataChannel.Observer() {
        @Override
        public void onBufferedAmountChange(long l) {
        }

        @Override
        public void onStateChange() {
            DataChannel channel = dataChannel;
            if (channel == null) {
                return;
            }
            handleDataChannelState(channel.state());
        }

        @Override
        public void onMessage(DataChannel.Buffer buffer) {
            ByteBuffer data = buffer.data;
            byte[] bytes = new byte[data.remaining()];
            data.get(bytes);
            if (buffer.binary) {
                listener.onRtcError("rtc binary data channel frames not supported");
                closeQuietly("rtc binary data channel frame");
                return;
            }
            listener.onRtcText(new String(bytes, StandardCharsets.UTF_8));
        }
    };

    /** Test seam: drive the data-channel state machine without native WebRTC. */
    void simulateDataChannelStateForTests(DataChannel.State state) {
        handleDataChannelState(state);
    }

    private void handleDataChannelState(DataChannel.State state) {
        dataChannelState = state;
        if (disposed) {
            return;
        }
        if (state == DataChannel.State.OPEN && !openPublished) {
            if (direct) {
                scheduleDirectOpenPublish();
            } else {
                publishOpen();
            }
            return;
        }
        if (state == DataChannel.State.CLOSED) {
            cancelStabilityFuture();
            listener.onRtcClosed(1000, "rtc data channel closed");
            closeQuietly("rtc data channel closed");
        }
    }

    private void scheduleDirectOpenPublish() {
        cancelStabilityFuture();
        stabilityFuture = stabilityScheduler.schedule(() -> {
            if (disposed || openPublished || dataChannelState != DataChannel.State.OPEN) {
                return;
            }
            publishOpen();
        }, directOpenStabilityMs, TimeUnit.MILLISECONDS);
    }

    private void publishOpen() {
        if (disposed || openPublished || dataChannelState != DataChannel.State.OPEN) {
            return;
        }
        openPublished = true;
        listener.onRtcOpen();
    }

    private void cancelStabilityFuture() {
        ScheduledFuture<?> future = stabilityFuture;
        stabilityFuture = null;
        if (future != null) {
            future.cancel(false);
        }
    }

    private boolean isRelay() {
        return "relay".equals(iceTransportPolicy);
    }

    static PeerConnection.IceTransportsType resolveIceTransportsType(String iceTransportPolicy) {
        return "relay".equals(iceTransportPolicy)
            ? PeerConnection.IceTransportsType.RELAY
            : PeerConnection.IceTransportsType.ALL;
    }

    static boolean shouldSignalIceCandidate(IceCandidate candidate) {
        return shouldPublishDirectCandidate(candidate.sdp);
    }

    static boolean shouldAcceptIceCandidate(String candidateSdp) {
        return shouldPublishDirectCandidate(candidateSdp);
    }

    static boolean shouldPublishDirectCandidate(String candidateSdp) {
        String type = iceCandidateType(candidateSdp);
        if (!"srflx".equals(type) && !"prflx".equals(type)) {
            return false;
        }
        return !isTailscaleIceCandidate(candidateSdp);
    }

    static boolean isTailscaleIceCandidate(String candidateSdp) {
        return candidateSdp.contains("100.6")
            || candidateSdp.contains("100.7")
            || candidateSdp.contains("100.8")
            || candidateSdp.contains("100.9")
            || candidateSdp.contains("100.10")
            || candidateSdp.contains("100.11")
            || candidateSdp.contains("100.12")
            || candidateSdp.contains("fd7a:115c:a1e0:");
    }

    static String iceCandidateType(String candidateSdp) {
        String[] parts = candidateSdp.split(" ");
        for (int i = 0; i + 1 < parts.length; i++) {
            if ("typ".equals(parts[i])) {
                return parts[i + 1];
            }
        }
        return "";
    }

    static String stripDirectSdp(String sdp) {
        if (sdp == null) {
            return "";
        }
        StringBuilder out = new StringBuilder();
        String[] lines = sdp.split("\\r?\\n");
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i];
            if (line.startsWith("a=candidate:")
                && !shouldPublishDirectCandidate(line.substring("a=candidate:".length()))) {
                continue;
            }
            if (out.length() > 0) {
                out.append("\r\n");
            }
            out.append(line);
        }
        return out.toString();
    }
}
