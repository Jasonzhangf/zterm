import type { RawData } from 'ws';
import {
  buildTerminalMuxError,
  buildTerminalMuxUnwrappedSessionMessageError,
  classifyTerminalMuxClientMessage,
} from '@zterm/shared/protocol';
import { buildRequestedRangeBufferPayload } from './buffer-sync-contract';
import type {
  BridgeClientMessage as ClientMessage,
  BridgeServerMessage as ServerMessage,
  HostConfigMessage,
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
import {
  createDaemonControlGateway,
  type DaemonControlGatewayDeps,
  type DaemonControlGatewayRuntime,
} from './daemon-control-gateway-runtime';
import type { RemoteWindowStreamDaemonRuntime } from './remote-window-stream-daemon';
import type { DaemonInputQueueRuntime } from './daemon-input-queue-runtime';
import { createTerminalMuxChannelRuntime } from './terminal-mux-channel-runtime';
import type {
  TerminalAttachmentClientMessage,
  TerminalAttachmentMessageRuntime,
} from './terminal-attachment-message-runtime';
import type {
  TerminalFileTransferClientMessage,
  TerminalFileTransferMessageRuntime,
} from './terminal-file-transfer-message-runtime';

const TERMINAL_FILE_TRANSFER_MESSAGE_TYPES = new Set<TerminalFileTransferClientMessage['type']>([
  'paste-image-start',
  'paste-image',
  'paste-image-from-upload',
  'attach-file-start',
  'remote-screenshot-request',
  'file-list-request',
  'file-create-directory-request',
  'file-download-request',
  'file-upload-start',
  'file-upload-chunk',
  'file-upload-end',
]);

function isTerminalFileTransferMessageType(
  value: string,
): value is TerminalFileTransferClientMessage['type'] {
  return TERMINAL_FILE_TRANSFER_MESSAGE_TYPES.has(value as TerminalFileTransferClientMessage['type']);
}

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
  daemonInputQueue: DaemonInputQueueRuntime;
  closeSession: (session: TerminalSession, reason: string, notifyClient?: boolean) => void;
  fileTransferMessageRuntime: TerminalFileTransferMessageRuntime;
  attachmentMessageRuntime: TerminalAttachmentMessageRuntime;
  remoteWindowStreamRuntime: RemoteWindowStreamDaemonRuntime;
  controlRuntimeDeps: DaemonControlGatewayDeps;
  channelMuxRuntime: {
    createMuxChannelSubscriber: (
      connection: TerminalTransportConnection,
      channelId: string,
    ) => TerminalTransportSubscriber;
    ensureMuxChannels: (connection: TerminalTransportConnection) => Map<string, string>;
    releaseMuxChannelSubscriber: (
      connection: TerminalTransportConnection,
      channelId: string,
    ) => void;
  };
}

export interface TerminalMessageRuntime {
  handleSessionOpen: (connection: TerminalTransportConnection, payload: HostConfigMessage) => TerminalTransportSubscriber | null;
  handleSessionTransportConnect: (
    connection: TerminalTransportConnection,
    payload: HostConfigMessage,
  ) => TerminalTransportSubscriber | null;
  handleMessage: (connection: TerminalTransportConnection, rawData: RawData, isBinary?: boolean) => Promise<void>;
  /** WS/传输断开时调用：停掉该连接发起的全部 remote-window 流，避免残留占用 capture */
  closeConnection: (connection: TerminalTransportConnection) => void;
}

