package com.zterm.android;

import static org.junit.Assert.assertEquals;

import org.json.JSONObject;
import org.junit.Test;

public final class AndroidConnectionServiceEventEnvelopeTest {
    @Test
    public void channelClosedPreservesReasonAndCode() throws Exception {
        AndroidConnectionServiceEventEnvelope event =
            AndroidConnectionServiceEventEnvelope.channelClosed(
                "target-a", "generation-1", "channel-a",
                "body subscription released", "no_body_demand");

        JSONObject json = event.toJson();

        assertEquals("channel-closed", json.getString("kind"));
        assertEquals("body subscription released", json.getString("reason"));
        assertEquals("no_body_demand", json.getString("code"));
    }
}
