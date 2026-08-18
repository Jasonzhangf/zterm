package com.zterm.android;

import org.json.JSONException;
import org.json.JSONObject;

public final class AndroidConnectionServiceEventEnvelope {
    public enum Kind {
        STATE_CHANGED("state-changed"),
        COMMAND_REJECTED("command-rejected"),
        PHYSICAL_ERROR("physical-error"),
        CHANNEL_OPENED("channel-opened"),
        CHANNEL_CLOSED("channel-closed"),
        SERVER_FRAME("server-frame"),
        CHANNEL_MESSAGE("channel-message");

        private final String wireName;
        Kind(String wireName) { this.wireName = wireName; }
        public String wireName() { return wireName; }
    }

    public final Kind kind;
    public final AndroidConnectionServiceSnapshot snapshot;
    public final AndroidConnectionCommand rejectedCommand;
    public final String errorCode;
    public final String errorMessage;
    public final String targetKey;
    public final String channelId;
    public final AndroidConnectionServiceServerFrameEvent serverFrame;
    public final AndroidConnectionServiceChannelMessageEvent channelMessage;

    private AndroidConnectionServiceEventEnvelope(Builder b) {
        this.kind = b.kind;
        this.snapshot = b.snapshot;
        this.rejectedCommand = b.rejectedCommand;
        this.errorCode = b.errorCode;
        this.errorMessage = b.errorMessage;
        this.targetKey = b.targetKey;
        this.channelId = b.channelId;
        this.serverFrame = b.serverFrame;
        this.channelMessage = b.channelMessage;
    }

    public JSONObject toJson() throws JSONException {
        JSONObject json = new JSONObject();
        json.put("kind", kind.wireName());
        if (targetKey != null && !targetKey.trim().isEmpty()) {
            json.put("targetKey", targetKey);
        }
        switch (kind) {
            case STATE_CHANGED:
                json.put("snapshot", snapshot == null ? JSONObject.NULL : snapshot.toJson());
                break;
            case COMMAND_REJECTED:
                json.put("command", rejectedCommand == null ? JSONObject.NULL : rejectedCommand.toJson());
                json.put("errorCode", errorCode == null ? "" : errorCode);
                json.put("errorMessage", errorMessage == null ? "" : errorMessage);
                break;
            case PHYSICAL_ERROR:
                json.put("errorCode", errorCode == null ? "" : errorCode);
                json.put("errorMessage", errorMessage == null ? "" : errorMessage);
                break;
            case CHANNEL_OPENED:
                json.put("channelId", channelId == null ? "" : channelId);
                json.put("snapshot", snapshot == null ? JSONObject.NULL : snapshot.toJson());
                break;
            case CHANNEL_CLOSED:
                json.put("channelId", channelId == null ? "" : channelId);
                break;
            case SERVER_FRAME:
                json.put("frame", serverFrame == null ? JSONObject.NULL : serverFrame.toJson());
                break;
            case CHANNEL_MESSAGE:
                json.put("message", channelMessage == null ? JSONObject.NULL : channelMessage.toJson());
                break;
        }
        return json;
    }

    public static AndroidConnectionServiceEventEnvelope stateChanged(AndroidConnectionServiceSnapshot snapshot) {
        return new Builder(Kind.STATE_CHANGED).snapshot(snapshot).build();
    }

    public static AndroidConnectionServiceEventEnvelope commandRejected(
        AndroidConnectionCommand command, String errorCode, String errorMessage) {
        return new Builder(Kind.COMMAND_REJECTED).rejectedCommand(command)
            .targetKey(command == null ? null : command.targetKey)
            .errorCode(errorCode).errorMessage(errorMessage).build();
    }

    public static AndroidConnectionServiceEventEnvelope physicalError(String errorCode, String errorMessage) {
        return new Builder(Kind.PHYSICAL_ERROR).errorCode(errorCode).errorMessage(errorMessage).build();
    }

    public static AndroidConnectionServiceEventEnvelope channelOpened(
        String targetKey, String channelId, AndroidConnectionServiceSnapshot snapshot) {
        return new Builder(Kind.CHANNEL_OPENED).targetKey(targetKey).channelId(channelId)
            .snapshot(snapshot).build();
    }

    public static AndroidConnectionServiceEventEnvelope channelClosed(String targetKey, String channelId) {
        return new Builder(Kind.CHANNEL_CLOSED).targetKey(targetKey).channelId(channelId).build();
    }

    public static AndroidConnectionServiceEventEnvelope serverFrame(AndroidConnectionServiceServerFrameEvent frame) {
        return new Builder(Kind.SERVER_FRAME).serverFrame(frame).build();
    }

    public static AndroidConnectionServiceEventEnvelope channelMessage(AndroidConnectionServiceChannelMessageEvent message) {
        return new Builder(Kind.CHANNEL_MESSAGE).channelMessage(message).build();
    }

    public static final class Builder {
        private final Kind kind;
        private AndroidConnectionServiceSnapshot snapshot;
        private AndroidConnectionCommand rejectedCommand;
        private String errorCode;
        private String errorMessage;
        private String targetKey;
        private String channelId;
        private AndroidConnectionServiceServerFrameEvent serverFrame;
        private AndroidConnectionServiceChannelMessageEvent channelMessage;

        public Builder(Kind kind) { this.kind = kind; }
        public Builder snapshot(AndroidConnectionServiceSnapshot v) { this.snapshot = v; return this; }
        public Builder rejectedCommand(AndroidConnectionCommand v) { this.rejectedCommand = v; return this; }
        public Builder errorCode(String v) { this.errorCode = v; return this; }
        public Builder errorMessage(String v) { this.errorMessage = v; return this; }
        public Builder targetKey(String v) { this.targetKey = v; return this; }
        public Builder channelId(String v) { this.channelId = v; return this; }
        public Builder serverFrame(AndroidConnectionServiceServerFrameEvent v) { this.serverFrame = v; return this; }
        public Builder channelMessage(AndroidConnectionServiceChannelMessageEvent v) { this.channelMessage = v; return this; }
        public AndroidConnectionServiceEventEnvelope build() {
            switch (kind) {
                case STATE_CHANGED:
                    if (snapshot == null) throw new IllegalArgumentException("state-changed snapshot required");
                    break;
                case COMMAND_REJECTED:
                    if (rejectedCommand == null) throw new IllegalArgumentException("command-rejected command required");
                    break;
                case CHANNEL_OPENED:
                case CHANNEL_CLOSED:
                    if (targetKey == null || targetKey.trim().isEmpty()) {
                        throw new IllegalArgumentException(kind.wireName() + " targetKey required");
                    }
                    if (channelId == null || channelId.trim().isEmpty()) {
                        throw new IllegalArgumentException(kind.wireName() + " channelId required");
                    }
                    break;
                case SERVER_FRAME:
                    if (serverFrame == null) throw new IllegalArgumentException("server-frame payload required");
                    break;
                case CHANNEL_MESSAGE:
                    if (channelMessage == null) throw new IllegalArgumentException("channel-message payload required");
                    break;
                case PHYSICAL_ERROR:
                default:
                    break;
            }
            return new AndroidConnectionServiceEventEnvelope(this);
        }
    }
}
