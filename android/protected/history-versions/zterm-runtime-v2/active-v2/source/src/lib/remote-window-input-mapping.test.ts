import { describe, expect, it } from 'vitest';
import {
  buildRemoteWindowBackspaceInputEvents,
  buildRemoteWindowKeyInputEventsFromSequence,
  buildRemoteWindowKeyboardInputEvents,
  buildRemoteWindowTextInputEvents,
} from './remote-window-input-mapping';

describe('remote-window-input-mapping', () => {
  it('maps terminal arrow sequences to remote key down/up events', () => {
    expect(buildRemoteWindowKeyInputEventsFromSequence('\x1b[A')).toEqual([
      { kind: 'key', phase: 'down', key: 'ArrowUp', code: 'ArrowUp' },
      { kind: 'key', phase: 'up', key: 'ArrowUp', code: 'ArrowUp' },
    ]);
  });

  it('maps terminal paste sequence to macOS command-v instead of ctrl-v text', () => {
    expect(buildRemoteWindowKeyInputEventsFromSequence('\x16')).toEqual([
      { kind: 'key', phase: 'down', key: 'v', code: 'KeyV', metaKey: true },
      { kind: 'key', phase: 'up', key: 'v', code: 'KeyV', metaKey: true },
    ]);
  });

  it('preserves text and follows it with enter when a quick action ends in carriage return', () => {
    expect(buildRemoteWindowKeyInputEventsFromSequence('继续执行\r')).toEqual([
      { kind: 'key', phase: 'down', key: '继续执行', code: '', text: '继续执行' },
      { kind: 'key', phase: 'down', key: 'Enter', code: 'Enter' },
      { kind: 'key', phase: 'up', key: 'Enter', code: 'Enter' },
    ]);
  });

  it('maps ctrl encoded terminal bytes back to remote modifier key strokes', () => {
    expect(buildRemoteWindowKeyInputEventsFromSequence('\x03')).toEqual([
      { kind: 'key', phase: 'down', key: 'c', code: 'KeyC', ctrlKey: true },
      { kind: 'key', phase: 'up', key: 'c', code: 'KeyC', ctrlKey: true },
    ]);
  });

  it('keeps IME committed text as one unicode text event', () => {
    expect(buildRemoteWindowTextInputEvents('中文 input')).toEqual([
      { kind: 'key', phase: 'down', key: '中文 input', code: '', text: '中文 input' },
    ]);
  });

  it('builds repeated backspace strokes for native IME delete events', () => {
    expect(buildRemoteWindowBackspaceInputEvents(2)).toEqual([
      { kind: 'key', phase: 'down', key: 'Backspace', code: 'Backspace' },
      { kind: 'key', phase: 'up', key: 'Backspace', code: 'Backspace' },
      { kind: 'key', phase: 'down', key: 'Backspace', code: 'Backspace' },
      { kind: 'key', phase: 'up', key: 'Backspace', code: 'Backspace' },
    ]);
  });

  it('preserves native keyboard modifier state for remote windows', () => {
    expect(buildRemoteWindowKeyboardInputEvents({
      key: 'a',
      code: 'KeyA',
      metaKey: true,
    })).toEqual([
      { kind: 'key', phase: 'down', key: 'a', code: 'KeyA', text: 'a', metaKey: true, altKey: false, ctrlKey: false, shiftKey: false },
      { kind: 'key', phase: 'up', key: 'a', code: 'KeyA', metaKey: true, altKey: false, ctrlKey: false, shiftKey: false },
    ]);
  });
});
