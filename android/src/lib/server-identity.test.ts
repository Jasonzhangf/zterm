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

  it('replaces a stale daemon id when an exact endpoint alias is confirmed', () => {
    const aliases = buildServerIdentityAliasMap([
      {
        daemonHostId: 'mac-studio',
        connectionName: 'Mac Studio',
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
      },
    ]);

    expect(resolveServerIdentity({
      daemonHostId: 'daemon-Macstu-old',
      connectionName: 'Mac Studio',
      bridgeHost: '100.66.1.82',
      bridgePort: 3333,
    }, aliases)).toEqual({
      key: 'mac-studio',
      label: 'mac-studio',
    });
  });

  it('keeps a stale daemon id when no exact endpoint alias exists', () => {
    expect(resolveServerIdentity({
      daemonHostId: 'daemon-Macstu-old',
      bridgeHost: '10.0.0.9',
      bridgePort: 3333,
    }, buildServerIdentityAliasMap([{
      daemonHostId: 'mac-studio',
      bridgeHost: '100.66.1.82',
      bridgePort: 3333,
    }]))).toEqual({
      key: 'daemon-Macstu-old',
      label: 'daemon-Macstu-old',
    });
  });

  it('does not infer an identity when two aliases share one endpoint', () => {
    const aliases = buildServerIdentityAliasMap([
      { daemonHostId: 'mac-studio', bridgeHost: '100.66.1.82', bridgePort: 3333 },
      { daemonHostId: 'macbook-air', bridgeHost: '100.66.1.82', bridgePort: 3333 },
    ]);

    expect(resolveServerIdentity({
      bridgeHost: '100.66.1.82',
      bridgePort: 3333,
    }, aliases)).toEqual({
      key: '100.66.1.82:3333',
      label: '100.66.1.82',
    });
  });
});
