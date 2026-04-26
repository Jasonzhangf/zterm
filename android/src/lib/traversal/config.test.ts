import { describe, expect, it } from 'vitest';
import { buildTraversalPlan } from './config';

describe('buildTraversalPlan', () => {
  it('orders direct paths as tailscale -> ipv6 -> ipv4 -> rtc', () => {
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
      },
    );

    expect(plan.candidates.map((candidate) => candidate.path)).toEqual([
      'tailscale',
      'ipv6',
      'ipv4',
      'rtc-direct',
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
        },
      )).toThrow('WebRTC mode requires explicit signalUrl and TURN configuration');
  });
});
