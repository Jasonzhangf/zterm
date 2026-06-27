package com.zterm.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import android.view.KeyEvent;
import org.junit.Test;

public class ImeAnchorHardwareKeyMappingTest {

    @Test
    public void plainLetterStaysOnEditableImePath() {
        assertNull(ImeAnchorPlugin.mapHardwareKeyToKey(
            KeyEvent.KEYCODE_A,
            false,
            false,
            false
        ));
        assertNull(ImeAnchorPlugin.mapHardwareKeyToCode(
            KeyEvent.KEYCODE_A,
            false,
            false
        ));
    }

    @Test
    public void ctrlLetterUsesHardwareKeyPathForTerminalControlChords() {
        assertEquals("c", ImeAnchorPlugin.mapHardwareKeyToKey(
            KeyEvent.KEYCODE_C,
            true,
            false,
            false
        ));
        assertEquals("KeyC", ImeAnchorPlugin.mapHardwareKeyToCode(
            KeyEvent.KEYCODE_C,
            true,
            false
        ));

        assertEquals("d", ImeAnchorPlugin.mapHardwareKeyToKey(
            KeyEvent.KEYCODE_D,
            true,
            false,
            false
        ));
        assertEquals("KeyD", ImeAnchorPlugin.mapHardwareKeyToCode(
            KeyEvent.KEYCODE_D,
            true,
            false
        ));
    }

    @Test
    public void ctrlBracketUsesTerminalControlChordKeys() {
        assertEquals("[", ImeAnchorPlugin.mapHardwareKeyToKey(
            KeyEvent.KEYCODE_LEFT_BRACKET,
            true,
            false,
            false
        ));
        assertEquals("BracketLeft", ImeAnchorPlugin.mapHardwareKeyToCode(
            KeyEvent.KEYCODE_LEFT_BRACKET,
            true,
            false
        ));
    }

    @Test
    public void specialKeysStayOnHardwareKeyPathWithoutModifiers() {
        assertEquals("ArrowUp", ImeAnchorPlugin.mapHardwareKeyToKey(
            KeyEvent.KEYCODE_DPAD_UP,
            false,
            false,
            false
        ));
        assertEquals("ArrowUp", ImeAnchorPlugin.mapHardwareKeyToCode(
            KeyEvent.KEYCODE_DPAD_UP,
            false,
            false
        ));

        assertEquals("Escape", ImeAnchorPlugin.mapHardwareKeyToKey(
            KeyEvent.KEYCODE_ESCAPE,
            false,
            false,
            false
        ));
        assertEquals("Escape", ImeAnchorPlugin.mapHardwareKeyToCode(
            KeyEvent.KEYCODE_ESCAPE,
            false,
            false
        ));

        assertEquals("Backspace", ImeAnchorPlugin.mapHardwareKeyToKey(
            KeyEvent.KEYCODE_DEL,
            false,
            false,
            false
        ));
        assertEquals("Backspace", ImeAnchorPlugin.mapHardwareKeyToCode(
            KeyEvent.KEYCODE_DEL,
            false,
            false
        ));

        assertEquals("Delete", ImeAnchorPlugin.mapHardwareKeyToKey(
            KeyEvent.KEYCODE_FORWARD_DEL,
            false,
            false,
            false
        ));
        assertEquals("Delete", ImeAnchorPlugin.mapHardwareKeyToCode(
            KeyEvent.KEYCODE_FORWARD_DEL,
            false,
            false
        ));
    }
}
