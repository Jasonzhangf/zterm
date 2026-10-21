import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import wrtc from '@roamhq/wrtc';
import { createRtcBridgeServer } from './rtc-bridge';

const nativeObservation = vi.hoisted(() => {
  type ObservedRecord = {
    id: number;
    client: boolean;
    closeCount: number;
  };
  type ObservedWaiter = {
    serverCount: number;
    resolve: (records: ObservedRecord[]) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };

  const records: ObservedRecord[] = [];
  const ownedPeers: Array<{ peer: { close(): void }; record: ObservedRecord }> = [];
  const byPeer = new WeakMap<object, ObservedRecord>();
  let waiters: ObservedWaiter[] = [];
  let nextId = 1;

  function countServerRecords() {
    return records.filter((record) => !record.client).length;
  }

  function settleWaiters() {
    const serverCount = countServerRecords();
    waiters = waiters.filter((waiter) => {
      if (serverCount < waiter.serverCount) {
        return true;
      }
      clearTimeout(waiter.timer);
      waiter.resolve(records);
      return false;
    });
  }

  return {
    clientConstructionDepth: 0,
    get records() {
      return records;
    },
    serverRecords() {
      return records.filter((record) => !record.client);
    },
    record(client: boolean, peer: { close(): void }) {
      const record: ObservedRecord = {
        id: nextId,
        client,
        closeCount: 0,
      };
      nextId += 1;
      records.push(record);
      ownedPeers.push({ peer, record });
      byPeer.set(peer, record);
      settleWaiters();
      return record;
    },
    waitForServerCount(target: number, timeoutMs: number) {
      if (countServerRecords() >= target) {
        return Promise.resolve(records);
      }
      return new Promise<ObservedRecord[]>((resolve, reject) => {
        const waiter: ObservedWaiter = {
          serverCount: target,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters = waiters.filter((candidate) => candidate !== waiter);
            reject(new Error(
              `timed out waiting for ${target} native server peers; observed ${countServerRecords()}`,
            ));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    closeUnreleased() {
      for (const { peer, record } of ownedPeers) {
        if (record.closeCount === 0) peer.close();
      }
    },
    reset() {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('native observation reset'));
      }
      waiters = [];
      records.length = 0;
      ownedPeers.length = 0;
      nextId = 1;
    },
  };
});

// Assertions run before this cleanup, so a leaked peer still fails the test.
afterEach(() => nativeObservation.closeUnreleased());

vi.mock('@roamhq/wrtc', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof wrtc }>();
  const actualDefault = actual.default as unknown as {
    RTCPeerConnection: new (configuration?: RTCConfiguration) => RTCPeerConnection;
    [key: string]: unknown;
  };
  const RealPeerConnection = actualDefault.RTCPeerConnection;
  const ObservedPeerConnection = new Proxy(RealPeerConnection, {
    construct(target, argumentsList, newTarget) {
      const actualNewTarget = newTarget === ObservedPeerConnection ? target : newTarget;
      const peer = Reflect.construct(target, argumentsList, actualNewTarget) as RTCPeerConnection;
      const record = nativeObservation.record(
        nativeObservation.clientConstructionDepth > 0,
        peer,
      );
      const realClose = peer.close.bind(peer);
      Object.defineProperty(peer, 'close', {
        configurable: true,
        writable: true,
        value: () => {
          record.closeCount += 1;
          realClose();
        },
      });
      return peer;
    },
  });

  return {
    ...actual,
    default: {
      ...actualDefault,
      RTCPeerConnection: ObservedPeerConnection,
    },
  };
});

const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = wrtc as unknown as {
  RTCPeerConnection: typeof globalThis.RTCPeerConnection;
  RTCSessionDescription: typeof globalThis.RTCSessionDescription;
  RTCIceCandidate: typeof globalThis.RTCIceCandidate;
};

type SignalEnvelope = {
  type: string;
  payload?: Record<string, unknown>;
};

