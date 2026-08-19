package com.zterm.android;

/** Projection listener for typed service events. */
public interface AndroidConnectionServiceListener {
    void onSnapshot(AndroidConnectionServiceSnapshot snapshot);

    default void onEvent(AndroidConnectionServiceEventEnvelope event) {
        if (event != null
            && event.kind == AndroidConnectionServiceEventEnvelope.Kind.STATE_CHANGED
            && event.snapshot != null) {
            onSnapshot(event.snapshot);
        }
    }
}
