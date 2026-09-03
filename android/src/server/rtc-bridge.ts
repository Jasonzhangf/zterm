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
  bufferedAmount?: number;
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
  stale: boolean;
  staleTimer: ReturnType<typeof setTimeout> | null;
  emitSignal: (message: SignalMessage) => void;
  closeSignal: (reason: string) => void;
  signalChain: Promise<void>;
  offerAccepted: boolean;
  pendingIceCandidates: RTCIceCandidateInit[];
}

function resolveRtcIceTransportPolicy(value: unknown): RTCIceTransportPolicy {
  return value === 'relay' ? 'relay' : 'all';
}

export function buildRtcPeerConnectionConfig(payload?: Record<string, unknown>): RTCConfiguration {
  return {
    iceServers: Array.isArray(payload?.iceServers) ? payload.iceServers as RTCIceServer[] : [],
    iceTransportPolicy: resolveRtcIceTransportPolicy(payload?.iceTransportPolicy),
  };
}

class RtcPeerTransport implements RtcServerTransport {
  public id: string;

  private channel: RTCDataChannel | null = null;

  private peerConnection: RTCPeerConnection | null = null;

  private handlers: TransportHandlers | null = null;

  private closed = false;

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

  public get bufferedAmount() {
    return Math.max(0, Math.floor(this.channel?.bufferedAmount || 0));
  }

  public attach(peerConnection: RTCPeerConnection, channel: RTCDataChannel, handlers: TransportHandlers) {
    this.closed = false;
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
    if (this.closed) {
      return;
    }
    this.closed = true;
    const channel = this.channel;
    const peerConnection = this.peerConnection;
    const handlers = this.handlers;
    this.channel = null;
    this.peerConnection = null;
    this.handlers = null;
    if (channel) {
      channel.onmessage = null;
      channel.onclose = null;
      channel.onerror = null;
    }
    try {
      channel?.close();
    } catch (error) {
      console.warn('[rtc-bridge] Failed to close RTC data channel:', error);
    }
    try {
      peerConnection?.close();
    } catch (error) {
      console.warn('[rtc-bridge] Failed to close RTC peer connection:', error);
    }
    handlers?.onClose(this.id, reason);
  }
}

export function createRtcBridgeServer(options: CreateRtcBridgeServerOptions) {
  const peers = new Map<string, PeerState>();
  const PEER_SIGNAL_GRACE_MS = 30_000;

  function upsertPeerTransport(
    peerId: string,
    requestOrigin: string,
    emitSignal: (message: SignalMessage) => void,
    closeSignal: (reason: string) => void,
  ) {
    const existing = peers.get(peerId);
    if (existing) {
      clearPeerStale(existing);
      existing.emitSignal = emitSignal;
      existing.closeSignal = closeSignal;
      return existing;
    }
    const created: PeerState = {
      requestOrigin,
      transport: new RtcPeerTransport(peerId, requestOrigin),
      peerConnection: null,
      ready: false,
      stale: false,
      staleTimer: null,
      emitSignal,
      closeSignal,
      signalChain: Promise.resolve(),
      offerAccepted: false,
      pendingIceCandidates: [],
    };
    peers.set(peerId, created);
    return created;
  }

  function markPeerStale(peerId: string, reason: string) {
    const peer = peers.get(peerId);
    if (!peer) {
      return;
    }
    peer.stale = true;
    if (peer.staleTimer) {
      clearTimeout(peer.staleTimer);
    }
    peer.staleTimer = setTimeout(() => {
      peer.staleTimer = null;
      closePeer(peerId, `signal grace expired: ${reason}`);
    }, PEER_SIGNAL_GRACE_MS);
    peer.staleTimer.unref?.();
  }

  function clearPeerStale(peer: PeerState) {
    peer.stale = false;
    if (peer.staleTimer) {
      clearTimeout(peer.staleTimer);
      peer.staleTimer = null;
    }
  }

  function closePeer(peerId: string, reason: string) {
    const peer = peers.get(peerId);
    if (!peer) {
      return;
    }
    clearPeerStale(peer);
    peer.transport.close(reason);
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

  function initializePeerConnection(peer: PeerState, payload?: Record<string, unknown>) {
    if (peer.peerConnection || peer.ready) {
      peer.transport.close('rtc peer replaced by new init');
    }
    peer.peerConnection = null;
    peer.ready = false;
    peer.offerAccepted = false;
    peer.pendingIceCandidates = [];
    const peerConnection = new RTCPeerConnection(buildRtcPeerConnectionConfig(payload));
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
    // ICE connection timeout: fail after 15 seconds if not connected
    const connectionTimeoutMs = 15000;
    const connectionTimeout = globalThis.setTimeout(() => {
      if (!peer.ready && peer.peerConnection === peerConnection) {
        peer.emitSignal({
          type: 'rtc-error',
          payload: { message: 'rtc ice connection timeout' },
        });
        peer.transport.close('rtc ice connection timeout');
      }
    }, connectionTimeoutMs);
    peerConnection.oniceconnectionstatechange = () => {
      const state = peerConnection.iceConnectionState;
      // Clear timeout once we have any state (connected, failed, closed, etc.)
      if (state !== 'new' && state !== 'checking') {
        globalThis.clearTimeout(connectionTimeout);
      }
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        if (!peer.ready) {
          peer.emitSignal({
            type: 'rtc-error',
            payload: { message: `rtc ice connection ${state}` },
          });
          peer.transport.close(`rtc ice connection ${state}`);
        }
      }
    };
  }

  async function flushPendingIceCandidates(peer: PeerState) {
    if (!peer.peerConnection || peer.pendingIceCandidates.length === 0) {
      return;
    }
    const pending = peer.pendingIceCandidates.splice(0);
    for (const candidate of pending) {
      await peer.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  async function processSignalMessage(input: {
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
      initializePeerConnection(peer, message.payload);
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
      if (peer.offerAccepted) {
        return;
      }
      peer.offerAccepted = true;
      const sdp = typeof message.payload?.sdp === 'string' ? message.payload.sdp : '';
      await peer.peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
      const answer = await peer.peerConnection.createAnswer();
      await peer.peerConnection.setLocalDescription(answer);
      await flushPendingIceCandidates(peer);
      peer.emitSignal({
        type: 'rtc-answer',
        payload: { sdp: answer.sdp, type: answer.type },
      });
      return;
    }

    if (message.type === 'rtc-candidate' && message.payload?.candidate) {
      const candidate = message.payload as RTCIceCandidateInit;
      if (!peer.offerAccepted || !peer.peerConnection.remoteDescription) {
        peer.pendingIceCandidates.push(candidate);
        return;
      }
      await peer.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  async function handleSignalMessage(input: {
    peerId: string;
    requestOrigin: string;
    message: SignalMessage;
    emitSignal: (message: SignalMessage) => void;
    closeSignal: (reason: string) => void;
  }) {
    const peer = upsertPeerTransport(input.peerId, input.requestOrigin, input.emitSignal, input.closeSignal);
    const next = peer.signalChain
      .catch(() => undefined)
      .then(async () => {
        try {
          await processSignalMessage(input);
        } catch (error) {
          peer.emitSignal({
            type: 'rtc-error',
            payload: { message: error instanceof Error ? error.message : 'rtc signaling error' },
          });
        }
      });
    peer.signalChain = next.catch(() => undefined);
    await next;
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
        markPeerStale(peerId, 'rtc signaling websocket closed');
      });

      signalSocket.on('error', () => {
        markPeerStale(peerId, 'rtc signaling websocket error');
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
