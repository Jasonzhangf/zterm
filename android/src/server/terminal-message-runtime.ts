import type { RawData } from 'ws';
import {
  buildTerminalMuxError,
  buildTerminalMuxUnwrappedSessionMessageError,
  classifyTerminalMuxClientMessage,
} from '@zterm/shared/protocol';
import { buildRequestedRangeBufferPayload } from './buffer-sync-contract';
import { TERMINAL_INPUT_DAEMON_FRAME_MAX_BYTES } from '@zterm/shared/terminal/input-chunking';
// R13: hard cap on a single input frame. Anything larger must be chunked by
// the client and resent as smaller `input` frames.
const MAX_INPUT_PAYLOAD_BYTES = TERMINAL_INPUT_DAEMON_FRAME_MAX_BYTES;
import type {
  BridgeClientMessage as ClientMessage,
  BridgeServerMessage as ServerMessage,
  AttachmentHistoryPayload,
  HostConfigMessage,
  PendingAttachmentsPayload,
  RuntimeDebugLogEntry,
  TerminalInputAckPayload,
  TerminalReliableInputPayload,
  TerminalTransportServerFrame,
} from '@zterm/shared/protocol';
import type {
  BufferSyncRequestPayload,
} from '@zterm/shared/types';
import type {
  TerminalTransportSubscriber,
  TerminalSession,
  TerminalSessionTransport,
  SessionMirror,
  TerminalTransportConnection,
} from './terminal-runtime-types';
import type { DaemonTransportConnection } from './terminal-transport-runtime';
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
import { createReliableInputAckCache } from './terminal-reliable-input-ack';
import { createTerminalMuxChannelRuntime } from './terminal-mux-channel-runtime';

export interface TerminalMessageRuntimeDeps {
  sessions: Map<string, TerminalTransportSubscriber>;
  sendTransportMessage: (transport: TerminalSessionTransport | null | undefined, message: TerminalTransportServerFrame) => void;
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
  attachmentDeliveryRuntime: {
    listForDevice: (deviceId: string, asset?: 'preview' | 'original', includeAcknowledged?: boolean) => Promise<Array<{
      attachmentId: string;
      kind: 'image';
      senderName: string;
      sourceSession?: string;
      fileName: string;
      mimeType: string;
      preview: { size: number };
      original: { size: number };
      message?: string;
      createdAt: string;
      expiresAt: string;
      deliveries: Array<{ targetDeviceId: string; previewStatus: string; originalStatus: string }>;
    }>>;
    readAsset: (attachmentId: string, asset: 'preview' | 'original', deviceId: string) => Promise<{
      manifest: {
        attachmentId: string;
        kind: 'image';
        mimeType: string;
        preview: { sha256: string; size: number };
        original: { sha256: string; size: number };
      };
      data: Buffer;
    }>;
    acknowledge: (attachmentId: string, deviceId: string, asset: 'preview' | 'original', sha256: string) => Promise<unknown>;
  };
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

  const reliableInputAckCache = createReliableInputAckCache();

  function sendInputAck(connection: TerminalTransportConnection, payload: TerminalInputAckPayload) {
    deps.sendTransportMessage(connection.transport, {
      type: 'input-ack',
      payload,
    });
  }

