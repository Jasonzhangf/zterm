import {
  buildTerminalMuxCapabilities,
  buildTerminalMuxError,
  buildTerminalMuxReady,
  buildTerminalMuxServerTargetMessage,
  isTerminalMuxClientFrame,
  validateTerminalMuxChannelEnvelope,
  type TerminalMuxClientFrame,
  type TerminalMuxServerFrame,
  type TerminalTransportServerFrame,
} from '@zterm/shared/protocol';
import type { BridgeServerMessage as ServerMessage } from '@zterm/shared/protocol';
import type { SessionMirror } from './terminal-runtime-types';
import type { DaemonTransportConnection } from './terminal-transport-runtime';
import { handleMuxChannelOpenedMessageRuntime } from './terminal-message-control-runtime';
import type {
  TerminalAttachPayload,
  TerminalSession,
  TerminalSessionTransport,
  TerminalTransportConnection,
  TerminalTransportSubscriber,
} from './terminal-runtime-types';

// Mux channel management: hello/ready handshake, channel open/message/binary/
// close envelopes, target-message unwrap, and ping. Extracted from
// terminal-message-runtime so the message switch stays routing-only.
export interface TerminalMuxChannelRuntimeDeps {
  sessions: Map<string, TerminalTransportSubscriber>;
  mirrors: ReadonlyMap<string, SessionMirror>;
  sendTransportMessage: (
    transport: TerminalSessionTransport | null | undefined,
    message: TerminalTransportServerFrame,
  ) => void;
  createMuxChannelSubscriber: (
    connection: TerminalTransportConnection,
    channelId: string,
  ) => TerminalTransportSubscriber;
  ensureMuxChannels: (connection: TerminalTransportConnection) => Map<string, string>;
  releaseMuxChannelSubscriber: (
    connection: TerminalTransportConnection,
    channelId: string,
  ) => void;
  sanitizeSessionName: (input?: string) => string;
  attachTmux: (subscriber: TerminalTransportSubscriber, payload: TerminalAttachPayload) => Promise<void>;
  closeSession: (session: TerminalSession, reason: string, notifyClient?: boolean) => void;
  handleMessage: (
    connection: TerminalTransportConnection,
    raw: Buffer,
    isBinary?: boolean,
  ) => Promise<void>;
}

export interface TerminalMuxChannelRuntime {
  sendMuxFrame: (connection: TerminalTransportConnection, frame: TerminalMuxServerFrame) => void;
  handleMuxFrame: (connection: DaemonTransportConnection, candidate: unknown) => Promise<void>;
}

export function createTerminalMuxChannelRuntime(
  deps: TerminalMuxChannelRuntimeDeps,
): TerminalMuxChannelRuntime {
  function sendMuxFrame(connection: TerminalTransportConnection, frame: TerminalMuxServerFrame) {
    deps.sendTransportMessage(connection.transport, frame);
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

  async function handleMuxFrame(connection: DaemonTransportConnection, candidate: unknown) {
    if (!isTerminalMuxClientFrame(candidate)) {
      rejectMuxProtocol(connection, 'invalid terminal mux frame');
      return;
    }
    const frame = candidate as TerminalMuxClientFrame;
    switch (frame.type) {
      case 'mux-hello':
        connection.muxVersion = frame.payload.version;
        connection.muxClientInstanceId = frame.payload.clientInstanceId;
        connection.deviceId = frame.payload.deviceId;
        deps.ensureMuxChannels(connection);
        sendMuxFrame(connection, buildTerminalMuxReady({
          capabilities: buildTerminalMuxCapabilities({
            reliableInput: { version: 1 },
          }),
        }));
        return;
      case 'mux-target-message': {
        await deps.handleMessage(
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
        const channels = deps.ensureMuxChannels(connection);
        if (channels.has(frame.payload.channelId)) {
          sendMuxFrame(connection, buildTerminalMuxError(
            'mux_duplicate_channel',
            `mux channel ${frame.payload.channelId} is already open`,
            frame.payload.channelId,
          ));
          return;
        }
        const subscriber = deps.createMuxChannelSubscriber(connection, frame.payload.channelId);
        subscriber.sessionName = deps.sanitizeSessionName(frame.payload.sessionName);
        subscriber.backend = frame.payload.backend;
        subscriber.bodySubscribed = frame.payload.bodySubscribed !== false;
        try {
          handleMuxChannelOpenedMessageRuntime(
            { mirrors: deps.mirrors, sendTransportMessage: deps.sendTransportMessage } as Parameters<typeof handleMuxChannelOpenedMessageRuntime>[0],
            connection,
          );
        } catch (error) {
          const reason = `session activity control publish failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
          deps.releaseMuxChannelSubscriber(connection, frame.payload.channelId);
          subscriber.transport = null;
          deps.closeSession(subscriber, reason, false);
          sendMuxFrame(connection, {
            type: 'mux-channel-closed',
            payload: {
              channelId: frame.payload.channelId,
              reason,
              code: 'session_activity_failed',
            },
          });
          return;
        }
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
        void deps.attachTmux(subscriber, {
          sessionName: frame.payload.sessionName,
          backend: frame.payload.backend,
          cols: frame.payload.cols,
          rows: frame.payload.rows,
          widthMode: frame.payload.widthMode,
          autoCommand: frame.payload.autoCommand,
        }).catch((error: unknown) => {
          const reason = `mux channel attach failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
          console.warn(`[server] ${reason} (channelId=${frame.payload.channelId} session=${frame.payload.sessionName})`);
          // 原子清理：删除 channel registry + 关闭 subscriber + 发显式 closed。
          // 禁止保留未 attach 的 phantom channel（否则占住 target，客户端后续无法连接）。
          // attach 失败只走控制线 mux-channel-closed，不让业务 channel 错误污染控制线。
          deps.releaseMuxChannelSubscriber(connection, frame.payload.channelId);
          subscriber.transport = null;
          deps.closeSession(subscriber, reason, false);
          sendMuxFrame(connection, {
            type: 'mux-channel-closed',
            payload: {
              channelId: frame.payload.channelId,
              reason,
              code: 'mux_channel_open_failed',
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
        await deps.handleMessage(
          {
            ...createMuxChannelMessageConnection(connection, subscriber),
            muxChannelId: envelope.channelId,
          },
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
        await deps.handleMessage(
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
          deps.releaseMuxChannelSubscriber(connection, envelope.channelId);
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


  return { sendMuxFrame, handleMuxFrame };
}
