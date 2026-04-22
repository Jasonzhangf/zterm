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
});
