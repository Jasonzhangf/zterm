import {
  HerdrFrameCanonicalizer,
  type HerdrCanonicalSnapshot,
  type HerdrTerminalFrame,
} from './herdr-frame-canonicalizer';

export type HerdrControlMessage =
  | { type: 'terminal.input'; text: string }
  | { type: 'terminal.input'; bytes: string }
  | { type: 'terminal.resize'; cols: number; rows: number; cell_width_px?: number; cell_height_px?: number }
  | { type: 'terminal.release' };

export type HerdrSourceMessage =
  | HerdrTerminalFrame
  | { type: 'terminal.closed'; reason: string }
  | { type: 'terminal.error'; code: string; message: string };

export interface HerdrBackendEvents {
  onCanonicalFrame: (snapshot: HerdrCanonicalSnapshot) => void;
  onClosed: (reason: string) => void;
  onError: (error: Error) => void;
}

export interface HerdrBackendTransport {
  send: (message: HerdrControlMessage) => void;
  close: (reason: string) => void;
}

export interface HerdrBackendSessionAdapter {
  receive: (message: HerdrSourceMessage) => void;
  input: (bytes: Uint8Array) => void;
  inputText: (text: string) => void;
  resize: (geometry: { cols: number; rows: number; cellWidthPx?: number; cellHeightPx?: number }) => void;
  release: () => void;
  reconnect: () => void;
}

function positiveInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`invalid Herdr ${label}: ${value}`);
  }
  return value;
}

function encodeInput(bytes: Uint8Array) {
  if (bytes.length === 0) {
    throw new Error('Herdr terminal.input bytes must not be empty');
  }
  return Buffer.from(bytes).toString('base64');
}

export function createHerdrBackendSessionAdapter(options: {
  canonicalizer: HerdrFrameCanonicalizer;
  transport: HerdrBackendTransport;
  events: HerdrBackendEvents;
}): HerdrBackendSessionAdapter {
  let closed = false;
  let releaseRequested = false;

  function reportError(error: unknown) {
    options.events.onError(error instanceof Error ? error : new Error(String(error)));
  }

  function receive(message: HerdrSourceMessage) {
    if (closed && !releaseRequested) {
      reportError(new Error('Herdr source message received after release'));
      return;
    }
    try {
      if (message.type === 'terminal.closed') {
        closed = true;
        releaseRequested = false;
        options.events.onClosed(message.reason);
        return;
      }
      if (releaseRequested) {
        throw new Error('Herdr source message received after release');
      }
      if (message.type === 'terminal.frame') {
        options.events.onCanonicalFrame(options.canonicalizer.apply(message));
        return;
      }
      throw new Error(`Herdr terminal source error ${message.code}: ${message.message}`);
    } catch (error) {
      reportError(error);
    }
  }

  function input(bytes: Uint8Array) {
    if (closed) {
      throw new Error('Herdr terminal.input after release');
    }
    options.transport.send({ type: 'terminal.input', bytes: encodeInput(bytes) });
  }

  function inputText(text: string) {
    if (closed) {
      throw new Error('Herdr terminal.input after release');
    }
    if (!text) {
      throw new Error('Herdr terminal.input text must not be empty');
    }
    options.transport.send({ type: 'terminal.input', text });
  }

  function resize(geometry: { cols: number; rows: number; cellWidthPx?: number; cellHeightPx?: number }) {
    if (closed) {
      throw new Error('Herdr terminal.resize after release');
    }
    const message: HerdrControlMessage = {
      type: 'terminal.resize',
      cols: positiveInteger(geometry.cols, 'resize cols'),
      rows: positiveInteger(geometry.rows, 'resize rows'),
    };
    if (geometry.cellWidthPx !== undefined) {
      message.cell_width_px = positiveInteger(geometry.cellWidthPx, 'cell width');
    }
    if (geometry.cellHeightPx !== undefined) {
      message.cell_height_px = positiveInteger(geometry.cellHeightPx, 'cell height');
    }
    options.transport.send(message);
  }

  function release() {
    if (closed) {
      // Source termination is already an authoritative close. Cleanup callers
      // must still be able to dispose the transport and remove the session.
      return;
    }
    closed = true;
    releaseRequested = true;
    options.transport.send({ type: 'terminal.release' });
  }

  function reconnect() {
    closed = false;
    releaseRequested = false;
    options.canonicalizer.resetAttachment();
  }

  return { receive, input, inputText, resize, release, reconnect };
}
