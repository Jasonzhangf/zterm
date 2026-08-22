package com.zterm.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import android.os.Handler;
import android.os.Looper;

import okhttp3.WebSocket;
import org.json.JSONObject;
import org.junit.Test;

public final class AndroidConnectionServiceTransportTest {
    private static final java.util.function.BiConsumer<Runnable, Long> IMMEDIATE_SCHEDULER =
        (runnable, delayMillis) -> runnable.run();

    private static void useImmediateScheduler(AndroidConnectionService service) throws Exception {
        setField(service, "sendRetryScheduler", IMMEDIATE_SCHEDULER);
    }
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
        setField(runtime, "stateMachine", readyStateMachine());
        setDesiredChannel(runtime, "channel-a", "shell");
        setDesiredChannelOpened(runtime, "channel-a", true);
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
            setField(service, "workerHandler", new Handler(Looper.getMainLooper()));
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
            setField(service, "workerHandler", new Handler(Looper.getMainLooper()));
            Object runtime = newRuntime(service);
            AndroidConnectionStateMachine stateMachine = readyStateMachine();
            setField(runtime, "stateMachine", stateMachine);
            setField(runtime, "generation", "gen-1");
            setDesiredChannel(runtime, "channel-a", "shell");
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

    @Test
    public void channelOpenReplacesStaleChannelForSameRemoteSession() throws Exception {
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
            setField(service, "workerHandler", new Handler(Looper.getMainLooper()));
            Object runtime = newRuntime(service);
            AndroidConnectionStateMachine stateMachine = readyStateMachine();
            setField(runtime, "stateMachine", stateMachine);
            setField(runtime, "generation", "gen-1");
            setField(runtime, "transportNetworkGeneration", 0L);
            setField(service, "networkGeneration", 0L);
            List<String> sent = new ArrayList<>();
            setField(runtime, "socket", fakeSocket(sent, true));
            Method sendChannelOpen = runtime.getClass().getDeclaredMethod(
                "sendChannelOpen", AndroidConnectionCommand.class);
            sendChannelOpen.setAccessible(true);

            sendChannelOpen.invoke(runtime, AndroidConnectionCommand.openChannel(
                "target-a", "channel-old", "shell", null));
            setDesiredChannelOpened(runtime, "channel-old", true);
            sendChannelOpen.invoke(runtime, AndroidConnectionCommand.openChannel(
                "target-a", "channel-new", "shell", null));

            // New behavior: opening a new channelId for the same session first
            // closes the stale channel (wire close), then opens the requested id
            // (wire open). Total wire messages: initial open + close + new open.
            assertEquals(3, sent.size());
            assertEquals("mux-channel-open", new JSONObject(sent.get(0)).getString("type"));
            Field desiredChannelsField = runtime.getClass().getDeclaredField("desiredChannels");
            desiredChannelsField.setAccessible(true);
            Map<?, ?> desiredChannels = (Map<?, ?>) desiredChannelsField.get(runtime);
            assertTrue(!desiredChannels.containsKey("channel-old"));
            assertTrue(desiredChannels.containsKey("channel-new"));
        } finally {
            AndroidConnectionService.resetForTests();
        }
    }

    @Test
    public void repeatedOpenReusesAlreadyOpenedChannelWithoutDuplicateWireOpen() throws Exception {
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
            setField(service, "workerHandler", new Handler(Looper.getMainLooper()));
            Object runtime = newRuntime(service);
            setField(runtime, "stateMachine", readyStateMachine());
            setField(runtime, "generation", "gen-1");
            setField(runtime, "transportNetworkGeneration", 0L);
            setField(service, "networkGeneration", 0L);
            List<String> sent = new ArrayList<>();
            setField(runtime, "socket", fakeSocket(sent, true));
            Method sendChannelOpen = runtime.getClass().getDeclaredMethod(
                "sendChannelOpen", AndroidConnectionCommand.class);
            sendChannelOpen.setAccessible(true);

            sendChannelOpen.invoke(runtime, AndroidConnectionCommand.openChannel(
                "target-a", "channel-a", "shell", null));
            setDesiredChannelOpened(runtime, "channel-a", true);
            sendChannelOpen.invoke(runtime, AndroidConnectionCommand.openChannel(
                "target-a", "channel-a", "shell", null));

            assertEquals(1, sent.size());
            assertEquals(1, events.stream().filter(event ->
                event.kind == AndroidConnectionServiceEventEnvelope.Kind.CHANNEL_OPENED).count());
        } finally {
            AndroidConnectionService.resetForTests();
        }
    }

    @Test
    public void staleChannelReplacementRebindsQueuedBusinessFramesToReplacement()
        throws Exception {
        AndroidConnectionService.resetForTests();
        AndroidConnectionService service = new AndroidConnectionService();
        Object runtime = newRuntime(service);
        setField(runtime, "stateMachine", readyStateMachine());
        setField(runtime, "generation", "gen-1");
        setField(runtime, "transportNetworkGeneration", 0L);
        setField(service, "networkGeneration", 0L);
        List<String> sent = new ArrayList<>();
        setField(runtime, "socket", fakeSocket(sent, true));
        Method sendChannelOpen = runtime.getClass().getDeclaredMethod(
            "sendChannelOpen", AndroidConnectionCommand.class);
        sendChannelOpen.setAccessible(true);

        sendChannelOpen.invoke(runtime, AndroidConnectionCommand.openChannel(
            "target-a", "channel-old", "shell", null));
        JSONObject queuedMessage = new JSONObject().put("type", "mux-channel-message")
            .put("payload", new JSONObject().put("channelId", "channel-old"));
        Method sendOrQueue = runtime.getClass().getDeclaredMethod(
            "sendOrQueue", JSONObject.class, String.class,
            AndroidConnectionCommand.class, boolean.class);
        sendOrQueue.setAccessible(true);
        sendOrQueue.invoke(runtime, queuedMessage, "channel-old",
            AndroidConnectionCommand.channelMessage(
                "target-a", "channel-old", new JSONObject()), true);

        sendChannelOpen.invoke(runtime, AndroidConnectionCommand.openChannel(
            "target-a", "channel-new", "shell", null));

        Field pendingFramesField = runtime.getClass().getDeclaredField("pendingFrames");
        pendingFramesField.setAccessible(true);
        @SuppressWarnings("unchecked")
        Map<String, java.util.ArrayDeque<JSONObject>> pendingFrames =
            (Map<String, java.util.ArrayDeque<JSONObject>>) pendingFramesField.get(runtime);
        Field desiredChannelsField = runtime.getClass().getDeclaredField("desiredChannels");
        desiredChannelsField.setAccessible(true);
        Map<?, ?> desiredChannels = (Map<?, ?>) desiredChannelsField.get(runtime);
        // Stale replacement only kicks in when desiredChannels has channel-old (which is removed
        // once channel-old sees mux-channel-open ack). Since we never marked channel-old opened,
        // sendChannelOpen re-creates it; rebind path applies during the second sendChannelOpen.
        assertTrue(pendingFrames.containsKey("channel-new"));
        assertTrue(!desiredChannels.containsKey("channel-old"));
        assertEquals(1, pendingFrames.get("channel-new").size());
        assertEquals(queuedMessage.toString(), pendingFrames.get("channel-new").peekFirst().toString());
    }

    @Test
    public void crossBackendSameSessionNameChannelsArePreserved() throws Exception {
        AndroidConnectionService.resetForTests();
        AndroidConnectionService service = new AndroidConnectionService();
        Object runtime = newRuntime(service);
        setField(runtime, "stateMachine", readyStateMachine());
        setField(runtime, "generation", "gen-1");
        setField(runtime, "transportNetworkGeneration", 0L);
        setField(service, "networkGeneration", 0L);
        List<String> sent = new ArrayList<>();
        setField(runtime, "socket", fakeSocket(sent, true));
        Method sendChannelOpen = runtime.getClass().getDeclaredMethod(
            "sendChannelOpen", AndroidConnectionCommand.class);
        sendChannelOpen.setAccessible(true);

        JSONObject tmuxOptions = new JSONObject().put("backend", "tmux");
        JSONObject herdrOptions = new JSONObject().put("backend", "herdr");
        sendChannelOpen.invoke(runtime, AndroidConnectionCommand.openChannel(
            "target-a", "channel-tmux", "shell", tmuxOptions));
        sendChannelOpen.invoke(runtime, AndroidConnectionCommand.openChannel(
            "target-a", "channel-herdr", "shell", herdrOptions));

        Field desiredChannelsField = runtime.getClass().getDeclaredField("desiredChannels");
        desiredChannelsField.setAccessible(true);
        Map<?, ?> desiredChannels = (Map<?, ?>) desiredChannelsField.get(runtime);
        assertTrue(desiredChannels.containsKey("channel-tmux"));
        assertTrue(desiredChannels.containsKey("channel-herdr"));
    }

    @Test
    public void repeatedOpenAfterTransportFailureDoesNotTakeIdempotentPath()
        throws Exception {
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
            setField(service, "workerHandler", new Handler(Looper.getMainLooper()));
            Object runtime = newRuntime(service);
            setField(runtime, "stateMachine", readyStateMachine());
            setField(runtime, "generation", null);
            setField(runtime, "transportNetworkGeneration", 0L);
            setField(service, "networkGeneration", 0L);
            List<String> sent = new ArrayList<>();
            setField(runtime, "socket", fakeSocket(sent, true));
            Method sendChannelOpen = runtime.getClass().getDeclaredMethod(
                "sendChannelOpen", AndroidConnectionCommand.class);
            sendChannelOpen.setAccessible(true);

            sendChannelOpen.invoke(runtime, AndroidConnectionCommand.openChannel(
                "target-a", "channel-a", "shell", null));
            setDesiredChannelOpened(runtime, "channel-a", true);
            // generation is null after transportFailure; idempotent branch must not fire.
            sendChannelOpen.invoke(runtime, AndroidConnectionCommand.openChannel(
                "target-a", "channel-a", "shell", null));

            assertEquals(0, events.stream().filter(event ->
                event.kind == AndroidConnectionServiceEventEnvelope.Kind.CHANNEL_OPENED).count());
        } finally {
            AndroidConnectionService.resetForTests();
        }
    }

    @Test
    public void webViewRecreationReusesExistingOpenedChannelWithoutWireOpen()
        throws Exception {
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
            setField(service, "workerHandler", new Handler(Looper.getMainLooper()));
            Object runtime = newRuntime(service);
            setField(runtime, "stateMachine", readyStateMachine());
            setField(runtime, "generation", "gen-1");
            setField(runtime, "transportNetworkGeneration", 0L);
            setField(service, "networkGeneration", 0L);
            List<String> sent = new ArrayList<>();
            setField(runtime, "socket", fakeSocket(sent, true));
            Method sendChannelOpen = runtime.getClass().getDeclaredMethod(
                "sendChannelOpen", AndroidConnectionCommand.class);
            sendChannelOpen.setAccessible(true);

            sendChannelOpen.invoke(runtime, AndroidConnectionCommand.openChannel(
                "target-a", "channel-original", "shell", null));
            setDesiredChannelOpened(runtime, "channel-original", true);

            // WebView recreation: new channelId requested for same session.
            // Queue a frame under the requested id first so we can verify the
            // reuse path drains it along with the reused channel's queue.
            JSONObject queuedMessage = new JSONObject().put("type", "mux-channel-message")
                .put("payload", new JSONObject().put("channelId", "channel-recreated"));
            Method sendOrQueue = runtime.getClass().getDeclaredMethod(
                "sendOrQueue", JSONObject.class, String.class,
                AndroidConnectionCommand.class, boolean.class);
            sendOrQueue.setAccessible(true);
            sendOrQueue.invoke(runtime, queuedMessage, "channel-recreated",
                AndroidConnectionCommand.channelMessage(
                    "target-a", "channel-recreated", new JSONObject()), true);

            events.clear();
            sent.clear();
            sendChannelOpen.invoke(runtime, AndroidConnectionCommand.openChannel(
                "target-a", "channel-recreated", "shell", null));

            // New behavior: opening a new channelId always sends a wire open for
            // that exact id and waits for the daemon to confirm. No immediate
            // CHANNEL_OPENED is published because the daemon response is async.
            assertEquals(0, events.stream().filter(event ->
                event.kind == AndroidConnectionServiceEventEnvelope.Kind.SERVER_FRAME).count());
            assertEquals(0, events.stream().filter(event ->
                event.kind == AndroidConnectionServiceEventEnvelope.Kind.CHANNEL_OPENED).count());
            Field pendingFramesField = runtime.getClass().getDeclaredField("pendingFrames");
            pendingFramesField.setAccessible(true);
            @SuppressWarnings("unchecked")
            Map<String, java.util.ArrayDeque<JSONObject>> pendingFrames =
                (Map<String, java.util.ArrayDeque<JSONObject>>) pendingFramesField.get(runtime);
            // The queued input frame stays pending until the daemon confirms the
            // new channel (async), so it must NOT have drained yet.
            assertTrue(pendingFrames.containsKey("channel-recreated"));
            // Wire traffic: mux-channel-close for channel-original + mux-channel-open
            // for channel-recreated.
            assertTrue(sent.size() >= 2);
            assertTrue(sent.stream().noneMatch(frame -> {
                try {
                    return new JSONObject(frame).getString("type").equals("mux-channel-message")
                        && new JSONObject(frame).getJSONObject("payload")
                            .getString("channelId").equals("channel-recreated");
                } catch (Exception error) {
                    return false;
                }
            }));
        } finally {
            AndroidConnectionService.resetForTests();
        }
    }

    private static void setDesiredChannelOpened(Object runtime, String channelId, boolean opened)
        throws Exception {
        Field desiredChannelsField = runtime.getClass().getDeclaredField("desiredChannels");
        desiredChannelsField.setAccessible(true);
        Map<?, ?> desiredChannels = (Map<?, ?>) desiredChannelsField.get(runtime);
        Object channel = desiredChannels.get(channelId);
        Field openedField = channel.getClass().getDeclaredField("opened");
        openedField.setAccessible(true);
        openedField.setBoolean(channel, opened);
    }

    private static void setDesiredChannel(Object runtime, String channelId, String sessionName)
        throws Exception {
        Field desiredChannelsField = runtime.getClass().getDeclaredField("desiredChannels");
        desiredChannelsField.setAccessible(true);
        @SuppressWarnings("unchecked")
        Map<String, Object> desiredChannels =
            (Map<String, Object>) desiredChannelsField.get(runtime);
        Class<?> runtimeClass = runtime.getClass();
        Class<?> channelClass = null;
        for (Class<?> declared : runtimeClass.getDeclaredClasses()) {
            if (declared.getSimpleName().equals("ChannelIntent")) {
                channelClass = declared;
                break;
            }
        }
        if (channelClass == null) {
            throw new IllegalStateException("ChannelIntent class not found");
        }
        Object channel = channelClass.getDeclaredConstructor(
            runtimeClass, String.class, String.class, JSONObject.class, long.class)
            .newInstance(runtime, channelId, sessionName, null, 0L);
        Field lifecycleEpochField = channel.getClass().getDeclaredField("lifecycleEpoch");
        lifecycleEpochField.setAccessible(true);
        lifecycleEpochField.setLong(channel, System.nanoTime());
        desiredChannels.put(channelId, channel);
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

    private static Object newDebouncedFailureRuntime(AndroidConnectionService service)
        throws Exception {
        setField(service, "workerHandler", new Handler(Looper.getMainLooper()));
        Object runtime = newRuntime(service);
        setField(runtime, "stateMachine", readyStateMachine());
        setField(runtime, "generation", "gen-1");
        setField(runtime, "transportNetworkGeneration", 0L);
        setField(service, "networkGeneration", 0L);
        return runtime;
    }

    private static void invokeTransportFailure(Object runtime, String code, String message)
        throws Exception {
        Method transportFailure = runtime.getClass().getDeclaredMethod(
            "transportFailure", String.class, String.class);
        transportFailure.setAccessible(true);
        transportFailure.invoke(runtime, code, message);
    }

    private static WebSocket fakeSocketWithSendResults(List<String> sent, boolean[] results) {
        AtomicInteger callIndex = new AtomicInteger(0);
        return (WebSocket) Proxy.newProxyInstance(
            WebSocket.class.getClassLoader(),
            new Class<?>[] { WebSocket.class },
            (proxy, method, args) -> {
                if ("send".equals(method.getName())) {
                    int index = callIndex.getAndIncrement();
                    sent.add(String.valueOf(args[0]));
                    if (index < results.length) {
                        return results[index];
                    }
                    return true;
                }
                if ("toString".equals(method.getName())) return "fake-websocket";
                if (method.getReturnType() == boolean.class) return false;
                if (method.getReturnType() == int.class) return 0;
                return null;
            });
    }

    private static WebSocket throwingSocket(List<String> sent, RuntimeException error) {
        AtomicInteger calls = new AtomicInteger(0);
        return (WebSocket) Proxy.newProxyInstance(
            WebSocket.class.getClassLoader(),
            new Class<?>[] { WebSocket.class },
            (proxy, method, args) -> {
                if ("send".equals(method.getName())) {
                    calls.incrementAndGet();
                    sent.add(String.valueOf(args[0]));
                    throw error;
                }
                if ("toString".equals(method.getName())) return "throwing-websocket";
                if (method.getReturnType() == boolean.class) return false;
                if (method.getReturnType() == int.class) return 0;
                return null;
            });
    }

    @Test
    public void singleSendFailureDoesNotTearDownConnection() throws Exception {
        AndroidConnectionService.resetForTests();
        List<AndroidConnectionServiceEventEnvelope> events = new ArrayList<>();
        AndroidConnectionService.registerListenerForTests(new AndroidConnectionServiceListener() {
            @Override public void onSnapshot(AndroidConnectionServiceSnapshot snapshot) { }
            @Override public void onEvent(AndroidConnectionServiceEventEnvelope event) {
                events.add(event);
            }
        });
        try {
            AndroidConnectionService service = new AndroidConnectionService();
            setField(service, "workerHandler", new Handler(Looper.getMainLooper()));
            Object runtime = newRuntime(service);
            setField(runtime, "stateMachine", readyStateMachine());
            useImmediateScheduler(service);
            setField(runtime, "stateMachine", readyStateMachine());
            setField(runtime, "generation", "gen-1");
            setField(runtime, "transportNetworkGeneration", 0L);
            setField(service, "networkGeneration", 0L);
            List<String> sent = new ArrayList<>();
            // First send fails, second send succeeds
            WebSocket socket = fakeSocketWithSendResults(sent, new boolean[]{false, true});
            setField(runtime, "socket", socket);
            Method sendOrQueue = runtime.getClass().getDeclaredMethod(
                "sendOrQueue", JSONObject.class, String.class,
                AndroidConnectionCommand.class, boolean.class);
            sendOrQueue.setAccessible(true);

            // First frame fails to enqueue, retry succeeds in-place
            sendOrQueue.invoke(runtime, new JSONObject().put("type", "mux-ping"),
                null, (AndroidConnectionCommand) null, false);

            assertEquals("retry succeeded without teardown", 2, sent.size());
            assertTrue("no transport failure event for single retryable failure",
                events.stream().noneMatch(e -> e.kind == AndroidConnectionServiceEventEnvelope.Kind.PHYSICAL_ERROR));
        } finally {
            AndroidConnectionService.resetForTests();
        }
    }

    @Test
    public void transientSendFailureSchedulesOneDelayedRetry() throws Exception {
        AndroidConnectionService.resetForTests();
        List<Runnable> scheduled = new ArrayList<>();
        List<Long> scheduledDelays = new ArrayList<>();
        List<AndroidConnectionServiceEventEnvelope> events = new ArrayList<>();
        AndroidConnectionService.registerListenerForTests(new AndroidConnectionServiceListener() {
            @Override public void onSnapshot(AndroidConnectionServiceSnapshot snapshot) { }
            @Override public void onEvent(AndroidConnectionServiceEventEnvelope event) {
                events.add(event);
            }
        });
        try {
            AndroidConnectionService service = new AndroidConnectionService();
            setField(service, "sendRetryScheduler", (java.util.function.BiConsumer<Runnable, Long>) (runnable, delayMillis) -> {
                scheduled.add(runnable);
                scheduledDelays.add(delayMillis);
            });
            Object runtime = newRuntime(service);
            setField(runtime, "stateMachine", readyStateMachine());
            setField(runtime, "generation", "gen-1");
            setField(runtime, "transportNetworkGeneration", 0L);
            setField(service, "networkGeneration", 0L);
            List<String> sent = new ArrayList<>();
            WebSocket socket = fakeSocketWithSendResults(sent, new boolean[]{false, true});
            setField(runtime, "socket", socket);
            Method sendOrQueue = runtime.getClass().getDeclaredMethod(
                "sendOrQueue", JSONObject.class, String.class,
                AndroidConnectionCommand.class, boolean.class);
            sendOrQueue.setAccessible(true);

            sendOrQueue.invoke(runtime, new JSONObject().put("type", "mux-ping"),
                null, (AndroidConnectionCommand) null, false);

            assertEquals(1, sent.size());
            assertEquals(1, scheduled.size());
            assertEquals(Long.valueOf(AndroidConnectionService.SEND_RETRY_DELAY_MS), scheduledDelays.get(0));

            setField(service, "sendRetryScheduler", IMMEDIATE_SCHEDULER);
            scheduled.get(0).run();

            assertEquals(2, sent.size());
            assertTrue(events.stream().noneMatch(event ->
                event.kind == AndroidConnectionServiceEventEnvelope.Kind.PHYSICAL_ERROR));
        } finally {
            AndroidConnectionService.resetForTests();
        }
    }

    @Test
    public void delayedRetryDoesNotSendOnRetiredGeneration() throws Exception {
        AndroidConnectionService.resetForTests();
        AtomicReference<Runnable> scheduledRetry = new AtomicReference<>();
        List<AndroidConnectionServiceEventEnvelope> events = new ArrayList<>();
        AndroidConnectionService.registerListenerForTests(new AndroidConnectionServiceListener() {
            @Override public void onSnapshot(AndroidConnectionServiceSnapshot snapshot) { }
            @Override public void onEvent(AndroidConnectionServiceEventEnvelope event) {
                events.add(event);
            }
        });
        try {
            AndroidConnectionService service = new AndroidConnectionService();
            setField(service, "sendRetryScheduler",
                (java.util.function.BiConsumer<Runnable, Long>) (runnable, delayMillis) ->
                    scheduledRetry.set(runnable));
            Object runtime = newRuntime(service);
            setField(runtime, "stateMachine", readyStateMachine());
            setField(runtime, "generation", "gen-1");
            setField(runtime, "transportNetworkGeneration", 0L);
            setField(service, "networkGeneration", 0L);
            List<String> sent = new ArrayList<>();
            WebSocket socket = fakeSocketWithSendResults(sent, new boolean[]{false});
            setField(runtime, "socket", socket);
            Method sendOrQueue = runtime.getClass().getDeclaredMethod(
                "sendOrQueue", JSONObject.class, String.class,
                AndroidConnectionCommand.class, boolean.class);
            sendOrQueue.setAccessible(true);

            sendOrQueue.invoke(runtime, new JSONObject().put("type", "mux-ping"),
                null, (AndroidConnectionCommand) null, false);
            setField(runtime, "generation", "gen-2");

            scheduledRetry.get().run();

            assertEquals(1, sent.size());
        } finally {
            AndroidConnectionService.resetForTests();
        }
    }

    @Test
    public void retiredGenerationParksCurrentAndDeferredChannelFramesInOrder()
        throws Exception {
        AndroidConnectionService.resetForTests();
        AtomicReference<Runnable> scheduledRetry = new AtomicReference<>();
        AndroidConnectionService.registerListenerForTests(new AndroidConnectionServiceListener() {
            @Override public void onSnapshot(AndroidConnectionServiceSnapshot snapshot) { }
            @Override public void onEvent(AndroidConnectionServiceEventEnvelope event) { }
        });
        try {
            AndroidConnectionService service = new AndroidConnectionService();
            setField(service, "sendRetryScheduler",
                (java.util.function.BiConsumer<Runnable, Long>) (runnable, delayMillis) ->
                    scheduledRetry.set(runnable));
            Object runtime = newRuntime(service);
            setField(runtime, "stateMachine", readyStateMachine());
            setField(runtime, "generation", "gen-1");
            setField(runtime, "transportNetworkGeneration", 0L);
            setField(service, "networkGeneration", 0L);
            setDesiredChannel(runtime, "channel-a", "shell");
            setDesiredChannelOpened(runtime, "channel-a", true);
            List<String> sent = new ArrayList<>();
            WebSocket socket = fakeSocketWithSendResults(sent, new boolean[]{false});
            setField(runtime, "socket", socket);
            Method sendOrQueue = runtime.getClass().getDeclaredMethod(
                "sendOrQueue", JSONObject.class, String.class,
                AndroidConnectionCommand.class, boolean.class);
            sendOrQueue.setAccessible(true);
            Method pendingCount = runtime.getClass().getDeclaredMethod(
                "pendingFrameCountForTests");
            pendingCount.setAccessible(true);
            AndroidConnectionCommand source = AndroidConnectionCommand.channelMessage(
                "target-a", "channel-a", new JSONObject());

            sendOrQueue.invoke(runtime,
                new JSONObject().put("type", "mux-channel-message"), "channel-a", source, true);
            sendOrQueue.invoke(runtime,
                new JSONObject().put("seq", 1), "channel-a", source, true);

            setField(runtime, "generation", "gen-2");
            scheduledRetry.get().run();

            assertEquals(1, sent.size());
            assertEquals(2, pendingCount.invoke(runtime));
            Field pendingFramesField = runtime.getClass().getDeclaredField("pendingFrames");
            pendingFramesField.setAccessible(true);
            @SuppressWarnings("unchecked")
            Map<String, java.util.ArrayDeque<JSONObject>> pendingFrames =
                (Map<String, java.util.ArrayDeque<JSONObject>>) pendingFramesField.get(runtime);
            assertEquals(0, new JSONObject(pendingFrames.get("channel-a").peekFirst().toString())
                .optInt("seq"));
            assertEquals(1, new JSONObject(
                java.util.Objects.requireNonNull(pendingFrames.get("channel-a")
                    .toArray()[1]).toString()).optInt("seq"));
        } finally {
            AndroidConnectionService.resetForTests();
        }
    }

    @Test
    public void targetSendRetriesBeforeTearingDown() throws Exception {
        AndroidConnectionService.resetForTests();
        List<AndroidConnectionServiceEventEnvelope> events = new ArrayList<>();
        AndroidConnectionService.registerListenerForTests(new AndroidConnectionServiceListener() {
            @Override public void onSnapshot(AndroidConnectionServiceSnapshot snapshot) { }
            @Override public void onEvent(AndroidConnectionServiceEventEnvelope event) {
                events.add(event);
            }
        });
        try {
            AndroidConnectionService service = new AndroidConnectionService();
            setField(service, "workerHandler", new Handler(Looper.getMainLooper()));
            Object runtime = newRuntime(service);
            setField(runtime, "stateMachine", readyStateMachine());
            useImmediateScheduler(service);
            setField(runtime, "stateMachine", readyStateMachine());
            setField(runtime, "generation", "gen-1");
            setField(runtime, "transportNetworkGeneration", 0L);
            setField(service, "networkGeneration", 0L);
            List<String> sent = new ArrayList<>();
            setField(runtime, "socket", fakeSocketWithSendResults(sent, new boolean[]{false, false, true}));
            Method send = runtime.getClass().getDeclaredMethod(
                "send", JSONObject.class);
            send.setAccessible(true);

            send.invoke(runtime, new JSONObject().put("type", "mux-hello"));

            assertEquals(3, sent.size());
            assertTrue(events.stream().noneMatch(event ->
                event.kind == AndroidConnectionServiceEventEnvelope.Kind.PHYSICAL_ERROR));
        } finally {
            AndroidConnectionService.resetForTests();
        }
    }

    @Test
    public void drainPendingFramesUsesRetryOwnerInsteadOfImmediateTeardown() throws Exception {
        AndroidConnectionService.resetForTests();
        List<AndroidConnectionServiceEventEnvelope> events = new ArrayList<>();
        AndroidConnectionService.registerListenerForTests(new AndroidConnectionServiceListener() {
            @Override public void onSnapshot(AndroidConnectionServiceSnapshot snapshot) { }
            @Override public void onEvent(AndroidConnectionServiceEventEnvelope event) {
                events.add(event);
            }
        });
        try {
            AndroidConnectionService service = new AndroidConnectionService();
            setField(service, "workerHandler", new Handler(Looper.getMainLooper()));
            Object runtime = newRuntime(service);
            useImmediateScheduler(service);
            setField(runtime, "stateMachine", readyStateMachine());
            setField(runtime, "generation", "gen-1");
            setField(runtime, "transportNetworkGeneration", 0L);
            setField(service, "networkGeneration", 0L);
            Field pendingFramesField = runtime.getClass().getDeclaredField("pendingFrames");
            pendingFramesField.setAccessible(true);
            @SuppressWarnings("unchecked")
            Map<String, java.util.ArrayDeque<JSONObject>> pendingFrames =
                (Map<String, java.util.ArrayDeque<JSONObject>>) pendingFramesField.get(runtime);
            java.util.ArrayDeque<JSONObject> queue = new java.util.ArrayDeque<>();
            queue.addLast(new JSONObject().put("type", "mux-channel-message"));
            pendingFrames.put("channel-a", queue);
            List<String> sent = new ArrayList<>();
            setField(runtime, "socket", fakeSocketWithSendResults(sent, new boolean[]{false, false, true}));
            Method drainPendingFrames = runtime.getClass().getDeclaredMethod(
                "drainPendingFrames", String.class);
            drainPendingFrames.setAccessible(true);

            drainPendingFrames.invoke(runtime, "channel-a");

            assertEquals(3, sent.size());
            assertTrue(pendingFrames.get("channel-a") == null || pendingFrames.get("channel-a").isEmpty());
            assertTrue(events.stream().noneMatch(event ->
                event.kind == AndroidConnectionServiceEventEnvelope.Kind.PHYSICAL_ERROR));
        } finally {
            AndroidConnectionService.resetForTests();
        }
    }

    @Test
    public void closedChannelDiscardsScheduledRetryAndDeferredFrames()
        throws Exception {
        AndroidConnectionService.resetForTests();
        AtomicReference<Runnable> scheduledRetry = new AtomicReference<>();
        AndroidConnectionService.registerListenerForTests(new AndroidConnectionServiceListener() {
            @Override public void onSnapshot(AndroidConnectionServiceSnapshot snapshot) { }
            @Override public void onEvent(AndroidConnectionServiceEventEnvelope event) { }
        });
        try {
            AndroidConnectionService service = new AndroidConnectionService();
            setField(service, "sendRetryScheduler",
                (java.util.function.BiConsumer<Runnable, Long>) (runnable, delayMillis) ->
                    scheduledRetry.set(runnable));
            Object runtime = newRuntime(service);
            setField(runtime, "stateMachine", readyStateMachine());
            setField(runtime, "generation", "gen-1");
            setField(runtime, "transportNetworkGeneration", 0L);
            setField(service, "networkGeneration", 0L);
            setDesiredChannel(runtime, "channel-a", "shell");
            setDesiredChannelOpened(runtime, "channel-a", true);
            List<String> sent = new ArrayList<>();
            WebSocket socket = fakeSocketWithSendResults(sent, new boolean[]{false, true});
            setField(runtime, "socket", socket);
            Method sendOrQueue = runtime.getClass().getDeclaredMethod(
                "sendOrQueue", JSONObject.class, String.class,
                AndroidConnectionCommand.class, boolean.class);
            sendOrQueue.setAccessible(true);
            Method pendingCount = runtime.getClass().getDeclaredMethod(
                "pendingFrameCountForTests");
            pendingCount.setAccessible(true);
            AndroidConnectionCommand source = AndroidConnectionCommand.channelMessage(
                "target-a", "channel-a", new JSONObject());

            sendOrQueue.invoke(runtime,
                new JSONObject().put("type", "mux-channel-message"), "channel-a", source, true);
            sendOrQueue.invoke(runtime,
                new JSONObject().put("seq", 1), "channel-a", source, true);

            Method sendCloseChannel = runtime.getClass().getDeclaredMethod(
                "sendCloseChannel", AndroidConnectionCommand.class);
            sendCloseChannel.setAccessible(true);
            sendCloseChannel.invoke(runtime, AndroidConnectionCommand.closeChannel(
                "target-a", "channel-a", "user-close"));

            setDesiredChannel(runtime, "channel-a", "shell");
            setDesiredChannelOpened(runtime, "channel-a", true);
            scheduledRetry.get().run();

            assertEquals(2, sent.size());
            assertEquals(1, pendingCount.invoke(runtime));
            assertTrue(sent.stream().noneMatch(frame -> {
                try {
                    return new JSONObject(frame).optString("type").equals("mux-channel-message")
                        && new JSONObject(frame).getJSONObject("payload")
                            .optString("channelId").equals("channel-a");
                } catch (Exception error) {
                    return false;
                }
            }));
        } finally {
            AndroidConnectionService.resetForTests();
        }
    }

    @Test
    public void threeConsecutiveFailuresTriggerTransportFailure() throws Exception {
        AndroidConnectionService.resetForTests();
        List<AndroidConnectionServiceEventEnvelope> events = new ArrayList<>();
        AndroidConnectionService.registerListenerForTests(new AndroidConnectionServiceListener() {
            @Override public void onSnapshot(AndroidConnectionServiceSnapshot snapshot) { }
            @Override public void onEvent(AndroidConnectionServiceEventEnvelope event) {
                events.add(event);
            }
        });
        try {
            AndroidConnectionService service = new AndroidConnectionService();
            setField(service, "workerHandler", new Handler(Looper.getMainLooper()));
            Object runtime = newRuntime(service);
            setField(runtime, "stateMachine", readyStateMachine());
            useImmediateScheduler(service);
            setField(runtime, "stateMachine", readyStateMachine());
            setField(runtime, "generation", "gen-1");
            setField(runtime, "transportNetworkGeneration", 0L);
            setField(service, "networkGeneration", 0L);
            List<String> sent = new ArrayList<>();
            // All 3 send attempts within a single call fail
            WebSocket socket = fakeSocketWithSendResults(sent, new boolean[]{false, false, false});
            setField(runtime, "socket", socket);
            Method sendOrQueue = runtime.getClass().getDeclaredMethod(
                "sendOrQueue", JSONObject.class, String.class,
                AndroidConnectionCommand.class, boolean.class);
            sendOrQueue.setAccessible(true);

            sendOrQueue.invoke(runtime, new JSONObject().put("type", "mux-ping"),
                null, (AndroidConnectionCommand) null, false);
            assertEquals(3, sent.size());

            Field stateMachineField = runtime.getClass().getDeclaredField("stateMachine");
            stateMachineField.setAccessible(true);
            AndroidConnectionStateMachine stateMachine =
                (AndroidConnectionStateMachine) stateMachineField.get(runtime);
            assertEquals("persistent send failure must retire the transport generation",
                AndroidConnectionServiceSnapshot.State.BACKOFF_RECONNECT,
                stateMachine.readSnapshot().state);
            assertTrue("sub-5s teardown must not project a physical error",
                events.stream().noneMatch(e ->
                    e.kind == AndroidConnectionServiceEventEnvelope.Kind.PHYSICAL_ERROR));
        } finally {
            AndroidConnectionService.resetForTests();
        }
    }

    @Test
    public void threeThrownSendFailuresRetryBeforeTeardown() throws Exception {
        AndroidConnectionService.resetForTests();
        List<AndroidConnectionServiceEventEnvelope> events = new ArrayList<>();
        AndroidConnectionService.registerListenerForTests(new AndroidConnectionServiceListener() {
            @Override public void onSnapshot(AndroidConnectionServiceSnapshot snapshot) { }
            @Override public void onEvent(AndroidConnectionServiceEventEnvelope event) {
                events.add(event);
            }
        });
        try {
            AndroidConnectionService service = new AndroidConnectionService();
            setField(service, "workerHandler", new Handler(Looper.getMainLooper()));
            Object runtime = newRuntime(service);
            setField(runtime, "stateMachine", readyStateMachine());
            useImmediateScheduler(service);
            setField(runtime, "stateMachine", readyStateMachine());
            setField(runtime, "generation", "gen-1");
            setField(runtime, "transportNetworkGeneration", 0L);
            setField(service, "networkGeneration", 0L);
            List<String> sent = new ArrayList<>();
            setField(runtime, "socket", throwingSocket(
                sent, new IllegalStateException("socket write failed")));
            Method sendOrQueue = runtime.getClass().getDeclaredMethod(
                "sendOrQueue", JSONObject.class, String.class,
                AndroidConnectionCommand.class, boolean.class);
            sendOrQueue.setAccessible(true);

            sendOrQueue.invoke(runtime, new JSONObject().put("type", "mux-ping"),
                null, (AndroidConnectionCommand) null, false);

            assertEquals(3, sent.size());
            Field stateMachineField = runtime.getClass().getDeclaredField("stateMachine");
            stateMachineField.setAccessible(true);
            AndroidConnectionStateMachine stateMachine =
                (AndroidConnectionStateMachine) stateMachineField.get(runtime);
            assertEquals(AndroidConnectionServiceSnapshot.State.BACKOFF_RECONNECT,
                stateMachine.readSnapshot().state);
            assertTrue(events.stream().noneMatch(event ->
                event.kind == AndroidConnectionServiceEventEnvelope.Kind.PHYSICAL_ERROR));
        } finally {
            AndroidConnectionService.resetForTests();
        }
    }

    @Test
    public void shortPhysicalFailureDoesNotProjectToJs() throws Exception {
        AndroidConnectionService.resetForTests();
        List<AndroidConnectionServiceEventEnvelope> events = new ArrayList<>();
        AndroidConnectionService.registerListenerForTests(new AndroidConnectionServiceListener() {
            @Override public void onSnapshot(AndroidConnectionServiceSnapshot snapshot) { }
            @Override public void onEvent(AndroidConnectionServiceEventEnvelope event) {
                events.add(event);
            }
        });
        try {
            Object runtime = newDebouncedFailureRuntime(new AndroidConnectionService());

            invokeTransportFailure(runtime, "websocket", "brief blip");

            assertTrue(events.stream().noneMatch(event ->
                event.kind == AndroidConnectionServiceEventEnvelope.Kind.PHYSICAL_ERROR));
        } finally {
            AndroidConnectionService.resetForTests();
        }
    }

    @Test
    public void sustainedPhysicalFailureProjectsExactlyOnce() throws Exception {
        AndroidConnectionService.resetForTests();
        List<AndroidConnectionServiceEventEnvelope> events = new ArrayList<>();
        AndroidConnectionService.registerListenerForTests(new AndroidConnectionServiceListener() {
            @Override public void onSnapshot(AndroidConnectionServiceSnapshot snapshot) { }
            @Override public void onEvent(AndroidConnectionServiceEventEnvelope event) {
                events.add(event);
            }
        });
        try {
            Object runtime = newDebouncedFailureRuntime(new AndroidConnectionService());
            setField(runtime, "physicalErrorFirstAtMillis",
                System.currentTimeMillis() - 8_000L);

            invokeTransportFailure(runtime, "websocket", "sustained outage");
            setField(runtime, "generation", "gen-2");
            invokeTransportFailure(runtime, "websocket", "repeat while already projected");

            assertEquals(1, events.stream().filter(event ->
                event.kind == AndroidConnectionServiceEventEnvelope.Kind.PHYSICAL_ERROR).count());
        } finally {
            AndroidConnectionService.resetForTests();
        }
    }

    @Test
    public void recoveryClearsPendingPhysicalFailureProjection() throws Exception {
        AndroidConnectionService.resetForTests();
        List<AndroidConnectionServiceEventEnvelope> events = new ArrayList<>();
        AndroidConnectionService.registerListenerForTests(new AndroidConnectionServiceListener() {
            @Override public void onSnapshot(AndroidConnectionServiceSnapshot snapshot) { }
            @Override public void onEvent(AndroidConnectionServiceEventEnvelope event) {
                events.add(event);
            }
        });
        try {
            Object runtime = newDebouncedFailureRuntime(new AndroidConnectionService());
            Method recordServerActivity = runtime.getClass().getDeclaredMethod("recordServerActivity");
            recordServerActivity.setAccessible(true);
            recordServerActivity.invoke(runtime);

            invokeTransportFailure(runtime, "websocket", "failure after recovery");

            assertTrue(events.stream().noneMatch(event ->
                event.kind == AndroidConnectionServiceEventEnvelope.Kind.PHYSICAL_ERROR));
        } finally {
            AndroidConnectionService.resetForTests();
        }
    }
}
