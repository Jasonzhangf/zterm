import { describe, expect, it } from 'vitest';
import {
  createLocalInputParser,
  type LocalInputIntent,
  type LocalInputParseResult,
  type LocalInputTimerOptions,
} from './local-input.js';

const encoder = new TextEncoder();
const PREFIX = 0x1d;
const ESCAPE = 0x1b;
const PASTE_START = Uint8Array.of(ESCAPE, 0x5b, 0x32, 0x30, 0x30, 0x7e);
const PASTE_END = Uint8Array.of(ESCAPE, 0x5b, 0x32, 0x30, 0x31, 0x7e);

function createParser(options: Partial<LocalInputTimerOptions> = {}) {
  return createLocalInputParser({
    onIntents() {},
    ...options,
  });
}

function bytes(...values: Array<number | string | Uint8Array>): Uint8Array {
  const output: number[] = [];
  for (const value of values) {
    if (typeof value === 'number') {
      output.push(value);
    } else if (typeof value === 'string') {
      output.push(...encoder.encode(value));
    } else {
      output.push(...value);
    }
  }
  return Uint8Array.from(output);
}

function remoteText(result: LocalInputParseResult) {
  return result.intents
    .filter((intent): intent is Extract<LocalInputIntent, { kind: 'remote-input' }> => (
      intent.kind === 'remote-input'
    ))
    .map((intent) => intent.data)
    .join('');
}

function localCommands(result: LocalInputParseResult) {
  return result.intents
    .filter((intent): intent is Extract<LocalInputIntent, { kind: 'local-command' }> => (
      intent.kind === 'local-command'
    ))
    .map((intent) => intent.command);
}

