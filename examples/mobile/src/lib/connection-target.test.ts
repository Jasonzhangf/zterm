import { describe, expect, it } from 'vitest';
import { formatBridgeEndpoint, formatBridgeSessionTarget, getResolvedSessionName, normalizeHost } from './connection-target';

describe('connection-target helpers', () => {
  it('normalizes legacy host records to bridge/session fields', () => {
    const host = normalizeHost({
      id: 'legacy-1',
      createdAt: 123,
      name: 'Mac',
      host: '100.127.23.27',
      port: 37283,
      username: 'main',
      authType: 'password',
      tags: ['local'],
      pinned: true,
    });

    expect(host).toEqual({
      id: 'legacy-1',
      createdAt: 123,
      name: 'Mac',
      bridgeHost: '100.127.23.27',
      bridgePort: 37283,
      sessionName: 'main',
      authType: 'password',
      password: undefined,
      privateKey: undefined,
      tags: ['local'],
      pinned: true,
      lastConnected: undefined,
      autoCommand: '',
    });
  });

  it('formats bridge endpoint and session target for multi-session tabs', () => {
    expect(formatBridgeEndpoint({ bridgeHost: '100.127.23.27', bridgePort: 37283 })).toBe('100.127.23.27:37283');
    expect(
      formatBridgeSessionTarget({
        bridgeHost: '100.127.23.27',
        bridgePort: 37283,
        sessionName: 'build',
      }),
    ).toBe('100.127.23.27:37283 · build');
  });

  it('falls back to connection name when sessionName is empty', () => {
    expect(getResolvedSessionName({ name: 'Mac', sessionName: '' })).toBe('Mac');
  });
});
