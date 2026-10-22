import { describe, expect, it } from 'vitest';
import { createTerminalControlRuntime } from './terminal-control-runtime';

function createRuntime(tmuxCommandTimeoutMs?: number) {
  return createTerminalControlRuntime({
    tmuxBinary: '/bin/sh',
    defaultSessionName: 'demo',
    hiddenTmuxSessions: new Set(),
    sanitizeSessionName: (input) => input?.trim() || 'demo',
    ...(tmuxCommandTimeoutMs === undefined ? {} : { tmuxCommandTimeoutMs }),
  });
}

describe('terminal control runtime bounded exact-target execution', () => {
  it('terminates an actual spawned tmux async child when it exceeds the command timeout', async () => {
    const runtime = createRuntime(50);
    const startedAt = Date.now();

    await expect(runtime.runTmuxAsync(['-c', 'sleep 5']))
      .rejects.toThrow('tmux command timed out after 50ms');
    expect(Date.now() - startedAt).toBeLessThan(1000);

    const recovered = await runtime.runTmuxAsync(['-c', 'printf recovered']);
    expect(recovered.stdout).toBe('recovered');
  });

  it('routes explicit target reads without mutating shared session-name bindings', async () => {
    const runtime = createRuntime(1000);
    const target = {
      backend: 'tmux' as const,
      sessionName: 'demo',
      stableId: 'tmux:v1:exact-target',
      serverPid: '42',
      sessionId: '$9',
      createdAt: 100,
    };

    const asyncResult = await runtime.runTmuxAsyncForTarget(['-c', 'printf target-async'], target);

    expect(asyncResult.stdout).toBe('target-async');
  });
});
