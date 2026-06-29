import { describe, expect, it } from 'vitest';
import {
  buildServerIdentityAliasMap,
  resolveServerDisplayName,
  resolveServerIdentity,
  resolveServerIdentityKey,
} from './server-identity';

describe('server identity projection', () => {
  it('uses daemonHostId as stable server identity before connection labels', () => {
    const input = {
      daemonHostId: 'macbook-air',
      connectionName: '100.86.84.63 · server',
      bridgeHost: '100.86.84.63',
      bridgePort: 3333,
    };

    expect(resolveServerIdentityKey(input)).toBe('macbook-air');
    expect(resolveServerDisplayName(input)).toBe('macbook-air');
  });

  it('strips session suffix and bridge port from user-visible fallback labels', () => {
    expect(resolveServerDisplayName({
      connectionName: 'MacBook Air · server',
      bridgeHost: '100.86.84.63',
      bridgePort: 3333,
    })).toBe('MacBook Air');
    expect(resolveServerDisplayName({
      bridgeHost: '100.86.84.63:3333',
      bridgePort: 3333,
    })).toBe('100.86.84.63');
  });

  it('coalesces bridge-only sessions into the daemon identity found on the same endpoint', () => {
    const aliases = buildServerIdentityAliasMap([
      {
        daemonHostId: 'mac-studio',
        connectionName: 'mac-studio · server',
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
      },
      {
        connectionName: '100.66.1.82 · freehand',
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
      },
    ]);

    expect(resolveServerIdentity({
      connectionName: '100.66.1.82 · freehand',
      bridgeHost: '100.66.1.82',
      bridgePort: 3333,
    }, aliases)).toEqual({
      key: 'mac-studio',
      label: 'mac-studio',
    });
  });
});
