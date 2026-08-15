import type { Session } from '../lib/types';
import type { ClientDaemonConnection } from '../lib/client-daemon-connection';
import {
  TERMINAL_INPUT_CHUNK_BYTES,
  getTerminalInputUtf8ByteLength,
  splitTerminalInputUtf8Chunks,
} from '@zterm/shared/terminal/input-chunking';
import {
  enqueueReliableInputChunks,
  isSessionMessageTransportReady,
  readDaemonConnectionSessionResource,
  readDaemonConnectionSessionSocket,
  readSocketReadyState,
  scheduleInputHeadRefresh,
  TERMINAL_INPUT_BACKPRESSURE_BUFFERED_BYTES,
  type SendInputTransportOptions,
} from '../lib/reliable-input/reliable-input-queue';

interface MutableRefObject<T> {
  current: T;
}

export {
  enqueueReliableInputChunks,
  handleTerminalInputAck,
  resetTerminalReliableInputRuntimeForTests,
  TERMINAL_RELIABLE_INPUT_ACK_TIMEOUT_MS,
  TERMINAL_RELIABLE_INPUT_RETRY_MS,
  type SendInputTransportOptions,
} from '../lib/reliable-input/reliable-input-queue';

export function sendInputThroughSessionTransport(options: SendInputTransportOptions) {
  const targetSessionId = options.sessionId.trim();
  if (!targetSessionId) {
    options.runtimeDebug('session.input.skip', {
      why: 'no-target-session',
      size: options.data.length,
    });
    return;
  }

  const session = options.refs.sessionsRef.current.find((item) => item.id === targetSessionId) || null;
  if (!session) {
    options.runtimeDebug('session.input.skip', {
      why: 'missing-session',
      sessionId: targetSessionId,
      size: options.data.length,
    });
    return;
  }

  const resource = readDaemonConnectionSessionResource(options, targetSessionId);
  const ws = readDaemonConnectionSessionSocket(options, targetSessionId);
  const wsReadyState = readSocketReadyState(ws);
  const runtimeActiveSessionId = options.refs.stateRef.current.activeSessionId;
  const isActiveTarget = runtimeActiveSessionId === targetSessionId;
  const isExplicitInputTarget = true;
  const reconnectInFlight = options.isReconnectInFlight(targetSessionId);
  const inputChunks = splitTerminalInputUtf8Chunks(options.data, TERMINAL_INPUT_CHUNK_BYTES);

  if (session.reliableInputSupported === true) {
    options.runtimeDebug('session.input.reliable-send-request', {
      sessionId: targetSessionId,
      size: options.data.length,
      bytes: getTerminalInputUtf8ByteLength(options.data),
      chunks: inputChunks.length,
      maxChunkBytes: TERMINAL_INPUT_CHUNK_BYTES,
      preview: options.data.slice(0, 32),
      resourceTargetKey: resource.targetKey,
      resourceSocketState: resource.socketState,
      wsReadyState,
      reconnectInFlight,
    });
    enqueueReliableInputChunks(options, targetSessionId, inputChunks);
    if (
      (!ws || ws.readyState !== WebSocket.OPEN)
      && isActiveTarget
      && !reconnectInFlight
    ) {
      options.scheduleReconnect?.(targetSessionId, 'input transport unavailable', true, {
        immediate: true,
        resetAttempt: false,
        force: true,
      });
    }
    return;
  }

  if (isSessionMessageTransportReady(resource, ws)) {
    const bufferedBytes = Number.isFinite(ws.bufferedAmount)
      ? Math.max(0, Math.floor(ws.bufferedAmount || 0))
      : 0;
    if (bufferedBytes >= TERMINAL_INPUT_BACKPRESSURE_BUFFERED_BYTES) {
      options.runtimeDebug('session.input.drop.backpressured-transport', {
        sessionId: targetSessionId,
        size: options.data.length,
        bufferedBytes,
        thresholdBytes: TERMINAL_INPUT_BACKPRESSURE_BUFFERED_BYTES,
        reconnectInFlight,
      });
      return;
    }
    const localRevision = options.readSessionBufferSnapshot(targetSessionId).revision;
    options.runtimeDebug('session.input.send', {
      sessionId: targetSessionId,
      size: options.data.length,
      bytes: getTerminalInputUtf8ByteLength(options.data),
      chunks: inputChunks.length,
      maxChunkBytes: TERMINAL_INPUT_CHUNK_BYTES,
      preview: options.data.slice(0, 32),
      resourceTargetKey: resource.targetKey,
      resourceSocketState: resource.socketState,
    });
    const isFirstPendingInputTailRefresh = options.markPendingInputTailRefresh(
      targetSessionId,
      localRevision,
    );
    for (const chunk of inputChunks) {
      // 2026-08-09 BUG #3 fix: re-check bufferedAmount after each send so that
      // an end-of-loop flush stops before exceeding the backpressure threshold.
      // Without this, a long voice commit can drive buffered bytes far past
      // 128KB before the function returns, leaving the transport wedged in a
      // high-backpressure state.
      const chunkBufferedBytes = Number.isFinite(ws.bufferedAmount)
        ? Math.max(0, Math.floor(ws.bufferedAmount || 0))
        : 0;
      if (chunkBufferedBytes >= TERMINAL_INPUT_BACKPRESSURE_BUFFERED_BYTES) {
        options.runtimeDebug('session.input.legacy-backpressure', {
          sessionId: targetSessionId,
          bufferedBytes: chunkBufferedBytes,
          thresholdBytes: TERMINAL_INPUT_BACKPRESSURE_BUFFERED_BYTES,
        });
        return;
      }
      options.sendSocketPayload(
        targetSessionId,
        ws,
        JSON.stringify({ type: 'input', payload: chunk }),
      );
    }
    if (isFirstPendingInputTailRefresh) {
      scheduleInputHeadRefresh({
        sessionId: targetSessionId,
        daemonConnection: options.daemonConnection,
        requestSessionBufferHead: options.requestSessionBufferHead,
      });
    }
    // Input path keeps transport input synchronous and moves head refresh to a
    // coalesced microtask so refresh work cannot block key dispatch.
    return;
  }

  options.runtimeDebug('session.input.transport-unavailable', {
    sessionId: targetSessionId,
    why: 'transport-unavailable',
    size: options.data.length,
    preview: options.data.slice(0, 32),
    isActiveTarget,
    runtimeActiveSessionId,
    explicitInputTarget: isExplicitInputTarget,
    reconnectInFlight,
    resourceTargetKey: resource.targetKey,
    resourceSocketState: resource.socketState,
    wsReadyState,
    channelState: resource.channel?.state ?? null,
  });
  const pendingTransportOpen = options.hasPendingSessionTransportOpen(targetSessionId);
  const pendingTransportOpenStale = pendingTransportOpen
    ? options.isPendingSessionTransportOpenStale(targetSessionId)
    : false;
  if (pendingTransportOpen) {
    options.runtimeDebug('session.input.drop.pending-transport-open', {
      sessionId: targetSessionId,
      size: options.data.length,
      preview: options.data.slice(0, 32),
      wsReadyState,
      reconnectInFlight,
      pendingTransportOpenStale,
      resourceTargetKey: resource.targetKey,
      resourceSocketState: resource.socketState,
    });
    return;
  }
  if (isActiveTarget && !reconnectInFlight) {
    options.scheduleReconnect?.(targetSessionId, 'input transport unavailable', true, {
      immediate: true,
      resetAttempt: false,
      force: true,
    });
  }
}

