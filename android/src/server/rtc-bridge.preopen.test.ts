import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRtcBridgeServer } from './rtc-bridge';

interface MockPeerConnection {
  id: number;
  config: unknown;
  closed: boolean;
  closeCalls: number;
  iceConnectionState: string;
  onicecandidate: ((event: unknown) => void) | null;
  ondatachannel: ((event: unknown) => void) | null;
  oniceconnectionstatechange: (() => void) | null;
  close(): void;
  setRemoteDescription(_description: unknown): Promise<void>;
  createAnswer(): Promise<{ type: string; sdp: string }>;
  setLocalDescription(_description: unknown): Promise<void>;
  addIceCandidate(_candidate: unknown): Promise<void>;
}

const wrtcState = vi.hoisted(() => {
  const instances: MockPeerConnection[] = [];
  let nextId = 0;

  class MockRTCPeerConnection implements MockPeerConnection {
    public readonly id: number;

    public readonly config: unknown;

    public closed = false;

    public closeCalls = 0;

    public iceConnectionState = 'new';

    public onicecandidate: ((event: unknown) => void) | null = null;

    public ondatachannel: ((event: unknown) => void) | null = null;

    public oniceconnectionstatechange: (() => void) | null = null;

    public constructor(config: unknown) {
      this.id = nextId;
      nextId += 1;
      this.config = config;
      instances.push(this);
    }

    public close() {
      this.closeCalls += 1;
      if (this.closed) {
        return;
      }
      this.closed = true;
      this.iceConnectionState = 'closed';
      this.oniceconnectionstatechange?.();
    }

    public async setRemoteDescription(_description: unknown): Promise<void> {
      return undefined;
    }

    public async createAnswer(): Promise<{ type: string; sdp: string }> {
      return { type: 'answer', sdp: 'mock-answer-sdp' };
    }

    public async setLocalDescription(_description: unknown): Promise<void> {
      return undefined;
    }

    public async addIceCandidate(_candidate: unknown): Promise<void> {
      return undefined;
    }
  }

  return { instances, MockRTCPeerConnection };
});

vi.mock('@roamhq/wrtc', () => ({
  default: {
    RTCPeerConnection: wrtcState.MockRTCPeerConnection,
    RTCSessionDescription: class MockRTCSessionDescription {
      public constructor(public readonly init: unknown) {}
    },
    RTCIceCandidate: class MockRTCIceCandidate {
      public constructor(public readonly init: unknown) {}
    },
  },
}));

