import type { RawData } from 'ws';
import {
  buildTerminalMuxCapabilities,
  buildTerminalMuxError,
  buildTerminalMuxReady,
  buildTerminalMuxServerTargetMessage,
  buildTerminalMuxUnwrappedSessionMessageError,
  classifyTerminalMuxClientMessage,
  isTerminalMuxClientFrame,
  validateTerminalMuxChannelEnvelope,
  type TerminalMuxClientFrame,
  type TerminalMuxServerFrame,
} from '@zterm/shared/protocol';
import { buildRequestedRangeBufferPayload } from './buffer-sync-contract';
import { TERMINAL_INPUT_DAEMON_FRAME_MAX_BYTES } from '@zterm/shared/terminal/input-chunking';
// R13: hard cap on a single input frame. Anything larger must be chunked by
// the client and resent as smaller `input` frames.
const MAX_INPUT_PAYLOAD_BYTES = TERMINAL_INPUT_DAEMON_FRAME_MAX_BYTES;
import type {
  BufferSyncRequestPayload,
  ClientMessage,
  HostConfigMessage,
  RuntimeDebugLogEntry,
  ServerMessage,
  TerminalInputAckPayload,
  TerminalReliableInputPayload,
} from '../lib/types';
import type {
  TerminalTransportSubscriber,
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
import type { RemoteWindowStreamDaemonRuntime } from './remote-window-stream-daemon';

export interface TerminalMessageRuntimeDeps {
  sessions: Map<string, TerminalTransportSubscriber>;
  sendTransportMessage: (transport: TerminalSessionTransport | null | undefined, message: ServerMessage) => void;
  sendMessage: (session: TerminalSession, message: ServerMessage) => void;
  normalizeBufferSyncRequestPayload: (
    session: TerminalSession,
    request: BufferSyncRequestPayload,
  ) => BufferSyncRequestPayload;
  getSessionMirror: (session: TerminalSession) => SessionMirror | null;
  sendBufferHeadToSession: (session: TerminalSession, mirror: SessionMirror) => void;
  scheduleMirrorLiveSync: (mirror: SessionMirror, delayMs?: number) => void;
  refreshMirrorHeadForSession: (session: TerminalSession, mirror: SessionMirror) => Promise<boolean>;
  handleInput: (session: TerminalSession, data: string, shouldWrite?: () => boolean) => Promise<boolean>;
  closeSession: (session: TerminalSession, reason: string, notifyClient?: boolean) => void;
  terminalFileTransferRuntime: TerminalFileTransferRuntime;
  remoteWindowStreamRuntime: RemoteWindowStreamDaemonRuntime;
  handleClientDebugLog: (session: TerminalSession, payload: { entries: RuntimeDebugLogEntry[] }) => void;
  handleClientDebugSnapshot: (session: TerminalSession, payload: { snapshot?: unknown }) => void;
  controlRuntimeDeps: TerminalMessageControlRuntimeDeps;
  daemonRuntimeDebug?: (scope: string, payload?: unknown) => void;
}

export interface TerminalMessageRuntime {
  handleSessionOpen: (connection: TerminalTransportConnection, payload: HostConfigMessage) => TerminalTransportSubscriber | null;
  handleSessionTransportConnect: (
    connection: TerminalTransportConnection,
    payload: HostConfigMessage,
  ) => TerminalTransportSubscriber | null;
  handleMessage: (connection: TerminalTransportConnection, rawData: RawData, isBinary?: boolean) => Promise<void>;
}

export function createTerminalMessageRuntime(
  deps: TerminalMessageRuntimeDeps,
): TerminalMessageRuntime {
  function debugInput(scope: 'receive' | 'drop' | 'write', payload: Record<string, unknown>) {
    deps.daemonRuntimeDebug?.(`input-${scope}`, payload);
  }

  function resolveCurrentSessionForInput(connection: TerminalTransportConnection): TerminalSession | null {
    if (!connection.boundSubscriberId) {
      return null;
    }
    const current = deps.sessions.get(connection.boundSubscriberId) || null;
    if (!current) {
      return null;
    }
    if (current.transportId !== connection.transportId || current.transport !== connection.transport) {
      return null;
    }
    return current;
  }

  const reliableInputAckedSeqs = new Map<string, { accepted: true; bytes: number }>();
  const RELIABLE_INPUT_ACKED_SEQ_MAX = 2048;

  function reliableInputKey(sessionId: string, seq: string) {
    return `${sessionId}\u0000${seq}`;
  }

  function rememberReliableInputAck(sessionId: string, seq: string, bytes: number) {
    reliableInputAckedSeqs.set(reliableInputKey(sessionId, seq), { accepted: true, bytes });
    while (reliableInputAckedSeqs.size > RELIABLE_INPUT_ACKED_SEQ_MAX) {
      const oldestKey = reliableInputAckedSeqs.keys().next().value;
      if (typeof oldestKey !== 'string') {
        break;
      }
      reliableInputAckedSeqs.delete(oldestKey);
    }
  }

  function readReliableInputAck(sessionId: string, seq: string) {
    return reliableInputAckedSeqs.get(reliableInputKey(sessionId, seq)) || null;
  }

  function sendInputAck(connection: TerminalTransportConnection, payload: TerminalInputAckPayload) {
    deps.sendTransportMessage(connection.transport, {
      type: 'input-ack',
      payload,
    });
  }

  function sendMuxFrame(connection: TerminalTransportConnection, frame: TerminalMuxServerFrame) {
    deps.sendTransportMessage(connection.transport, frame as unknown as ServerMessage);
  }

  function resolveMuxChannelSubscriber(
    connection: TerminalTransportConnection,
    channelId: string,
  ): TerminalSession | null {
    const subscriberId = connection.muxChannels?.get(channelId) || '';
    return subscriberId ? deps.sessions.get(subscriberId) || null : null;
  }

  function createMuxChannelMessageConnection(
    connection: TerminalTransportConnection,
    subscriber: TerminalSession,
  ): TerminalTransportConnection {
    return {
      ...connection,
      role: 'session',
      boundSubscriberId: subscriber.id,
      transport: subscriber.transport || connection.transport,
      closeTransport: subscriber.closeTransport || (() => {}),
      muxVersion: undefined,
      muxClientInstanceId: null,
      muxChannels: undefined,
    };
  }

  function createMuxTargetMessageConnection(
    connection: TerminalTransportConnection,
    requestId?: string,
  ): TerminalTransportConnection {
    return {
      ...connection,
      boundSubscriberId: null,
      transport: {
        kind: connection.transport.kind,
        requestOrigin: connection.requestOrigin,
        connectedSent: false,
        get readyState() {
          return connection.transport.readyState;
        },
        get bufferedAmount() {
          return Math.max(0, Math.floor(connection.transport.bufferedAmount || 0));
        },
        sendText(text: string) {
          let message: ServerMessage;
          try {
            message = JSON.parse(text) as ServerMessage;
          } catch {
            sendMuxFrame(connection, buildTerminalMuxError(
              'mux_protocol_invalid',
              'mux target send requires a JSON server message',
            ));
            return;
          }
          sendMuxFrame(
            connection,
            buildTerminalMuxServerTargetMessage(
              message as Parameters<typeof buildTerminalMuxServerTargetMessage>[0],
              requestId,
            ),
          );
        },
        close: connection.transport.close,
        ping: connection.transport.ping,
      },
      muxVersion: undefined,
      muxClientInstanceId: null,
      muxChannels: undefined,
    };
  }

  function rejectMuxProtocol(connection: TerminalTransportConnection, message: string, channelId?: string) {
    sendMuxFrame(connection, buildTerminalMuxError('mux_protocol_invalid', message, channelId));
  }

  async function handleMuxFrame(connection: TerminalTransportConnection, candidate: unknown) {
    if (!isTerminalMuxClientFrame(candidate)) {
      rejectMuxProtocol(connection, 'invalid terminal mux frame');
      return;
    }
    const frame = candidate as TerminalMuxClientFrame;
    switch (frame.type) {
      case 'mux-hello':
        connection.muxVersion = frame.payload.version;
        connection.muxClientInstanceId = frame.payload.clientInstanceId;
        if (!connection.muxChannels) {
          connection.muxChannels = new Map();
        }
        sendMuxFrame(connection, buildTerminalMuxReady({
          capabilities: buildTerminalMuxCapabilities({
            reliableInput: { version: 1 },
          }),
        }));
        return;
      case 'mux-target-message': {
        await handleMessage(
          createMuxTargetMessageConnection(connection, frame.payload.requestId),
          Buffer.from(JSON.stringify(frame.payload.message)),
        );
        return;
      }
      case 'mux-channel-open': {
        if (!connection.muxVersion) {
          sendMuxFrame(connection, buildTerminalMuxError(
            'daemon_multiplex_upgrade_required',
            'mux-channel-open requires mux-hello / mux-ready first',
            frame.payload.channelId,
          ));
          return;
        }
        if (!connection.muxChannels) {
          connection.muxChannels = new Map();
        }
        if (connection.muxChannels.has(frame.payload.channelId)) {
          sendMuxFrame(connection, buildTerminalMuxError(
            'mux_duplicate_channel',
            `mux channel ${frame.payload.channelId} is already open`,
            frame.payload.channelId,
          ));
          return;
        }
        const subscriber = deps.controlRuntimeDeps.createMuxChannelSubscriber(connection, frame.payload.channelId);
        subscriber.sessionName = deps.controlRuntimeDeps.sanitizeSessionName(frame.payload.sessionName);
        sendMuxFrame(connection, {
          type: 'mux-channel-opened',
          payload: {
            channelId: frame.payload.channelId,
            sessionName: subscriber.sessionName,
            capabilities: {
              reliableInput: { version: 1 },
            },
          },
        });
        void deps.controlRuntimeDeps.attachTmux(subscriber, {
          sessionName: frame.payload.sessionName,
          cols: frame.payload.cols,
          rows: frame.payload.rows,
          widthMode: frame.payload.widthMode,
          autoCommand: frame.payload.autoCommand,
        }).catch((error: unknown) => {
          sendMuxFrame(connection, {
            type: 'mux-channel-message',
            payload: {
              channelId: frame.payload.channelId,
              message: {
                type: 'error',
                payload: {
                  message: error instanceof Error ? error.message : 'Invalid mux channel open payload',
                  code: 'mux_channel_open_failed',
                },
              },
            },
          });
        });
        return;
      }
      case 'mux-channel-message': {
        const envelope = validateTerminalMuxChannelEnvelope(frame, {
          hasChannel: (channelId) => Boolean(resolveMuxChannelSubscriber(connection, channelId)),
        });
        if (!envelope.ok) {
          sendMuxFrame(connection, envelope.error);
          return;
        }
        const subscriber = resolveMuxChannelSubscriber(connection, envelope.channelId);
        if (!subscriber) {
          sendMuxFrame(connection, buildTerminalMuxError(
            'mux_unknown_channel',
            `mux channel ${envelope.channelId} is not open`,
            envelope.channelId,
          ));
          return;
        }
        await handleMessage(
          createMuxChannelMessageConnection(connection, subscriber),
          Buffer.from(JSON.stringify(frame.payload.message)),
        );
        return;
      }
      case 'mux-channel-binary': {
        const envelope = validateTerminalMuxChannelEnvelope(frame, {
          hasChannel: (channelId) => Boolean(resolveMuxChannelSubscriber(connection, channelId)),
        });
        if (!envelope.ok) {
          sendMuxFrame(connection, envelope.error);
          return;
        }
        const subscriber = resolveMuxChannelSubscriber(connection, envelope.channelId);
        if (!subscriber) {
          sendMuxFrame(connection, buildTerminalMuxError(
            'mux_unknown_channel',
            `mux channel ${envelope.channelId} is not open`,
            envelope.channelId,
          ));
          return;
        }
        await handleMessage(
          createMuxChannelMessageConnection(connection, subscriber),
          Buffer.from(frame.payload.dataBase64, 'base64'),
          true,
        );
        return;
      }
      case 'mux-channel-close': {
        const envelope = validateTerminalMuxChannelEnvelope(frame, {
          hasChannel: (channelId) => Boolean(resolveMuxChannelSubscriber(connection, channelId)),
        });
        if (!envelope.ok) {
          sendMuxFrame(connection, envelope.error);
          return;
        }
        const subscriber = resolveMuxChannelSubscriber(connection, envelope.channelId);
        if (subscriber) {
          connection.muxChannels?.delete(envelope.channelId);
          deps.closeSession(subscriber, frame.payload.reason || 'client requested channel close', false);
        }
        return;
      }
      case 'mux-ping':
        sendMuxFrame(connection, {
          type: 'mux-pong',
          payload: {
            sentAt: frame.payload.sentAt,
            receivedAt: Date.now(),
          },
        });
        return;
    }
  }

  function normalizeReliableInputPayload(payload: unknown): TerminalReliableInputPayload | null {
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    const candidate = payload as Partial<TerminalReliableInputPayload>;
    if (
      candidate.version !== 1
      || typeof candidate.seq !== 'string'
      || candidate.seq.trim().length === 0
      || typeof candidate.data !== 'string'
      || typeof candidate.sentAt !== 'number'
      || !Number.isFinite(candidate.sentAt)
      || typeof candidate.attempt !== 'number'
      || !Number.isFinite(candidate.attempt)
    ) {
      return null;
    }
    return {
      version: 1,
      seq: candidate.seq,
      data: candidate.data,
      sentAt: candidate.sentAt,
      attempt: Math.max(0, Math.floor(candidate.attempt)),
    };
  }

  function readReliableInputSeq(payload: unknown) {
    if (!payload || typeof payload !== 'object') {
      return '';
    }
    const seq = (payload as { seq?: unknown }).seq;
    return typeof seq === 'string' ? seq.trim() : '';
  }

  function reportInputDrop(
    connection: TerminalTransportConnection,
    reason: 'session_required' | 'input_stale_transport',
    bytes: number,
    ackSeq?: string,
  ) {
    debugInput('drop', {
      transportId: connection.transportId,
      sessionId: connection.boundSubscriberId,
      reason,
      bytes,
      queueDepth: 0,
    });
    if (ackSeq) {
      sendInputAck(connection, {
        version: 1,
        seq: ackSeq,
        accepted: false,
        bytes,
        error: reason,
      });
    }
    deps.sendTransportMessage(connection.transport, {
      type: 'error',
      payload: reason === 'input_stale_transport'
        ? { message: 'input requires the current attached session transport', code: 'input_stale_transport' }
        : { message: 'input requires an attached session transport', code: 'session_required' },
    });
  }

  async function writeInputIfCurrent(connection: TerminalTransportConnection, data: string, ackSeq?: string) {
    const bytes = Buffer.byteLength(data, 'utf8');
    // R13: reject oversized input payloads before they reach the tmux write
    // path. tmux's send-keys has a hard limit (~1MB) and a multi-MB paste can
    // stall the entire capture loop. The client should chunk on its side.
    if (bytes > MAX_INPUT_PAYLOAD_BYTES) {
      debugInput('drop', {
        transportId: connection.transportId,
        sessionId: connection.boundSubscriberId,
        reason: 'input_too_large',
        bytes,
        queueDepth: 0,
        max: MAX_INPUT_PAYLOAD_BYTES,
      });
      deps.sendTransportMessage(connection.transport, {
        type: 'error',
        payload: {
          message: `input payload exceeds ${MAX_INPUT_PAYLOAD_BYTES} bytes; client must chunk`,
          code: 'input_too_large',
        },
      });
      if (ackSeq) {
        sendInputAck(connection, {
          version: 1,
          seq: ackSeq,
          accepted: false,
          bytes,
          error: 'input_too_large',
        });
      }
      return;
    }
    debugInput('receive', {
      transportId: connection.transportId,
      sessionId: connection.boundSubscriberId,
      bytes,
      queueDepth: 0,
    });
    const inputSession = resolveCurrentSessionForInput(connection);
    if (!inputSession) {
      reportInputDrop(
        connection,
        connection.boundSubscriberId && deps.sessions.has(connection.boundSubscriberId) ? 'input_stale_transport' : 'session_required',
        bytes,
        ackSeq,
      );
      return;
    }
    if (ackSeq) {
      const existingAck = readReliableInputAck(inputSession.id, ackSeq);
      if (existingAck) {
        sendInputAck(connection, {
          version: 1,
          seq: ackSeq,
          accepted: true,
          bytes: existingAck.bytes,
        });
        debugInput('write', {
          transportId: connection.transportId,
          sessionId: inputSession.id,
          sessionName: inputSession.sessionName,
          bytes: existingAck.bytes,
          duplicateSeq: ackSeq,
          queueDepth: 0,
        });
        return;
      }
    }
    const startedAt = Date.now();
    const wrote = await deps.handleInput(inputSession, data, () => {
      const current = resolveCurrentSessionForInput(connection);
      return current?.id === inputSession.id;
    });
    if (!wrote) {
      reportInputDrop(connection, 'input_stale_transport', bytes, ackSeq);
      return;
    }
    if (ackSeq) {
      rememberReliableInputAck(inputSession.id, ackSeq, bytes);
      sendInputAck(connection, {
        version: 1,
        seq: ackSeq,
        accepted: true,
        bytes,
      });
    }
    debugInput('write', {
      transportId: connection.transportId,
      sessionId: inputSession.id,
      sessionName: inputSession.sessionName,
      bytes,
      durationMs: Date.now() - startedAt,
      queueDepth: 0,
    });
  }

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
    const session = connection.boundSubscriberId ? deps.sessions.get(connection.boundSubscriberId) || null : null;
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
      if (!connection.boundSubscriberId) {
        deps.sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'Plain text input requires an attached session transport', code: 'input_requires_session' },
        });
        return;
      }
          await writeInputIfCurrent(connection, text);
          return;
        }

    if (typeof (message as { type?: unknown }).type === 'string' && (message as { type: string }).type.startsWith('mux-')) {
      await handleMuxFrame(connection, message);
      return;
    }

    if (connection.muxVersion) {
      const messageType = (message as { type?: unknown }).type;
      if (typeof messageType === 'string' && classifyTerminalMuxClientMessage(message) === 'channel') {
        sendMuxFrame(connection, buildTerminalMuxUnwrappedSessionMessageError(messageType));
        return;
      }
      if (typeof messageType === 'string' && classifyTerminalMuxClientMessage(message) === 'legacy') {
        sendMuxFrame(connection, buildTerminalMuxError(
          'mux_unwrapped_session_message',
          `legacy message ${messageType} is not valid after mux-ready`,
        ));
        return;
      }
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
            void deps.controlRuntimeDeps.attachTmux(serverSession, message.payload).catch((error: unknown) => {
              deps.sendTransportMessage(connection.transport, {
                type: 'error',
                payload: {
                  message: error instanceof Error ? error.message : 'Invalid connect payload',
                  code: 'connect_payload_invalid',
                },
              });
            });
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
      case 'resize':
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'resize requires an attached session transport', code: 'session_required' },
          });
          break;
        }
        try {
          const resizeResult = deps.controlRuntimeDeps.handleAdaptiveResize?.(session, {
            cols: typeof message.payload?.cols === 'number' && Number.isFinite(message.payload.cols)
              ? message.payload.cols
              : undefined,
            widthMode: message.payload?.widthMode === 'adaptive-phone' ? 'adaptive-phone' : 'mirror-fixed',
          });
          if (resizeResult && !resizeResult.ok) {
            deps.sendMessage(session, {
              type: 'error',
              payload: {
                message: resizeResult.message,
                code: resizeResult.code,
              },
            });
          }
        } catch (error) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: {
              message: error instanceof Error ? error.message : 'Resize failed',
              code: 'resize_failed',
            },
          });
        }
        break;
      case 'body-subscription': {
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'body-subscription requires an attached session transport', code: 'session_required' },
          });
          break;
        }
        if (message.payload?.version !== 1 || typeof message.payload.subscribed !== 'boolean') {
          deps.sendMessage(session, {
            type: 'error',
            payload: {
              message: 'body-subscription requires version=1 and boolean subscribed',
              code: 'body_subscription_invalid',
            },
          });
          break;
        }
        session.bodySubscribed = message.payload.subscribed;
        const mirror = deps.getSessionMirror(session);
        if (mirror?.lifecycle === 'ready') {
          if (message.payload.subscribed) {
            deps.sendBufferHeadToSession(session, mirror);
          }
          deps.scheduleMirrorLiveSync(mirror, 0);
        }
        break;
      }
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
        // R1+R2: a single sub's head request no longer takes a private
        // per-sub path. sendBufferHeadToSession now routes through the
        // dedup'd broadcast, so 8 subs all asking within the cache window
        // share one mirror capture / one stringify.
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
      case 'debug-snapshot':
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'debug-snapshot requires an attached session transport', code: 'session_required' },
          });
          break;
        }
        deps.handleClientDebugSnapshot(session, message.payload);
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
        if (typeof message.payload === 'string') {
          await writeInputIfCurrent(connection, message.payload);
          break;
        }
        {
          const reliablePayload = normalizeReliableInputPayload(message.payload);
          if (reliablePayload) {
            await writeInputIfCurrent(connection, reliablePayload.data, reliablePayload.seq);
            break;
          }
        }
        {
          const invalidSeq = readReliableInputSeq(message.payload);
          if (invalidSeq) {
            sendInputAck(connection, {
              version: 1,
              seq: invalidSeq,
              accepted: false,
              bytes: 0,
              error: 'input_invalid',
            });
          }
        }
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'input requires an attached session transport', code: 'session_required' },
          });
          break;
        }
        deps.sendMessage(session, {
          type: 'error',
          payload: { message: 'invalid input payload', code: 'input_invalid' },
        });
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
      case 'remote-window-targets-request':
        void deps.remoteWindowStreamRuntime.listTargets(message.payload).then((payload) => {
          deps.sendTransportMessage(connection.transport, 'targets' in payload
            ? { type: 'remote-window-targets-response', payload }
            : { type: 'remote-window-error', payload });
        }).catch((error: unknown) => {
          deps.sendTransportMessage(connection.transport, {
            type: 'remote-window-error',
            payload: {
              requestId: message.payload.requestId || '',
              code: 'remote_window_catalog_failed',
              message: error instanceof Error ? error.message : 'remote window catalog failed',
            },
          });
        });
        break;
      case 'remote-window-stream-start-request':
        void deps.remoteWindowStreamRuntime.startStream(message.payload, {
          sendIceCandidate: (payload) => {
            deps.sendTransportMessage(connection.transport, {
              type: 'remote-window-stream-ice-candidate',
              payload,
            });
          },
          sendStatus: (payload) => {
            deps.sendTransportMessage(connection.transport, {
              type: 'remote-window-stream-status',
              payload,
            });
          },
        }).then((payload) => {
          deps.sendTransportMessage(connection.transport, 'answer' in payload
            ? { type: 'remote-window-stream-started', payload }
            : { type: 'remote-window-error', payload });
        }).catch((error: unknown) => {
          deps.sendTransportMessage(connection.transport, {
            type: 'remote-window-error',
            payload: {
              requestId: message.payload.requestId || '',
              streamId: message.payload.streamId || '',
              code: 'remote_window_stream_start_failed',
              message: error instanceof Error ? error.message : 'remote window stream start failed',
            },
          });
        });
        break;
      case 'remote-window-stream-ice-candidate':
        void deps.remoteWindowStreamRuntime.addIceCandidate(message.payload).catch((error: unknown) => {
          deps.sendTransportMessage(connection.transport, {
            type: 'remote-window-error',
            payload: {
              requestId: message.payload.requestId || '',
              streamId: message.payload.streamId || '',
              code: 'remote_window_stream_candidate_failed',
              message: error instanceof Error ? error.message : 'remote window stream ICE candidate failed',
            },
          });
        });
        break;
      case 'remote-window-stream-stop-request':
        void deps.remoteWindowStreamRuntime.stopStream(message.payload).then((payload) => {
          deps.sendTransportMessage(connection.transport, 'phase' in payload
            ? { type: 'remote-window-stream-status', payload }
            : { type: 'remote-window-error', payload });
        }).catch((error: unknown) => {
          deps.sendTransportMessage(connection.transport, {
            type: 'remote-window-error',
            payload: {
              requestId: message.payload.requestId || '',
              streamId: message.payload.streamId || '',
              code: 'remote_window_stream_stop_failed',
              message: error instanceof Error ? error.message : 'remote window stream stop failed',
            },
          });
        });
        break;
      case 'remote-window-stream-quality-request':
        void deps.remoteWindowStreamRuntime.updateStreamQuality(message.payload).then((payload) => {
          deps.sendTransportMessage(connection.transport, 'accepted' in payload
            ? { type: 'remote-window-stream-quality-result', payload }
            : { type: 'remote-window-error', payload });
        }).catch((error: unknown) => {
          deps.sendTransportMessage(connection.transport, {
            type: 'remote-window-error',
            payload: {
              requestId: message.payload.requestId || '',
              streamId: message.payload.streamId || '',
              code: 'remote_window_stream_quality_failed',
              message: error instanceof Error ? error.message : 'remote window stream quality update failed',
            },
          });
        });
        break;
      case 'remote-window-input':
        void deps.remoteWindowStreamRuntime.injectInput(message.payload).then((payload) => {
          deps.sendTransportMessage(connection.transport, 'accepted' in payload
            ? { type: 'remote-window-input-result', payload }
            : { type: 'remote-window-error', payload });
        }).catch((error: unknown) => {
          deps.sendTransportMessage(connection.transport, {
            type: 'remote-window-error',
            payload: {
              requestId: message.payload.requestId || '',
              streamId: message.payload.streamId || '',
              code: 'remote_window_input_failed',
              message: error instanceof Error ? error.message : 'remote window input failed',
            },
          });
        });
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
