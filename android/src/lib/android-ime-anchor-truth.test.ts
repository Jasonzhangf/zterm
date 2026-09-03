import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const pluginSource = readFileSync(
  join(
    process.cwd(),
    'native/android/app/src/main/java/com/zterm/android/ImeAnchorPlugin.java',
  ),
  'utf8',
);

describe('Android IME anchor truth', () => {
  it('keeps the native IME anchor serviceable instead of hiding it with view alpha', () => {
    expect(pluginSource).toContain('imeEditText.setAlpha(1.0f)');
    expect(pluginSource).not.toContain('imeEditText.setAlpha(0.01f)');
  });

  it('keeps a real editor rectangle for OEM IMEs without changing terminal layout truth', () => {
    expect(pluginSource).toContain('new FrameLayout.LayoutParams(\n            dpToPx(240),\n            dpToPx(48)\n        )');
    expect(pluginSource).toContain('imeEditText.setMinHeight(dpToPx(48))');
    expect(pluginSource).toContain('imeEditText.setGravity(Gravity.CENTER_VERTICAL)');
    expect(pluginSource).toContain('imeEditText.requestRectangleOnScreen(');
  });

  it('keeps line-break IME text on the shifted enter path while completion stays on plain enter', () => {
    expect(pluginSource).toContain('emitImeShiftEnterKey("commitText")');
    expect(pluginSource).toContain('emitImeShiftEnterKey("finishComposingText")');
    expect(pluginSource).toContain('emitImeEnterKey("performEditorAction")');
  });

  it('keeps system paste line breaks as paste payload instead of turning them into Enter', () => {
    expect(pluginSource).toContain('private boolean pasteInProgress = false;');
    expect(pluginSource).toContain('public boolean onTextContextMenuItem(int id)');
    expect(pluginSource).toContain('android.R.id.pasteAsPlainText');
    expect(pluginSource).toContain('if (!plugin.pasteInProgress && plugin.isLineBreakOnly(text))');
    expect(pluginSource).toContain('if (!plugin.pasteInProgress && plugin.isLineBreakOnly(editable))');
  });

  it('keeps the serviceable native anchor cursor invisible so it cannot render as a terminal cursor', () => {
    expect(pluginSource).toContain('imeEditText.setCursorVisible(false)');
    expect(pluginSource).not.toContain('imeEditText.setCursorVisible(true)');
  });

  it('only enables soft-input-on-focus during an explicit keyboard show intent', () => {
    expect(pluginSource).toContain('imeEditText.setShowSoftInputOnFocus(false)');
    expect(pluginSource).toContain('imeEditText.setShowSoftInputOnFocus(enabled)');
    expect(pluginSource).toContain(
      'public boolean dispatchTouchEvent(MotionEvent event) {\n            return false;\n        }',
    );
    expect(pluginSource).toContain('setTerminalAnchorInputEnabled(false)');
    expect(pluginSource).toContain(
      'pendingShowRequest = true;\n            setTerminalAnchorInputEnabled(true);',
    );
    expect(pluginSource).toContain(
      'if (!keyboardVisible && pendingShowRequest) {\n                pendingShowRequest = false;\n                setTerminalAnchorInputEnabled(false);',
    );
    expect(pluginSource).toContain(
      'imeEditText.setVisibility(enabled ? View.VISIBLE : View.INVISIBLE)',
    );
  });

  it('does not repeat toggle-based show requests after the explicit keyboard intent', () => {
    expect(pluginSource).not.toContain('PENDING_SHOW_GUARD_DELAYS_MS');
    expect(pluginSource).not.toContain('schedulePendingShowGuards();');
    expect(pluginSource).toContain('lastKeyboardVisible');
    expect(pluginSource).not.toContain('showKeyboardWithStableInput("guard")');
    expect(pluginSource).toContain('stable toggle show scheduled without repeat guards');
  });

  it('uses a single direct native keyboard show request without hide/show churn', () => {
    expect(pluginSource).toContain('InputMethodManager.SHOW_IMPLICIT');
    expect(pluginSource).not.toContain('InputMethodManager.SHOW_FORCED');
    expect(pluginSource).not.toContain('toggleSoftInput(');
    expect(pluginSource).not.toContain('resetHidden = imm.hideSoftInputFromWindow');
    expect(pluginSource).toContain('showKeyboardWithStableInput(" + reason + "): directShow');
    expect(pluginSource).toContain('imm.showSoftInput(imeEditText, InputMethodManager.SHOW_IMPLICIT)');
    expect(pluginSource).toContain('}, 160);');
  });

  it('does not rebuild the input connection while asking the IME window to show', () => {
    expect(pluginSource).not.toContain('restartInput(');
    expect(pluginSource).not.toContain('showKeyboardWithInsetsController');
    expect(pluginSource).toContain('showKeyboardWithStableInput("initial")');
  });

  it('does not keep the ineffective immersive-system-ui compensation path', () => {
    expect(pluginSource).not.toContain('setImeSystemBarsVisible');
  });
});
