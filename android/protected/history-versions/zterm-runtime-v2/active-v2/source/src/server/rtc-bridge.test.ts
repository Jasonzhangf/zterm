import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import wrtc from '@roamhq/wrtc';
import { buildRtcPeerConnectionConfig, createRtcBridgeServer } from './rtc-bridge';

const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = wrtc as unknown as {
  RTCPeerConnection: typeof globalThis.RTCPeerConnection;
  RTCSessionDescription: typeof globalThis.RTCSessionDescription;
  RTCIceCandidate: typeof globalThis.RTCIceCandidate;
};

describe('rtc-bridge', () => {
  const cleanupTasks: Array<() => Promise<void> | void> = [];

  function closeTestResource(label: string, close: () => void) {
    try {
      close();
    } catch (error) {
      console.warn(`[rtc-bridge.test] Failed to close ${label}:`, error);
    }
  }

  afterEach(async () => {
    while (cleanupTasks.length > 0) {
      const task = cleanupTasks.pop();
      await task?.();
    }
  });

  it('honors relay-only ICE policy from rtc-init instead of widening it on the daemon side', () => {
    expect(buildRtcPeerConnectionConfig({
      iceServers: [{ urls: 'turn:relay.example.test:3478?transport=udp' }],
      iceTransportPolicy: 'relay',
    })).toEqual({
      iceServers: [{ urls: 'turn:relay.example.test:3478?transport=udp' }],
      iceTransportPolicy: 'relay',
    });
    expect(buildRtcPeerConnectionConfig({
      iceServers: [{ urls: 'turn:relay.example.test:3478?transport=udp' }],
      iceTransportPolicy: 'all',
    })).toEqual({
      iceServers: [{ urls: 'turn:relay.example.test:3478?transport=udp' }],
      iceTransportPolicy: 'all',
    });
    expect(buildRtcPeerConnectionConfig({
      iceServers: [{ urls: 'turn:relay.example.test:3478?transport=udp' }],
      iceTransportPolicy: 'invalid',
    })).toEqual({
      iceServers: [{ urls: 'turn:relay.example.test:3478?transport=udp' }],
      iceTransportPolicy: 'all',
    });
  });

  it('bridges rtc datachannel messages through the server transport', async () => {
    const httpServer = createServer();
    const signalWss = new WebSocketServer({ noServer: true });
    const rtcBridge = createRtcBridgeServer({
      onTransportOpen: (transport) => ({
        onMessage: (_transportId, data) => {
          transport.sendText(data.toString('utf8'));
        },
        onClose: () => undefined,
      }),
    });

    cleanupTasks.push(async () => {
      rtcBridge.dispose();
      await new Promise<void>((resolve) => signalWss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
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

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const address = httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve test server address');
    }

    const signalUrl = `ws://127.0.0.1:${address.port}/signal`;
    const signal = new WebSocket(signalUrl);
    const pc = new RTCPeerConnection({ iceServers: [] });
    const dc = pc.createDataChannel('zterm', { ordered: true });

    cleanupTasks.push(() => {
      closeTestResource('data channel', () => dc.close());
      closeTestResource('peer connection', () => pc.close());
      closeTestResource('signal socket', () => signal.close());
    });

    const echoed = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('rtc bridge test timeout')), 10000);
      cleanupTasks.push(() => clearTimeout(timer));

      pc.onicecandidate = (event) => {
        if (!event.candidate || signal.readyState !== WebSocket.OPEN) {
          return;
        }
        signal.send(JSON.stringify({ type: 'rtc-candidate', payload: event.candidate.toJSON() }));
      };

      signal.onopen = async () => {
        signal.send(JSON.stringify({ type: 'rtc-init', payload: { iceServers: [] } }));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        signal.send(JSON.stringify({ type: 'rtc-offer', payload: { type: offer.type, sdp: offer.sdp } }));
      };

      signal.onmessage = async (event) => {
        const msg = JSON.parse(String(event.data)) as { type: string; payload?: Record<string, unknown> };
        if (msg.type === 'rtc-answer') {
          await pc.setRemoteDescription(new RTCSessionDescription({
            type: 'answer',
            sdp: typeof msg.payload?.sdp === 'string' ? msg.payload.sdp : '',
          }));
          return;
        }
        if (msg.type === 'rtc-candidate') {
          await pc.addIceCandidate(new RTCIceCandidate(msg.payload as RTCIceCandidateInit));
          return;
        }
        if (msg.type === 'rtc-error') {
          reject(new Error(typeof msg.payload?.message === 'string' ? msg.payload.message : 'rtc error'));
        }
      };

      dc.onopen = () => {
        dc.send('hello-over-rtc');
      };

      dc.onmessage = (event) => {
        resolve(String(event.data));
      };

      dc.onerror = () => {
        reject(new Error('datachannel error'));
      };
    });

    expect(echoed).toBe('hello-over-rtc');
  });

  it('buffers early relay candidates until the rtc offer arrives so candidate reordering does not break the peer', { timeout: 15_000 }, async () => {
    const httpServer = createServer();
    const signalWss = new WebSocketServer({ noServer: true });
    const rtcBridge = createRtcBridgeServer({
      onTransportOpen: (transport) => ({
        onMessage: (_transportId, data) => {
          transport.sendText(data.toString('utf8'));
        },
        onClose: () => undefined,
      }),
    });

    cleanupTasks.push(async () => {
      rtcBridge.dispose();
      await new Promise<void>((resolve) => signalWss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
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

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const address = httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve test server address');
    }

    const signalUrl = `ws://127.0.0.1:${address.port}/signal`;
    const signal = new WebSocket(signalUrl);
    const pc = new RTCPeerConnection({ iceServers: [] });
    const dc = pc.createDataChannel('zterm', { ordered: true });
    const generatedCandidates: RTCIceCandidateInit[] = [];

    cleanupTasks.push(() => {
      closeTestResource('data channel', () => dc.close());
      closeTestResource('peer connection', () => pc.close());
      closeTestResource('signal socket', () => signal.close());
    });

    const echoed = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('rtc bridge reorder test timeout')), 10_000);
      cleanupTasks.push(() => clearTimeout(timer));
      let settled = false;

      function settle(value: string) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }

      pc.onicecandidate = (event) => {
        if (!event.candidate) {
          return;
        }
        generatedCandidates.push(event.candidate.toJSON());
      };

      signal.onopen = async () => {
        try {
          signal.send(JSON.stringify({ type: 'rtc-init', payload: { iceServers: [] } }));
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);

          const firstCandidate = await new Promise<RTCIceCandidateInit>((resolveCandidate, rejectCandidate) => {
            const candidateTimer = setTimeout(() => rejectCandidate(new Error('missing early candidate')), 3000);
            cleanupTasks.push(() => clearTimeout(candidateTimer));
            const poll = () => {
              const candidate = generatedCandidates.shift();
              if (candidate) {
                clearTimeout(candidateTimer);
                resolveCandidate(candidate);
                return;
              }
              setTimeout(poll, 10);
            };
            poll();
          });

          signal.send(JSON.stringify({ type: 'rtc-candidate', payload: firstCandidate }));
          signal.send(JSON.stringify({ type: 'rtc-offer', payload: { type: offer.type, sdp: offer.sdp } }));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      signal.onmessage = async (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as { type: string; payload?: Record<string, unknown> };
          if (msg.type === 'rtc-answer') {
            await pc.setRemoteDescription(new RTCSessionDescription({
              type: 'answer',
              sdp: typeof msg.payload?.sdp === 'string' ? msg.payload.sdp : '',
            }));
            return;
          }
          if (msg.type === 'rtc-candidate') {
            await pc.addIceCandidate(new RTCIceCandidate(msg.payload as RTCIceCandidateInit));
            return;
          }
          if (msg.type === 'rtc-error') {
            reject(new Error(typeof msg.payload?.message === 'string' ? msg.payload.message : 'rtc error'));
          }
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      dc.onopen = () => {
        dc.send('hello-reordered-rtc');
      };

      dc.onmessage = (event) => {
        settle(String(event.data));
      };

      dc.onerror = () => {
        reject(new Error('datachannel error'));
      };
    });

    expect(echoed).toBe('hello-reordered-rtc');
  });
});
