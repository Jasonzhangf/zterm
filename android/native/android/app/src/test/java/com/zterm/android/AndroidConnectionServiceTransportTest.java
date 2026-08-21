package com.zterm.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;

import okhttp3.WebSocket;
import org.json.JSONObject;
import org.junit.Test;

public final class AndroidConnectionServiceTransportTest {
    @Test
    public void channelMessageQueuesUntilTransportReadyThenPreservesWirePayload() throws Exception {
        AndroidConnectionService service = new AndroidConnectionService();
        Object runtime = newRuntime(service);
        Method sendChannelMessage = runtime.getClass().getDeclaredMethod(
            "sendChannelMessage", String.class, JSONObject.class);
        sendChannelMessage.setAccessible(true);
        Method pendingCount = runtime.getClass().getDeclaredMethod("pendingFrameCountForTests");
        pendingCount.setAccessible(true);

        sendChannelMessage.invoke(runtime, "channel-a", new JSONObject().put("text", "hello"));
        assertEquals(1, pendingCount.invoke(runtime));

        List<String> sent = new ArrayList<>();
        setField(runtime, "socket", fakeSocket(sent, true));
        setField(runtime, "generation", "gen-1");
        setField(runtime, "transportNetworkGeneration", 0L);
        setField(service, "networkGeneration", 0L);
        Method drain = runtime.getClass().getDeclaredMethod("drainPendingFrames", String.class);
        drain.setAccessible(true);
        drain.invoke(runtime, "channel-a");

        assertEquals(0, pendingCount.invoke(runtime));
        assertEquals(1, sent.size());
        JSONObject frame = new JSONObject(sent.get(0));
        assertEquals("mux-channel-message", frame.getString("type"));
        assertEquals("channel-a", frame.getJSONObject("payload").getString("channelId"));
        assertEquals("hello", frame.getJSONObject("payload")
            .getJSONObject("message").getString("text"));
    }

    @Test
    public void targetMessageRejectsWhenTransportIsUnavailableInsteadOfQueueing() throws Exception {
        AndroidConnectionService.resetForTests();
        List<AndroidConnectionServiceEventEnvelope> events = new ArrayList<>();
        AndroidConnectionService.registerListenerForTests(new AndroidConnectionServiceListener() {
            @Override
            public void onSnapshot(AndroidConnectionServiceSnapshot snapshot) {
            }

            @Override
            public void onEvent(AndroidConnectionServiceEventEnvelope event) {
                events.add(event);
            }
        });
        try {
            AndroidConnectionService service = new AndroidConnectionService();
            Object runtime = newRuntime(service);
            Method sendTargetMessage = runtime.getClass().getDeclaredMethod(
                "sendTargetMessage", String.class, JSONObject.class);
            sendTargetMessage.setAccessible(true);
            Method pendingCount = runtime.getClass().getDeclaredMethod("pendingFrameCountForTests");
            pendingCount.setAccessible(true);

            sendTargetMessage.invoke(runtime, "request-1", new JSONObject().put("op", "ping"));

            assertEquals(0, pendingCount.invoke(runtime));
            assertTrue(events.stream().anyMatch(event ->
                event.kind == AndroidConnectionServiceEventEnvelope.Kind.COMMAND_REJECTED
                    && "frame-dropped-transport-pending".equals(event.errorCode)));
        } finally {
            AndroidConnectionService.resetForTests();
        }
    }

    @Test
    public void channelMessageQueuesWhenSocketExistsBeforeMuxReady() throws Exception {
        AndroidConnectionService service = new AndroidConnectionService();
        Object runtime = newRuntime(service);
        Method sendChannelMessage = runtime.getClass().getDeclaredMethod(
            "sendChannelMessage", String.class, JSONObject.class);
        sendChannelMessage.setAccessible(true);
        Method pendingCount = runtime.getClass().getDeclaredMethod("pendingFrameCountForTests");
        pendingCount.setAccessible(true);

        setField(runtime, "socket", fakeSocket(new ArrayList<>(), true));
        setField(runtime, "generation", "gen-1");
        setField(runtime, "transportNetworkGeneration", 0L);
        setField(service, "networkGeneration", 0L);

        sendChannelMessage.invoke(runtime, "channel-a", new JSONObject().put("text", "hello"));

        assertEquals(1, pendingCount.invoke(runtime));
    }

