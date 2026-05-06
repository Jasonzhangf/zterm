import { describe, expect, it } from 'vitest';
import { buildTraversalPlan } from './config';

describe('buildTraversalPlan', () => {
  it('orders auto paths as tailscale -> ipv6 -> ipv4 -> relay', () => {
    const plan = buildTraversalPlan(
      {
        bridgeHost: '203.0.113.10',
        bridgePort: 3333,
        authToken: 'token',
        tailscaleHost: 'mac.tailnet.ts.net',
        ipv6Host: '240e:1234::10',
        ipv4Host: '203.0.113.10',
        signalUrl: 'wss://signal.example.com/signal',
        transportMode: 'auto',
      },
      {
        signalUrl: 'wss://signal.example.com/signal',
        turnServerUrl: 'turn:turn.example.com:3478?transport=udp',
        turnUsername: 'alice',
        turnCredential: 'secret',
        transportMode: 'auto',
        traversalRelay: undefined,
      },
    );

    expect(plan.candidates.map((candidate) => candidate.path)).toEqual([
      'tailscale',
      'ipv6',
      'ipv4',
      'rtc-relay',
    ]);
  });

  it('uses override url as a single direct candidate', () => {
    const plan = buildTraversalPlan(
      {
        bridgeHost: '100.64.0.2',
        bridgePort: 3333,
        authToken: 'token',
      },
      {
        signalUrl: '',
        turnServerUrl: 'turn:turn.example.com:3478?transport=udp',
        turnUsername: 'alice',
        turnCredential: 'secret',
        transportMode: 'auto',
        traversalRelay: undefined,
      },
      'ws://127.0.0.1:3333/ws',
    );

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({
      kind: 'ws',
      endpoint: 'ws://127.0.0.1:3333/ws',
    });
  });

  it('can disable rtc candidates in websocket mode', () => {
    const plan = buildTraversalPlan(
      {
        bridgeHost: '203.0.113.10',
        bridgePort: 3333,
        authToken: 'token',
      },
      {
        signalUrl: 'wss://signal.example.com/signal',
        turnServerUrl: 'turn:turn.example.com:3478?transport=udp',
        turnUsername: 'alice',
        turnCredential: 'secret',
        transportMode: 'websocket',
        traversalRelay: undefined,
      },
    );

    expect(plan.candidates.every((candidate) => candidate.kind === 'ws')).toBe(true);
  });

  it('accepts raw host:port as a single normalized websocket endpoint', () => {
    const plan = buildTraversalPlan(
      {
        bridgeHost: '100.127.23.27:40807',
        bridgePort: 3333,
        authToken: 'token',
        transportMode: 'websocket',
      },
      {
        signalUrl: '',
        turnServerUrl: '',
        turnUsername: '',
        turnCredential: '',
        transportMode: 'websocket',
        traversalRelay: undefined,
      },
    );

    expect(plan.candidates).toContainEqual(expect.objectContaining({
      kind: 'ws',
      endpoint: '100.127.23.27:40807',
      url: 'ws://100.127.23.27:40807/?token=token',
    }));
  });

  it('requires explicit signal url in webrtc mode', () => {
    expect(() =>
      buildTraversalPlan(
        {
          bridgeHost: '203.0.113.10',
          bridgePort: 3333,
          authToken: 'token',
          transportMode: 'webrtc',
        },
        {
          signalUrl: '',
          turnServerUrl: 'turn:turn.example.com:3478?transport=udp',
          turnUsername: 'alice',
          turnCredential: 'secret',
          transportMode: 'webrtc',
          traversalRelay: undefined,
        },
      )).toThrow('WebRTC mode requires explicit signalUrl and TURN configuration');
  });

  it('prefers relay control-plane ws client url and injects hostId for rtc relay mode', () => {
    const plan = buildTraversalPlan(
      {
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        authToken: 'token-a',
        relayHostId: 'daemon-host-a',
        transportMode: 'webrtc',
      },
      {
        signalUrl: '',
        turnServerUrl: '',
        turnUsername: '',
        turnCredential: '',
        transportMode: 'webrtc',
        traversalRelay: {
          relayBaseUrl: 'http://159.75.134.56/relay/',
          accessToken: 'access-1',
          userId: 'user-1',
          username: 'jason',
          deviceId: 'tablet-1',
          deviceName: 'Jason Tablet',
          platform: 'android',
          wsDevicesUrl: 'ws://159.75.134.56/relay/ws/devices',
          wsHostUrl: 'ws://159.75.134.56/relay/ws/host',
          wsClientUrl: 'ws://159.75.134.56/relay/ws/client',
          turnUrl: 'turn:claw.codewhisper.cc:3479?transport=udp',
          turnUsername: 'ztermturn',
          turnCredential: 'turn-pass',
          updatedAt: 1,
        },
      },
    );

    expect(plan.candidates).toContainEqual(expect.objectContaining({
      kind: 'rtc',
      signalUrl: 'ws://159.75.134.56/relay/ws/client?token=access-1&hostId=daemon-host-a',
      iceServers: [{
        urls: 'turn:claw.codewhisper.cc:3479?transport=udp',
        username: 'ztermturn',
        credential: 'turn-pass',
      }],
    }));
  });

  it('fails fast in webrtc relay mode when no relay daemon device is selected', () => {
    expect(() =>
      buildTraversalPlan(
        {
          bridgeHost: '100.64.0.10',
          bridgePort: 3333,
          authToken: 'token-a',
          transportMode: 'webrtc',
        },
        {
          signalUrl: '',
          turnServerUrl: '',
          turnUsername: '',
          turnCredential: '',
          transportMode: 'webrtc',
          traversalRelay: {
            relayBaseUrl: 'http://159.75.134.56/relay/',
            accessToken: 'access-1',
            userId: 'user-1',
            username: 'jason',
            deviceId: 'tablet-1',
            deviceName: 'Jason Tablet',
            platform: 'android',
            wsDevicesUrl: 'ws://159.75.134.56/relay/ws/devices',
            wsHostUrl: 'ws://159.75.134.56/relay/ws/host',
            wsClientUrl: 'ws://159.75.134.56/relay/ws/client',
            turnUrl: 'turn:154.40.36.9:3479?transport=udp',
            turnUsername: 'ztermturn',
            turnCredential: 'turn-pass',
            updatedAt: 1,
          },
        },
      )).toThrow('WebRTC relay mode requires selecting an online relay daemon device');
  });
});
