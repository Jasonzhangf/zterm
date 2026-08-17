import { describe, expect, it } from 'vitest';
import { DEFAULT_BRIDGE_PORT } from './mobile-config';
import { buildBridgeUrl } from './bridge-url';

describe('buildBridgeUrl', () => {
  it('defaults to ws for plain host entries', () => {
    expect(buildBridgeUrl({
      id: '1',
      createdAt: Date.now(),
      name: 'Mac',
      bridgeHost: '192.168.0.130',
      bridgePort: DEFAULT_BRIDGE_PORT,
      sessionName: 'tmux',
      authType: 'password',
      tags: [],
      pinned: false,
    })).toBe(`ws://192.168.0.130:${DEFAULT_BRIDGE_PORT}/`);
  });

  it('preserves explicit ws/wss urls', () => {
    expect(buildBridgeUrl({
      id: '1',
      createdAt: Date.now(),
      name: 'Mac',
      bridgeHost: 'ws://192.168.0.130',
      bridgePort: DEFAULT_BRIDGE_PORT,
      sessionName: 'tmux',
      authType: 'password',
      tags: [],
      pinned: false,
    })).toBe(`ws://192.168.0.130:${DEFAULT_BRIDGE_PORT}/`);
  });

  it('accepts raw host:port input without duplicating the port', () => {
    expect(buildBridgeUrl({
      id: '1',
      createdAt: Date.now(),
      name: 'Mac',
      bridgeHost: '100.127.23.27:40807',
      bridgePort: DEFAULT_BRIDGE_PORT,
      sessionName: 'tmux',
      authType: 'password',
      tags: [],
      pinned: false,
    })).toBe('ws://100.127.23.27:40807/');
  });

  it('keeps localhost and LAN direct websocket targets on the explicit bridge port', () => {
    const baseHost = {
      id: '1',
      createdAt: Date.now(),
      name: 'Mac',
      sessionName: 'tmux',
      authType: 'password' as const,
      tags: [],
      pinned: false,
    };

    expect(buildBridgeUrl({
      ...baseHost,
      bridgeHost: '127.0.0.1',
      bridgePort: 40807,
    })).toBe('ws://127.0.0.1:40807/');
    expect(buildBridgeUrl({
      ...baseHost,
      bridgeHost: '192.168.1.20',
      bridgePort: 40807,
    })).toBe('ws://192.168.1.20:40807/');
  });
});