    @Test
    public void channelOpenedPublishesExactlyOneTypedProjection() throws Exception {
        AndroidConnectionService.resetForTests();
        List<AndroidConnectionServiceEventEnvelope> events = new ArrayList<>();
        AndroidConnectionService.registerListenerForTests(new AndroidConnectionServiceListener() {
            @Override
            public void onSnapshot(AndroidConnectionServiceSnapshot snapshot) {
            }

            @Override
            public void onEvent(AndroidConnectionServiceEventEnvelope event) {
                events.add(event);
            }
        });
        try {
            AndroidConnectionService service = new AndroidConnectionService();
            Object runtime = newRuntime(service);
            AndroidConnectionStateMachine stateMachine = readyStateMachine();
            setField(runtime, "stateMachine", stateMachine);
            setField(runtime, "generation", "gen-1");
            Method handleChannelOpened = runtime.getClass().getDeclaredMethod(
                "handleChannelOpened", JSONObject.class);
            handleChannelOpened.setAccessible(true);

            handleChannelOpened.invoke(runtime, new JSONObject()
                .put("channelId", "channel-a")
                .put("sessionName", "shell"));

            assertEquals(1, events.stream().filter(event ->
                event.kind == AndroidConnectionServiceEventEnvelope.Kind.CHANNEL_OPENED).count());
            assertEquals(0, events.stream().filter(event ->
                event.kind == AndroidConnectionServiceEventEnvelope.Kind.SERVER_FRAME).count());
        } finally {
            AndroidConnectionService.resetForTests();
        }
    }

    private static AndroidConnectionStateMachine readyStateMachine() {
        AndroidConnectionStateMachine stateMachine = new AndroidConnectionStateMachine(snapshot -> { });
        stateMachine.dispatch(AndroidConnectionServiceEvent.bindTarget(target()), 1L);
        stateMachine.dispatch(AndroidConnectionServiceEvent.transportOpening("gen-1"), 2L);
        stateMachine.dispatch(AndroidConnectionServiceEvent.muxReady(
            "gen-1",
            "{\"version\":1,\"capabilities\":{\"channelEnvelope\":true,\"targetMessages\":true}}"),
            3L);
        return stateMachine;
    }

    private static Object newRuntime(AndroidConnectionService service) throws Exception {
        Class<?> runtimeClass = Class.forName(
            "com.zterm.android.AndroidConnectionService$TargetRuntime");
        Constructor<?> constructor = runtimeClass.getDeclaredConstructor(
            AndroidConnectionService.class,
            AndroidConnectionServiceTarget.class,
            AndroidConnectionServiceRoutePolicy.class);
        constructor.setAccessible(true);
        return constructor.newInstance(service, target(), AndroidConnectionServiceRoutePolicy.auto());
    }

    private static AndroidConnectionServiceTarget target() {
        return new AndroidConnectionServiceTarget.Builder()
            .targetKey("target-a")
            .bridgeHost("127.0.0.1")
            .bridgePort(3333)
            .build();
    }

    private static WebSocket fakeSocket(List<String> sent, boolean result) {
        return (WebSocket) Proxy.newProxyInstance(
            WebSocket.class.getClassLoader(),
            new Class<?>[] { WebSocket.class },
            (proxy, method, args) -> {
                if ("send".equals(method.getName())) {
                    sent.add(String.valueOf(args[0]));
                    return result;
                }
                if ("toString".equals(method.getName())) return "fake-websocket";
                if (method.getReturnType() == boolean.class) return false;
                if (method.getReturnType() == int.class) return 0;
                return null;
            });
    }

    private static void setField(Object target, String name, Object value) throws Exception {
        Field field = target instanceof AndroidConnectionService
            ? AndroidConnectionService.class.getDeclaredField(name)
            : target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        field.set(target, value);
    }
}
