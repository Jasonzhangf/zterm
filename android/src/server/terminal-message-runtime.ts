import type { RawData } from 'ws';
import { buildRequestedRangeBufferPayload } from './buffer-sync-contract';
import type {
  BufferSyncRequestPayload,
  ClientMessage,
  HostConfigMessage,
  RuntimeDebugLogEntry,
  ServerMessage,
} from '../lib/types';
import type {
  TerminalSession,
  TerminalSessionTransport,
  SessionMirror,
  TerminalTransportConnection,
} from './terminal-runtime-types';
import type { TerminalFileTransferRuntime } from './terminal-file-transfer-runtime';
import {
  handleListSessionsMessageRuntime,
  handleScheduleMessageRuntime,
  handleSessionOpenMessageRuntime,
  handleSessionTransportConnectRuntime,
  handleTmuxControlMessageRuntime,
} from './terminal-message-control-runtime';
import type { TerminalMessageControlRuntimeDeps } from './terminal-message-control-runtime';

export interface TerminalMessageRuntimeDeps {
  sessions: Map<string, TerminalSession>;
  sendTransportMessage: (transport: TerminalSessionTransport | null | undefined, message: ServerMessage) => void;
  sendMessage: (session: TerminalSession, message: ServerMessage) => void;
  normalizeBufferSyncRequestPayload: (
    session: TerminalSession,
    request: BufferSyncRequestPayload,
  ) => BufferSyncRequestPayload;
  getSessionMirror: (session: TerminalSession) => SessionMirror | null;
  sendBufferHeadToSession: (session: TerminalSession, mirror: SessionMirror) => void;
  refreshMirrorHeadForSession: (session: TerminalSession, mirror: SessionMirror) => Promise<boolean>;
  handleInput: (session: TerminalSession, data: string) => void;
  closeSession: (session: TerminalSession, reason: string, notifyClient?: boolean) => void;
  terminalFileTransferRuntime: TerminalFileTransferRuntime;
  handleClientDebugLog: (session: TerminalSession, payload: { entries: RuntimeDebugLogEntry[] }) => void;
  controlRuntimeDeps: TerminalMessageControlRuntimeDeps;
}

export interface TerminalMessageRuntime {
  handleSessionOpen: (connection: TerminalTransportConnection, payload: HostConfigMessage) => TerminalSession | null;
  handleSessionTransportConnect: (
    connection: TerminalTransportConnection,
    payload: HostConfigMessage,
  ) => TerminalSession | null;
  handleMessage: (connection: TerminalTransportConnection, rawData: RawData, isBinary?: boolean) => Promise<void>;
}

