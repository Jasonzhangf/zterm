const PREFIX_BYTE = 0x1d;
const ESCAPE_BYTE = 0x1b;
const PASTE_START_MARKER = Object.freeze([0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]);
const PASTE_END_MARKER = Object.freeze([0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]);
const PASTE_CANDIDATE_TIMEOUT_MS = 30;

export type LocalInputCommand =
  | 'close'
  | 'scroll-up'
  | 'scroll-down'
  | 'page-up'
  | 'page-down'
  | 'pan-left'
  | 'pan-right'
  | 'follow';

export type LocalInputIntent =
  | { kind: 'remote-input'; data: string }
  | { kind: 'local-command'; command: LocalInputCommand };

export interface LocalInputState {
  prefixPending: boolean;
  pasteActive: boolean;
  pasteIncomplete: boolean;
  stopped: boolean;
}

export interface LocalInputError {
  code: 'input_encoding_invalid' | 'input_closed';
  message: string;
}

export type LocalInputParseResult =
  | {
      kind: 'ok';
      intents: readonly LocalInputIntent[];
      state: LocalInputState;
    }
  | {
      kind: 'failed';
      stage: 'local-input';
      error: LocalInputError;
      intents: readonly LocalInputIntent[];
      state: LocalInputState;
    };

export interface LocalInputTimerOptions {
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onIntents: (
    intents: readonly LocalInputIntent[],
    state: LocalInputState,
  ) => void;
}

export interface LocalInputParser {
  feed(chunk: Uint8Array): LocalInputParseResult;
  finish(): LocalInputParseResult;
  discardPending(): number;
  snapshot(): LocalInputState;
}

const COMMAND_BY_BYTE = new Map<number, LocalInputCommand>([
  [0x6b, 'scroll-up'],
  [0x6a, 'scroll-down'],
  [0x75, 'page-up'],
  [0x64, 'page-down'],
  [0x68, 'pan-left'],
  [0x6c, 'pan-right'],
  [0x66, 'follow'],
]);

function defaultSetTimer(callback: () => void, delayMs: number) {
  return setTimeout(callback, delayMs);
}

