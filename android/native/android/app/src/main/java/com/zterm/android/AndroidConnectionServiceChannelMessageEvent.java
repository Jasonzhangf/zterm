package com.zterm.android;

import org.json.JSONException;
import org.json.JSONObject;

public final class AndroidConnectionServiceChannelMessageEvent {
    public final String generation;
    public final String channelId;
    public final JSONObject message;

    private AndroidConnectionServiceChannelMessageEvent(Builder b) {
        this.generation = b.generation;
        this.channelId = b.channelId;
        this.message = b.message;
    }

    public JSONObject toJson() throws JSONException {
        JSONObject json = new JSONObject();
        json.put("generation", generation == null ? JSONObject.NULL : generation);
        json.put("channelId", channelId == null ? "" : channelId);
        json.put("message", message == null ? JSONObject.NULL : message);
        return json;
    }

    public static final class Builder {
        private String generation;
        private String channelId;
        private JSONObject message;

        public Builder generation(String v) { this.generation = v; return this; }
        public Builder channelId(String v) { this.channelId = v; return this; }
        public Builder message(JSONObject v) { this.message = v; return this; }
        public AndroidConnectionServiceChannelMessageEvent build() {
            if (generation == null || generation.trim().isEmpty()) {
                throw new IllegalArgumentException("channel message requires generation");
            }
            if (channelId == null || channelId.trim().isEmpty()) {
                throw new IllegalArgumentException("channel message requires channelId");
            }
            if (message == null) {
                throw new IllegalArgumentException("channel message payload required");
            }
            return new AndroidConnectionServiceChannelMessageEvent(this);
        }
    }
}
