import type { RawData } from 'ws';
import { normalizeScheduleDraft } from '../../../packages/shared/src/schedule/next-fire.ts';
import type { ScheduleJob } from '../../../packages/shared/src/schedule/types.ts';
import { buildRequestedRangeBufferPayload } from './buffer-sync-contract';
import type {
  BufferSyncRequestPayload,
  ClientMessage,
  HostConfigMessage,
  RuntimeDebugLogEntry,
  ScheduleJobDraft,
  ServerMessage,
} from '../lib/types';
import type {
  ClientSession,
  ClientSessionTransport,
  SessionMirror,
  TerminalAttachPayload,
  TerminalTransportConnection,
} from './terminal-runtime-types';
import type { TerminalFileTransferRuntime } from './terminal-file-transfer-runtime';

export interface TerminalMessageRuntimeDeps {
  sessions: Map<string, ClientSession>;
  mirrors: Map<string, SessionMirror>;
  scheduleEngine: {
    listBySession: (sessionName: string) => ScheduleJob[];
    upsert: (job: ScheduleJobDraft) => void;
    delete: (jobId: string) => void;
    toggle: (jobId: string, enabled: boolean) => void;
    runNow: (jobId: string) => Promise<unknown>;
    renameSession: (currentName: string, nextName: string) => void;
    markSessionMissing: (sessionName: string, reason: string) => void;
  };
  sendTransportMessage: (transport: ClientSessionTransport | null | undefined, message: ServerMessage) => void;
  sendMessage: (session: ClientSession, message: ServerMessage) => void;
  sendScheduleStateToSession: (session: ClientSession, sessionName?: string) => void;
  listTmuxSessions: () => string[];
  createDetachedTmuxSession: (sessionName?: string) => string;
  renameTmuxSession: (currentName?: string, nextName?: string) => string;
  runTmux: (args: string[]) => { ok: true; stdout: string };
  sanitizeSessionName: (input?: string) => string;
  normalizeClientSessionId: (input?: string) => string;
  normalizeSessionTransportToken: (input?: string) => string;
  normalizeBufferSyncRequestPayload: (
    session: ClientSession,
    request: BufferSyncRequestPayload,
  ) => BufferSyncRequestPayload;
  getOrCreateLogicalClientSession: (clientSessionId: string, requestOrigin: string) => ClientSession;
  bindTransportConnectionToLogicalSession: (
    connection: TerminalTransportConnection,
    session: ClientSession,
  ) => ClientSession;
  issueSessionTransportTicket: (clientSessionId: string) => { token: string };
  takeSessionTransportTicket: (token: string) => { clientSessionId: string } | null;
  getMirrorKey: (sessionName: string) => string;
  getClientMirror: (session: ClientSession) => SessionMirror | null;
  sendBufferHeadToSession: (session: ClientSession, mirror: SessionMirror) => void;
  attachTmux: (session: ClientSession, payload: TerminalAttachPayload) => Promise<void>;
  handleInput: (session: ClientSession, data: string) => void;
  closeLogicalClientSession: (session: ClientSession, reason: string, notifyClient?: boolean) => void;
  destroyMirror: (
    mirror: SessionMirror,
    reason: string,
    options?: { closeLogicalSessions?: boolean; notifyClientClose?: boolean; releaseCode?: string },
  ) => void;
  terminalFileTransferRuntime: TerminalFileTransferRuntime;
  handleClientDebugLog: (session: ClientSession, payload: { entries: RuntimeDebugLogEntry[] }) => void;
}

export interface TerminalMessageRuntime {
  handleSessionOpen: (connection: TerminalTransportConnection, payload: HostConfigMessage) => ClientSession;
  handleSessionTransportConnect: (
    connection: TerminalTransportConnection,
    payload: HostConfigMessage,
  ) => ClientSession | null;
  handleMessage: (connection: TerminalTransportConnection, rawData: RawData, isBinary?: boolean) => Promise<void>;
}