export function createTerminalMessageRuntime(
  deps: TerminalMessageRuntimeDeps,
): TerminalMessageRuntime {
  function sendSessionNotReadyError(
    session: TerminalSession,
    operation: 'buffer-head-request' | 'buffer-sync-request',
  ) {
    deps.sendMessage(session, {
      type: 'error',
      payload: {
        message: `${operation} requires a ready mirror`,
        code: 'session_not_ready',
      },
    });
  }

  function handleSessionOpen(connection: TerminalTransportConnection, payload: HostConfigMessage) {
    return handleSessionOpenMessageRuntime(deps.controlRuntimeDeps, connection, payload);
  }

  function handleSessionTransportConnect(connection: TerminalTransportConnection, payload: HostConfigMessage) {
    return handleSessionTransportConnectRuntime(deps.controlRuntimeDeps, connection, payload);
  }

  async function handleMessage(connection: TerminalTransportConnection, rawData: RawData, isBinary = false) {
    const session = connection.boundSessionId ? deps.sessions.get(connection.boundSessionId) || null : null;
    if (isBinary) {
      if (!session) {
        deps.sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'Binary payload requires an attached session transport', code: 'binary_requires_session' },
        });
        return;
      }
      const binaryBuffer = Buffer.isBuffer(rawData)
        ? rawData
        : Array.isArray(rawData)
          ? Buffer.concat(rawData)
          : Buffer.from(rawData as ArrayBuffer);
      deps.terminalFileTransferRuntime.handleBinaryPayload(session, binaryBuffer);
      return;
    }

    const text = typeof rawData === 'string'
      ? rawData
      : Buffer.isBuffer(rawData)
        ? rawData.toString('utf-8')
        : Array.isArray(rawData)
          ? Buffer.concat(rawData).toString('utf-8')
          : Buffer.from(rawData as ArrayBuffer).toString('utf-8');

    let message: ClientMessage;
    try {
      message = JSON.parse(text) as ClientMessage;
    } catch {
      if (!session) {
        deps.sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'Plain text input requires an attached session transport', code: 'input_requires_session' },
        });
        return;
      }
      deps.handleInput(session, text);
      return;
    }

    switch (message.type) {
      case 'session-open':
        try {
          handleSessionOpen(connection, message.payload);
        } catch (error) {
          deps.sendTransportMessage(connection.transport, {
            type: 'session-open-failed',
            payload: {
              openRequestId: message.payload?.openRequestId || '',
              clientSessionId: message.payload?.clientSessionId?.trim() || undefined,
              message: error instanceof Error ? error.message : 'Invalid session-open payload',
              code: 'session_open_invalid',
            },
          });
        }
        break;
      case 'list-sessions':
        handleListSessionsMessageRuntime(deps.controlRuntimeDeps, connection);
        break;
      case 'schedule-list':
        handleScheduleMessageRuntime(deps.controlRuntimeDeps, session, message, connection.transport);
        break;
      case 'schedule-upsert':
        handleScheduleMessageRuntime(deps.controlRuntimeDeps, session, message, connection.transport);
        break;
      case 'schedule-delete':
        handleScheduleMessageRuntime(deps.controlRuntimeDeps, session, message, connection.transport);
        break;
      case 'schedule-toggle':
        handleScheduleMessageRuntime(deps.controlRuntimeDeps, session, message, connection.transport);
        break;
      case 'schedule-run-now':
        handleScheduleMessageRuntime(deps.controlRuntimeDeps, session, message, connection.transport);
        break;
      case 'connect':
        try {
          const serverSession = handleSessionTransportConnect(connection, message.payload);
          if (serverSession) {
            void deps.controlRuntimeDeps.attachTmux(serverSession, message.payload);
          }
        } catch (error) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: {
              message: error instanceof Error ? error.message : 'Invalid connect payload',
              code: 'connect_payload_invalid',
            },
          });
        }
        break;
      case 'buffer-head-request': {
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'buffer-head-request requires an attached session transport', code: 'session_required' },
          });
          break;
        }
        const mirror = deps.getSessionMirror(session);
        if (!mirror || mirror.lifecycle !== 'ready') {
          sendSessionNotReadyError(session, 'buffer-head-request');
          break;
        }
        deps.sendBufferHeadToSession(session, mirror);
        break;
      }
      case 'paste-image-start':
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'paste-image-start requires an attached session transport', code: 'session_required' },
          });
          break;
        }
        session.pendingPasteImage = {
          payload: message.payload,
          receivedBytes: 0,
          chunks: [],
        };
        break;
      case 'attach-file-start':
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'attach-file-start requires an attached session transport', code: 'session_required' },
          });
          break;
        }
        session.pendingAttachFile = {
          payload: message.payload,
          receivedBytes: 0,
          chunks: [],
        };
        break;
      case 'buffer-sync-request': {
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'buffer-sync-request requires an attached session transport', code: 'session_required' },
          });
          break;
        }
        const mirror = deps.getSessionMirror(session);
        if (!mirror || mirror.lifecycle !== 'ready') {
          sendSessionNotReadyError(session, 'buffer-sync-request');
          break;
        }
        let request: BufferSyncRequestPayload;
        try {
          request = deps.normalizeBufferSyncRequestPayload(session, message.payload);
        } catch (error) {
          deps.sendMessage(session, {
            type: 'error',
            payload: {
              message: error instanceof Error ? error.message : 'Invalid buffer-sync-request',
              code: 'buffer_sync_request_invalid',
            },
          });
          break;
        }
        const payload = buildRequestedRangeBufferPayload(mirror, request);
        deps.sendMessage(session, { type: 'buffer-sync', payload });
        break;
      }
      case 'debug-log':
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'debug-log requires an attached session transport', code: 'session_required' },
          });
          break;
        }
        deps.handleClientDebugLog(session, message.payload);
        break;
      case 'tmux-create-session':
        handleTmuxControlMessageRuntime(deps.controlRuntimeDeps, connection, message);
        break;
      case 'tmux-rename-session':
        handleTmuxControlMessageRuntime(deps.controlRuntimeDeps, connection, message);
        break;
      case 'tmux-kill-session':
        handleTmuxControlMessageRuntime(deps.controlRuntimeDeps, connection, message);
        break;
      case 'input':
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'input requires an attached session transport', code: 'session_required' },
          });
          break;
        }
        deps.handleInput(session, message.payload);
        break;
      case 'paste-image':
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'paste-image requires an attached session transport', code: 'session_required' },
          });
          break;
        }
        deps.terminalFileTransferRuntime.handlePasteImage(session, message.payload);
        break;
      case 'ping':
        deps.sendTransportMessage(connection.transport, { type: 'pong' });
        break;
      case 'close':
        if (!session) {
          connection.closeTransport('client requested close');
          break;
        }
        deps.closeSession(session, 'client requested close', false);
        break;
      case 'file-list-request':
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'file-list-request requires an attached session transport', code: 'session_required' },
          });
          break;
        }
        deps.terminalFileTransferRuntime.handleFileListRequest(session, message.payload);
        break;
      case 'file-create-directory-request':
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'file-create-directory-request requires an attached session transport', code: 'session_required' },
          });
          break;
        }
        deps.terminalFileTransferRuntime.handleFileCreateDirectoryRequest(session, message.payload);
        break;
      case 'file-download-request':
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'file-download-request requires an attached session transport', code: 'session_required' },
          });
          break;
        }
        deps.terminalFileTransferRuntime.handleFileDownloadRequest(session, message.payload);
        break;
      case 'remote-screenshot-request':
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'remote-screenshot-request requires an attached session transport', code: 'session_required' },
          });
          break;
        }
        void deps.terminalFileTransferRuntime.handleRemoteScreenshotRequest(session, message.payload);
        break;
      case 'file-upload-start':
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'file-upload-start requires an attached session transport', code: 'session_required' },
          });
          break;
        }
        deps.terminalFileTransferRuntime.handleFileUploadStart(session, message.payload);
        break;
      case 'file-upload-chunk':
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'file-upload-chunk requires an attached session transport', code: 'session_required' },
          });
          break;
        }
        deps.terminalFileTransferRuntime.handleFileUploadChunk(session, message.payload);
        break;
      case 'file-upload-end':
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'file-upload-end requires an attached session transport', code: 'session_required' },
          });
          break;
        }
        deps.terminalFileTransferRuntime.handleFileUploadEnd(session, message.payload);
        break;
    }
  }

  return {
    handleSessionOpen,
    handleSessionTransportConnect,
    handleMessage,
  };
}
