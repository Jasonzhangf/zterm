import {
  applyBufferSyncToSessionBuffer,
  createSessionBufferState,
  isBridgeBufferMessage,
  type BridgeBufferMessage,
  type BridgeServerMessage,
  type SessionBufferState,
  type TerminalRenderBufferProjection,
} from '@zterm/shared';

const DEFAULT_TERMINAL_CACHE_LINES = 1200;

export interface TerminalBufferStoreSnapshot {
  canonicalBuffer: SessionBufferState;
  renderBuffer: TerminalRenderBufferProjection;
}

export interface TerminalBufferStore {
  getState: () => TerminalBufferStoreSnapshot;
  subscribe: (listener: () => void) => () => void;
  reset: () => void;
  applyServerMessage: (message: BridgeServerMessage) => boolean;
}

function createEmptyBuffer(cacheLines: number) {
  return createSessionBufferState({ cacheLines });
}

function projectRenderBuffer(buffer: SessionBufferState): TerminalRenderBufferProjection {
  return {
    lines: buffer.lines,
    gapRanges: buffer.gapRanges,
    startIndex: buffer.startIndex,
    endIndex: buffer.endIndex,
    viewportEndIndex: buffer.viewportEndIndex,
    cols: buffer.cols,
    rows: buffer.rows,
    cursorKeysApp: buffer.cursorKeysApp,
    revision: buffer.revision,
  };
}

function reduceCanonicalBuffer(
  current: SessionBufferState,
  message: BridgeBufferMessage,
  cacheLines: number,
): SessionBufferState {
  if (message.type !== 'buffer-sync') {
    return current;
  }
  return applyBufferSyncToSessionBuffer(current, message.payload, cacheLines);
}

export function createTerminalBufferStore(cacheLines = DEFAULT_TERMINAL_CACHE_LINES): TerminalBufferStore {
  const listeners = new Set<() => void>();
  let state: TerminalBufferStoreSnapshot = {
    canonicalBuffer: createEmptyBuffer(cacheLines),
    renderBuffer: projectRenderBuffer(createEmptyBuffer(cacheLines)),
  };

  const emit = () => {
    listeners.forEach((listener) => listener());
  };

  const setBuffer = (nextBuffer: SessionBufferState) => {
    if (nextBuffer === state.canonicalBuffer) {
      return;
    }
    state = {
      canonicalBuffer: nextBuffer,
      renderBuffer: projectRenderBuffer(nextBuffer),
    };
    emit();
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset: () => {
      setBuffer(createEmptyBuffer(cacheLines));
    },
    applyServerMessage: (message) => {
      if (!isBridgeBufferMessage(message)) {
        return false;
      }
      setBuffer(reduceCanonicalBuffer(state.canonicalBuffer, message, cacheLines));
      return true;
    },
  };
}
