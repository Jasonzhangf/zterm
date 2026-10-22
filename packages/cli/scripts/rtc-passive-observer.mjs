import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const signalTypes = new Set([
  'rtc-init', 'rtc-offer', 'rtc-answer', 'rtc-candidate', 'rtc-error',
  'hello', 'mux-hello', 'ping', 'pong',
  'mux-ready', 'mux-target-message', 'mux-channel-open', 'mux-channel-opened',
  'mux-channel-message', 'mux-channel-binary', 'mux-channel-close',
  'mux-channel-closed', 'mux-ping', 'mux-pong', 'mux-error',
]);

export function installNativeTimingObserver({ emit, resolveFrom }) {
  const require = createRequire(resolveFrom ?? import.meta.url);
  const wsModule = require('ws');
  const wrtc = require('@roamhq/wrtc');
  const NativeWebSocket = wsModule.WebSocket;
  const NativePeer = wrtc.RTCPeerConnection;
  const start = performance.now();
  let wsCount = 0;
  let peerCount = 0;
  const report = (event, details = {}) => emit({
    ms: Math.round(performance.now() - start), event, ...details,
  });

  function messageType(data) {
    try {
      const value = JSON.parse(String(data));
      return typeof value.type === 'string' && signalTypes.has(value.type)
        ? value.type : 'other';
    } catch {
      return 'other';
    }
  }

  class ObservedWebSocket extends NativeWebSocket {
    constructor(...args) {
      super(...args);
      const ws = ++wsCount;
      report('ws.construct', { ws });
      this._req?.once('socket', (socket) => {
        report('network.socket', { ws });
        socket.once('lookup', () => report('network.lookup', { ws }));
        socket.once('connect', () => report('network.connect', { ws }));
        socket.once('secureConnect', () => report('network.secureConnect', { ws }));
      });
      this.on('open', () => report('ws.open', { ws }));
      this.on('close', () => report('ws.close', { ws }));
      this.on('error', () => report('ws.error', { ws }));
      this.on('message', (data) => report('ws.receive', { ws, type: messageType(data) }));
      const send = this.send;
      this.send = (...values) => {
        report('ws.send', { ws, type: messageType(values[0]) });
        return send.apply(this, values);
      };
    }
  }

  function ObservedPeer(...args) {
    const peer = new NativePeer(...args);
    const pc = ++peerCount;
    report('pc.construct', { pc });
    for (const event of ['iceconnectionstatechange', 'connectionstatechange', 'icegatheringstatechange']) {
      peer.addEventListener(event, () => report(event, {
        pc, ice: peer.iceConnectionState, connection: peer.connectionState,
        gathering: peer.iceGatheringState,
      }));
    }
    let relaySeen = false;
    peer.addEventListener('icecandidate', (event) => {
      if (!relaySeen && event.candidate && / typ relay(?: |$)/.test(event.candidate.candidate)) {
        relaySeen = true;
        report('pc.first-relay-candidate', { pc });
      }
    });
    for (const method of ['createOffer', 'setLocalDescription', 'setRemoteDescription', 'addIceCandidate', 'getStats']) {
      const native = peer[method];
      peer[method] = (...values) => {
        report(`${method}.begin`, { pc });
        const result = native.apply(peer, values);
        result.then(() => report(`${method}.end`, { pc }), () => report(`${method}.error`, { pc }));
        return result;
      };
    }
    const createChannel = peer.createDataChannel;
    peer.createDataChannel = (...values) => {
      const channel = createChannel.apply(peer, values);
      report('datachannel.create', { pc });
      channel.addEventListener('open', () => report('datachannel.open', { pc }));
      channel.addEventListener('close', () => report('datachannel.close', { pc }));
      return channel;
    };
    const close = peer.close;
    peer.close = (...values) => {
      report('pc.close', { pc });
      return close.apply(peer, values);
    };
    return peer;
  }
  ObservedPeer.prototype = NativePeer.prototype;
  Object.setPrototypeOf(ObservedPeer, NativePeer);

  wsModule.WebSocket = ObservedWebSocket;
  wrtc.RTCPeerConnection = ObservedPeer;

  return () => {
    wsModule.WebSocket = NativeWebSocket;
    wrtc.RTCPeerConnection = NativePeer;
  };
}