describe('local-input public contract', () => {
  it('recognizes Ctrl+] q across arbitrary chunks and ignores the rest of the close chunk', () => {
    const parser = createParser();
    const pending = parser.feed(Uint8Array.of(PREFIX));

    expect(remoteText(pending)).toBe('');
    expect(pending.state.prefixPending).toBe(true);

    const closed = parser.feed(bytes('q', 'tail'));
    expect(localCommands(closed)).toEqual(['close']);
    expect(remoteText(closed)).toBe('');
    expect(closed.state.stopped).toBe(true);
    expect(parser.feed(Uint8Array.of(0x61)).kind).toBe('failed');
  });

  it('sends a literal prefix for double Ctrl+] and keeps a following q remote', () => {
    const parser = createParser();
    const result = parser.feed(Uint8Array.of(PREFIX, PREFIX, 0x71));

    expect(result.kind).toBe('ok');
    expect(remoteText(result)).toBe('\x1dq');
    expect(localCommands(result)).toEqual([]);
  });

  it('preserves ordinary controls, escape sequences, and unknown prefix successors byte for byte', () => {
    const parser = createParser();
    const controls = parser.feed(Uint8Array.of(0x03, 0x04, 0x1a, ESCAPE, 0x1b, 0x5b, 0x41));
    expect(remoteText(controls)).toBe('\x03\x04\x1a\x1b\x1b[A');

    const unknownSuccessor = parser.feed(Uint8Array.of(PREFIX, ESCAPE, 0x5b, 0x41));
    expect(remoteText(unknownSuccessor)).toBe('\x1d\x1b[A');
    expect(unknownSuccessor.state.prefixPending).toBe(false);
  });

  it('maps prefix k/j/u/d/h/l/f to renderer-only local commands', () => {
    const parser = createParser();
    for (const key of ['k', 'j', 'u', 'd', 'h', 'l', 'f']) {
      const result = parser.feed(bytes(PREFIX, key));
      expect(localCommands(result)).toHaveLength(1);
      expect(remoteText(result)).toBe('');
    }

    expect(parser.snapshot()).toMatchObject({
      prefixPending: false,
      pasteActive: false,
      stopped: false,
    });
  });

  it('consumes complete local paste wrappers and forwards only exact content at every split', () => {
    const content = bytes('A', PREFIX, 0x71, PREFIX, PREFIX, '中文');
    const whole = bytes(PASTE_START, content, PASTE_END);
    const expected = 'A\x1dq\x1d\x1d中文';

    for (let split = 0; split <= whole.length; split += 1) {
      const parser = createParser();
      const first = parser.feed(whole.slice(0, split));
      const second = parser.feed(whole.slice(split));
      expect(`${remoteText(first)}${remoteText(second)}`).toBe(expected);
      expect(localCommands(first)).toEqual([]);
      expect(localCommands(second)).toEqual([]);
      expect(parser.snapshot().pasteActive).toBe(false);
    }
  });

  it('does not add wrappers or reinterpret content for a remote without paste mode', () => {
    const parser = createParser();
    const result = parser.feed(bytes('plain', PREFIX, PREFIX, 0x71, 'text'));
    expect(remoteText(result)).toBe('plain\x1dqtext');
    expect(result.intents).toEqual([
      { kind: 'remote-input', data: 'plain\x1dqtext' },
    ]);
  });

  it('flushes a standalone Esc after the injected 30ms window', () => {
    const timer = {
      callback: null as (() => void) | null,
    };
    let cleared = 0;
    const timerEvents: LocalInputIntent[] = [];
    const parser = createParser({
      setTimer(callback, delayMs) {
        expect(delayMs).toBe(30);
        timer.callback = callback;
        return 7;
      },
      clearTimer(handle) {
        expect(handle).toBe(7);
        cleared += 1;
      },
      onIntents(intents) {
        timerEvents.push(...intents);
      },
    });

    const pending = parser.feed(Uint8Array.of(ESCAPE));
    expect(pending.intents).toEqual([]);
    expect(timer.callback).not.toBeNull();

    timer.callback?.();
    expect(timerEvents).toEqual([{ kind: 'remote-input', data: '\x1b' }]);
    expect(cleared).toBe(1);
  });

  it('emits a mismatched escape candidate immediately without waiting for the timer', () => {
    let cleared = 0;
    const parser = createParser({
      setTimer() {
        return 'timer';
      },
      clearTimer() {
        cleared += 1;
      },
    });

    expect(parser.feed(Uint8Array.of(ESCAPE)).intents).toEqual([]);
    const mismatch = parser.feed(bytes('[X'));
    expect(remoteText(mismatch)).toBe('\x1b[X');
    expect(cleared).toBe(1);
  });

  it('fails explicitly for invalid or EOF-truncated UTF-8 without replacement characters', () => {
    const invalid = createParser();
    const invalidResult = invalid.feed(Uint8Array.of(0xc3, 0x28));
    expect(invalidResult.kind).toBe('failed');
    if (invalidResult.kind === 'failed') {
      expect(invalidResult.error.code).toBe('input_encoding_invalid');
    }
    expect(remoteText(invalidResult)).not.toContain('\ufffd');

    const truncated = createParser();
    expect(truncated.feed(Uint8Array.of(0xe4, 0xb8)).kind).toBe('ok');
    const eof = truncated.finish();
    expect(eof.kind).toBe('failed');
    if (eof.kind === 'failed') {
      expect(eof.error.code).toBe('input_encoding_invalid');
    }
  });

  it('settles pending prefix and incomplete paste at EOF without fabricating wrappers', () => {
    const prefixOnly = createParser();
    prefixOnly.feed(Uint8Array.of(PREFIX));
    const prefixEof = prefixOnly.finish();
    expect(prefixEof.kind).toBe('ok');
    expect(remoteText(prefixEof)).toBe('\x1d');

    const paste = createParser();
    const started = paste.feed(bytes(PASTE_START, 'content'));
    expect(remoteText(started)).toBe('content');
    const pasteEof = paste.finish();
    expect(pasteEof.kind).toBe('ok');
    expect(remoteText(pasteEof)).toBe('');
    expect(pasteEof.state.pasteIncomplete).toBe(true);
  });

  it('flushes an incomplete marker candidate at EOF as ordinary bytes', () => {
    const parser = createParser();
    parser.feed(Uint8Array.of(ESCAPE, 0x5b));
    const eof = parser.finish();
    expect(eof.kind).toBe('ok');
    expect(remoteText(eof)).toBe('\x1b[');
  });
});
