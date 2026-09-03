package com.zterm.android;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.graphics.Rect;
import android.text.Editable;
import android.text.InputType;
import android.text.Spannable;
import android.text.TextWatcher;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewTreeObserver;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputConnectionWrapper;
import android.view.inputmethod.InputMethodManager;
import android.widget.FrameLayout;
import androidx.appcompat.widget.AppCompatEditText;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.List;

@CapacitorPlugin(name = "ImeAnchor")
public class ImeAnchorPlugin extends Plugin {
    private static final String TAG = "ImeAnchor";

    private ImeAnchorEditText imeEditText;
    private FrameLayout rootView;
    private ViewTreeObserver.OnGlobalLayoutListener keyboardLayoutListener;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private boolean suppressTextChange = false;
    private boolean suppressFrameworkEditableDispatch = false;
    private boolean pasteInProgress = false;
    private boolean pendingShowRequest = false;
    private boolean lastKeyboardVisible = false;
    private int lastKeyboardHeight = 0;
    private final ImeAnchorInputLogic inputLogic = new ImeAnchorInputLogic();

    @Override
    public void load() {
        super.load();
        Log.d(TAG, "load()");
        getActivity().runOnUiThread(this::ensureImeAnchor);
    }

    @PluginMethod
    public void show(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            Log.i(TAG, "show()");
            ensureImeAnchor();
            pendingShowRequest = true;
            setTerminalAnchorInputEnabled(true);
            requestFocusAndShowKeyboard();
            call.resolve(buildState("show"));
        });
    }

    @PluginMethod
    public void hide(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            Log.i(TAG, "hide()");
            pendingShowRequest = false;
            hideKeyboard();
            setTerminalAnchorInputEnabled(false);
            call.resolve();
        });
    }

    @PluginMethod
    public void blur(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            Log.i(TAG, "blur()");
            pendingShowRequest = false;
            if (imeEditText != null) {
                imeEditText.clearFocus();
            }
            hideKeyboard();
            setTerminalAnchorInputEnabled(false);
            call.resolve();
        });
    }

    @PluginMethod
    public void getState(PluginCall call) {
        getActivity().runOnUiThread(() -> call.resolve(buildState("getState")));
    }

    @PluginMethod
    public void debugEmitInput(PluginCall call) {
        String text = call.getString("text", "");
        Log.i(TAG, "debugEmitInput(): text=" + text);
        JSObject payload = new JSObject();
        payload.put("text", text);
        notifyListeners("input", payload);
        call.resolve(buildState("debugEmitInput"));
    }

    @PluginMethod
    public void setEditorActive(PluginCall call) {
        boolean active = call.getBoolean("active", false);
        getActivity().runOnUiThread(() -> {
            Log.i(TAG, "setEditorActive(): active=" + active);
            if (imeEditText != null) {
                if (active) {
                    // Editor overlay is active: make ImeAnchor unfocusable so it
                    // cannot steal focus from WebView <input>/<textarea> elements.
                    // Do NOT hide keyboard — the HTML editor input needs it.
                    pendingShowRequest = false;
                    setTerminalAnchorInputEnabled(false);
                } else {
                    // Terminal mode remains inert until the keyboard button
                    // creates an explicit show request.
                    setTerminalAnchorInputEnabled(false);
                }
            }
            call.resolve(buildState("setEditorActive"));
        });
    }

    private void ensureImeAnchor() {
        if (imeEditText != null) {
            Log.i(TAG, "ensureImeAnchor(): reuse existing anchor");
            return;
        }

        rootView = getActivity().findViewById(android.R.id.content);
        ensureKeyboardObserver();
        if (rootView == null) {
            Log.w(TAG, "ensureImeAnchor(): rootView is null");
            return;
        }

        imeEditText = new ImeAnchorEditText(getContext());
        imeEditText.setPlugin(this);
        imeEditText.setBackground(null);
        imeEditText.setTextColor(0x00000000);
        imeEditText.setHintTextColor(0x00000000);
        imeEditText.setCursorVisible(false);
        imeEditText.setIncludeFontPadding(false);
        imeEditText.setPadding(0, 0, 0, 0);
        imeEditText.setHighlightColor(0x00000000);
        imeEditText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        imeEditText.setImeOptions(
            EditorInfo.IME_ACTION_UNSPECIFIED
                | EditorInfo.IME_FLAG_NO_EXTRACT_UI
                | EditorInfo.IME_FLAG_NO_FULLSCREEN
                | EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
        );
        imeEditText.setInputType(
            InputType.TYPE_CLASS_TEXT
                | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        );
        imeEditText.setSingleLine(true);
        imeEditText.setMinLines(1);
        imeEditText.setMaxLines(1);
        imeEditText.setMinHeight(dpToPx(48));
        imeEditText.setGravity(Gravity.CENTER_VERTICAL);
        imeEditText.setAlpha(1.0f);
        imeEditText.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        imeEditText.setFocusable(true);
        imeEditText.setFocusableInTouchMode(true);
        imeEditText.setShowSoftInputOnFocus(false);
        imeEditText.setOnFocusChangeListener((view, hasFocus) -> {
            Log.i(
                TAG,
                "imeEditText focus=" + hasFocus
                    + " windowFocus=" + view.hasWindowFocus()
                    + " attached=" + view.isAttachedToWindow()
            );
            if (!hasFocus
                && pendingShowRequest
                && view.hasWindowFocus()
                && view.isAttachedToWindow()
                && view.isFocusable()) {
                mainHandler.postDelayed(() -> {
                    if (imeEditText == null
                        || !pendingShowRequest
                        || !imeEditText.isFocusable()
                        || !imeEditText.isAttachedToWindow()
                        || !imeEditText.hasWindowFocus()
                        || imeEditText.hasFocus()) {
                        return;
                    }
                    Log.i(TAG, "imeEditText focus lost while terminal IME active; restoring anchor focus");
                    requestFocusAndShowKeyboard();
                }, 32);
            }
        });

        imeEditText.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {}

            @Override
            public void afterTextChanged(Editable editable) {
                handleEditableChanged(editable);
            }
        });

        FrameLayout.LayoutParams layoutParams = new FrameLayout.LayoutParams(
            dpToPx(240),
            dpToPx(48)
        );
        layoutParams.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
        layoutParams.bottomMargin = dpToPx(12);
        rootView.addView(imeEditText, layoutParams);
        setTerminalAnchorInputEnabled(false);
        Log.i(TAG, "ensureImeAnchor(): anchor attached");
    }

    private void setTerminalAnchorInputEnabled(boolean enabled) {
        if (imeEditText == null) {
            return;
        }
        if (!enabled && imeEditText.hasFocus()) {
            imeEditText.clearFocus();
        }
        imeEditText.setEnabled(enabled);
        imeEditText.setFocusable(enabled);
        imeEditText.setFocusableInTouchMode(enabled);
        imeEditText.setShowSoftInputOnFocus(enabled);
        imeEditText.setVisibility(enabled ? View.VISIBLE : View.INVISIBLE);
    }

    private void ensureKeyboardObserver() {
        if (rootView == null || keyboardLayoutListener != null) {
            return;
        }

        keyboardLayoutListener = () -> {
            if (rootView == null) {
                return;
            }

            Rect visibleFrame = new Rect();
            rootView.getWindowVisibleDisplayFrame(visibleFrame);
            int occludedHeight = Math.max(0, rootView.getRootView().getHeight() - visibleFrame.bottom);
            boolean keyboardVisible = occludedHeight > dpToPx(80);
            int keyboardHeight = keyboardVisible ? occludedHeight : 0;

            if (keyboardVisible == lastKeyboardVisible && keyboardHeight == lastKeyboardHeight) {
                return;
            }

            lastKeyboardVisible = keyboardVisible;
            lastKeyboardHeight = keyboardHeight;
            if (!keyboardVisible && pendingShowRequest) {
                pendingShowRequest = false;
                setTerminalAnchorInputEnabled(false);
            }
            Log.i(TAG, "keyboardState(): visible=" + keyboardVisible + " height=" + keyboardHeight);
            JSObject payload = new JSObject();
            payload.put("visible", keyboardVisible);
            payload.put("height", keyboardHeight);
            notifyListeners("keyboardState", payload);
        };

        rootView.getViewTreeObserver().addOnGlobalLayoutListener(keyboardLayoutListener);
    }

    private void handleEditableChanged(Editable editable) {
        if (suppressTextChange || suppressFrameworkEditableDispatch || imeEditText == null) {
            return;
        }

        String currentText = editable.toString();
        boolean composing = hasComposingText(editable);
        Log.i(TAG, "handleEditableChanged(): composing=" + composing + " length=" + editable.length());
        dispatchInputLogicEvents(
            inputLogic.onEditableChanged(currentText, composing),
            "editableChanged"
        );
    }

    private void dispatchEditableSnapshot(String source) {
        if (imeEditText == null) {
            return;
        }

        Editable editable = imeEditText.getText();
        if (editable == null) {
            return;
        }

        String currentText = editable.toString();
        boolean composing = hasComposingText(editable);
        Log.i(TAG, "dispatchEditableSnapshot(): source=" + source + " composing=" + composing + " length=" + editable.length());
        dispatchInputLogicEvents(
            inputLogic.onEditableChanged(currentText, composing),
            source
        );
    }

    private void clearImeEditText() {
        inputLogic.reset();
        if (imeEditText == null || imeEditText.getText() == null) {
            return;
        }
        suppressTextChange = true;
        imeEditText.getText().clear();
        suppressTextChange = false;
    }

    void emitBackspace(int count) {
        Log.i(TAG, "emitBackspace(): count=" + count);
        JSObject payload = new JSObject();
        payload.put("count", Math.max(1, count));
        notifyListeners("backspace", payload);
        clearImeEditText();
    }

    void emitInputText(String text, String source) {
        if (text == null || text.isEmpty()) {
            return;
        }

        Log.i(TAG, "emitInputText(): source=" + source + " text=" + text);
        JSObject payload = new JSObject();
        payload.put("text", text);
        notifyListeners("input", payload);
        clearImeEditText();
    }

    void emitHardwareKey(
        String key,
        String code,
        boolean ctrlKey,
        boolean altKey,
        boolean metaKey,
        boolean shiftKey
    ) {
        if (key == null || key.isEmpty()) {
            return;
        }

        Log.i(TAG, "emitHardwareKey(): key=" + key + " code=" + code);
        JSObject payload = new JSObject();
        payload.put("key", key);
        payload.put("code", code == null ? "" : code);
        payload.put("ctrlKey", ctrlKey);
        payload.put("altKey", altKey);
        payload.put("metaKey", metaKey);
        payload.put("shiftKey", shiftKey);
        notifyListeners("key", payload);
    }

    private void emitImeEnterKey(String source) {
        Log.i(TAG, "emitImeEnterKey(): source=" + source);
        emitHardwareKey("Enter", "Enter", false, false, false, false);
    }

    private void emitImeShiftEnterKey(String source) {
        Log.i(TAG, "emitImeShiftEnterKey(): source=" + source);
        emitHardwareKey("Enter", "Enter", false, false, false, true);
    }

    private boolean isLineBreakOnly(CharSequence text) {
        if (text == null || text.length() == 0) {
            return false;
        }
        for (int index = 0; index < text.length(); index += 1) {
            char ch = text.charAt(index);
            if (ch != '\n' && ch != '\r') {
                return false;
            }
        }
        return true;
    }

    static String mapHardwareKeyEventToKey(int keyCode, KeyEvent event) {
        return mapHardwareKeyToKey(
            keyCode,
            event != null && event.isCtrlPressed(),
            event != null && event.isAltPressed(),
            event != null && event.isShiftPressed()
        );
    }

    static String mapHardwareKeyEventToCode(int keyCode, KeyEvent event) {
        return mapHardwareKeyToCode(
            keyCode,
            event != null && event.isCtrlPressed(),
            event != null && event.isAltPressed()
        );
    }

    static String mapHardwareKeyToKey(int keyCode, boolean ctrlPressed, boolean altPressed, boolean shiftPressed) {
        String specialKey = mapSpecialKeyCodeToKey(keyCode);
        if (specialKey != null) {
            return specialKey;
        }
        if (!ctrlPressed && !altPressed) {
            return null;
        }
        return mapTerminalModifiedKeyCodeToKey(keyCode, shiftPressed);
    }

    static String mapHardwareKeyToCode(int keyCode, boolean ctrlPressed, boolean altPressed) {
        String specialCode = mapSpecialKeyCodeToCode(keyCode);
        if (specialCode != null) {
            return specialCode;
        }
        if (!ctrlPressed && !altPressed) {
            return null;
        }
        return mapTerminalModifiedKeyCodeToCode(keyCode);
    }

    private static String mapSpecialKeyCodeToKey(int keyCode) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_ESCAPE:
                return "Escape";
            case KeyEvent.KEYCODE_DEL:
                return "Backspace";
            case KeyEvent.KEYCODE_FORWARD_DEL:
                return "Delete";
            case KeyEvent.KEYCODE_DPAD_UP:
                return "ArrowUp";
            case KeyEvent.KEYCODE_DPAD_DOWN:
                return "ArrowDown";
            case KeyEvent.KEYCODE_DPAD_LEFT:
                return "ArrowLeft";
            case KeyEvent.KEYCODE_DPAD_RIGHT:
                return "ArrowRight";
            case KeyEvent.KEYCODE_TAB:
                return "Tab";
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
                return "Enter";
            default:
                return null;
        }
    }

    private static String mapSpecialKeyCodeToCode(int keyCode) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_ESCAPE:
                return "Escape";
            case KeyEvent.KEYCODE_DEL:
                return "Backspace";
            case KeyEvent.KEYCODE_FORWARD_DEL:
                return "Delete";
            case KeyEvent.KEYCODE_DPAD_UP:
                return "ArrowUp";
            case KeyEvent.KEYCODE_DPAD_DOWN:
                return "ArrowDown";
            case KeyEvent.KEYCODE_DPAD_LEFT:
                return "ArrowLeft";
            case KeyEvent.KEYCODE_DPAD_RIGHT:
                return "ArrowRight";
            case KeyEvent.KEYCODE_TAB:
                return "Tab";
            case KeyEvent.KEYCODE_ENTER:
                return "Enter";
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
                return "NumpadEnter";
            default:
                return null;
        }
    }

    private static String mapTerminalModifiedKeyCodeToKey(int keyCode, boolean shiftPressed) {
        if (keyCode >= KeyEvent.KEYCODE_A && keyCode <= KeyEvent.KEYCODE_Z) {
            char base = (char) ('a' + (keyCode - KeyEvent.KEYCODE_A));
            return String.valueOf(shiftPressed ? Character.toUpperCase(base) : base);
        }
        switch (keyCode) {
            case KeyEvent.KEYCODE_LEFT_BRACKET:
                return "[";
            case KeyEvent.KEYCODE_RIGHT_BRACKET:
                return "]";
            case KeyEvent.KEYCODE_BACKSLASH:
                return "\\";
            case KeyEvent.KEYCODE_SPACE:
                return shiftPressed ? "@" : " ";
            case KeyEvent.KEYCODE_MINUS:
                return shiftPressed ? "_" : "-";
            case KeyEvent.KEYCODE_GRAVE:
                return shiftPressed ? "~" : "`";
            case KeyEvent.KEYCODE_EQUALS:
                return shiftPressed ? "+" : "=";
            default:
                return null;
        }
    }

    private static String mapTerminalModifiedKeyCodeToCode(int keyCode) {
        if (keyCode >= KeyEvent.KEYCODE_A && keyCode <= KeyEvent.KEYCODE_Z) {
            char base = (char) ('A' + (keyCode - KeyEvent.KEYCODE_A));
            return "Key" + base;
        }
        switch (keyCode) {
            case KeyEvent.KEYCODE_LEFT_BRACKET:
                return "BracketLeft";
            case KeyEvent.KEYCODE_RIGHT_BRACKET:
                return "BracketRight";
            case KeyEvent.KEYCODE_BACKSLASH:
                return "Backslash";
            case KeyEvent.KEYCODE_SPACE:
                return "Space";
            case KeyEvent.KEYCODE_MINUS:
                return "Minus";
            case KeyEvent.KEYCODE_GRAVE:
                return "Backquote";
            case KeyEvent.KEYCODE_EQUALS:
                return "Equal";
            default:
                return null;
        }
    }

    private void dispatchInputLogicEvents(List<ImeAnchorInputLogic.Event> events, String source) {
        for (ImeAnchorInputLogic.Event event : events) {
            if (event.type == ImeAnchorInputLogic.EventType.EMIT_INPUT && event.text != null && !event.text.isEmpty()) {
                Log.i(TAG, "dispatchInputLogicEvents(): source=" + source + " emitInput=" + event.text);
                JSObject payload = new JSObject();
                payload.put("text", event.text);
                notifyListeners("input", payload);
                continue;
            }
            if (event.type == ImeAnchorInputLogic.EventType.EMIT_BACKSPACE && event.count > 0) {
                Log.i(TAG, "dispatchInputLogicEvents(): source=" + source + " emitBackspace=" + event.count);
                JSObject payload = new JSObject();
                payload.put("count", event.count);
                notifyListeners("backspace", payload);
                continue;
            }
            if (event.type == ImeAnchorInputLogic.EventType.CLEAR_EDITABLE) {
                Log.i(TAG, "dispatchInputLogicEvents(): source=" + source + " clearEditable");
                clearImeEditText();
            }
        }
    }

    private boolean hasComposingText(Editable editable) {
        if (!(editable instanceof Spannable)) {
            return false;
        }
        Spannable spannable = editable;
        return BaseInputConnectionCompat.getComposingSpanStart(spannable) >= 0
            || BaseInputConnectionCompat.getComposingSpanEnd(spannable) >= 0;
    }

    private void requestFocusAndShowKeyboard() {
        if (imeEditText == null) {
            Log.w(TAG, "requestFocusAndShowKeyboard(): imeEditText is null");
            return;
        }

        if (getBridge() != null && getBridge().getWebView() != null) {
            View webView = getBridge().getWebView();
            Log.i(TAG, "requestFocusAndShowKeyboard(): clearing webview focus hasFocus=" + webView.hasFocus());
            webView.clearFocus();
        }

        imeEditText.requestFocusFromTouch();
        boolean focusGranted = imeEditText.requestFocus();
        imeEditText.setSelection(imeEditText.getText() == null ? 0 : imeEditText.getText().length());
        imeEditText.bringToFront();
        imeEditText.requestRectangleOnScreen(
            new Rect(0, 0, Math.max(1, imeEditText.getWidth()), Math.max(1, imeEditText.getHeight())),
            false
        );
        Log.i(
            TAG,
            "requestFocusAndShowKeyboard(): focusGranted=" + focusGranted
                + " hasFocus=" + imeEditText.hasFocus()
                + " windowFocus=" + imeEditText.hasWindowFocus()
                + " attached=" + imeEditText.isAttachedToWindow()
                + " token=" + (imeEditText.getWindowToken() != null)
        );
        imeEditText.postDelayed(() -> showKeyboardWithStableInput("initial"), 48);
        Log.i(TAG, "requestFocusAndShowKeyboard(): stable toggle show scheduled without repeat guards");
    }

    private void hideKeyboard() {
        if (imeEditText == null) {
            Log.w(TAG, "hideKeyboard(): imeEditText is null");
            return;
        }
        InputMethodManager imm =
            (InputMethodManager) getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm != null) {
            boolean hidden = imm.hideSoftInputFromWindow(imeEditText.getWindowToken(), 0);
            Log.i(TAG, "hideKeyboard(): hidden=" + hidden + " token=" + (imeEditText.getWindowToken() != null));
        } else {
            Log.w(TAG, "hideKeyboard(): InputMethodManager is null");
        }
    }

    private void showKeyboardWithStableInput(String reason) {
        if (imeEditText == null || !pendingShowRequest) {
            Log.i(TAG, "showKeyboardWithStableInput(" + reason + "): skip pending=" + pendingShowRequest);
            return;
        }

        if (!imeEditText.hasWindowFocus()) {
            Log.i(TAG, "showKeyboardWithStableInput(" + reason + "): waiting for window focus");
            imeEditText.postDelayed(() -> showKeyboardWithStableInput(reason), 32);
            return;
        }

        if (!imeEditText.hasFocus()) {
            imeEditText.requestFocusFromTouch();
            imeEditText.requestFocus();
        }
        imeEditText.setSelection(imeEditText.getText() == null ? 0 : imeEditText.getText().length());
        InputMethodManager imm =
            (InputMethodManager) getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm == null) {
            Log.w(TAG, "showKeyboardWithStableInput(" + reason + "): InputMethodManager is null");
            return;
        }

        Log.i(
            TAG,
            "showKeyboardWithStableInput(" + reason + "): directShow"
                + " hasFocus=" + imeEditText.hasFocus()
                + " windowFocus=" + imeEditText.hasWindowFocus()
                + " token=" + (imeEditText.getWindowToken() != null)
        );
        mainHandler.postDelayed(() -> {
            if (imeEditText == null || !pendingShowRequest || !imeEditText.hasWindowFocus()) {
                return;
            }
            if (!imeEditText.hasFocus()) {
                imeEditText.requestFocusFromTouch();
                imeEditText.requestFocus();
            }
            imeEditText.bringToFront();
            imeEditText.requestRectangleOnScreen(
                new Rect(0, 0, Math.max(1, imeEditText.getWidth()), Math.max(1, imeEditText.getHeight())),
                false
            );
            boolean shown = imm.showSoftInput(imeEditText, InputMethodManager.SHOW_IMPLICIT);
            Log.i(
                TAG,
                "showKeyboardWithStableInput(" + reason + "): shown=" + shown
                    + " hasFocus=" + imeEditText.hasFocus()
                    + " windowFocus=" + imeEditText.hasWindowFocus()
                    + " token=" + (imeEditText.getWindowToken() != null)
            );
        }, 160);
    }

    private JSObject buildState(String source) {
        JSObject state = new JSObject();
        state.put("source", source);
        state.put("pendingShowRequest", pendingShowRequest);
        state.put("keyboardVisible", lastKeyboardVisible);
        state.put("keyboardHeight", lastKeyboardHeight);
        state.put("hasAnchor", imeEditText != null);
        state.put("hasFocus", imeEditText != null && imeEditText.hasFocus());
        state.put("hasWindowFocus", imeEditText != null && imeEditText.hasWindowFocus());
        state.put("isAttached", imeEditText != null && imeEditText.isAttachedToWindow());
        state.put("hasWindowToken", imeEditText != null && imeEditText.getWindowToken() != null);
        state.put("inputEnabled", imeEditText != null && imeEditText.isEnabled());
        state.put("textLength", imeEditText != null && imeEditText.getText() != null ? imeEditText.getText().length() : 0);
        return state;
    }

    private int dpToPx(int dp) {
        return Math.round(
            TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP,
                dp,
                getContext().getResources().getDisplayMetrics()
            )
        );
    }

    private static class ImeAnchorEditText extends AppCompatEditText {
        private ImeAnchorPlugin plugin;

        ImeAnchorEditText(Context context) {
            super(context);
        }

        void setPlugin(ImeAnchorPlugin plugin) {
            this.plugin = plugin;
        }

        @Override
        public boolean dispatchTouchEvent(MotionEvent event) {
            return false;
        }

        @Override
        public boolean onKeyDown(int keyCode, KeyEvent event) {
            if (plugin != null) {
                String key = mapHardwareKeyEventToKey(keyCode, event);
                if (key != null) {
                    plugin.emitHardwareKey(
                        key,
                        mapHardwareKeyEventToCode(keyCode, event),
                        event.isCtrlPressed(),
                        event.isAltPressed(),
                        event.isMetaPressed(),
                        event.isShiftPressed()
                    );
                    return true;
                }
            }
            return super.onKeyDown(keyCode, event);
        }

        @Override
        public InputConnection onCreateInputConnection(EditorInfo outAttrs) {
            Log.i(TAG, "onCreateInputConnection()");
            InputConnection target = super.onCreateInputConnection(outAttrs);
            if (target == null) {
                Log.w(TAG, "onCreateInputConnection(): target is null");
                return null;
            }

            return new InputConnectionWrapper(target, true) {
                @Override
                public boolean deleteSurroundingText(int beforeLength, int afterLength) {
                    Editable editable = getText();
                    if (plugin != null && beforeLength > 0 && afterLength == 0 && (editable == null || editable.length() == 0)) {
                        plugin.emitBackspace(beforeLength);
                        return true;
                    }
                    return super.deleteSurroundingText(beforeLength, afterLength);
                }

                @Override
                public boolean sendKeyEvent(KeyEvent event) {
                    if (plugin != null
                        && event.getAction() == KeyEvent.ACTION_DOWN
                        && event.getKeyCode() == KeyEvent.KEYCODE_DEL) {
                        Editable editable = getText();
                        if (editable == null || editable.length() == 0) {
                            plugin.emitBackspace(1);
                            return true;
                        }
                    }
                    return super.sendKeyEvent(event);
                }

                @Override
                public boolean commitText(CharSequence text, int newCursorPosition) {
                    if (plugin != null) {
                        if (!plugin.pasteInProgress && plugin.isLineBreakOnly(text)) {
                            plugin.emitImeShiftEnterKey("commitText");
                            plugin.clearImeEditText();
                            return true;
                        }
                        plugin.suppressFrameworkEditableDispatch = true;
                        boolean handled;
                        try {
                            handled = super.commitText(text, newCursorPosition);
                        } finally {
                            plugin.suppressFrameworkEditableDispatch = false;
                        }
                        plugin.dispatchInputLogicEvents(
                            plugin.inputLogic.onCommitText(text == null ? "" : text.toString()),
                            "commitText"
                        );
                        return handled;
                    }
                    return super.commitText(text, newCursorPosition);
                }

                @Override
                public boolean finishComposingText() {
                    if (plugin != null) {
                        Editable editable = getText();
                        if (!plugin.pasteInProgress && plugin.isLineBreakOnly(editable)) {
                            plugin.emitImeShiftEnterKey("finishComposingText");
                            plugin.clearImeEditText();
                            return true;
                        }
                        plugin.suppressFrameworkEditableDispatch = true;
                        boolean handled;
                        try {
                            handled = super.finishComposingText();
                        } finally {
                            plugin.suppressFrameworkEditableDispatch = false;
                        }
                        Editable currentEditable = getText();
                        plugin.dispatchInputLogicEvents(
                            plugin.inputLogic.onFinishComposingText(currentEditable == null ? "" : currentEditable.toString()),
                            "finishComposingText"
                        );
                        return handled;
                    }
                    return super.finishComposingText();
                }

                @Override
                public boolean performEditorAction(int actionCode) {
                    if (plugin != null) {
                        switch (actionCode) {
                            case EditorInfo.IME_ACTION_UNSPECIFIED:
                            case EditorInfo.IME_ACTION_DONE:
                            case EditorInfo.IME_ACTION_SEND:
                            case EditorInfo.IME_ACTION_GO:
                            case EditorInfo.IME_ACTION_NEXT:
                                plugin.emitImeEnterKey("performEditorAction");
                                plugin.clearImeEditText();
                                return true;
                            default:
                                break;
                        }
                    }
                    return super.performEditorAction(actionCode);
                }

            };
        }

        @Override
        public boolean onTextContextMenuItem(int id) {
            if (plugin == null || (id != android.R.id.paste && id != android.R.id.pasteAsPlainText)) {
                return super.onTextContextMenuItem(id);
            }
            plugin.pasteInProgress = true;
            try {
                return super.onTextContextMenuItem(id);
            } finally {
                plugin.pasteInProgress = false;
            }
        }

        @Override
        public void onWindowFocusChanged(boolean hasWindowFocus) {
            super.onWindowFocusChanged(hasWindowFocus);
            if (hasWindowFocus && plugin != null && plugin.pendingShowRequest) {
                Log.i(TAG, "ImeAnchorEditText.onWindowFocusChanged(): scheduling show");
                post(() -> plugin.showKeyboardWithStableInput("window-focus"));
            }
        }
    }

    private static class BaseInputConnectionCompat {
        static int getComposingSpanStart(Spannable text) {
            return android.view.inputmethod.BaseInputConnection.getComposingSpanStart(text);
        }

        static int getComposingSpanEnd(Spannable text) {
            return android.view.inputmethod.BaseInputConnection.getComposingSpanEnd(text);
        }
    }
}
