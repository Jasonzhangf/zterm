import { WebSocket, type RawData } from 'ws';
import wrtc from '@roamhq/wrtc';

const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = wrtc as unknown as {
  RTCPeerConnection: typeof globalThis.RTCPeerConnection;
  RTCSessionDescription: typeof globalThis.RTCSessionDescription;
  RTCIceCandidate: typeof globalThis.RTCIceCandidate;
};

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

export interface SignalMessage {
  type: 'rtc-init' | 'rtc-offer' | 'rtc-answer' | 'rtc-candidate' | 'rtc-close' | 'rtc-error';
  payload?: Record<string, unknown>;
}

export interface RtcServerTransport {
  id: string;
  requestOrigin: string;
  readyState: number;
  sendText(text: string): void;
  close(reason?: string): void;
}

interface TransportHandlers {
  onMessage: (transportId: string, data: RawData, isBinary: boolean) => void;
  onClose: (transportId: string, reason: string) => void;
  onError?: (transportId: string, message: string) => void;
}

interface CreateRtcBridgeServerOptions {
  onTransportOpen: (transport: RtcServerTransport) => TransportHandlers;
}

interface PeerState {
  requestOrigin: string;
  transport: RtcPeerTransport;
  peerConnection: RTCPeerConnection | null;
  ready: boolean;
  emitSignal: (message: SignalMessage) => void;
  closeSignal: (reason: string) => void;
}

class RtcPeerTransport implements RtcServerTransport {
  public id: string;

  private channel: RTCDataChannel | null = null;

  private peerConnection: RTCPeerConnection | null = null;

  private handlers: TransportHandlers | null = null;

  public constructor(
    id: string,
    public readonly requestOrigin: string,
  ) {
    this.id = id;
  }

  public get readyState() {
    if (this.channel?.readyState === 'open') {
      return OPEN;
    }
    if (this.channel?.readyState === 'closing') {
      return CLOSING;
    }
    if (this.channel?.readyState === 'closed') {
      return CLOSED;
    }
    return CONNECTING;
  }

  public attach(peerConnection: RTCPeerConnection, channel: RTCDataChannel, handlers: TransportHandlers) {
    this.peerConnection = peerConnection;
    this.channel = channel;
    this.handlers = handlers;
    channel.binaryType = 'arraybuffer';
    channel.onmessage = (event) => {
      const value = event.data;
      if (typeof value === 'string') {
        handlers.onMessage(this.id, Buffer.from(value, 'utf8'), false);
        return;
      }
      if (value instanceof ArrayBuffer) {
        handlers.onMessage(this.id, Buffer.from(value), true);
        return;
      }
      if (ArrayBuffer.isView(value)) {
        handlers.onMessage(this.id, Buffer.from(value.buffer, value.byteOffset, value.byteLength), true);
        return;
      }
      handlers.onMessage(this.id, Buffer.from(String(value)), false);
    };
    channel.onclose = () => {
      handlers.onClose(this.id, 'rtc data channel closed');
    };
    channel.onerror = () => {
      handlers.onError?.(this.id, 'rtc data channel error');
    };
  }

  public sendText(text: string) {
    this.channel?.send(text);
  }

  public close(reason = 'rtc close') {
    try {
      this.channel?.close();
    } catch (error) {
      console.warn('[rtc-bridge] Failed to close RTC data channel:', error);
    }
    try {
      this.peerConnection?.close();
    } catch (error) {
      console.warn('[rtc-bridge] Failed to close RTC peer connection:', error);
    }
    this.handlers?.onClose(this.id, reason);
  }
}

