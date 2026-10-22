import type { IncomingMessage } from 'node:http';
import type { ClientRequest } from 'node:http';
import type { AttemptFailure, TraversalWebSocketLike } from '../../shared/src/connection/traversal/types';

type NodeWebSocket = TraversalWebSocketLike & {
  addEventListener(
    event: 'close',
    listener: (event: { code: number; reason: string }) => void,
  ): void;
  once(
    event: 'unexpected-response',
    listener: (request: ClientRequest, response: IncomingMessage) => void,
  ): void;
  once(event: 'error', listener: (error: Error) => void): void;
};

function getErrorCode(error: Error): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

function isNodeWebSocket(socket: unknown): socket is NodeWebSocket {
  return Boolean(
    socket
    && typeof socket === 'object'
    && 'readyState' in socket
    && typeof socket.readyState === 'number'
    && 'addEventListener' in socket
    && typeof socket.addEventListener === 'function'
    && 'once' in socket
    && typeof socket.once === 'function'
    && 'send' in socket
    && typeof socket.send === 'function'
    && 'close' in socket
    && typeof socket.close === 'function',
  );
}

function isTraversalWebSocketLike(socket: unknown): socket is TraversalWebSocketLike {
  return Boolean(
    socket
    && typeof socket === 'object'
    && 'readyState' in socket
    && typeof socket.readyState === 'number'
    && 'send' in socket
    && typeof socket.send === 'function'
    && 'close' in socket
    && typeof socket.close === 'function',
  );
}

export function createNodeWebSocket(socket: unknown): TraversalWebSocketLike {
  if (!isNodeWebSocket(socket)) {
    if (isTraversalWebSocketLike(socket)) {
      return socket;
    }
    throw new TypeError('Node WebSocket constructor returned an incompatible socket');
  }

  if (!('onfailure' in socket)) {
    Object.defineProperty(socket, 'onfailure', {
      configurable: true,
      enumerable: false,
      value: null,
      writable: true,
    });
  }

  let failureSent = false;

  const reportFailure = (failure: AttemptFailure) => {
    if (failureSent) {
      return;
    }
    failureSent = true;
    socket.onfailure?.(failure);
  };

  socket.once('unexpected-response', (request, response) => {
    const status = response.statusCode;
    reportFailure({
      kind: 'http',
      stage: 'connect',
      cause: response,
      ...(typeof status === 'number' ? { status } : {}),
    });
    request.destroy();
    response.destroy();
    socket.close();
  });

  socket.once('error', (error) => {
    const code = getErrorCode(error);
    reportFailure(
      code
        ? {
            kind: 'system',
            stage: 'connect',
            code,
            cause: error,
          }
        : {
            kind: 'unknown',
            stage: 'connect',
            cause: error,
          },
    );
  });

  socket.addEventListener('close', (event) => {
    reportFailure({
      kind: 'ws-close',
      stage: 'connect',
      code: event.code,
      reason: event.reason,
      cause: event,
    });
  });

  return socket;
}
