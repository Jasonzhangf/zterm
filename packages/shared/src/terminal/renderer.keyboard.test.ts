import { describe, expect, it } from 'vitest';
import {
  resolveTerminalCtrlChord,
  resolveTerminalKeyboardInput,
} from './renderer';

function keydown(init: Partial<KeyboardEvent>) {
  return {
    key: '',
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...init,
  } as KeyboardEvent;
}

describe('terminal renderer keyboard mapping', () => {
  it('maps escape and arrows', () => {
    expect(resolveTerminalKeyboardInput(keydown({ key: 'Escape' }), false)).toBe('\x1b');
    expect(resolveTerminalKeyboardInput(keydown({ key: 'ArrowUp' }), false)).toBe('\x1b[A');
  });

  it('maps alt printable chords to esc-prefixed input', () => {
    expect(resolveTerminalKeyboardInput(keydown({ key: 'f', altKey: true }), false)).toBe('\x1bf');
  });

  it('keeps ctrl chords but rejects ctrl when meta/alt also pressed', () => {
    expect(resolveTerminalCtrlChord(keydown({ key: 'c', ctrlKey: true }))).toBe('\x03');
    expect(resolveTerminalCtrlChord(keydown({ key: 'c', ctrlKey: true, metaKey: true }))).toBeNull();
    expect(resolveTerminalCtrlChord(keydown({ key: 'c', ctrlKey: true, altKey: true }))).toBeNull();
  });
});
