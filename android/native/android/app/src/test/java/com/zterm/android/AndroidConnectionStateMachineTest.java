package com.zterm.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

public class AndroidConnectionStateMachineTest {
    private static AndroidConnectionServiceTarget target(String key) {
        return new AndroidConnectionServiceTarget.Builder()
            .targetKey(key)
            .bridgeHost("127.0.0.1")
            .bridgePort(3333)
            .authToken("token")
            .build();
    }

    @Test
    public void reachesHealthyThroughTypedTransitions() {
        List<AndroidConnectionServiceSnapshot> snapshots = new ArrayList<>();
        AndroidConnectionStateMachine machine = new AndroidConnectionStateMachine(snapshots::add);

        assertTrue(machine.dispatch(AndroidConnectionServiceEvent.bindTarget(target("daemon-a")), 1));
        assertTrue(machine.dispatch(AndroidConnectionServiceEvent.transportOpening("gen-1"), 2));
        assertTrue(machine.dispatch(AndroidConnectionServiceEvent.muxReady("gen-1"), 3));
        assertTrue(machine.dispatch(AndroidConnectionServiceEvent.channelOpened("gen-1", "channel-a", 4), 4));
        assertTrue(machine.dispatch(AndroidConnectionServiceEvent.heartbeatPong("gen-1", 5), 5));

        AndroidConnectionServiceSnapshot snapshot = machine.readSnapshot();
        assertEquals(AndroidConnectionServiceSnapshot.State.HEALTHY, snapshot.state);
        assertEquals("gen-1", snapshot.generation);
        assertEquals(Long.valueOf(5L), snapshot.lastHeartbeatAt);
        assertEquals(1, snapshot.channels.size());
        assertEquals(AndroidConnectionServiceSnapshot.Channel.State.OPEN, snapshot.channels.get(0).state);
        assertFalse(snapshots.isEmpty());
    }

    @Test
    public void threeMissesRetireExactlyOneGenerationAndStaleEventsCannotMutateSnapshot() {
        AndroidConnectionStateMachine machine = new AndroidConnectionStateMachine(null);
        machine.dispatch(AndroidConnectionServiceEvent.bindTarget(target("daemon-a")), 1);
        machine.dispatch(AndroidConnectionServiceEvent.transportOpening("gen-1"), 2);
        machine.dispatch(AndroidConnectionServiceEvent.muxReady("gen-1"), 3);

        assertTrue(machine.dispatch(AndroidConnectionServiceEvent.heartbeatMissed("gen-1"), 4));
        assertTrue(machine.dispatch(AndroidConnectionServiceEvent.heartbeatMissed("gen-1"), 5));
        assertTrue(machine.dispatch(AndroidConnectionServiceEvent.heartbeatMissed("gen-1"), 6));

        AndroidConnectionServiceSnapshot afterRetire = machine.readSnapshot();
        assertEquals(AndroidConnectionServiceSnapshot.State.BACKOFF_RECONNECT, afterRetire.state);
        assertNull(afterRetire.generation);
        assertEquals(Long.valueOf(1006L), afterRetire.nextRetryAt);
        assertEquals("heartbeat-timeout", afterRetire.error.code);

        assertFalse(machine.dispatch(AndroidConnectionServiceEvent.serverActivity("gen-1", 7), 7));
        assertEquals(afterRetire, machine.readSnapshot());
    }

    @Test
    public void authenticationFailureStopsAutomaticReconnect() {
        AndroidConnectionStateMachine machine = new AndroidConnectionStateMachine(null);
        machine.dispatch(AndroidConnectionServiceEvent.bindTarget(target("daemon-a")), 1);
        machine.dispatch(AndroidConnectionServiceEvent.transportOpening("gen-1"), 2);

        assertTrue(machine.dispatch(AndroidConnectionServiceEvent.authenticationFailure("gen-1", "denied"), 3));
        AndroidConnectionServiceSnapshot snapshot = machine.readSnapshot();
        assertEquals(AndroidConnectionServiceSnapshot.State.AUTHENTICATION_ERROR, snapshot.state);
        assertNull(snapshot.generation);
        assertNull(snapshot.nextRetryAt);
        assertEquals("authentication", snapshot.error.code);
        assertFalse(machine.dispatch(AndroidConnectionServiceEvent.reconnectAttempt("gen-1", 4), 4));
    }

    @Test
    public void manualRoutePolicySurvivesTargetReleaseWithoutReconnecting() {
        AndroidConnectionStateMachine machine = new AndroidConnectionStateMachine(null);
        AndroidConnectionServiceRoutePolicy route = AndroidConnectionServiceRoutePolicy.manual(
            AndroidConnectionServiceRoutePolicy.Path.TAILSCALE);

        assertTrue(machine.dispatch(AndroidConnectionServiceEvent.setRoutePolicy(route), 1));
        assertTrue(machine.dispatch(AndroidConnectionServiceEvent.bindTarget(target("daemon-a")), 2));
        assertTrue(machine.dispatch(AndroidConnectionServiceEvent.releaseTarget("user"), 3));

        AndroidConnectionServiceSnapshot snapshot = machine.readSnapshot();
        assertEquals(AndroidConnectionServiceSnapshot.State.IDLE, snapshot.state);
        assertNull(snapshot.target);
        assertEquals(AndroidConnectionServiceRoutePolicy.Mode.MANUAL, snapshot.route.mode);
        assertEquals(AndroidConnectionServiceRoutePolicy.Path.TAILSCALE, snapshot.route.path);
    }
}
