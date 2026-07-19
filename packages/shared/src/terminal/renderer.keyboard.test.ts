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

  it('maps shift enter to a newline while plain enter stays carriage return', () => {
    expect(resolveTerminalKeyboardInput(keydown({ key: 'Enter', shiftKey: true }), false)).toBe('\n');
    expect(resolveTerminalKeyboardInput(keydown({ key: 'Enter' }), false)).toBe('\r');
  });

  it('keeps ctrl chords but rejects ctrl when meta/alt also pressed', () => {
    expect(resolveTerminalCtrlChord(keydown({ key: 'c', ctrlKey: true }))).toBe('\x03');
    expect(resolveTerminalCtrlChord(keydown({ key: ' ', ctrlKey: true }))).toBe('\x00');
    expect(resolveTerminalCtrlChord(keydown({ key: 'c', ctrlKey: true, metaKey: true }))).toBeNull();
    expect(resolveTerminalCtrlChord(keydown({ key: 'c', ctrlKey: true, altKey: true }))).toBeNull();
  });
});
