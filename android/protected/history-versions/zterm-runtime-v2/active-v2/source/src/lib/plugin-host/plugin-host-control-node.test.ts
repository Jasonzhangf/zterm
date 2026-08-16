import { describe, expect, it, vi } from 'vitest';
import { createControlCommand } from '@zterm/shared/terminal/control-contract';
import { PluginHostControlNode } from './plugin-host-control-node';
import type { PluginHost } from './plugin-host-runtime';

function disposeCommand(reason: string) {
  return createControlCommand('plugin-host.dispose', 'app-unmount-1', 'app-unmount', {
    reason,
  });
}

describe('plugin host control node', () => {
  it('disposes the host with the validated reason exactly once', async () => {
    const disposeAll = vi.fn(async (_reason: string) => {});
    const node = new PluginHostControlNode({
      disposeAll,
    } as unknown as PluginHost);

    const result = await node.execute(disposeCommand('app-unmount'));

    expect(result).toEqual({
      ok: true,
      value: { disposed: true, reason: 'app-unmount' },
    });
    expect(disposeAll).toHaveBeenCalledTimes(1);
    expect(disposeAll).toHaveBeenCalledWith('app-unmount');
  });

  it('rejects an empty reason without calling the host', async () => {
    const disposeAll = vi.fn(async (_reason: string) => {});
    const node = new PluginHostControlNode({
      disposeAll,
    } as unknown as PluginHost);

    const result = await node.execute(disposeCommand('   '));

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'invalid_reason',
        message: 'plugin-host.dispose reason must be a non-empty string',
      },
    });
    expect(disposeAll).not.toHaveBeenCalled();
  });

  it('returns an explicit error when the host dispose fails', async () => {
    const disposeAll = vi.fn(async (_reason: string) => {
      throw new Error('host unavailable');
    });
    const node = new PluginHostControlNode({
      disposeAll,
    } as unknown as PluginHost);

    const result = await node.execute(disposeCommand('app-unmount'));

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'dispose_failed',
        message: 'host unavailable',
      },
    });
  });
});
