package com.zterm.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Red/lock test for the native transport-flow projection.
 *
 * The native DataChannel buffered amount is the only sender-side queue truth.
 * It must reach the immutable snapshot as a typed FlowObservation, survive
 * same-generation projections (heartbeat pong / channel open), be cleared when
 * a new transport generation opens, and reject stale-generation callbacks.
 */
public final class AndroidConnectionStateMachineFlowTest {
    private static AndroidConnectionServiceTarget target(String key) {
        return new AndroidConnectionServiceTarget.Builder()
            .targetKey(key)
            .bridgeHost("127.0.0.1")
            .bridgePort(3333)
            .authToken("token")
            .build();
    }

    private static AndroidConnectionStateMachine connected() {
        AndroidConnectionStateMachine machine = new AndroidConnectionStateMachine(null);
        assertTrue(machine.dispatch(AndroidConnectionServiceEvent.bindTarget(target("daemon-a")), 1));
        assertTrue(machine.dispatch(AndroidConnectionServiceEvent.transportOpening("gen-1"), 2));
        assertTrue(machine.dispatch(AndroidConnectionServiceEvent.muxReady(
            "gen-1", "{\"version\":1,\"daemonHostId\":\"daemon-host-exact\"}"), 3));
        return machine;
    }

    @Test
    public void flowObservationProjectsNonNullValuesIntoSnapshot() {
        AndroidConnectionStateMachine machine = connected();

        assertTrue(machine.dispatch(AndroidConnectionServiceEvent.transportFlowChanged(
            "gen-1", 200_000L, 4_096L, 3L, true, 1_000L), 1_000L));

        AndroidConnectionServiceSnapshot snapshot = machine.readSnapshot();
        AndroidConnectionServiceSnapshot.FlowObservation flow = snapshot.transportFlow;
        assertNotNull("native flow must project into the snapshot", flow);
        assertEquals(200_000L, flow.nativeBufferedBytes);
        assertEquals(4_096L, flow.serviceQueuedBytes);
        assertEquals(3L, flow.serviceQueuedFrames);
        assertTrue(flow.backpressured);
        assertEquals(1_000L, flow.sampledAt);
    }

    @Test
    public void flowObservationSurvivesSameGenerationProjections() {
        AndroidConnectionStateMachine machine = connected();
        machine.dispatch(AndroidConnectionServiceEvent.transportFlowChanged(
            "gen-1", 100_000L, 2_048L, 2L, false, 1_000L), 1_000L);

        assertTrue(machine.dispatch(AndroidConnectionServiceEvent.channelOpened(
            "gen-1", "channel-a", "shell", 2_100L), 2_100L));
        assertTrue(machine.dispatch(AndroidConnectionServiceEvent.heartbeatPong("gen-1", 2_000L), 2_000L));

        AndroidConnectionServiceSnapshot.FlowObservation flow = machine.readSnapshot().transportFlow;
        assertNotNull("flow must not be dropped by same-generation state projection", flow);
        assertEquals(100_000L, flow.nativeBufferedBytes);
        assertEquals(2_048L, flow.serviceQueuedBytes);
        assertFalse(flow.backpressured);
    }

    @Test
    public void newTransportGenerationClearsPriorFlowReading() {
        AndroidConnectionStateMachine machine = connected();
        machine.dispatch(AndroidConnectionServiceEvent.transportFlowChanged(
            "gen-1", 100_000L, 0L, 0L, true, 1_000L), 1_000L);
        // A real transport failure retires gen-1 before a new opening.
        assertTrue(machine.dispatch(AndroidConnectionServiceEvent.transportFailure(
            "gen-1", "physical loss", null), 2_000L));
        assertTrue(machine.dispatch(AndroidConnectionServiceEvent.transportOpening("gen-2"), 3_000L));

        assertNull("a new transport generation must not inherit a prior flow reading",
            machine.readSnapshot().transportFlow);
    }

    @Test
    public void staleGenerationFlowCallbackCannotMutateCurrentSnapshot() {
        AndroidConnectionStateMachine machine = connected();
        machine.dispatch(AndroidConnectionServiceEvent.transportFlowChanged(
            "gen-1", 10_000L, 1_024L, 1L, false, 1_000L), 1_000L);
        AndroidConnectionServiceSnapshot before = machine.readSnapshot();

        assertFalse(machine.dispatch(AndroidConnectionServiceEvent.transportFlowChanged(
            "gen-old", 999_999L, 999L, 9L, true, 5_000L), 5_000L));
        assertEquals("stale generation flow must not overwrite current truth", before, machine.readSnapshot());
    }
}
