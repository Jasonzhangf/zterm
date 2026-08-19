package com.zterm.android;

/**
 * Explicit typed command sink for AndroidConnectionService. This interface is
 * intentionally small: Activity / WebView / React may not inject lifecycle,
 * heartbeat, retry or network-generation events.
 */
public final class AndroidConnectionCommandReceiver {
    public AndroidConnectionCommand onCommand(AndroidConnectionCommand command) {
        if (command == null) {
            throw new IllegalArgumentException("command must not be null");
        }
        return command;
    }
}