export function createTerminalMessageRuntime(
  deps: TerminalMessageRuntimeDeps,
): TerminalMessageRuntime {
  const controlGateway: DaemonControlGatewayRuntime = createDaemonControlGateway(
    deps.controlRuntimeDeps,
  );

  // 连接 → 该连接发起的 remote-window 流（transportId → streamId 集合）
  const connectionRwStreams = new Map<string, Set<string>>();

  function closeConnection(connection: TerminalTransportConnection) {
    const streamIds = connectionRwStreams.get(connection.transportId);
    if (!streamIds || streamIds.size === 0) {
      connectionRwStreams.delete(connection.transportId);
      return;
    }
    for (const streamId of [...streamIds]) {
      void deps.remoteWindowStreamRuntime.stopStream({
        requestId: `rw-close-${streamId}`,
        streamId,
      }).catch(() => {
        // 断连清理不因单个流失败而中断
      });
    }
    connectionRwStreams.delete(connection.transportId);
  }

  const muxRuntime = createTerminalMuxChannelRuntime({
    sessions: deps.sessions,
    mirrors: deps.controlRuntimeDeps.mirrors,
    sendTransportMessage: deps.sendTransportMessage,
    createMuxChannelSubscriber: deps.channelMuxRuntime.createMuxChannelSubscriber,
    ensureMuxChannels: deps.channelMuxRuntime.ensureMuxChannels,
    releaseMuxChannelSubscriber: deps.channelMuxRuntime.releaseMuxChannelSubscriber,
    sanitizeSessionName: (input) => deps.controlRuntimeDeps.sanitizeSessionName(input),
    attachTmux: (subscriber, payload) => deps.controlRuntimeDeps.attachTmux(subscriber, payload),
    closeSession: deps.closeSession,
    handleMessage: (connection, raw, isBinary) => handleMessage(connection, raw, isBinary),
  });
  const handleMuxFrame = muxRuntime.handleMuxFrame;
  const sendMuxFrame = muxRuntime.sendMuxFrame;

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

  function sendRemoteWindowMessage(
    connection: TerminalTransportConnection,
    message: ServerMessage,
  ) {
    deps.sendTransportMessage(connection.transport, message);
  }

  function handleSessionOpen(connection: TerminalTransportConnection, payload: HostConfigMessage) {
    return controlGateway.handleSessionOpen(connection, payload);
  }

  function handleSessionTransportConnect(connection: TerminalTransportConnection, payload: HostConfigMessage) {
    return controlGateway.handleSessionTransportConnect(connection, payload);
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
      deps.fileTransferMessageRuntime.handleBinaryPayload(session, binaryBuffer);
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
      await deps.daemonInputQueue.handleInputMessage(connection, text);
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
        // remote-window-* are channel-lane business messages that ride the
        // same mux channel. The channel subscriber wrapper removes mux
        // metadata before this switch and owns the original channel envelope;
        // a physical mux connection must never guess a channel.
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
      if (typeof messageType === 'string' && classifyTerminalMuxClientMessage(message) === 'observability') {
        sendMuxFrame(connection, buildTerminalMuxError(
          'mux_protocol_invalid',
          `debug observability message ${messageType} cannot use the terminal mux channel`,
        ));
        return;
      }
    }

    if (isTerminalFileTransferMessageType(message.type)) {
      await deps.fileTransferMessageRuntime.handleMessage(
        session,
        connection,
        message as TerminalFileTransferClientMessage,
      );
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
              message: error instanceof Error ? error.message : 'Invalid session-open payload',
              code: 'session_open_invalid',
            },
          });
        }
        break;
      case 'list-sessions':
        controlGateway.handleListSessions(connection, message);
        break;
      case 'pending-attachments-query':
      case 'attachment-history-query':
      case 'attachment-asset-request':
      case 'attachment-receipt':
        await deps.attachmentMessageRuntime.handleMessage(
          connection,
          message as TerminalAttachmentClientMessage,
        );
        break;
      case 'schedule-list':
        await controlGateway.handleScheduleControl(
          session,
          message,
          connection.transport,
          connection.transportId,
        );
        break;
      case 'schedule-upsert':
        await controlGateway.handleScheduleControl(
          session,
          message,
          connection.transport,
          connection.transportId,
        );
        break;
      case 'schedule-delete':
        await controlGateway.handleScheduleControl(
          session,
          message,
          connection.transport,
          connection.transportId,
        );
        break;
      case 'schedule-toggle':
        await controlGateway.handleScheduleControl(
          session,
          message,
          connection.transport,
          connection.transportId,
        );
        break;
      case 'schedule-run-now':
        await controlGateway.handleScheduleControl(
          session,
          message,
          connection.transport,
          connection.transportId,
        );
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
            rows: typeof message.payload?.rows === 'number' && Number.isFinite(message.payload.rows)
              ? message.payload.rows
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
      case 'tmux-create-session':
        await controlGateway.handleTmuxControl(connection, message);
        break;
      case 'tmux-rename-session':
        await controlGateway.handleTmuxControl(connection, message);
        break;
      case 'tmux-kill-session':
        await controlGateway.handleTmuxControl(connection, message);
        break;
      case 'input':
        await deps.daemonInputQueue.handleInputMessage(connection, message.payload);
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
      case 'remote-window-targets-request':
        void deps.remoteWindowStreamRuntime.listTargets(message.payload).then((payload) => {
          sendRemoteWindowMessage(connection, 'targets' in payload
            ? { type: 'remote-window-targets-response', payload }
            : { type: 'remote-window-error', payload });
        }).catch((error: unknown) => {
          sendRemoteWindowMessage(connection, {
            type: 'remote-window-error',
            payload: {
              requestId: message.payload.requestId || '',
              code: 'remote_window_catalog_failed',
              message: error instanceof Error ? error.message : 'remote window catalog failed',
            },
          });
        });
        break;
      case 'remote-window-browser-user-agent-request':
        void deps.remoteWindowStreamRuntime.setBrowserUserAgent(message.payload).then((payload) => {
          sendRemoteWindowMessage(connection, { type: 'remote-window-browser-user-agent-result', payload });
        }).catch((error: unknown) => {
          sendRemoteWindowMessage(connection, {
            type: 'remote-window-error',
            payload: {
              requestId: message.payload.requestId,
              code: 'remote_window_browser_cdp_failed',
              message: error instanceof Error ? error.message : 'Chrome CDP UA control failed',
            },
          });
        });
        break;
      case 'remote-window-stream-start-request':
        sendRemoteWindowMessage(connection, {
          type: 'remote-window-error',
          payload: {
            requestId: message.payload.requestId || '',
            streamId: message.payload.streamId || '',
            code: 'remote_window_stream_protocol_unsupported',
            message: 'remote window stream start v1 is unsupported; use mediaPlanVersion 2',
          },
        });
        break;
      case 'remote-window-stream-start-v2-request':
        {
          const streamId = message.payload.streamId || '';
          if (streamId) {
            let streamIds = connectionRwStreams.get(connection.transportId);
            if (!streamIds) {
              streamIds = new Set<string>();
              connectionRwStreams.set(connection.transportId, streamIds);
            }
            streamIds.add(streamId);
          }
        }
        void deps.remoteWindowStreamRuntime.startStream(message.payload, {
          sendOffer: (payload) => {
            sendRemoteWindowMessage(connection, { type: 'remote-window-stream-offer-v2', payload });
          },
          sendIceCandidate: (payload) => {
            sendRemoteWindowMessage(connection, { type: 'remote-window-stream-ice-candidate', payload });
          },
          sendStatus: (payload) => {
            sendRemoteWindowMessage(connection, { type: 'remote-window-stream-status', payload });
          },
          sendFocusResult: (payload) => {
            sendRemoteWindowMessage(connection, { type: 'remote-window-stream-focus-result', payload });
          },
        }).then((payload) => {
          if ('code' in payload) {
            sendRemoteWindowMessage(connection, { type: 'remote-window-error', payload });
          }
        }).catch((error: unknown) => {
          sendRemoteWindowMessage(connection, {
            type: 'remote-window-error',
            payload: {
              requestId: message.payload.requestId,
              streamId: message.payload.streamId,
              code: 'remote_window_stream_start_failed',
              message: error instanceof Error ? error.message : 'remote window stream start failed',
            },
          });
        });
        break;
      case 'remote-window-stream-answer-v2':
        if (!deps.remoteWindowStreamRuntime.acceptAnswer) {
          throw new Error('remote window v2 answer owner is unavailable');
        }
        void deps.remoteWindowStreamRuntime.acceptAnswer(message.payload).catch((error: unknown) => {
          sendRemoteWindowMessage(connection, {
            type: 'remote-window-error',
            payload: {
              requestId: message.payload.requestId,
              streamId: message.payload.streamId,
              code: 'remote_window_stream_answer_failed',
              message: error instanceof Error ? error.message : 'remote window stream answer failed',
            },
          });
        });
        break;
      case 'remote-window-stream-ice-candidate':
        void deps.remoteWindowStreamRuntime.addIceCandidate(message.payload).catch((error: unknown) => {
          sendRemoteWindowMessage(connection, {
            type: 'remote-window-error',
            payload: {
              requestId: message.payload.requestId || '',
              streamId: message.payload.streamId || '',
              code: error instanceof Error && error.name.startsWith('remote_window_')
                ? error.name
                : 'remote_window_stream_candidate_failed',
              message: error instanceof Error ? error.message : 'remote window stream ICE candidate failed',
            },
          });
        });
        break;
      case 'remote-window-stream-update-focus':
        void deps.remoteWindowStreamRuntime.updateFocus(message.payload).then((payload) => {
          sendRemoteWindowMessage(connection, 'phase' in payload
            ? { type: 'remote-window-stream-focus-result', payload }
            : { type: 'remote-window-error', payload });
        }).catch((error: unknown) => {
          sendRemoteWindowMessage(connection, {
            type: 'remote-window-error',
            payload: {
              requestId: message.payload.requestId || '',
              streamId: message.payload.streamId || '',
              code: 'remote_window_stream_update_focus_failed',
              message: error instanceof Error ? error.message : 'remote window stream update focus failed',
            },
          });
        });
        break;
      case 'remote-window-stream-stop-request':
        {
          const stoppedStreamId = message.payload.streamId || '';
          void deps.remoteWindowStreamRuntime.stopStream(message.payload).then((payload) => {
            if (stoppedStreamId) {
              const streamIds = connectionRwStreams.get(connection.transportId);
              if (streamIds) {
                streamIds.delete(stoppedStreamId);
                if (streamIds.size === 0) {
                  connectionRwStreams.delete(connection.transportId);
                }
              }
            }
            sendRemoteWindowMessage(connection, 'phase' in payload
              ? { type: 'remote-window-stream-status', payload }
              : { type: 'remote-window-error', payload });
          }).catch((error: unknown) => {
          sendRemoteWindowMessage(connection, {
            type: 'remote-window-error',
            payload: {
              requestId: message.payload.requestId || '',
              streamId: message.payload.streamId || '',
              code: 'remote_window_stream_stop_failed',
              message: error instanceof Error ? error.message : 'remote window stream stop failed',
            },
          });
        });
        }
        break;
      case 'remote-window-stream-quality-request':
        void deps.remoteWindowStreamRuntime.updateStreamQuality(message.payload).then((payload) => {
          sendRemoteWindowMessage(connection, 'status' in payload
            ? { type: 'remote-window-stream-quality-result', payload }
            : { type: 'remote-window-error', payload });
        }).catch((error: unknown) => {
          sendRemoteWindowMessage(connection, {
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
        void deps.remoteWindowStreamRuntime.injectInput(message.payload, message.control).then((result) => {
          if (!result) {
            return;
          }
          sendRemoteWindowMessage(connection, {
            type: 'remote-window-input-ack',
            control: result.control,
            payload: result.payload,
          });
        }).catch((error: unknown) => {
          sendRemoteWindowMessage(connection, {
            type: 'remote-window-input-ack',
            control: {
              version: 1,
              sequence: message.control.sequence,
              accepted: false,
              retryable: false,
              duplicate: false,
              receivedAtMs: Date.now(),
              error: {
                code: 'remote_window_input_failed',
                message: error instanceof Error ? error.message : 'remote window input failed',
              },
            },
            payload: {
              streamId: message.payload.streamId,
              targetId: message.payload.targetId,
            },
          });
        });
        break;
    }
  }

  return {
    handleSessionOpen,
    handleSessionTransportConnect,
    handleMessage,
    closeConnection,
  };
}
