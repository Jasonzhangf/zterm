import {
  appendTerminalDataToSessionBuffer,
  applyScrollbackUpdateToSessionBuffer,
  applySnapshotToSessionBuffer,
  applyViewportUpdateToSessionBuffer,
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
    scrollbackStartIndex: buffer.scrollbackStartIndex,
    revision: buffer.revision,
  };
}

function reduceCanonicalBuffer(
  current: SessionBufferState,
  message: BridgeBufferMessage,
  cacheLines: number,
): SessionBufferState {
  switch (message.type) {
    case 'snapshot':
      return applySnapshotToSessionBuffer(current, message.payload, cacheLines);
    case 'viewport-update':
      return applyViewportUpdateToSessionBuffer(current, message.payload, cacheLines);
    case 'scrollback-update':
      return applyScrollbackUpdateToSessionBuffer(current, message.payload, cacheLines);
    case 'data':
      return appendTerminalDataToSessionBuffer(current, message.payload, cacheLines);
    default:
      return current;
  }
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
