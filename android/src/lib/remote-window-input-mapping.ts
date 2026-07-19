import type { RemoteWindowInputEventPayload } from './types';

export type RemoteWindowKeyInputEvent = Extract<
  RemoteWindowInputEventPayload['event'],
  { kind: 'key' }
>;

type KeyModifierState = Pick<
  RemoteWindowKeyInputEvent,
  'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'
>;

function keyDown(
  key: string,
  code: string,
  modifiers: KeyModifierState = {},
  text?: string,
): RemoteWindowKeyInputEvent {
  return {
    kind: 'key',
    phase: 'down',
    key,
    code,
    text,
    ...modifiers,
  };
}

function keyUp(
  key: string,
  code: string,
  modifiers: KeyModifierState = {},
): RemoteWindowKeyInputEvent {
  return {
    kind: 'key',
    phase: 'up',
    key,
    code,
    ...modifiers,
  };
}

function keyStroke(
  key: string,
  code: string,
  modifiers: KeyModifierState = {},
  text?: string,
) {
  return [
    keyDown(key, code, modifiers, text),
    keyUp(key, code, modifiers),
  ];
}

const TERMINAL_SEQUENCE_KEY_EVENTS: Array<{
  sequence: string;
  events: RemoteWindowKeyInputEvent[];
}> = [
  { sequence: '\x1b[15~', events: keyStroke('F5', 'F5') },
  { sequence: '\x1b[17~', events: keyStroke('F6', 'F6') },
  { sequence: '\x1b[18~', events: keyStroke('F7', 'F7') },
  { sequence: '\x1b[19~', events: keyStroke('F8', 'F8') },
  { sequence: '\x1b[20~', events: keyStroke('F9', 'F9') },
  { sequence: '\x1b[21~', events: keyStroke('F10', 'F10') },
  { sequence: '\x1b[23~', events: keyStroke('F11', 'F11') },
  { sequence: '\x1b[24~', events: keyStroke('F12', 'F12') },
  { sequence: '\x1bOP', events: keyStroke('F1', 'F1') },
  { sequence: '\x1bOQ', events: keyStroke('F2', 'F2') },
  { sequence: '\x1bOR', events: keyStroke('F3', 'F3') },
  { sequence: '\x1bOS', events: keyStroke('F4', 'F4') },
  { sequence: '\x1b[A', events: keyStroke('ArrowUp', 'ArrowUp') },
  { sequence: '\x1b[B', events: keyStroke('ArrowDown', 'ArrowDown') },
  { sequence: '\x1b[C', events: keyStroke('ArrowRight', 'ArrowRight') },
  { sequence: '\x1b[D', events: keyStroke('ArrowLeft', 'ArrowLeft') },
  { sequence: '\x1b[Z', events: keyStroke('Tab', 'Tab', { shiftKey: true }) },
  { sequence: '\x16', events: keyStroke('v', 'KeyV', { metaKey: true }) },
  { sequence: '\x1b', events: keyStroke('Escape', 'Escape') },
  { sequence: '\x7f', events: keyStroke('Backspace', 'Backspace') },
  { sequence: '\r', events: keyStroke('Enter', 'Enter') },
  { sequence: '\n', events: keyStroke('Enter', 'Enter', { shiftKey: true }) },
  { sequence: '\t', events: keyStroke('Tab', 'Tab') },
];

const SORTED_TERMINAL_SEQUENCE_KEY_EVENTS = [...TERMINAL_SEQUENCE_KEY_EVENTS]
  .sort((left, right) => right.sequence.length - left.sequence.length);

function inferPrintableCode(key: string) {
  if (/^[a-z]$/i.test(key)) {
    return `Key${key.toUpperCase()}`;
  }
  if (/^[0-9]$/.test(key)) {
    return `Digit${key}`;
  }
  if (key === ' ') {
    return 'Space';
  }
  return '';
}

function buildCtrlKeyStroke(controlCharCode: number) {
  const key = String.fromCharCode(controlCharCode + 96);
  return keyStroke(key, inferPrintableCode(key), { ctrlKey: true });
}

export function buildRemoteWindowTextInputEvents(text: string): RemoteWindowKeyInputEvent[] {
  if (!text) {
    return [];
  }
  return [keyDown(text, '', {}, text)];
}

export function buildRemoteWindowBackspaceInputEvents(count: number): RemoteWindowKeyInputEvent[] {
  const normalizedCount = Math.max(1, Math.min(64, Math.round(count || 1)));
  return Array.from({ length: normalizedCount }, () => keyStroke('Backspace', 'Backspace')).flat();
}

export function buildRemoteWindowKeyboardInputEvents(input: {
  key?: string;
  code?: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}): RemoteWindowKeyInputEvent[] {
  const key = input.key || '';
  const code = input.code || inferPrintableCode(key);
  if (!key && !code) {
    return [];
  }
  const modifiers = {
    shiftKey: Boolean(input.shiftKey),
    altKey: Boolean(input.altKey),
    ctrlKey: Boolean(input.ctrlKey),
    metaKey: Boolean(input.metaKey),
  };
  return keyStroke(key, code, modifiers, key.length === 1 ? key : undefined);
}

export function buildRemoteWindowKeyInputEventsFromSequence(sequence: string): RemoteWindowKeyInputEvent[] {
  if (!sequence) {
    return [];
  }
  const events: RemoteWindowKeyInputEvent[] = [];
  let pendingText = '';
  let index = 0;

  const flushText = () => {
    if (!pendingText) {
      return;
    }
    events.push(...buildRemoteWindowTextInputEvents(pendingText));
    pendingText = '';
  };

  while (index < sequence.length) {
    const matched = SORTED_TERMINAL_SEQUENCE_KEY_EVENTS.find((entry) => (
      sequence.startsWith(entry.sequence, index)
    ));
    if (matched) {
      flushText();
      events.push(...matched.events);
      index += matched.sequence.length;
      continue;
    }

    const [char = ''] = Array.from(sequence.slice(index));
    if (!char) {
      break;
    }
    const code = char.charCodeAt(0);
    if (code >= 1 && code <= 26) {
      flushText();
      events.push(...buildCtrlKeyStroke(code));
    } else if (code < 32 || code === 127) {
      flushText();
    } else {
      pendingText += char;
    }
    index += char.length;
  }

  flushText();
  return events;
}