  const muxRuntime = createTerminalMuxChannelRuntime({
    sessions: deps.sessions,
    mirrors: deps.controlRuntimeDeps.mirrors,
    sendTransportMessage: deps.sendTransportMessage,
    createMuxChannelSubscriber: (connection, channelId) =>
      deps.controlRuntimeDeps.createMuxChannelSubscriber(connection, channelId),
    sanitizeSessionName: (input) => deps.controlRuntimeDeps.sanitizeSessionName(input),
    attachTmux: (subscriber, payload) => deps.controlRuntimeDeps.attachTmux(subscriber, payload),
    closeSession: deps.closeSession,
    handleMessage: (connection, raw, isBinary) => handleMessage(connection, raw, isBinary),
  });
  const handleMuxFrame = muxRuntime.handleMuxFrame;
  const sendMuxFrame = muxRuntime.sendMuxFrame;

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
      const existingAck = reliableInputAckCache.read(inputSession.id, ackSeq);
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
      reliableInputAckCache.remember(inputSession.id, ackSeq, bytes);
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
      // Mux frames are only ever carried by daemon transports (the daemon owns
      // the physical mux connection), so the narrower connection type holds.
      await handleMuxFrame(connection as DaemonTransportConnection, message);
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
      case 'pending-attachments-query': {
        const { deviceId } = (message as { payload: { deviceId: string } }).payload || {};
        if (!deviceId) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'pending-attachments-query requires deviceId', code: 'invalid_payload' },
          });
          break;
        }
        try {
          const manifests = await deps.attachmentDeliveryRuntime.listForDevice(deviceId);
          const pending: PendingAttachmentsPayload['pending'] = manifests.map((m) => ({
            attachmentId: m.attachmentId,
            kind: m.kind,
            senderName: m.senderName,
            sourceSession: m.sourceSession,
            fileName: m.fileName,
            mimeType: m.mimeType,
            previewSize: m.preview.size,
            originalSize: m.original.size,
            message: m.message,
            createdAt: m.createdAt,
            expiresAt: m.expiresAt,
          }));
          deps.sendTransportMessage(connection.transport, {
            type: 'pending-attachments',
            payload: { schemaVersion: 1, pending },
          });
          // eslint-disable-next-line no-console
          console.log(`[zterm:attach] pending-query device=${deviceId} -> ${pending.length} pending`);
        } catch (err) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: err instanceof Error ? err.message : 'attachment query failed', code: 'attachment_query_failed' },
          });
        }
        break;
      }
      case 'attachment-history-query': {
        const { deviceId } = (message as { payload: { deviceId: string } }).payload || {};
        if (!deviceId) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'attachment-history-query requires deviceId', code: 'invalid_payload' },
          });
          break;
        }
        try {
          const manifests = await deps.attachmentDeliveryRuntime.listForDevice(deviceId, 'preview', true);
          const items: AttachmentHistoryPayload['items'] = manifests.map((m) => {
            const delivery = m.deliveries.find((item) => item.targetDeviceId === deviceId);
            return {
              attachmentId: m.attachmentId,
              kind: m.kind,
              senderName: m.senderName,
              sourceSession: m.sourceSession,
              fileName: m.fileName,
              mimeType: m.mimeType,
              previewSize: m.preview.size,
              originalSize: m.original.size,
              message: m.message,
              createdAt: m.createdAt,
              expiresAt: m.expiresAt,
              previewStatus: delivery?.previewStatus === 'acknowledged' ? 'acknowledged' : 'pending',
              originalStatus: delivery?.originalStatus === 'acknowledged' ? 'acknowledged' : 'pending',
            };
          });
          deps.sendTransportMessage(connection.transport, {
            type: 'attachment-history',
            payload: { schemaVersion: 1, items },
          });
        } catch (err) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: err instanceof Error ? err.message : 'attachment history query failed', code: 'attachment_history_failed' },
          });
        }
        break;
      }
      case 'attachment-asset-request': {
        const { attachmentId, asset, deviceId } = (message as { payload: { attachmentId: string; asset: 'preview' | 'original'; deviceId: string } }).payload || {};
        if (!attachmentId || !asset || !deviceId) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'attachment-asset-request requires attachmentId, asset, and deviceId', code: 'invalid_payload' },
          });
          break;
        }
        try {
          const { manifest, data } = await deps.attachmentDeliveryRuntime.readAsset(attachmentId, asset, deviceId);
          // Send asset data via mux target message
          const base64 = data.toString('base64');
          deps.sendTransportMessage(connection.transport, {
            type: 'attachment-asset-data',
            payload: {
              attachmentId: manifest.attachmentId,
              deviceId,
              asset,
              dataBase64: base64,
              sha256: manifest[asset].sha256,
              mimeType: manifest.mimeType,
            },
          });
          // eslint-disable-next-line no-console
          console.log(`[zterm:attach] asset-request attachment=${attachmentId} asset=${asset} device=${deviceId} bytes=${data.byteLength} -> delivered`);
        } catch (err) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: err instanceof Error ? err.message : 'attachment read failed', code: 'attachment_read_failed' },
          });
        }
        break;
      }
      case 'attachment-receipt': {
        const { attachmentId, asset, sha256, deviceId } = (message as { payload: { attachmentId: string; asset: 'preview' | 'original'; sha256: string; deviceId: string } }).payload || {};
        if (!attachmentId || !asset || !sha256 || !deviceId) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: 'attachment-receipt requires attachmentId, asset, sha256, and deviceId', code: 'invalid_payload' },
          });
          break;
        }
        try {
          await deps.attachmentDeliveryRuntime.acknowledge(attachmentId, deviceId, asset, sha256);
          // eslint-disable-next-line no-console
          console.log(`[zterm:attach] receipt attachment=${attachmentId} asset=${asset} device=${deviceId} sha256=${sha256.slice(0, 8)} -> ack`);
          // No response needed - receipt is acknowledged
        } catch (err) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: { message: err instanceof Error ? err.message : 'attachment acknowledge failed', code: 'attachment_acknowledge_failed' },
          });
        }
        break;
      }
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