export async function ensureSessionReadyForTransfer(options: {
  sessionId: string;
  timeoutMs: number;
  sessionsRef: MutableRefObject<Session[]>;
  daemonConnection: ClientDaemonConnection;
}) {
  const readReadyState = () => {
    const session = options.sessionsRef.current.find((item) => item.id === options.sessionId) || null;
    const ws = options.daemonConnection.readSessionSocket(options.sessionId) || null;
    const ready =
      Boolean(session)
      && session?.state === 'connected'
      && Boolean(ws)
      && ws?.readyState === WebSocket.OPEN;
    return {
      session,
      ws,
      ready,
    };
  };

  const initial = readReadyState();
  if (initial.ready && initial.ws) {
    return initial.ws;
  }

  if (!initial.session) {
    throw new Error('Active session no longer exists');
  }

  if (initial.session.state !== 'connecting' && initial.session.state !== 'reconnecting') {
    throw new Error(`Active session is not ready yet (${initial.session.state || 'missing'})`);
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < options.timeoutMs) {
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    const current = readReadyState();
    if (current.ready && current.ws) {
      return current.ws;
    }
  }

  const latest = readReadyState();
  const stateLabel = latest.session?.state || 'missing';
  throw new Error(`Active session is not ready yet (${stateLabel})`);
}
