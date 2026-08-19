package com.zterm.android;

import org.json.JSONException;
import org.json.JSONObject;

public final class AndroidConnectionServiceServerFrameEvent {
    public enum Kind {
        MUX_READY("mux-ready"),
        MUX_TARGET_MESSAGE("mux-target-message"),
        MUX_PONG("mux-pong"),
        MUX_ERROR("mux-error");

        private final String wireName;
        Kind(String wireName) { this.wireName = wireName; }
        public String wireName() { return wireName; }
    }

    public final Kind kind;
    public final String targetKey;
    public final String generation;
    public final long receivedAt;
    public final JSONObject payload;

    private AndroidConnectionServiceServerFrameEvent(Builder b) {
        this.kind = b.kind;
        this.targetKey = b.targetKey;
        this.generation = b.generation;
        this.receivedAt = b.receivedAt;
        this.payload = b.payload;
    }

    public JSONObject toJson() throws JSONException {
        JSONObject json = new JSONObject();
        json.put("type", kind.wireName());
        json.put("targetKey", targetKey);
        json.put("generation", generation == null ? JSONObject.NULL : generation);
        json.put("receivedAt", receivedAt);
        json.put("payload", payload == null ? JSONObject.NULL : payload);
        return json;
    }

    public static final class Builder {
        private final Kind kind;
        private String targetKey;
        private String generation;
        private long receivedAt;
        private JSONObject payload;

        public Builder(Kind kind) { this.kind = kind; }
        public Builder targetKey(String v) { this.targetKey = v; return this; }
        public Builder generation(String v) { this.generation = v; return this; }
        public Builder receivedAt(long v) { this.receivedAt = v; return this; }
        public Builder payload(JSONObject v) { this.payload = v; return this; }
        public AndroidConnectionServiceServerFrameEvent build() {
            if (generation == null || generation.trim().isEmpty()) {
                throw new IllegalArgumentException(kind.wireName() + " requires generation");
            }
            if (targetKey == null || targetKey.trim().isEmpty()) {
                throw new IllegalArgumentException(kind.wireName() + " requires targetKey");
            }
            if (payload == null) {
                throw new IllegalArgumentException(kind.wireName() + " requires payload");
            }
            return new AndroidConnectionServiceServerFrameEvent(this);
        }
    }
}
