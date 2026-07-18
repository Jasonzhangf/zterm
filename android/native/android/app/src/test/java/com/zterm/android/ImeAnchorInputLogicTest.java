package com.zterm.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
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
    public void voiceStyleCommitTextEmitsCjkEmojiSymbolsAndLineBreaksAsOneTextEvent() {
        ImeAnchorInputLogic logic = new ImeAnchorInputLogic();
        String source = "第一段语音😀\n第二段，含特殊符号￥\n第三段";

        List<ImeAnchorInputLogic.Event> events = logic.onCommitText(source);

        assertEquals(2, events.size());
        assertEquals(ImeAnchorInputLogic.EventType.EMIT_INPUT, events.get(0).type);
        assertEquals(source, events.get(0).text);
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
    public void commitTextStillEmitsCommittedTextEvenIfFrameworkSnapshotWouldStillLookComposing() {
        ImeAnchorInputLogic logic = new ImeAnchorInputLogic();

        logic.onEditableChanged("语音识别", true);
        List<ImeAnchorInputLogic.Event> events = logic.onCommitText("语音识别结果");

        assertEquals(2, events.size());
        assertEquals(ImeAnchorInputLogic.EventType.EMIT_INPUT, events.get(0).type);
        assertEquals("语音识别结果", events.get(0).text);
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

    @Test
    public void editorActionEnterMapsToCarriageReturnInput() {
        ImeAnchorInputLogic logic = new ImeAnchorInputLogic();

        List<ImeAnchorInputLogic.Event> events = logic.onCommitText("\r");

        assertEquals(2, events.size());
        assertEquals(ImeAnchorInputLogic.EventType.EMIT_INPUT, events.get(0).type);
        assertEquals("\r", events.get(0).text);
        assertEquals(ImeAnchorInputLogic.EventType.CLEAR_EDITABLE, events.get(1).type);
    }

    @Test
    public void longCommitTextIsChunkedBeforeBridgeEmissionAndPreservesOrder() {
        ImeAnchorInputLogic logic = new ImeAnchorInputLogic();
        StringBuilder builder = new StringBuilder();
        for (int index = 0; index < ImeAnchorInputLogic.MAX_EMIT_INPUT_BYTES / 3 + 16; index++) {
            builder.append("中");
        }
        builder.append("tail");
        String source = builder.toString();

        List<ImeAnchorInputLogic.Event> events = logic.onCommitText(source);

        assertTrue(events.size() > 2);
        assertEquals(ImeAnchorInputLogic.EventType.CLEAR_EDITABLE, events.get(events.size() - 1).type);
        StringBuilder emitted = new StringBuilder();
        for (int index = 0; index < events.size() - 1; index++) {
            ImeAnchorInputLogic.Event event = events.get(index);
            assertEquals(ImeAnchorInputLogic.EventType.EMIT_INPUT, event.type);
            assertTrue(event.text.getBytes(StandardCharsets.UTF_8).length <= ImeAnchorInputLogic.MAX_EMIT_INPUT_BYTES);
            emitted.append(event.text);
        }
        assertEquals(source, emitted.toString());
    }

    @Test
    public void longCommitTextDoesNotSplitEmojiSurrogatePairs() {
        ImeAnchorInputLogic logic = new ImeAnchorInputLogic();
        StringBuilder builder = new StringBuilder("a");
        for (int index = 0; index < ImeAnchorInputLogic.MAX_EMIT_INPUT_BYTES / 4 + 4; index++) {
            builder.append("😀");
        }
        builder.append("z");
        String source = builder.toString();

        List<ImeAnchorInputLogic.Event> events = logic.onCommitText(source);

        assertTrue(events.size() > 2);
        StringBuilder emitted = new StringBuilder();
        for (int index = 0; index < events.size() - 1; index++) {
            String chunk = events.get(index).text;
            char first = chunk.charAt(0);
            char last = chunk.charAt(chunk.length() - 1);
            assertTrue(first < 0xdc00 || first > 0xdfff);
            assertTrue(last < 0xd800 || last > 0xdbff);
            assertTrue(chunk.getBytes(StandardCharsets.UTF_8).length <= ImeAnchorInputLogic.MAX_EMIT_INPUT_BYTES);
            emitted.append(chunk);
        }
        assertEquals(source, emitted.toString());
        assertEquals(ImeAnchorInputLogic.EventType.CLEAR_EDITABLE, events.get(events.size() - 1).type);
    }
}