export function createRtcBridgeServer(options: CreateRtcBridgeServerOptions) {
  const peers = new Map<string, PeerState>();

  function upsertPeerTransport(
    peerId: string,
    requestOrigin: string,
    emitSignal: (message: SignalMessage) => void,
    closeSignal: (reason: string) => void,
  ) {
    const existing = peers.get(peerId);
    if (existing) {
      existing.emitSignal = emitSignal;
      existing.closeSignal = closeSignal;
      return existing;
    }
    const created: PeerState = {
      requestOrigin,
      transport: new RtcPeerTransport(peerId, requestOrigin),
      peerConnection: null,
      ready: false,
      emitSignal,
      closeSignal,
    };
    peers.set(peerId, created);
    return created;
  }

  function closePeer(peerId: string, reason: string) {
    const peer = peers.get(peerId);
    if (!peer) {
      return;
    }
    try {
      peer.peerConnection?.close();
    } catch (error) {
      console.warn(`[rtc-bridge] Failed to close peer connection for ${peerId}:`, error);
    }
    try {
      peer.closeSignal(reason);
    } catch (error) {
      console.warn(`[rtc-bridge] Failed to close signal socket for ${peerId}:`, error);
    }
    peers.delete(peerId);
  }

  async function handleSignalMessage(input: {
    peerId: string;
    requestOrigin: string;
    message: SignalMessage;
    emitSignal: (message: SignalMessage) => void;
    closeSignal: (reason: string) => void;
  }) {
    const peer = upsertPeerTransport(input.peerId, input.requestOrigin, input.emitSignal, input.closeSignal);
    const { message } = input;

    if (message.type === 'rtc-close') {
      closePeer(input.peerId, 'rtc close');
      return;
    }

    if (message.type === 'rtc-init') {
      if (peer.peerConnection) {
        return;
      }
      const iceServers = Array.isArray(message.payload?.iceServers) ? message.payload?.iceServers as RTCIceServer[] : [];
      const peerConnection = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: 'all',
      });
      peer.peerConnection = peerConnection;
      peerConnection.onicecandidate = (event) => {
        if (!event.candidate) {
          return;
        }
        peer.emitSignal({
          type: 'rtc-candidate',
          payload: event.candidate.toJSON() as Record<string, unknown>,
        });
      };
      peerConnection.ondatachannel = (event) => {
        const channel = event.channel;
        channel.onopen = () => {
          if (peer.ready || !peer.peerConnection) {
            return;
          }
          peer.ready = true;
          const handlers = options.onTransportOpen(peer.transport);
          peer.transport.attach(peer.peerConnection, channel, handlers);
        };
      };
      return;
    }

    if (!peer.peerConnection) {
      peer.emitSignal({
        type: 'rtc-error',
        payload: { message: 'rtc peer not initialized' },
      });
      return;
    }

    if (message.type === 'rtc-offer') {
      const sdp = typeof message.payload?.sdp === 'string' ? message.payload.sdp : '';
      await peer.peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
      const answer = await peer.peerConnection.createAnswer();
      await peer.peerConnection.setLocalDescription(answer);
      peer.emitSignal({
        type: 'rtc-answer',
        payload: { sdp: answer.sdp, type: answer.type },
      });
      return;
    }

    if (message.type === 'rtc-candidate' && message.payload?.candidate) {
      await peer.peerConnection.addIceCandidate(new RTCIceCandidate(message.payload as RTCIceCandidateInit));
    }
  }

  return {
    handleSignalConnection(signalSocket: WebSocket, requestOrigin: string) {
      const peerId = globalThis.crypto?.randomUUID?.() || `rtc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const emitSignal = (message: SignalMessage) => {
        if (signalSocket.readyState !== WebSocket.OPEN) {
          return;
        }
        signalSocket.send(JSON.stringify(message));
      };
      const closeSignal = (reason: string) => {
        try {
          if (signalSocket.readyState < WebSocket.CLOSING) {
            signalSocket.close(1000, reason);
          }
        } catch (error) {
          console.warn('[rtc-bridge] Failed to close signaling websocket:', error);
        }
      };

      signalSocket.on('message', async (rawData) => {
        try {
          const message = JSON.parse(String(rawData)) as SignalMessage;
          await handleSignalMessage({
            peerId,
            requestOrigin,
            message,
            emitSignal,
            closeSignal,
          });
        } catch (error) {
          emitSignal({
            type: 'rtc-error',
            payload: { message: error instanceof Error ? error.message : 'rtc signaling parse error' },
          });
        }
      });

      signalSocket.on('close', () => {
        closePeer(peerId, 'rtc signaling websocket closed');
      });

      signalSocket.on('error', () => {
        closePeer(peerId, 'rtc signaling websocket error');
      });
    },
    async handleRelaySignal(
      peerId: string,
      requestOrigin: string,
      message: SignalMessage,
      emitSignal: (message: SignalMessage) => void,
      closeSignal?: (reason: string) => void,
    ) {
      await handleSignalMessage({
        peerId,
        requestOrigin,
        message,
        emitSignal,
        closeSignal: closeSignal || (() => undefined),
      });
    },
    closeRelayPeer(peerId: string, reason: string) {
      closePeer(peerId, reason);
    },
    dispose() {
      for (const peerId of peers.keys()) {
        closePeer(peerId, 'rtc bridge disposed');
      }
    },
  };
}
