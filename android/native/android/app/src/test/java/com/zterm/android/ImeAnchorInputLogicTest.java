package com.zterm.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.List;
import org.junit.Test;

public class ImeAnchorInputLogicTest {

    @Test
    public void composingChineseDoesNotEmitIntermediateDelta() {
        ImeAnchorInputLogic logic = new ImeAnchorInputLogic();

        List<ImeAnchorInputLogic.Event> first = logic.onEditableChanged("ni", true);
        List<ImeAnchorInputLogic.Event> second = logic.onEditableChanged("nih", true);

        assertTrue(first.isEmpty());
        assertTrue(second.isEmpty());
    }

    @Test
    public void commitTextEmitsCommittedChineseExactlyOnceAndRequestsClear() {
        ImeAnchorInputLogic logic = new ImeAnchorInputLogic();

        logic.onEditableChanged("ni", true);
        List<ImeAnchorInputLogic.Event> events = logic.onCommitText("你");

        assertEquals(2, events.size());
        assertEquals(ImeAnchorInputLogic.EventType.EMIT_INPUT, events.get(0).type);
        assertEquals("你", events.get(0).text);
        assertEquals(ImeAnchorInputLogic.EventType.CLEAR_EDITABLE, events.get(1).type);
    }

    @Test
    public void finishComposingEmitsFinalTextExactlyOnceAndRequestsClear() {
        ImeAnchorInputLogic logic = new ImeAnchorInputLogic();

        logic.onEditableChanged("ni", true);
        List<ImeAnchorInputLogic.Event> events = logic.onFinishComposingText("你好");

        assertEquals(2, events.size());
        assertEquals(ImeAnchorInputLogic.EventType.EMIT_INPUT, events.get(0).type);
        assertEquals("你好", events.get(0).text);
        assertEquals(ImeAnchorInputLogic.EventType.CLEAR_EDITABLE, events.get(1).type);
    }

    @Test
    public void frameworkCommittedEditableSnapshotEmitsOnceWhenComposingEnds() {
        ImeAnchorInputLogic logic = new ImeAnchorInputLogic();

        List<ImeAnchorInputLogic.Event> composing = logic.onEditableChanged("ni", true);
        List<ImeAnchorInputLogic.Event> committed = logic.onEditableChanged("你", false);

        assertTrue(composing.isEmpty());
        assertEquals(2, committed.size());
        assertEquals(ImeAnchorInputLogic.EventType.EMIT_INPUT, committed.get(0).type);
        assertEquals("你", committed.get(0).text);
        assertEquals(ImeAnchorInputLogic.EventType.CLEAR_EDITABLE, committed.get(1).type);
    }

    @Test
    public void directEditableCommitWithoutComposingStillEmitsOnce() {
        ImeAnchorInputLogic logic = new ImeAnchorInputLogic();

        List<ImeAnchorInputLogic.Event> events = logic.onEditableChanged("abc", false);

        assertEquals(2, events.size());
        assertEquals(ImeAnchorInputLogic.EventType.EMIT_INPUT, events.get(0).type);
        assertEquals("abc", events.get(0).text);
        assertEquals(ImeAnchorInputLogic.EventType.CLEAR_EDITABLE, events.get(1).type);
    }
}
