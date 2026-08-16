import { buildTerminalMuxServerChannelMessage } from '@zterm/shared/protocol';
import type { BridgeServerMessage as ServerMessage } from '@zterm/shared/protocol';
import type {
  TerminalSessionTransport,
  TerminalTransportConnection,
  TerminalTransportSubscriber,
} from './terminal-runtime-types';

export interface TerminalChannelMuxRuntimeDeps {
  sessions: Map<string, TerminalTransportSubscriber>;
  sendText: (transport: TerminalSessionTransport | null | undefined, text: string) => void;
  defaultSessionName: string;
}

export interface TerminalChannelMuxRuntime {
  createMuxChannelSubscriber: (
    connection: TerminalTransportConnection,
    channelId: string,
  ) => TerminalTransportSubscriber;
  ensureMuxChannels: (connection: TerminalTransportConnection) => Map<string, string>;
  releaseMuxChannelSubscriber: (
    connection: TerminalTransportConnection,
    channelId: string,
  ) => boolean;
  listMuxChannelSubscriberIds: (connection: TerminalTransportConnection) => string[];
  releaseAllMuxChannelSubscribers: (connection: TerminalTransportConnection) => string[];
}

export function createTerminalChannelMuxRuntime(
  deps: TerminalChannelMuxRuntimeDeps,
): TerminalChannelMuxRuntime {
  function createMuxChannelTransport(
    connection: TerminalTransportConnection,
    channelId: string,
  ): TerminalSessionTransport {
    return {
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
          deps.sendText(connection.transport, JSON.stringify({
            type: 'mux-error',
            payload: {
              code: 'mux_protocol_invalid',
              message: 'mux channel send requires a JSON server message',
              channelId,
            },
          }));
          return;
        }
        deps.sendText(
          connection.transport,
          JSON.stringify(buildTerminalMuxServerChannelMessage(channelId, message)),
        );
      },
      close() {
        deps.sendText(connection.transport, JSON.stringify({
          type: 'mux-channel-closed',
          payload: {
            channelId,
            reason: 'server closed channel transport',
          },
        }));
      },
    };
  }

  function ensureMuxChannels(connection: TerminalTransportConnection): Map<string, string> {
    if (!connection.muxChannels) {
      connection.muxChannels = new Map();
    }
    return connection.muxChannels;
  }

  function createMuxChannelSubscriber(
    connection: TerminalTransportConnection,
    channelId: string,
  ): TerminalTransportSubscriber {
    const normalizedChannelId = channelId.trim();
    const subscriberId = `${connection.transportId}:${normalizedChannelId}`;
    const subscriber: TerminalTransportSubscriber = {
      id: subscriberId,
      transportId: connection.transportId,
      transport: createMuxChannelTransport(connection, normalizedChannelId),
      closeTransport: (reason: string) => {
        deps.sendText(connection.transport, JSON.stringify({
          type: 'mux-channel-closed',
          payload: {
            channelId: normalizedChannelId,
            reason,
          },
        }));
      },
      connectedSent: false,
      muxChannelId: normalizedChannelId,
      muxParentTransportId: connection.transportId,
      sessionName: deps.defaultSessionName,
      backend: 'tmux',
      mirrorKey: null,
      bodySubscribed: true,
      adaptiveWidthCols: null,
      adaptiveWidthHeartbeatAt: 0,
      pendingPasteImage: null,
      pendingAttachFile: null,
    };
    deps.sessions.set(subscriber.id, subscriber);
    connection.role = 'session';
    connection.boundSubscriberId = null;
    ensureMuxChannels(connection).set(normalizedChannelId, subscriber.id);
    return subscriber;
  }

  function releaseMuxChannelSubscriber(
    connection: TerminalTransportConnection,
    channelId: string,
  ): boolean {
    if (!connection.muxChannels) {
      return false;
    }
    return connection.muxChannels.delete(channelId);
  }

  function listMuxChannelSubscriberIds(connection: TerminalTransportConnection): string[] {
    return Array.from(connection.muxChannels?.values() || []);
  }

  function releaseAllMuxChannelSubscribers(connection: TerminalTransportConnection): string[] {
    const subscriberIds = listMuxChannelSubscriberIds(connection);
    connection.muxChannels?.clear();
    return subscriberIds;
  }

  return {
    createMuxChannelSubscriber,
    ensureMuxChannels,
    releaseMuxChannelSubscriber,
    listMuxChannelSubscriberIds,
    releaseAllMuxChannelSubscribers,
  };
}
