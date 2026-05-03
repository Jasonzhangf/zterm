import type { Host, ServerMessage, TerminalWidthMode } from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type { PendingSessionTransportOpenIntent } from './session-sync-helpers';
import {
  cleanupControlSocketOrchestrationRuntime,
  ensureControlTransportForSessionOpenOrchestrationRuntime,
  failPendingControlTargetIntentsOrchestrationRuntime,
  handleControlTransportMessageOrchestrationRuntime,
} from './session-context-transport-lifecycle-runtime';

interface MutableRefObject<T> {
  current: T;
}

export function createSessionControlTransportOrchestrationRuntime(options: {
  terminalWidthMode: TerminalWidthMode;
  refs: {
    pendingSessionTransportOpenIntentsRef: MutableRefObject<Map<string, PendingSessionTransportOpenIntent>>;
  };
  readSessionTargetControlSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTargetRuntime: (sessionId: string) => { sessionIds: string[] } | null;
  readSessionTargetKey: (sessionId: string) => string | null;
  writeSessionTransportToken: (sessionId: string, token: string | null) => unknown;
  writeSessionTargetControlSocket: (sessionId: string, socket: BridgeTransportSocket | null) => unknown;
  clearSessionHandshakeTimeout: (sessionId: string) => void;
  setSessionHandshakeTimeout: (sessionId: string, callback: () => void, delayMs: number) => number;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  buildTraversalSocketForHost: (host: Host, transportRole?: 'control' | 'session') => BridgeTransportSocket;
  applyTransportDiagnostics: (sessionId: string, socket: BridgeTransportSocket) => void;
  runtimeDebug: (event: string, payload?: Record<string, unknown>) => void;
  recordSessionRx: (sessionId: string, data: string | ArrayBuffer) => void;
  openSessionTransportByIntent: ((intent: PendingSessionTransportOpenIntent) => void) | null;
  sessionHandshakeTimeoutMs: number;
}) {
  const cleanupControlSocket = (sessionId: string, shouldClose = false) => {
    cleanupControlSocketOrchestrationRuntime({
      sessionId,
      shouldClose,
      readSessionTargetControlSocket: options.readSessionTargetControlSocket,
      writeSessionTargetControlSocket: options.writeSessionTargetControlSocket,
    });
  };

  const handleControlTransportMessage = (sessionId: string, msg: ServerMessage) => {
    handleControlTransportMessageOrchestrationRuntime({
      sessionId,
      openSessionTransportByIntent: options.openSessionTransportByIntent,
      pendingSessionTransportOpenIntentsRef: options.refs.pendingSessionTransportOpenIntentsRef,
      clearSessionHandshakeTimeout: options.clearSessionHandshakeTimeout,
      writeSessionTransportToken: options.writeSessionTransportToken,
      msg,
    });
  };

  const failPendingControlTargetIntents = (sessionId: string, message: string, retryable: boolean) => {
    failPendingControlTargetIntentsOrchestrationRuntime({
      sessionId,
      message,
      retryable,
      readSessionTargetRuntime: options.readSessionTargetRuntime,
      pendingSessionTransportOpenIntentsRef: options.refs.pendingSessionTransportOpenIntentsRef,
      clearSessionHandshakeTimeout: options.clearSessionHandshakeTimeout,
      writeSessionTransportToken: options.writeSessionTransportToken,
    });
  };

  const ensureControlTransportForSessionOpen = (intent: PendingSessionTransportOpenIntent) => {
    ensureControlTransportForSessionOpenOrchestrationRuntime({
      intent,
      terminalWidthMode: options.terminalWidthMode,
      readSessionTargetControlSocket: options.readSessionTargetControlSocket,
      readSessionTargetRuntime: options.readSessionTargetRuntime,
      readSessionTargetKey: options.readSessionTargetKey,
      pendingSessionTransportOpenIntentsRef: options.refs.pendingSessionTransportOpenIntentsRef,
      sendSocketPayload: options.sendSocketPayload,
      clearSessionHandshakeTimeout: options.clearSessionHandshakeTimeout,
      setSessionHandshakeTimeout: options.setSessionHandshakeTimeout,
      failPendingControlTargetIntents,
      buildTraversalSocketForHost: options.buildTraversalSocketForHost,
      writeSessionTargetControlSocket: options.writeSessionTargetControlSocket,
      applyTransportDiagnostics: options.applyTransportDiagnostics,
      runtimeDebug: options.runtimeDebug,
      recordSessionRx: options.recordSessionRx,
      handleControlTransportMessage: ({ sessionId }, nextMsg) => {
        handleControlTransportMessage(sessionId, nextMsg);
      },
      cleanupControlSocket,
      sessionHandshakeTimeoutMs: options.sessionHandshakeTimeoutMs,
    });
  };

  return {
    cleanupControlSocket,
    handleControlTransportMessage,
    failPendingControlTargetIntents,
    ensureControlTransportForSessionOpen,
  };
}
