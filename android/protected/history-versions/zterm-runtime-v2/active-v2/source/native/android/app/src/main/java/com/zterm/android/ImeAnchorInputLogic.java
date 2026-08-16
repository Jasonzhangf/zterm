package com.zterm.android;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.nio.charset.StandardCharsets;

class ImeAnchorInputLogic {
    static final int MAX_EMIT_INPUT_BYTES = 16 * 1024;

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
        for (String chunk : splitUtf8Chunks(text, MAX_EMIT_INPUT_BYTES)) {
            events.add(Event.emitInput(chunk));
        }
        events.add(Event.clearEditable());
        return events;
    }

    private static List<String> splitUtf8Chunks(String text, int maxBytes) {
        if (maxBytes < 4) {
            throw new IllegalArgumentException("terminal input chunk size must be at least 4 UTF-8 bytes");
        }
        if (text.isEmpty()) {
            return Collections.emptyList();
        }
        List<String> chunks = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        int currentBytes = 0;
        for (int index = 0; index < text.length();) {
            int codePoint = text.codePointAt(index);
            String codePointText = new String(Character.toChars(codePoint));
            int codePointBytes = codePointText.getBytes(StandardCharsets.UTF_8).length;
            if (currentBytes > 0 && currentBytes + codePointBytes > maxBytes) {
                chunks.add(current.toString());
                current.setLength(0);
                currentBytes = 0;
            }
            current.append(codePointText);
            currentBytes += codePointBytes;
            index += Character.charCount(codePoint);
        }
        if (current.length() > 0) {
            chunks.add(current.toString());
        }
        return chunks;
    }
}
