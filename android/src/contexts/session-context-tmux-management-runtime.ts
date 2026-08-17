import {
  buildTerminalMuxTargetMessage,
  type TerminalSessionCatalog,
  type TerminalSessionCatalogEntry,
  type TerminalMuxTargetClientMessage,
  type TerminalMuxTargetServerMessage,
} from '@zterm/shared/protocol';
import type { SessionTransportResource } from '../lib/session-transport-runtime';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type { ClientDaemonConnection } from '../lib/client-daemon-connection';

const TRANSPORT_OPEN = 1;
export const SESSION_TMUX_TARGET_REQUEST_TIMEOUT_MS = 10_000;

export interface PendingSessionTmuxTargetRequest {
  sessionId: string;
  requestId: string;
  messageType: TerminalMuxTargetClientMessage['type'];
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (sessions: string[], sessionCatalog?: TerminalSessionCatalogEntry[]) => void;
  reject: (error: Error) => void;
}

export type SessionTmuxTargetRequestStore = Map<string, PendingSessionTmuxTargetRequest>;

function normalizeSessionNames(input: unknown) {
  return (input as string[]).map((item) => item.trim()).filter(Boolean);
}

function isSessionNameList(input: unknown): input is string[] {
  return Array.isArray(input) && input.every((item) => typeof item === 'string');
}

function isSessionCatalog(input: unknown): input is TerminalSessionCatalogEntry[] {
  return Array.isArray(input) && input.every((entry) => (
    !!entry
    && typeof entry === 'object'
    && typeof (entry as TerminalSessionCatalogEntry).name === 'string'
    && ((entry as TerminalSessionCatalogEntry).backend === 'tmux' || (entry as TerminalSessionCatalogEntry).backend === 'herdr')
  ));
}

function createTmuxTargetRequestId(sessionId: string, messageType: string) {
  const token = Math.random().toString(36).slice(2, 10);
  return `tmux:${sessionId}:${messageType}:${Date.now().toString(36)}:${token}`;
}

function clearPendingRequestTimer(request: PendingSessionTmuxTargetRequest) {
  if (request.timer) {
    clearTimeout(request.timer);
    request.timer = null;
  }
}

export function settleSessionTmuxTargetRequestRuntime(options: {
  pendingRequestsRef: { current: SessionTmuxTargetRequestStore };
  requestId?: string;
  message: TerminalMuxTargetServerMessage;
  runtimeDebug?: (event: string, payload?: Record<string, unknown>) => void;
}) {
  const requestId = typeof options.requestId === 'string' ? options.requestId.trim() : '';
  if (!requestId) {
    return false;
  }
  const request = options.pendingRequestsRef.current.get(requestId);
  if (!request) {
    return false;
  }
  options.pendingRequestsRef.current.delete(requestId);
  clearPendingRequestTimer(request);

  if (options.message.type === 'sessions') {
    if (!isSessionNameList(options.message.payload.sessions)) {
      request.reject(new Error('Malformed tmux target sessions response'));
      options.runtimeDebug?.('session.tmux-target.malformed-response', {
        sessionId: request.sessionId,
        requestId,
        requestType: request.messageType,
      });
      return true;
    }
    const rawCatalog = options.message.payload.sessionCatalog;
    if (rawCatalog !== undefined && !isSessionCatalog(rawCatalog)) {
      request.reject(new Error('Malformed tmux target session catalog'));
      options.runtimeDebug?.('session.tmux-target.malformed-catalog', {
        sessionId: request.sessionId,
        requestId,
        requestType: request.messageType,
      });
      return true;
    }
    request.resolve(normalizeSessionNames(options.message.payload.sessions), rawCatalog);
    return true;
  }
  if (options.message.type === 'error') {
    request.reject(new Error(options.message.payload.message || 'Failed to manage tmux sessions'));
    return true;
  }

  request.reject(new Error(`Unexpected tmux target response type: ${options.message.type}`));
  options.runtimeDebug?.('session.tmux-target.unexpected-response', {
    sessionId: request.sessionId,
    requestId,
    requestType: request.messageType,
    responseType: options.message.type,
  });
  return true;
}

interface OpenTransportRequestOptions {
  sessionId: string;
  message: TerminalMuxTargetClientMessage;
  pendingRequestsRef: { current: SessionTmuxTargetRequestStore };
  readSessionTransportResource: (sessionId: string) => SessionTransportResource;
  daemonConnection?: ClientDaemonConnection;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  timeoutMs?: number;
  runtimeDebug?: (event: string, payload?: Record<string, unknown>) => void;
}

function createOpenTransportRequestRuntime<T>(
  options: OpenTransportRequestOptions,
  resolveResult: (sessions: string[], sessionCatalog?: TerminalSessionCatalogEntry[]) => T,
): Promise<T | null> {
  const resource = options.daemonConnection
    ? options.daemonConnection.readSessionResource(options.sessionId)
    : options.readSessionTransportResource(options.sessionId);
  const ws = resource.targetRuntime?.terminalTransport || resource.terminalSocket;
  if (!resource.targetRuntime?.terminalMuxReady || !ws || ws.readyState !== TRANSPORT_OPEN) {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const requestId = createTmuxTargetRequestId(options.sessionId, options.message.type);
    const request: PendingSessionTmuxTargetRequest = {
      sessionId: options.sessionId,
      requestId,
      messageType: options.message.type,
      timer: null,
      resolve: (sessions, sessionCatalog) => resolve(resolveResult(sessions, sessionCatalog)),
      reject,
    };
    const timeoutMs = Math.max(1, Math.floor(options.timeoutMs || SESSION_TMUX_TARGET_REQUEST_TIMEOUT_MS));
    request.timer = setTimeout(() => {
      if (!options.pendingRequestsRef.current.has(requestId)) {
        return;
      }
      options.pendingRequestsRef.current.delete(requestId);
      request.reject(new Error('Timed out while managing tmux sessions'));
      options.runtimeDebug?.('session.tmux-target.timeout', {
        sessionId: options.sessionId,
        requestId,
        requestType: options.message.type,
      });
    }, timeoutMs);
    options.pendingRequestsRef.current.set(requestId, request);

    try {
      options.sendSocketPayload(
        options.sessionId,
        ws,
        JSON.stringify(buildTerminalMuxTargetMessage(options.message, requestId)),
      );
      options.runtimeDebug?.('session.tmux-target.request-sent', {
        sessionId: options.sessionId,
        requestId,
        requestType: options.message.type,
        targetKey: resource.targetKey,
      });
    } catch (error) {
      options.pendingRequestsRef.current.delete(requestId);
      clearPendingRequestTimer(request);
      request.reject(error instanceof Error ? error : new Error('Failed to send tmux target request'));
    }
  });
}

export function manageTmuxSessionsOnOpenTransportRuntime(
  options: OpenTransportRequestOptions,
): Promise<string[] | null> {
  return createOpenTransportRequestRuntime(options, (sessions) => sessions);
}

export function queryTerminalSessionCatalogOnOpenTransportRuntime(
  options: OpenTransportRequestOptions,
): Promise<TerminalSessionCatalog | null> {
  return createOpenTransportRequestRuntime(options, (sessions, sessionCatalog) => ({
    sessionNames: sessions,
    sessionCatalog: sessionCatalog || [],
  }));
}
