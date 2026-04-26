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

@CapacitorPlugin(name = "ImeAnchor")
public class ImeAnchorPlugin extends Plugin {
    private static final String TAG = "ImeAnchor";

    private ImeAnchorEditText imeEditText;
    private FrameLayout rootView;
    private ViewTreeObserver.OnGlobalLayoutListener keyboardLayoutListener;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private boolean suppressTextChange = false;
    private boolean pendingShowRequest = false;
    private boolean suppressCommittedTextEcho = false;
    private String lastObservedEditableText = "";
    private boolean lastObservedEditableWasImmediate = false;
    private boolean lastKeyboardVisible = false;
    private int lastKeyboardHeight = 0;

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
                    if (imeEditText.hasFocus()) {
                        imeEditText.clearFocus();
                    }
                    imeEditText.setFocusable(false);
                    imeEditText.setFocusableInTouchMode(false);
                } else {
                    // Terminal mode: re-enable ImeAnchor for terminal input.
                    imeEditText.setFocusable(true);
                    imeEditText.setFocusableInTouchMode(true);
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
        imeEditText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        imeEditText.setImeOptions(
            EditorInfo.IME_FLAG_NO_EXTRACT_UI
                | EditorInfo.IME_FLAG_NO_FULLSCREEN
                | EditorInfo.IME_FLAG_NAVIGATE_NEXT
                | EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
        );
        imeEditText.setInputType(
            InputType.TYPE_CLASS_TEXT
                | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
                | InputType.TYPE_TEXT_FLAG_MULTI_LINE
        );
        imeEditText.setSingleLine(false);
        imeEditText.setMinLines(1);
        imeEditText.setMaxLines(1);
        imeEditText.setAlpha(0.01f);
        imeEditText.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        imeEditText.setFocusable(true);
        imeEditText.setFocusableInTouchMode(true);
        imeEditText.setShowSoftInputOnFocus(true);
        imeEditText.setOnFocusChangeListener((view, hasFocus) ->
            Log.i(
                TAG,
                "imeEditText focus=" + hasFocus
                    + " windowFocus=" + view.hasWindowFocus()
                    + " attached=" + view.isAttachedToWindow()
            )
        );

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
            dpToPx(140),
            dpToPx(36)
        );
        layoutParams.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
        layoutParams.bottomMargin = dpToPx(12);
        rootView.addView(imeEditText, layoutParams);
        Log.i(TAG, "ensureImeAnchor(): anchor attached");
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
            Log.i(TAG, "keyboardState(): visible=" + keyboardVisible + " height=" + keyboardHeight);
            JSObject payload = new JSObject();
            payload.put("visible", keyboardVisible);
            payload.put("height", keyboardHeight);
            notifyListeners("keyboardState", payload);
        };

        rootView.getViewTreeObserver().addOnGlobalLayoutListener(keyboardLayoutListener);
    }

    private void handleEditableChanged(Editable editable) {
        if (suppressTextChange || imeEditText == null) {
            return;
        }

        String currentText = editable.toString();
        if (currentText.isEmpty()) {
            lastObservedEditableText = "";
            lastObservedEditableWasImmediate = false;
            return;
        }

        boolean composing = hasComposingText(editable);
        if (composing) {
            boolean immediate = isImmediateTerminalComposition(currentText);
            Log.i(TAG, "handleEditableChanged(): composing length=" + editable.length() + " immediate=" + immediate);
            if (immediate) {
                emitImmediateTextDelta(lastObservedEditableText, currentText, "editableComposing");
            }
            lastObservedEditableText = currentText;
            lastObservedEditableWasImmediate = immediate;
            return;
        }

        if (suppressCommittedTextEcho) {
            Log.i(TAG, "handleEditableChanged(): skip committed echo=" + currentText);
            return;
        }

        if (lastObservedEditableWasImmediate) {
            emitImmediateTextDelta(lastObservedEditableText, currentText, "editableCommit");
            clearImeEditText();
            return;
        }

        emitInputText(currentText, "editableCommitBuffer");
    }

    private void clearImeEditText() {
        if (imeEditText == null || imeEditText.getText() == null) {
            lastObservedEditableText = "";
            lastObservedEditableWasImmediate = false;
            return;
        }
        lastObservedEditableText = "";
        lastObservedEditableWasImmediate = false;
        suppressCommittedTextEcho = true;
        suppressTextChange = true;
        imeEditText.getText().clear();
        suppressTextChange = false;
        suppressCommittedTextEcho = false;
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

    private void emitImmediateTextDelta(String previousText, String nextText, String source) {
        String previous = previousText == null ? "" : previousText;
        String next = nextText == null ? "" : nextText;
        if (previous.equals(next)) {
            return;
        }

        if (next.startsWith(previous)) {
            String delta = next.substring(previous.length());
            if (!delta.isEmpty()) {
                JSObject payload = new JSObject();
                payload.put("text", delta);
                Log.i(TAG, "emitImmediateTextDelta(): source=" + source + " delta=" + delta);
                notifyListeners("input", payload);
            }
            return;
        }

        if (previous.startsWith(next)) {
            int deleteCount = previous.length() - next.length();
            if (deleteCount > 0) {
                emitBackspace(deleteCount);
            }
            return;
        }

        if (!previous.isEmpty()) {
            emitBackspace(previous.length());
        }
        if (!next.isEmpty()) {
            JSObject payload = new JSObject();
            payload.put("text", next);
            Log.i(TAG, "emitImmediateTextDelta(): source=" + source + " reset=" + next);
            notifyListeners("input", payload);
        }
    }

    private boolean isImmediateTerminalComposition(String text) {
        if (text == null || text.isEmpty()) {
            return false;
        }
        for (int i = 0; i < text.length(); ) {
            int codePoint = text.codePointAt(i);
            i += Character.charCount(codePoint);
            if (codePoint == '\n' || codePoint == '\r' || codePoint == '\t') {
                continue;
            }
            if (codePoint < 0x20 || codePoint > 0x7e) {
                return false;
            }
        }
        return true;
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
        Log.i(
            TAG,
            "requestFocusAndShowKeyboard(): focusGranted=" + focusGranted
                + " hasFocus=" + imeEditText.hasFocus()
                + " windowFocus=" + imeEditText.hasWindowFocus()
                + " attached=" + imeEditText.isAttachedToWindow()
                + " token=" + (imeEditText.getWindowToken() != null)
        );
        imeEditText.post(this::showKeyboardWithInsetsController);
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

    private void showKeyboardWithInsetsController() {
        if (imeEditText == null || !pendingShowRequest) {
            Log.i(TAG, "showKeyboardWithInsetsController(): skip pending=" + pendingShowRequest);
            return;
        }

        if (!imeEditText.hasWindowFocus()) {
            Log.i(TAG, "showKeyboardWithInsetsController(): waiting for window focus");
            imeEditText.postDelayed(this::showKeyboardWithInsetsController, 32);
            return;
        }

        imeEditText.requestFocus();
        imeEditText.setSelection(imeEditText.getText() == null ? 0 : imeEditText.getText().length());
        InputMethodManager imm =
            (InputMethodManager) getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm == null) {
            Log.w(TAG, "showKeyboardWithInsetsController(): InputMethodManager is null");
            return;
        }

        imm.restartInput(imeEditText);
        boolean shown = imm.showSoftInput(imeEditText, 0);
        Log.i(
            TAG,
            "showKeyboardWithInsetsController(): shown=" + shown
                + " hasFocus=" + imeEditText.hasFocus()
                + " windowFocus=" + imeEditText.hasWindowFocus()
                + " token=" + (imeEditText.getWindowToken() != null)
        );

        mainHandler.postDelayed(() -> {
            if (imeEditText == null || !pendingShowRequest) {
                return;
            }
            imm.restartInput(imeEditText);
            boolean retryShown = imm.showSoftInput(imeEditText, 0);
            Log.i(
                TAG,
                "showKeyboardWithInsetsController(retry): shown=" + retryShown
                    + " hasFocus=" + imeEditText.hasFocus()
                    + " windowFocus=" + imeEditText.hasWindowFocus()
                    + " token=" + (imeEditText.getWindowToken() != null)
            );
        }, 96);
    }

    private JSObject buildState(String source) {
        JSObject state = new JSObject();
        state.put("source", source);
        state.put("pendingShowRequest", pendingShowRequest);
        state.put("hasAnchor", imeEditText != null);
        state.put("hasFocus", imeEditText != null && imeEditText.hasFocus());
        state.put("hasWindowFocus", imeEditText != null && imeEditText.hasWindowFocus());
        state.put("isAttached", imeEditText != null && imeEditText.isAttachedToWindow());
        state.put("hasWindowToken", imeEditText != null && imeEditText.getWindowToken() != null);
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
                    if (plugin != null && text != null && text.length() > 0) {
                        String committed = text.toString();
                        if (plugin.lastObservedEditableWasImmediate) {
                            plugin.emitImmediateTextDelta(plugin.lastObservedEditableText, committed, "commitText");
                            plugin.clearImeEditText();
                            return true;
                        }
                        plugin.emitInputText(committed, "commitText");
                        return true;
                    }
                    return super.commitText(text, newCursorPosition);
                }

                @Override
                public boolean finishComposingText() {
                    Editable editable = getText();
                    if (plugin != null && editable != null && editable.length() > 0) {
                        String committed = editable.toString();
                        if (plugin.lastObservedEditableWasImmediate) {
                            plugin.emitImmediateTextDelta(plugin.lastObservedEditableText, committed, "finishComposingText");
                            plugin.clearImeEditText();
                            return true;
                        }
                        plugin.emitInputText(committed, "finishComposingText");
                        return true;
                    }
                    return super.finishComposingText();
                }

            };
        }

        @Override
        public void onWindowFocusChanged(boolean hasWindowFocus) {
            super.onWindowFocusChanged(hasWindowFocus);
            if (hasWindowFocus && plugin != null && plugin.pendingShowRequest) {
                Log.i(TAG, "ImeAnchorEditText.onWindowFocusChanged(): scheduling show");
                post(plugin::showKeyboardWithInsetsController);
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