export function createTerminalMessageRuntime(
  deps: TerminalMessageRuntimeDeps,
): TerminalMessageRuntime {
  function handleSessionOpen(connection: TerminalTransportConnection, payload: HostConfigMessage) {
    const clientSessionId = deps.normalizeClientSessionId(payload.clientSessionId);
    const logicalSession = deps.getOrCreateLogicalClientSession(clientSessionId, connection.requestOrigin);
    connection.role = 'control';
    connection.boundSessionId = null;
    const sessionName = deps.sanitizeSessionName(payload.sessionName || payload.name);
    const issued = deps.issueSessionTransportTicket(clientSessionId);
    deps.sendTransportMessage(connection.transport, {
      type: 'session-ticket',
      payload: {
        clientSessionId,
        sessionTransportToken: issued.token,
        sessionName,
      },
    });
    return logicalSession;
  }

  function handleSessionTransportConnect(connection: TerminalTransportConnection, payload: HostConfigMessage) {
    const clientSessionId = deps.normalizeClientSessionId(payload.clientSessionId);
    const token = deps.normalizeSessionTransportToken(payload.sessionTransportToken);
    const ticket = deps.takeSessionTransportTicket(token);
    if (!ticket || ticket.clientSessionId !== clientSessionId) {
      deps.sendTransportMessage(connection.transport, {
        type: 'error',
        payload: {
          message: 'Invalid session transport ticket',
          code: 'session_transport_ticket_invalid',
        },
      });
      connection.closeTransport('session transport ticket invalid');
      return null;
    }
    const logicalSession = deps.sessions.get(clientSessionId) || null;
    if (!logicalSession) {
      deps.sendTransportMessage(connection.transport, {
        type: 'error',
        payload: {
          message: `Logical client session ${clientSessionId} not found`,
          code: 'logical_session_missing',
        },
      });
      connection.closeTransport('logical client session missing');
      return null;
    }
    return deps.bindTransportConnectionToLogicalSession(connection, logicalSession);
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
              clientSessionId: message.payload?.clientSessionId || '',
              message: error instanceof Error ? error.message : 'Invalid session-open payload',
              code: 'session_open_invalid',
            },
          });
        }
        break;
      case 'list-sessions':
        try {
          deps.sendTransportMessage(connection.transport, { type: 'sessions', payload: { sessions: deps.listTmuxSessions() } });
        } catch (error) {
          const err = error instanceof Error ? error.message : String(error);
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: `Failed to list tmux sessions: ${err}`, code: 'list_sessions_failed' },
          });
        }
        break;
      case 'schedule-list':
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'schedule-list requires an attached session transport', code: 'session_required' },
          });
          break;
        }
        deps.sendScheduleStateToSession(session, deps.sanitizeSessionName(message.payload.sessionName || session.sessionName));
        break;
      case 'schedule-upsert':
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'schedule-upsert requires an attached session transport', code: 'session_required' },
          });
          break;
        }
        try {
          const normalized = normalizeScheduleDraft(
            {
              ...message.payload.job,
              targetSessionName: deps.sanitizeSessionName(message.payload.job.targetSessionName || session.sessionName),
            },
            {
              now: new Date(),
              existing: message.payload.job.id
                ? deps.scheduleEngine.listBySession(
                  deps.sanitizeSessionName(message.payload.job.targetSessionName || session.sessionName),
                ).find((job) => job.id === message.payload.job.id) || null
                : null,
            },
          );
          if (!normalized.targetSessionName) {
            deps.sendMessage(session, {
              type: 'error',
              payload: { message: 'Missing target session', code: 'schedule_invalid_target' },
            });
            break;
          }
          deps.scheduleEngine.upsert({
            ...message.payload.job,
            targetSessionName: normalized.targetSessionName,
          });
        } catch (error) {
          const err = error instanceof Error ? error.message : String(error);
          deps.sendMessage(session, {
            type: 'error',
            payload: { message: `Failed to save schedule: ${err}`, code: 'schedule_upsert_failed' },
          });
        }
        break;
      case 'schedule-delete':
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'schedule-delete requires an attached session transport', code: 'session_required' },
          });
          break;
        }
        deps.scheduleEngine.delete(message.payload.jobId);
        break;
      case 'schedule-toggle':
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'schedule-toggle requires an attached session transport', code: 'session_required' },
          });
          break;
        }
        deps.scheduleEngine.toggle(message.payload.jobId, Boolean(message.payload.enabled));
        break;
      case 'schedule-run-now':
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'schedule-run-now requires an attached session transport', code: 'session_required' },
          });
          break;
        }
        void deps.scheduleEngine.runNow(message.payload.jobId);
        break;
      case 'connect':
        try {
          const logicalSession = handleSessionTransportConnect(connection, message.payload);
          if (logicalSession) {
            void deps.attachTmux(logicalSession, message.payload as TerminalAttachPayload);
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
        const mirror = deps.getClientMirror(session);
        if (!mirror || mirror.lifecycle !== 'ready') {
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
        const mirror = deps.getClientMirror(session);
        if (!mirror || mirror.lifecycle !== 'ready') {
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
        try {
          deps.createDetachedTmuxSession(message.payload.sessionName);
          deps.sendTransportMessage(connection.transport, { type: 'sessions', payload: { sessions: deps.listTmuxSessions() } });
        } catch (error) {
          const err = error instanceof Error ? error.message : String(error);
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: `Failed to create tmux session: ${err}`, code: 'tmux_create_failed' },
          });
        }
        break;
      case 'tmux-rename-session':
        try {
          const currentName = deps.sanitizeSessionName(message.payload.sessionName);
          const nextName = deps.renameTmuxSession(message.payload.sessionName, message.payload.nextSessionName);
          const currentKey = deps.getMirrorKey(currentName);
          const nextKey = deps.getMirrorKey(nextName);
          deps.scheduleEngine.renameSession(currentName, nextName);
          const mirror = deps.mirrors.get(currentKey);
          if (mirror && currentKey !== nextKey) {
            deps.mirrors.delete(currentKey);
            mirror.key = nextKey;
            mirror.sessionName = nextKey;
            deps.mirrors.set(nextKey, mirror);
            for (const sessionId of mirror.subscribers) {
              const client = deps.sessions.get(sessionId);
              if (!client) {
                continue;
              }
              client.mirrorKey = nextKey;
              client.sessionName = nextKey;
              deps.sendMessage(client, { type: 'title', payload: nextKey });
            }
          }
          deps.sendTransportMessage(connection.transport, { type: 'sessions', payload: { sessions: deps.listTmuxSessions() } });
        } catch (error) {
          const err = error instanceof Error ? error.message : String(error);
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: `Failed to rename tmux session: ${err}`, code: 'tmux_rename_failed' },
          });
        }
        break;
      case 'tmux-kill-session':
        try {
          const sessionName = deps.sanitizeSessionName(message.payload.sessionName);
          deps.runTmux(['kill-session', '-t', sessionName]);
          deps.scheduleEngine.markSessionMissing(sessionName, 'session killed');
          const mirror = deps.mirrors.get(deps.getMirrorKey(sessionName));
          if (mirror) {
            deps.destroyMirror(mirror, 'tmux session killed', {
              closeLogicalSessions: false,
              releaseCode: 'tmux_session_killed',
            });
          }
          deps.sendTransportMessage(connection.transport, { type: 'sessions', payload: { sessions: deps.listTmuxSessions() } });
        } catch (error) {
          const err = error instanceof Error ? error.message : String(error);
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: `Failed to kill tmux session: ${err}`, code: 'tmux_kill_failed' },
          });
        }
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
      case 'resize':
      case 'terminal-width-mode':
        break;
      case 'ping':
        deps.sendTransportMessage(connection.transport, { type: 'pong' });
        break;
      case 'close':
        if (!session) {
          connection.closeTransport('client requested close');
          break;
        }
        deps.closeLogicalClientSession(session, 'client requested close', false);
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