type SignalWaiter = {
  predicate: (message: SignalEnvelope) => boolean;
  resolve: (message: SignalEnvelope) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

class SignalClient {
  private readonly queue: SignalEnvelope[] = [];

  private readonly waiters: SignalWaiter[] = [];

  private readonly listeners = new Set<(message: SignalEnvelope) => void>();

  private closeReason: string | null = null;

  public constructor(public readonly socket: WebSocket) {
    socket.on('message', (rawData) => {
      let message: SignalEnvelope;
      try {
        message = JSON.parse(String(rawData)) as SignalEnvelope;
      } catch {
        return;
      }
      this.queue.push(message);
      this.settleWaiters();
      for (const listener of this.listeners) {
        listener(message);
      }
    });
    socket.on('close', (code, reason) => {
      this.closeReason = `signaling socket closed (${code}): ${reason.toString()}`;
      this.rejectWaiters(new Error(this.closeReason));
    });
    socket.on('error', (error) => {
      this.closeReason = `signaling socket error: ${error.message}`;
      this.rejectWaiters(new Error(this.closeReason));
    });
  }

  public static async open(url: string) {
    const socket = new WebSocket(url);
    const client = new SignalClient(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out opening signaling socket')), 5000);
      socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return client;
  }

  public send(message: SignalEnvelope) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`cannot send signaling message: ${this.closeReason || 'socket is not open'}`);
    }
    this.socket.send(JSON.stringify(message));
  }

  public subscribe(listener: (message: SignalEnvelope) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public waitFor(
    predicate: (message: SignalEnvelope) => boolean,
    timeoutMs: number,
    label: string,
  ) {
    const queuedIndex = this.queue.findIndex(predicate);
    if (queuedIndex >= 0) {
      return Promise.resolve(this.queue.splice(queuedIndex, 1)[0]);
    }
    if (this.socket.readyState === WebSocket.CLOSED) {
      return Promise.reject(new Error(`${label}: ${this.closeReason || 'signaling socket closed'}`));
    }
    return new Promise<SignalEnvelope>((resolve, reject) => {
      const waiter: SignalWaiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          reject(new Error(`timed out waiting for ${label}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  public async close() {
    if (this.socket.readyState === WebSocket.CLOSED) {
      return;
    }
    const closed = new Promise<void>((resolve) => {
      this.socket.once('close', () => resolve());
    });
    try {
      this.socket.close();
    } catch {
      // The close event or the bounded wait below settles cleanup.
    }
    await Promise.race([
      closed,
      new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    ]);
  }

  private settleWaiters() {
    for (const waiter of [...this.waiters]) {
      const index = this.queue.findIndex(waiter.predicate);
      if (index < 0) {
        continue;
      }
      const message = this.queue.splice(index, 1)[0];
      clearTimeout(waiter.timer);
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  }

  private rejectWaiters(error: Error) {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

type DataWaiter = {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

class EchoPeer {
  private readonly messages: string[] = [];

  private readonly dataWaiters: DataWaiter[] = [];

  private readonly unsubscribe: () => void;

  private signalChain = Promise.resolve();

  private failure: Error | null = null;

  private openResolve: (() => void) | null = null;

  private openReject: ((error: Error) => void) | null = null;

  private openTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(
    public readonly label: string,
    public readonly signal: SignalClient,
    public readonly peerConnection: RTCPeerConnection,
    public readonly dataChannel: RTCDataChannel,
  ) {
    this.unsubscribe = signal.subscribe((message) => {
      this.signalChain = this.signalChain
        .then(() => this.handleSignalMessage(message))
        .catch((error: unknown) => {
          this.fail(error instanceof Error ? error : new Error(String(error)));
        });
    });
    peerConnection.onicecandidate = (event) => {
      if (!event.candidate || signal.socket.readyState !== WebSocket.OPEN) {
        return;
      }
      signal.send({
        type: 'rtc-candidate',
        payload: event.candidate.toJSON() as Record<string, unknown>,
      });
    };
    dataChannel.onmessage = (event) => {
      this.handleData(String(event.data));
    };
    dataChannel.onerror = () => {
      this.fail(new Error(`${label} data channel error`));
    };
  }

  public async negotiate(options: { sendInit: boolean; timeoutMs?: number }) {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const opened = new Promise<void>((resolve, reject) => {
      this.openResolve = resolve;
      this.openReject = reject;
      this.openTimer = setTimeout(() => {
        reject(new Error(`${this.label}: timed out opening data channel`));
      }, timeoutMs);
    });
    this.dataChannel.onopen = () => {
      if (this.openTimer) {
        clearTimeout(this.openTimer);
        this.openTimer = null;
      }
      this.openResolve?.();
      this.openResolve = null;
      this.openReject = null;
    };

    if (options.sendInit) {
      this.signal.send({ type: 'rtc-init', payload: { iceServers: [] } });
    }
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    this.signal.send({
      type: 'rtc-offer',
      payload: { type: offer.type, sdp: offer.sdp },
    });
    await opened;
  }

  public sendAndWait(text: string, timeoutMs = 10_000) {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    const queuedIndex = this.messages.indexOf(text);
    if (queuedIndex >= 0) {
      this.messages.splice(queuedIndex, 1);
      return Promise.resolve(text);
    }
    return new Promise<string>((resolve, reject) => {
      const waiter: DataWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.dataWaiters.indexOf(waiter);
          if (index >= 0) {
            this.dataWaiters.splice(index, 1);
          }
          reject(new Error(`${this.label}: timed out waiting for echo ${text}`));
        }, timeoutMs),
      };
      this.dataWaiters.push(waiter);
      this.dataChannel.send(text);
    });
  }

  public dispose() {
    this.unsubscribe();
    if (this.openTimer) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
  }

  private async handleSignalMessage(message: SignalEnvelope) {
    if (message.type === 'rtc-answer') {
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription({
        type: 'answer',
        sdp: typeof message.payload?.sdp === 'string' ? message.payload.sdp : '',
      }));
      return;
    }
    if (message.type === 'rtc-candidate' && message.payload) {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(
        message.payload as RTCIceCandidateInit,
      ));
      return;
    }
    if (message.type === 'rtc-error') {
      throw new Error(
        typeof message.payload?.message === 'string'
          ? message.payload.message
          : `${this.label}: rtc error`,
      );
    }
  }

  private handleData(value: string) {
    const waiter = this.dataWaiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(value);
      return;
    }
    this.messages.push(value);
  }

  private fail(error: Error) {
    if (this.failure) {
      return;
    }
    this.failure = error;
    if (this.openTimer) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    this.openReject?.(error);
    this.openResolve = null;
    this.openReject = null;
    for (const waiter of this.dataWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

class TestResources {
  private readonly signalClients: SignalClient[] = [];

  private readonly peers: EchoPeer[] = [];

  private readonly peerConnections: RTCPeerConnection[] = [];

  private readonly dataChannels: RTCDataChannel[] = [];

  public async openSignal(url: string) {
    const signal = await SignalClient.open(url);
    this.signalClients.push(signal);
    return signal;
  }

  public createEchoPeer(signal: SignalClient, label: string) {
    nativeObservation.clientConstructionDepth += 1;
    let peerConnection: RTCPeerConnection;
    try {
      peerConnection = new RTCPeerConnection({ iceServers: [] });
    } finally {
      nativeObservation.clientConstructionDepth -= 1;
    }
    const dataChannel = peerConnection.createDataChannel(`zterm-${label}`, { ordered: true });
    this.peerConnections.push(peerConnection);
    this.dataChannels.push(dataChannel);
    const peer = new EchoPeer(label, signal, peerConnection, dataChannel);
    this.peers.push(peer);
    return peer;
  }

  public async dispose() {
    for (const peer of this.peers) {
      peer.dispose();
    }
    for (const dataChannel of this.dataChannels) {
      try {
        dataChannel.close();
      } catch (error) {
        console.warn('[rtc-bridge.native-lifecycle.test] Failed to close data channel:', error);
      }
    }
    for (const peerConnection of this.peerConnections) {
      try {
        peerConnection.close();
      } catch (error) {
        console.warn('[rtc-bridge.native-lifecycle.test] Failed to close peer connection:', error);
      }
    }
    for (const signal of this.signalClients) {
      await signal.close();
    }
  }
}

type BridgeHarness = {
  signalUrl: string;
  waitForTransportCount: (count: number) => Promise<void>;
  close: () => Promise<void>;
};

async function startBridgeHarness(): Promise<BridgeHarness> {
  const httpServer: Server = createServer();
  const signalWss = new WebSocketServer({ noServer: true });
  let opened = 0;
  const openWaiters = new Set<{ count: number; resolve: () => void }>();
  const rtcBridge = createRtcBridgeServer({
    onTransportOpen: (transport) => {
      opened += 1;
      for (const waiter of openWaiters) {
        if (opened >= waiter.count) waiter.resolve();
      }
      return {
        onMessage: (_transportId, data) => transport.sendText(data.toString('utf8')),
        onClose: () => undefined,
      };
    },
  });

  httpServer.on('upgrade', (request, socket, head) => {
    if (new URL(request.url || '/', 'ws://127.0.0.1').pathname !== '/signal') {
      socket.destroy();
      return;
    }
    signalWss.handleUpgrade(request, socket, head, (ws) => {
      rtcBridge.handleSignalConnection(ws, 'ws://127.0.0.1');
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      const events = httpServer as typeof httpServer & {
        removeListener(event: 'error', listener: (error: Error) => void): void;
      };
      events.removeListener('error', reject);
      resolve();
    });
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    rtcBridge.dispose();
    signalWss.close();
    httpServer.close();
    throw new Error('failed to resolve loopback test server address');
  }

  return {
    signalUrl: `ws://127.0.0.1:${address.port}/signal`,
    waitForTransportCount(count) {
      if (opened >= count) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          openWaiters.delete(waiter);
          reject(new Error('server transport did not open'));
        }, 5000);
        const waiter = { count, resolve: () => {
          clearTimeout(timer);
          openWaiters.delete(waiter);
          resolve();
        } };
        openWaiters.add(waiter);
      });
    },
    async close() {
      rtcBridge.dispose();
      for (const client of signalWss.clients) {
        client.close();
      }
      await new Promise<void>((resolve) => {
        signalWss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
}

describe('rtc-bridge native lifecycle', () => {
  beforeEach(() => {
    nativeObservation.reset();
  });

  it('closes a replaced pending native peer and keeps signaling alive', { timeout: 20_000 }, async () => {
    const harness = await startBridgeHarness();
    const resources = new TestResources();
    try {
      const establishedSignal = await resources.openSignal(harness.signalUrl);
      const established = resources.createEchoPeer(establishedSignal, 'established');
      await established.negotiate({ sendInit: true });
      await harness.waitForTransportCount(1);
      expect(await established.sendAndWait('established-before-replacement')).toBe(
        'established-before-replacement',
      );

      const baseline = nativeObservation.serverRecords().length;
      const pendingSignal = await resources.openSignal(harness.signalUrl);
      pendingSignal.send({ type: 'rtc-init', payload: { iceServers: [] } });
      await nativeObservation.waitForServerCount(baseline + 1, 5000);
      pendingSignal.send({ type: 'rtc-init', payload: { iceServers: [] } });
      await nativeObservation.waitForServerCount(baseline + 2, 5000);

      const serverRecords = nativeObservation.serverRecords();
      const oldPending = serverRecords[baseline];
      const replacement = serverRecords[baseline + 1];
      expect(oldPending.closeCount).toBe(1);
      expect(replacement.closeCount).toBe(0);
      expect(pendingSignal.socket.readyState).toBe(WebSocket.OPEN);

      const pendingReplacement = resources.createEchoPeer(pendingSignal, 'replacement');
      await pendingReplacement.negotiate({ sendInit: false });
      await harness.waitForTransportCount(2);
      expect(await pendingReplacement.sendAndWait('replacement-over-rtc')).toBe(
        'replacement-over-rtc',
      );
      expect(oldPending.closeCount).toBe(1);
      expect(replacement.closeCount).toBe(0);
      expect(pendingSignal.socket.readyState).toBe(WebSocket.OPEN);

      expect(await established.sendAndWait('established-after-replacement')).toBe(
        'established-after-replacement',
      );
    } finally {
      await resources.dispose();
      await harness.close();
    }
  });

  it('closes a native peer on the unchanged 30 second timeout and reuses signaling', { timeout: 45_000 }, async () => {
    const harness = await startBridgeHarness();
    const resources = new TestResources();
    try {
      const establishedSignal = await resources.openSignal(harness.signalUrl);
      const established = resources.createEchoPeer(establishedSignal, 'established');
      await established.negotiate({ sendInit: true });
      await harness.waitForTransportCount(1);
      expect(await established.sendAndWait('established-before-timeout')).toBe(
        'established-before-timeout',
      );

      const baseline = nativeObservation.serverRecords().length;
      const pendingSignal = await resources.openSignal(harness.signalUrl);
      const startedAt = Date.now();
      pendingSignal.send({ type: 'rtc-init', payload: { iceServers: [] } });
      await nativeObservation.waitForServerCount(baseline + 1, 5000);

      const timeoutError = await pendingSignal.waitFor(
        (message) => message.type === 'rtc-error'
          && message.payload?.message === 'rtc ice connection timeout',
        40_000,
        'rtc ice connection timeout error',
      );
      const elapsedMs = Date.now() - startedAt;
      expect(timeoutError.payload?.message).toBe('rtc ice connection timeout');
      expect(elapsedMs).toBeGreaterThanOrEqual(29_000);
      expect(pendingSignal.socket.readyState).toBe(WebSocket.OPEN);

      const pendingPeer = nativeObservation.serverRecords()[baseline];
      expect(pendingPeer.closeCount).toBe(1);

      const recovered = resources.createEchoPeer(pendingSignal, 'timeout-recovery');
      await recovered.negotiate({ sendInit: true });
      await harness.waitForTransportCount(2);
      expect(await recovered.sendAndWait('timeout-recovery-echo')).toBe(
        'timeout-recovery-echo',
      );
      expect(pendingPeer.closeCount).toBe(1);
      expect(pendingSignal.socket.readyState).toBe(WebSocket.OPEN);

      expect(await established.sendAndWait('established-after-timeout')).toBe(
        'established-after-timeout',
      );
    } finally {
      await resources.dispose();
      await harness.close();
    }
  });
});