describe('rtc-bridge preopen native peer lifecycle', () => {
  beforeEach(() => {
    wrtcState.instances.length = 0;
  });

  function createBridge() {
    const emitSignal = vi.fn();
    const closeSignal = vi.fn();
    const bridge = createRtcBridgeServer({
      onTransportOpen: () => ({
        onMessage: () => undefined,
        onClose: () => undefined,
      }),
    });
    return { bridge, emitSignal, closeSignal };
  }

  function cleanup(bridge: ReturnType<typeof createRtcBridgeServer>) {
    bridge.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
  }

  it('closes the replaced native peer connection when rtc-init re-inits before the data channel opens', async () => {
    vi.useFakeTimers();
    const { bridge, emitSignal, closeSignal } = createBridge();
    try {
      await bridge.handleRelaySignal('test-peer', 'local', { type: 'rtc-init', payload: {} }, emitSignal, closeSignal);
      await bridge.handleRelaySignal('test-peer', 'local', { type: 'rtc-init', payload: {} }, emitSignal, closeSignal);

      expect(wrtcState.instances.length).toBe(2);
      expect(wrtcState.instances[0]!.closed).toBe(true);
      expect(wrtcState.instances[0]!.closeCalls).toBe(1);
      expect(wrtcState.instances[1]!.closeCalls).toBe(0);
      expect(closeSignal).not.toHaveBeenCalled();
    } finally {
      cleanup(bridge);
    }
  });

  it('closes the pending native peer connection when the 30s connection timeout fires', async () => {
    vi.useFakeTimers();
    const { bridge, emitSignal, closeSignal } = createBridge();
    try {
      await bridge.handleRelaySignal('test-peer', 'local', { type: 'rtc-init', payload: {} }, emitSignal, closeSignal);
      expect(wrtcState.instances.length).toBe(1);

      vi.advanceTimersByTime(30_000);

      expect(wrtcState.instances[0]!.closed).toBe(true);
      expect(wrtcState.instances[0]!.closeCalls).toBe(1);
      expect(emitSignal).toHaveBeenCalledTimes(1);
      bridge.closeRelayPeer('test-peer', 'after timeout');
      expect(wrtcState.instances[0]!.closeCalls).toBe(1);
    } finally {
      cleanup(bridge);
    }
  });

  it('closeRelayPeer closes the current pending native peer connection (positive control)', async () => {
    vi.useFakeTimers();
    const { bridge, emitSignal, closeSignal } = createBridge();
    try {
      await bridge.handleRelaySignal('test-peer', 'local', { type: 'rtc-init', payload: {} }, emitSignal, closeSignal);
      expect(wrtcState.instances.length).toBe(1);

      bridge.closeRelayPeer('test-peer', 'test cleanup');

      expect(wrtcState.instances[0]!.closed).toBe(true);
      expect(wrtcState.instances[0]!.closeCalls).toBe(1);
      expect(closeSignal).toHaveBeenCalledTimes(1);
      bridge.dispose();
      expect(wrtcState.instances[0]!.closeCalls).toBe(1);
    } finally {
      cleanup(bridge);
    }
  });

  it.each(['failed', 'disconnected', 'closed'])('releases a pending peer once on ICE %s', async (state) => {
    vi.useFakeTimers();
    const { bridge, emitSignal, closeSignal } = createBridge();
    try {
      await bridge.handleRelaySignal('test-peer', 'local', { type: 'rtc-init' }, emitSignal, closeSignal);
      const peer = wrtcState.instances[0]!;
      const savedCallback = peer.oniceconnectionstatechange!;
      peer.iceConnectionState = state;
      savedCallback();
      savedCallback();
      bridge.closeRelayPeer('test-peer', 'cleanup');
      expect(peer.closeCalls).toBe(1);
      expect(emitSignal).toHaveBeenCalledTimes(1);
    } finally { cleanup(bridge); }
  });

  it('ignores released callbacks and a deferred offer after a replacement', async () => {
    vi.useFakeTimers();
    const { bridge, emitSignal, closeSignal } = createBridge();
    try {
      await bridge.handleRelaySignal('test-peer', 'local', { type: 'rtc-init' }, emitSignal, closeSignal);
      const old = wrtcState.instances[0]!;
      const candidate = old.onicecandidate!;
      const channel = old.ondatachannel!;
      const state = old.oniceconnectionstatechange!;
      let settleRemote!: () => void;
      let started!: () => void;
      const remoteStarted = new Promise<void>((resolve) => { started = resolve; });
      old.setRemoteDescription = () => {
        started();
        return new Promise<void>((resolve) => { settleRemote = resolve; });
      };
      const pendingOffer = bridge.handleRelaySignal('test-peer', 'local', {
        type: 'rtc-offer', payload: { sdp: 'deferred' },
      }, emitSignal, closeSignal);
      await remoteStarted;
      vi.advanceTimersByTime(10);
      bridge.closeRelayPeer('test-peer', 'replace');
      await bridge.handleRelaySignal('test-peer', 'local', { type: 'rtc-init' }, emitSignal, closeSignal);
      const next = wrtcState.instances[1]!;
      candidate({ candidate: { toJSON: () => ({ candidate: 'old' }) } });
      const staleChannel = { close: vi.fn() };
      channel({ channel: staleChannel });
      state();
      settleRemote();
      await pendingOffer;
      vi.advanceTimersByTime(29_990);
      expect(old.closeCalls).toBe(1);
      expect(next.closeCalls).toBe(0);
      expect(staleChannel.close).toHaveBeenCalledTimes(1);
      expect(emitSignal).not.toHaveBeenCalled();
    } finally { cleanup(bridge); }
  });

  it('closing one pending peer leaves another peer owned and usable', async () => {
    vi.useFakeTimers();
    const { bridge, emitSignal, closeSignal } = createBridge();
    try {
      await bridge.handleRelaySignal('first', 'local', { type: 'rtc-init' }, emitSignal, closeSignal);
      await bridge.handleRelaySignal('second', 'local', { type: 'rtc-init' }, emitSignal, closeSignal);
      bridge.closeRelayPeer('first', 'close one');
      expect(wrtcState.instances[0]!.closeCalls).toBe(1);
      expect(wrtcState.instances[1]!.closeCalls).toBe(0);
      await bridge.handleRelaySignal('second', 'local', { type: 'rtc-offer', payload: { sdp: 'offer' } }, emitSignal, closeSignal);
      expect(emitSignal).toHaveBeenCalledWith({ type: 'rtc-answer', payload: { type: 'answer', sdp: 'mock-answer-sdp' } });
    } finally { cleanup(bridge); }
  });
});
