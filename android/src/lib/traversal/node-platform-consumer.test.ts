import wrtc from '@roamhq/wrtc';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

class ControlledWebSocket {
  static instances: ControlledWebSocket[] = [];

  readonly url: string;
  readyState = 0;
  binaryType = 'blob';
  bufferedAmount = 0;
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    ControlledWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send() {}

  close(code = 1000, reason = '') {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }
}

describe('Node traversal platform consumer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates a real Node transport without window or browser storage', async () => {
    expect(typeof window).toBe('undefined');
    const storageAccess = vi.fn(() => {
      throw new Error('browser storage must not be accessed');
    });
    vi.stubGlobal('localStorage', {
      getItem: storageAccess,
      setItem: storageAccess,
      removeItem: storageAccess,
    });

    const { createNodeTraversalFactory } = await import('../../../../packages/cli/src/node-platform');
    const realDependencyFactory = createNodeTraversalFactory({
      WebSocket,
      RTCPeerConnection: wrtc.RTCPeerConnection,
      RTCSessionDescription: wrtc.RTCSessionDescription,
      RTCIceCandidate: wrtc.RTCIceCandidate,
    });
    const peer = realDependencyFactory.platform.createPeerConnection({
      iceServers: [],
      iceTransportPolicy: 'all',
    });
    expect(peer).toBeInstanceOf(wrtc.RTCPeerConnection);
    peer.close();

    const factory = createNodeTraversalFactory({
      WebSocket: ControlledWebSocket,
      RTCPeerConnection: wrtc.RTCPeerConnection,
      RTCSessionDescription: wrtc.RTCSessionDescription,
      RTCIceCandidate: wrtc.RTCIceCandidate,
    });
    const socket = factory.createSocket(
      {
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        authToken: 'daemon-token',
        transportMode: 'websocket',
      },
      {
        signalUrl: '',
        turnServerUrl: '',
        turnUsername: '',
        turnCredential: '',
        transportMode: 'websocket',
        traversalPathPriority: ['lan'],
      },
    );

    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onclose = (event) => reject(new Error(event?.reason || 'closed before open'));
    });
    expect(ControlledWebSocket.instances).toHaveLength(1);
    expect(ControlledWebSocket.instances[0]?.url).toContain('token=daemon-token');
    expect(socket.getDiagnostics()).toMatchObject({
      stage: 'open',
      resolvedPath: 'lan',
    });

    const closed = new Promise<void>((resolve) => {
      socket.onclose = () => resolve();
    });
    socket.close(1000, 'consumer closed');
    await closed;
    expect(socket.getDiagnostics().stage).toBe('closed');
    expect(storageAccess).not.toHaveBeenCalled();
  });
});
