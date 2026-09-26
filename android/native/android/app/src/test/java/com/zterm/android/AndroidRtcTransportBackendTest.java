package com.zterm.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.junit.Test;
import org.webrtc.DataChannel;
import org.webrtc.PeerConnection;
import okhttp3.WebSocket;

import java.lang.reflect.Field;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public final class AndroidRtcTransportBackendTest {
    private static final class RecordingListener
        implements AndroidRtcTransportBackend.Listener {
        final List<String> events = Collections.synchronizedList(new ArrayList<>());
        final List<Integer> closedCodes = Collections.synchronizedList(new ArrayList<>());

        @Override
        public void onRtcOpen() {
            events.add("open");
        }

        @Override
        public void onRtcText(String text) {
            events.add("text:" + text);
        }

        @Override
        public void onRtcError(String message) {
            events.add("error:" + message);
        }

        @Override
        public void onRtcClosed(int code, String reason) {
            closedCodes.add(code);
            events.add("closed:" + code + ":" + reason);
        }
    }

    @Test
    public void directStabilityWindowDefersOpenUntilChannelIsStable() throws Exception {
        RecordingListener listener = new RecordingListener();
        AndroidRtcTransportBackend backend = new AndroidRtcTransportBackend(
            null, null, "wss://relay.example/client", new JSONArray(), "all",
            true, 50L, listener);

        backend.simulateDataChannelStateForTests(DataChannel.State.OPEN);
        assertTrue("open must be deferred inside the direct stability window",
            !listener.events.contains("open"));

        CountDownLatch openLatch = new CountDownLatch(1);
        Thread waiter = new Thread(() -> {
            while (!listener.events.contains("open")) {
                if (listener.closedCodes.size() > 0) {
                    return;
                }
                try {
                    Thread.sleep(5L);
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
            openLatch.countDown();
        });
        waiter.start();
        assertTrue("open must publish after the stability window",
            openLatch.await(1L, TimeUnit.SECONDS));
        backend.closeQuietly("test");
    }

    @Test
    public void closeBeforeDirectStabilityFailsCandidateWithoutOpen() throws Exception {
        RecordingListener listener = new RecordingListener();
        AndroidRtcTransportBackend backend = new AndroidRtcTransportBackend(
            null, null, "wss://relay.example/client", new JSONArray(), "all",
            true, 5_000L, listener);

        backend.simulateDataChannelStateForTests(DataChannel.State.OPEN);
        backend.simulateDataChannelStateForTests(DataChannel.State.CLOSED);

        assertEquals("candidate must close inside stability window",
            Collections.singletonList(1000), listener.closedCodes);
        assertFalse("open must never publish for a close-before-open candidate",
            listener.events.contains("open"));
        Thread.sleep(40L);
        assertFalse("late open must not publish after close",
            listener.events.contains("open"));
        backend.closeQuietly("test");
    }

    @Test
    public void relayOpensImmediatelyWhenDataChannelBecomesOpen() {
        RecordingListener listener = new RecordingListener();
        AndroidRtcTransportBackend backend = new AndroidRtcTransportBackend(
            null, null, "wss://relay.example/client", new JSONArray(), "relay",
            false, 5_000L, listener);

        backend.simulateDataChannelStateForTests(DataChannel.State.OPEN);

        assertTrue(listener.events.contains("open"));
        backend.closeQuietly("test");
    }

    @Test
    public void signalingFailureAfterOpenPreservesHealthyRtcTransport() throws Exception {
        RecordingListener listener = new RecordingListener();
        AndroidRtcTransportBackend backend = new AndroidRtcTransportBackend(
            null, null, "wss://relay.example/client", new JSONArray(), "all",
            false, 5_000L, listener);
        WebSocket webSocket = (WebSocket) Proxy.newProxyInstance(
            WebSocket.class.getClassLoader(),
            new Class<?>[] { WebSocket.class },
            (proxy, method, args) -> {
                if ("toString".equals(method.getName())) {
                    return "fake-signal-websocket";
                }
                if (method.getReturnType() == boolean.class) {
                    return false;
                }
                if (method.getReturnType() == int.class) {
                    return 0;
                }
                return null;
            });
        Field signalSocketField = AndroidRtcTransportBackend.class
            .getDeclaredField("signalSocket");
        signalSocketField.setAccessible(true);
        signalSocketField.set(backend, webSocket);

        backend.simulateDataChannelStateForTests(DataChannel.State.OPEN);
        assertTrue(listener.events.contains("open"));

        backend.onFailure(webSocket, new RuntimeException("signaling websocket down"), null);

        assertTrue("healthy RTC must stay open after a signaling websocket failure",
            backend.isOpen());
        assertTrue("no error or close may be published after open",
            listener.events.stream().noneMatch(event ->
                event.startsWith("error:") || event.startsWith("closed:")));
        backend.closeQuietly("test");
    }

    @Test
    public void signalingErrorReportsRtcClosed4004() {
        RecordingListener listener = new RecordingListener();
        AndroidRtcTransportBackend backend = new AndroidRtcTransportBackend(
            null, null, "wss://relay.example/client", new JSONArray(), "all",
            true, 1_000L, listener);

        backend.handleSignalMessage(
            "{\"type\":\"rtc-error\",\"payload\":{\"message\":\"bad\"}}");

        assertEquals(Collections.singletonList(4004), listener.closedCodes);
        assertTrue(listener.events.get(0).contains("closed:4004:bad"));
    }

    @Test
    public void answerBeforePeerInitIsTypedError() {
        RecordingListener listener = new RecordingListener();
        AndroidRtcTransportBackend backend = new AndroidRtcTransportBackend(
            null, null, "wss://relay.example/client", new JSONArray(), "all",
            true, 1_000L, listener);

        backend.handleSignalMessage(
            "{\"type\":\"rtc-answer\",\"payload\":{\"sdp\":\"v=0\"}}");

        assertTrue(listener.events.contains("error:rtc answer before peer init"));
        backend.closeQuietly("test");
    }

    @Test
    public void iceTransportPolicyMapsRelayAndDirect() {
        assertEquals(PeerConnection.IceTransportsType.RELAY,
            AndroidRtcTransportBackend.resolveIceTransportsType("relay"));
        assertEquals(PeerConnection.IceTransportsType.ALL,
            AndroidRtcTransportBackend.resolveIceTransportsType("all"));
        assertEquals(PeerConnection.IceTransportsType.ALL,
            AndroidRtcTransportBackend.resolveIceTransportsType(""));
    }

    @Test
    public void directSdpStripKeepsOnlySrflxAndPrflxNonTailscaleCandidates() {
        String sdp = "v=0\r\n"
            + "a=candidate:1 1 udp 2113937151 192.0.2.1 5000 typ host\r\n"
            + "a=candidate:2 1 udp 2113937151 100.64.0.2 5000 typ host\r\n"
            + "a=candidate:3 1 udp 2113937151 203.0.113.1 5000 typ srflx\r\n"
            + "a=candidate:4 1 udp 2113937151 2001:db8::1 5000 typ prflx\r\n";

        String stripped = AndroidRtcTransportBackend.stripDirectSdp(sdp);
        assertTrue(stripped.contains("typ srflx"));
        assertTrue(stripped.contains("typ prflx"));
        assertFalse(stripped.contains("192.0.2.1"));
        assertFalse(stripped.contains("100.64.0.2"));
    }
}
