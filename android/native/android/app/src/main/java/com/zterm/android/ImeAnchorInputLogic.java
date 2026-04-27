package com.zterm.android;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

class ImeAnchorInputLogic {

    enum EventType {
        EMIT_INPUT,
        EMIT_BACKSPACE,
        CLEAR_EDITABLE,
    }

    static class Event {
        final EventType type;
        final String text;
        final int count;

        private Event(EventType type, String text, int count) {
            this.type = type;
            this.text = text;
            this.count = count;
        }

        static Event emitInput(String text) {
            return new Event(EventType.EMIT_INPUT, text, 0);
        }

        static Event emitBackspace(int count) {
            return new Event(EventType.EMIT_BACKSPACE, null, Math.max(1, count));
        }

        static Event clearEditable() {
            return new Event(EventType.CLEAR_EDITABLE, null, 0);
        }
    }

    private String lastEditableText = "";
    private boolean composing = false;

    List<Event> onEditableChanged(String currentText, boolean hasComposingText) {
        String nextText = currentText == null ? "" : currentText;
        lastEditableText = nextText;
        composing = hasComposingText;

        if (nextText.isEmpty() || hasComposingText) {
            return Collections.emptyList();
        }

        return emitCommittedText(nextText);
    }

    List<Event> onCommitText(String committedText) {
        String text = committedText == null ? "" : committedText;
        if (text.isEmpty()) {
            reset();
            return Collections.emptyList();
        }
        return emitCommittedText(text);
    }

    List<Event> onFinishComposingText(String editableText) {
        String text = editableText == null ? "" : editableText;
        if (text.isEmpty()) {
            reset();
            return Collections.emptyList();
        }
        return emitCommittedText(text);
    }

    void reset() {
        lastEditableText = "";
        composing = false;
    }

    @SuppressWarnings("unused")
    String getLastEditableText() {
        return lastEditableText;
    }

    @SuppressWarnings("unused")
    boolean isComposing() {
        return composing;
    }

    private List<Event> emitCommittedText(String text) {
        reset();
        List<Event> events = new ArrayList<>();
        events.add(Event.emitInput(text));
        events.add(Event.clearEditable());
        return events;
    }
}