function defaultClearTimer(handle: unknown) {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

export function createLocalInputParser(options: LocalInputTimerOptions): LocalInputParser {
  const setTimer = options.setTimer || defaultSetTimer;
  const clearTimer = options.clearTimer || defaultClearTimer;
  const decoder = new TextDecoder('utf-8', { fatal: true });

  let intents: LocalInputIntent[] = [];
  let prefixPending = false;
  let pasteActive = false;
  let pasteIncomplete = false;
  let stopped = false;
  let finished = false;
  let failure: LocalInputError | null = null;
  let candidate: number[] = [];
  let candidateMarker: readonly number[] = PASTE_START_MARKER;
  let candidateTimer: unknown = null;
  let candidateGeneration = 0;

  function snapshot(): LocalInputState {
    return {
      prefixPending,
      pasteActive,
      pasteIncomplete,
      stopped,
    };
  }

  function emit(intent: LocalInputIntent) {
    if (intent.kind === 'remote-input' && intent.data.length === 0) return;
    const previous = intents[intents.length - 1];
    if (intent.kind === 'remote-input' && previous?.kind === 'remote-input') {
      intents[intents.length - 1] = {
        kind: 'remote-input',
        data: previous.data + intent.data,
      };
      return;
    }
    intents.push(intent);
  }

  function emitRemoteText(data: string) {
    if (data) emit({ kind: 'remote-input', data });
  }

  function emitRemoteBytes(bytes: readonly number[]) {
    for (const byte of bytes) emitRemoteBytesThroughDecoder(Uint8Array.of(byte));
  }

  function emitRemoteBytesThroughDecoder(bytes: Uint8Array) {
    const decoded = decoder.decode(bytes, { stream: true });
    emitRemoteText(decoded);
  }

  function clearCandidateTimer() {
    if (candidateTimer === null) return;
    clearTimer(candidateTimer);
    candidateTimer = null;
    candidateGeneration += 1;
  }

  function clearCandidate(flush: boolean) {
    const pending = candidate;
    candidate = [];
    clearCandidateTimer();
    if (flush && pending.length > 0) {
      emitRemoteBytes(pending);
    }
  }

  function beginCandidate(byte: number) {
    candidate = [byte];
    candidateMarker = pasteActive ? PASTE_END_MARKER : PASTE_START_MARKER;
    const generation = ++candidateGeneration;
    candidateTimer = setTimer(() => {
      if (generation !== candidateGeneration || candidate.length === 0) return;
      const expiredHandle = candidateTimer;
      candidateTimer = null;
      candidateGeneration += 1;
      if (expiredHandle !== null) clearTimer(expiredHandle);
      const expired = candidate;
      candidate = [];
      emitRemoteBytes(expired);
      options.onIntents([...intents], snapshot());
      intents = [];
    }, PASTE_CANDIDATE_TIMEOUT_MS);
  }

  function enterMarkerState() {
    pasteActive = !pasteActive;
    candidate = [];
    clearCandidateTimer();
  }

  function flushMismatchedCandidate(nextByte: number) {
    const buffered = candidate;
    candidate = [];
    clearCandidateTimer();

    const allBytes = [...buffered, nextByte];
    emitRemoteBytesThroughDecoder(Uint8Array.of(allBytes[0] ?? 0));
    for (let index = 1; index < allBytes.length; index += 1) {
      consumeByte(allBytes[index] ?? 0);
    }
  }

  function consumePrefixSuccessor(byte: number) {
    if (byte === 0x71) {
      prefixPending = false;
      stopped = true;
      emit({ kind: 'local-command', command: 'close' });
      return;
    }

    prefixPending = false;
    if (byte === PREFIX_BYTE) {
      emitRemoteBytesThroughDecoder(Uint8Array.of(PREFIX_BYTE));
      return;
    }

    const command = COMMAND_BY_BYTE.get(byte);
    if (command) {
      emit({ kind: 'local-command', command });
      return;
    }
    emitRemoteBytesThroughDecoder(Uint8Array.of(PREFIX_BYTE));
    consumeByte(byte);
  }

  function consumeByte(byte: number) {
    if (candidate.length > 0) {
      const expected = candidateMarker[candidate.length];
      if (expected === byte) {
        candidate.push(byte);
        if (candidate.length === candidateMarker.length) {
          enterMarkerState();
        }
        return;
      }
      flushMismatchedCandidate(byte);
      return;
    }

    if (prefixPending) {
      consumePrefixSuccessor(byte);
      return;
    }

    if (byte === ESCAPE_BYTE) {
      beginCandidate(byte);
      return;
    }

    if (!pasteActive && byte === PREFIX_BYTE) {
      prefixPending = true;
      return;
    }

    emitRemoteBytesThroughDecoder(Uint8Array.of(byte));
  }

  function fail(error: LocalInputError): LocalInputParseResult {
    failure = error;
    clearCandidateTimer();
    const result: LocalInputParseResult = {
      kind: 'failed',
      stage: 'local-input',
      error,
      intents: [...intents],
      state: snapshot(),
    };
    intents = [];
    return result;
  }

  function ok(): LocalInputParseResult {
    const result: LocalInputParseResult = {
      kind: 'ok',
      intents: [...intents],
      state: snapshot(),
    };
    intents = [];
    return result;
  }

  function feed(chunk: Uint8Array): LocalInputParseResult {
    if (failure) return fail(failure);
    if (finished || stopped) {
      return fail({
        code: 'input_closed',
        message: 'local input parser is already closed',
      });
    }

    intents = [];
    try {
      for (const byte of chunk) {
        consumeByte(byte);
        if (stopped) break;
      }
    } catch (error) {
      if (error instanceof TypeError) {
        return fail({
          code: 'input_encoding_invalid',
          message: 'remote input is not valid UTF-8',
        });
      }
      throw error;
    }
    return ok();
  }

  function finish(): LocalInputParseResult {
    if (failure) return fail(failure);
    if (finished) {
      return fail({
        code: 'input_closed',
        message: 'local input parser is already finished',
      });
    }

    intents = [];
    if (candidate.length > 0) {
      const pending = candidate;
      candidate = [];
      clearCandidateTimer();
      emitRemoteBytes(pending);
    }
    if (prefixPending) {
      prefixPending = false;
      emitRemoteBytesThroughDecoder(Uint8Array.of(PREFIX_BYTE));
    }
    if (pasteActive) {
      pasteIncomplete = true;
    }

    try {
      const tail = decoder.decode();
      emitRemoteText(tail);
    } catch (error) {
      if (error instanceof TypeError) {
        finished = true;
        return fail({
          code: 'input_encoding_invalid',
          message: 'remote input ended with an incomplete UTF-8 sequence',
        });
      }
      throw error;
    }

    finished = true;
    return ok();
  }

  function discardPending() {
    let discarded = 0;
    if (prefixPending) discarded += 1;
    discarded += candidate.length;
    prefixPending = false;
    candidate = [];
    pasteActive = false;
    pasteIncomplete = false;
    clearCandidateTimer();
    intents = [];
    return discarded;
  }

  return {
    feed,
    finish,
    discardPending,
    snapshot,
  };
}
