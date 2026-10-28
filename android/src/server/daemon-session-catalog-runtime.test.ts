import { describe, expect, it, vi } from 'vitest';
import {
  buildSessionsCatalogPayload,
  createDaemonSessionCatalogRuntime,
  DAEMON_COLLAB_PROJECTION_CACHE_MS,
  handleListSessionsMessageRuntime,
  type DaemonSessionCatalogRuntimeDeps,
} from './daemon-session-catalog-runtime';
import type { TerminalTransportConnection } from './terminal-runtime-types';
import { buildTmuxSessionStableId } from './terminal-source-adapter';
import type { TerminalSessionCatalogEntry } from '@zterm/shared/protocol';

function makeDeps(
  overrides: Partial<DaemonSessionCatalogRuntimeDeps> = {},
): DaemonSessionCatalogRuntimeDeps {
  return {
    mirrors: new Map(),
    listTmuxSessions: vi.fn(() => []),
    sendTransportMessage: vi.fn(),
    ...overrides,
  };
}

describe('daemon session catalog runtime', () => {
  it('caches the daemon-owned catalog until an explicit refresh', async () => {
    const listTerminalSessionCatalog = vi.fn(() => [
      { name: 'alpha', backend: 'tmux' as const },
      { name: 'herdr-one', backend: 'herdr' as const },
    ]);
    const runtime = createDaemonSessionCatalogRuntime({
      listTmuxSessions: vi.fn(() => []),
      listTerminalSessionCatalog,
    });

    await runtime.refresh();
    expect(runtime.read()).toEqual([
      { name: 'alpha', backend: 'tmux' },
      { name: 'herdr-one', backend: 'herdr' },
    ]);
    expect(runtime.read()).toEqual([
      { name: 'alpha', backend: 'tmux' },
      { name: 'herdr-one', backend: 'herdr' },
    ]);
    expect(listTerminalSessionCatalog).toHaveBeenCalledTimes(1);

    listTerminalSessionCatalog.mockReturnValueOnce([
      { name: 'alpha', backend: 'tmux' as const },
      { name: 'beta', backend: 'tmux' as const },
    ]);
    await expect(runtime.refresh()).resolves.toEqual([
      { name: 'alpha', backend: 'tmux' },
      { name: 'beta', backend: 'tmux' },
    ]);
    expect(runtime.read()).toEqual([
      { name: 'alpha', backend: 'tmux' },
      { name: 'beta', backend: 'tmux' },
    ]);
    expect(listTerminalSessionCatalog).toHaveBeenCalledTimes(2);
  });

  it('filters cached reads by backend without re-enumerating', async () => {
    const listTerminalSessionCatalog = vi.fn(() => [
      { name: 'alpha', backend: 'tmux' as const },
      { name: 'herdr-one', backend: 'herdr' as const },
    ]);
    const runtime = createDaemonSessionCatalogRuntime({
      listTmuxSessions: vi.fn(() => []),
      listTerminalSessionCatalog,
    });

    await runtime.refresh();
    expect(runtime.read('tmux')).toEqual([{ name: 'alpha', backend: 'tmux' }]);
    expect(runtime.read('herdr')).toEqual([{ name: 'herdr-one', backend: 'herdr' }]);
    expect(listTerminalSessionCatalog).toHaveBeenCalledTimes(1);
  });

  it('does not expose mutable cache entries to callers', async () => {
    const runtime = createDaemonSessionCatalogRuntime({
      listTmuxSessions: vi.fn(() => []),
      listTerminalSessionCatalog: () => [{ name: 'alpha', backend: 'tmux', cwd: '/tmp/alpha' }],
    });

    await runtime.refresh();
    const firstRead = runtime.read();
    firstRead[0]!.name = 'mutated';
    firstRead[0]!.cwd = '/tmp/mutated';

    expect(runtime.read()).toEqual([{ name: 'alpha', backend: 'tmux', cwd: '/tmp/alpha' }]);
  });

  it('keeps the cached catalog when the daemon detection loop sees no membership change', async () => {
    vi.useFakeTimers();
    try {
      const listTerminalSessionCatalog = vi.fn(() => [{ name: 'alpha', backend: 'tmux' as const }]);
      const runtime = createDaemonSessionCatalogRuntime({
        listTmuxSessions: vi.fn(() => []),
        listTerminalSessionCatalog,
      });

      await runtime.refresh();
      expect(runtime.read()).toEqual([{ name: 'alpha', backend: 'tmux' }]);
      runtime.startRefreshLoop(1000);
      vi.advanceTimersByTime(1000);
      await vi.waitFor(() => {
        expect(listTerminalSessionCatalog).toHaveBeenCalledTimes(2);
      });

      expect(runtime.read()).toEqual([{ name: 'alpha', backend: 'tmux' }]);
      expect(listTerminalSessionCatalog).toHaveBeenCalledTimes(2);
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs the shared refresh path when daemon detection sees a new tmux session', async () => {
    vi.useFakeTimers();
    try {
      let entries: TerminalSessionCatalogEntry[] = [{ name: 'alpha', backend: 'tmux' }];
      const listTerminalSessionCatalog = vi.fn(() => entries);
      const runtime = createDaemonSessionCatalogRuntime({
        listTmuxSessions: vi.fn(() => []),
        listTerminalSessionCatalog,
      });
      const refresh = vi.fn((detectedEntries?: TerminalSessionCatalogEntry[]) => (
        runtime.refresh(undefined, detectedEntries)
      ));
      await runtime.refresh();
      runtime.startRefreshLoop(1000, refresh);

      entries = [
        { name: 'alpha', backend: 'tmux' as const },
        { name: 'beta', backend: 'tmux' as const },
      ];
      vi.advanceTimersByTime(1000);
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh.mock.calls[0]?.[0]).toEqual([
        { name: 'alpha', backend: 'tmux' },
        { name: 'beta', backend: 'tmux' },
      ]);
      expect(listTerminalSessionCatalog).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => expect(runtime.read()).toEqual([
        { name: 'alpha', backend: 'tmux' },
        { name: 'beta', backend: 'tmux' },
      ]));
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes the cached catalog when daemon detection sees a new Herdr session', async () => {
    vi.useFakeTimers();
    try {
      let entries: TerminalSessionCatalogEntry[] = [{ name: 'alpha', backend: 'tmux' }];
      const listTerminalSessionCatalog = vi.fn(() => entries);
      const runtime = createDaemonSessionCatalogRuntime({
        listTmuxSessions: vi.fn(() => []),
        listTerminalSessionCatalog,
      });
      const refresh = vi.fn((detectedEntries?: TerminalSessionCatalogEntry[]) => (
        runtime.refresh(undefined, detectedEntries)
      ));
      await runtime.refresh();
      runtime.startRefreshLoop(1000, refresh);

      entries = [
        { name: 'alpha', backend: 'tmux' as const },
        { name: 'herdr-one', backend: 'herdr' as const },
      ];
      vi.advanceTimersByTime(1000);
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

      await vi.waitFor(() => expect(runtime.read()).toEqual([
        { name: 'alpha', backend: 'tmux' },
        { name: 'herdr-one', backend: 'herdr' },
      ]));
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes the cached catalog when daemon detection sees a session removal', async () => {
    vi.useFakeTimers();
    try {
      let entries: TerminalSessionCatalogEntry[] = [
        { name: 'alpha', backend: 'tmux' },
        { name: 'herdr-one', backend: 'herdr' },
      ];
      const listTerminalSessionCatalog = vi.fn(() => entries);
      const runtime = createDaemonSessionCatalogRuntime({
        listTmuxSessions: vi.fn(() => []),
        listTerminalSessionCatalog,
      });
      const refresh = vi.fn((detectedEntries?: TerminalSessionCatalogEntry[]) => (
        runtime.refresh(undefined, detectedEntries)
      ));
      await runtime.refresh();
      runtime.startRefreshLoop(1000, refresh);

      entries = [{ name: 'herdr-one', backend: 'herdr' }];
      vi.advanceTimersByTime(1000);
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(runtime.read()).toEqual([{ name: 'herdr-one', backend: 'herdr' }]));

      entries = [];
      vi.advanceTimersByTime(1000);
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(runtime.read()).toEqual([]));
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the last complete snapshot when new-session detection cannot enumerate', async () => {
    vi.useFakeTimers();
    try {
      const listTerminalSessionCatalog = vi.fn()
        .mockReturnValueOnce([{ name: 'alpha', backend: 'tmux' as const }])
        .mockImplementationOnce(() => {
          throw new Error('tmux backend unavailable');
        })
        .mockReturnValueOnce([
          { name: 'alpha', backend: 'tmux' as const },
          { name: 'beta', backend: 'tmux' as const },
        ]);
      const runtime = createDaemonSessionCatalogRuntime({
        listTmuxSessions: vi.fn(() => []),
        listTerminalSessionCatalog,
      });

      await runtime.refresh();
      expect(runtime.read()).toEqual([{ name: 'alpha', backend: 'tmux' }]);
      runtime.startRefreshLoop(1000);
      vi.advanceTimersByTime(1000);
      await vi.waitFor(() => {
        expect(listTerminalSessionCatalog).toHaveBeenCalledTimes(2);
      });

      expect(runtime.read()).toEqual([{ name: 'alpha', backend: 'tmux' }]);
      expect(listTerminalSessionCatalog).toHaveBeenCalledTimes(2);

      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries daemon-side detection after an explicit refresh invalidates the snapshot', async () => {
    vi.useFakeTimers();
    try {
      let entries: TerminalSessionCatalogEntry[] = [{ name: 'alpha', backend: 'tmux' }];
      const listTerminalSessionCatalog = vi.fn(() => entries);
      const runtime = createDaemonSessionCatalogRuntime({
        listTmuxSessions: vi.fn(() => []),
        listTerminalSessionCatalog,
      });
      await runtime.refresh();

      listTerminalSessionCatalog.mockImplementationOnce(() => {
        throw new Error('explicit refresh failed');
      });
      await expect(runtime.refresh()).rejects.toThrow('explicit refresh failed');
      expect(() => runtime.read()).toThrow(/stale; explicit refresh required/);

      runtime.startRefreshLoop(1000);
      entries = [{ name: 'beta', backend: 'tmux' }];
      vi.advanceTimersByTime(1000);
      await vi.waitFor(() => expect(runtime.read()).toEqual([
        { name: 'beta', backend: 'tmux' },
      ]));

      expect(listTerminalSessionCatalog).toHaveBeenCalledTimes(3);
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('samples passive observation into the resident snapshot only for tmux catalog sessions', async () => {
    const runTmuxAsync = vi.fn(async (args: string[]) => ({
      ok: true as const,
      stdout: args[0] === 'list-panes' ? 'agent-a\t1234\tcodex' : '\u001b]133;A\u0007output',
    }));
    const runtime = createDaemonSessionCatalogRuntime({
      listTmuxSessions: vi.fn(() => []),
      listTerminalSessionCatalog: () => [
        { name: 'agent-a', backend: 'tmux' },
        { name: 'external-a', backend: 'herdr' },
      ],
      runTmuxAsyncAcrossSockets: (args) => runTmuxAsync(args),
      runTmuxAsyncForSession: (args, _sessionName) => runTmuxAsync(args),
      readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
    });

    const sampled = await runtime.refresh();
    expect(sampled[0]).toMatchObject({
      name: 'agent-a',
      backend: 'tmux',
      observation: { observedAt: expect.any(Number) },
    });
    expect(sampled[1]).toEqual({ name: 'external-a', backend: 'herdr' });
    expect(sampled[0]?.observation).toMatchObject({
      foregroundProcess: 'codex',
      recentOutput: true,
      oscProgressSeen: true,
    });
    expect(runTmuxAsync).toHaveBeenCalledWith(['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}\t#{pane_current_command}']);
    expect(runTmuxAsync).toHaveBeenCalledWith(['capture-pane', '-p', '-e', '-t', 'agent-a', '-S', '-20']);
    runtime.dispose();
  });

  it('samples pane facts once and keeps the passive output observation for every tmux session', async () => {
    const runTmuxAsync = vi.fn(async (args: string[]) => {
      if (args[0] === 'list-panes') {
        return {
          ok: true as const,
          stdout: [
            'agent-a\t1234\tcodex',
            'shell-a\t5678\tzsh',
            'agent-b\t9012\tclaude',
          ].join('\n'),
        };
      }
      return {
        ok: true as const,
        stdout: args.includes('agent-b') ? 'thinking' : 'should not be read',
      };
    });
    const runtime = createDaemonSessionCatalogRuntime({
      listTmuxSessions: vi.fn(() => []),
      listTerminalSessionCatalog: () => [
        { name: 'agent-a', backend: 'tmux' },
        { name: 'shell-a', backend: 'tmux' },
        { name: 'agent-b', backend: 'tmux' },
      ],
      runTmuxAsyncAcrossSockets: (args) => runTmuxAsync(args),
      runTmuxAsyncForSession: (args, _sessionName) => runTmuxAsync(args),
      readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
    });

    const sampled = await runtime.refresh();
    expect(sampled.map((entry) => entry.name)).toEqual(['agent-a', 'shell-a', 'agent-b']);
    expect(sampled[1]?.observation).toMatchObject({
      foregroundProcess: 'zsh',
      status: 'unknown',
      statusReason: 'insufficient-evidence',
    });
    expect(runTmuxAsync.mock.calls.filter(([args]) => args[0] === 'list-panes')).toHaveLength(1);
    expect(runTmuxAsync.mock.calls.filter(([args]) => args[0] === 'capture-pane')).toEqual([
      [['capture-pane', '-p', '-e', '-t', 'agent-a', '-S', '-20']],
      [['capture-pane', '-p', '-e', '-t', 'shell-a', '-S', '-20']],
      [['capture-pane', '-p', '-e', '-t', 'agent-b', '-S', '-20']],
    ]);
  });

  it('projects Collab roles from the registered tmux transport identity', async () => {
    const runTmuxAsync = vi.fn(async (args: string[]) => {
      if (args[0] === 'list-sessions') {
        return {
          ok: true as const,
          stdout: [
            '$75\tzterm-1\t/Users/fanzhang/.tmux/run/tmux-501/default',
            '$76\tzterm-2\t/Users/fanzhang/.tmux/run/tmux-501/default',
          ].join('\n'),
        };
      }
      if (args[0] === 'list-panes') {
        return {
          ok: true as const,
          stdout: [
            'zterm-1\t1234\tcodex',
            'zterm-2\t5678\tcodex',
          ].join('\n'),
        };
      }
      return { ok: true as const, stdout: 'idle' };
    });
    const runCollabWho = vi.fn(async () => ({
      workers: [
        {
          display_name: 'Jenny',
          role: 'master',
          agent_state: 'idle',
          transport: {
            kind: 'tmux',
            endpoint: '/Users/fanzhang/.tmux/run/tmux-501/default',
            namespace: '$75',
          },
        },
        {
          display_name: 'Alice',
          role: 'worker',
          agent_state: 'ready',
          transport: {
            kind: 'tmux',
            endpoint: '/Users/fanzhang/.tmux/run/tmux-501/default',
            namespace: '$76',
          },
        },
      ],
    }));
    const runtime = createDaemonSessionCatalogRuntime({
      listTmuxSessions: vi.fn(() => []),
      listTerminalSessionCatalog: () => [
        { name: 'zterm-1', backend: 'tmux', cwd: '/Volumes/extension/code/zterm' },
        { name: 'zterm-2', backend: 'tmux', cwd: '/Volumes/extension/code/zterm' },
      ],
      runTmuxAsyncAcrossSockets: (args) => runTmuxAsync(args),
      runTmuxAsyncForSession: (args) => runTmuxAsync(args),
      readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
      runCollabWho,
    });

    const sampled = await runtime.refresh();
    expect(sampled[0]?.collab).toEqual({
      role: 'master',
      displayName: 'Jenny',
      agentState: 'idle',
    });
    expect(sampled[1]?.collab).toEqual({
      role: 'worker',
      displayName: 'Alice',
      agentState: 'ready',
    });
    expect(runCollabWho).toHaveBeenCalledTimes(1);
    expect(runCollabWho).toHaveBeenCalledWith({ cwd: '/Volumes/extension/code/zterm' });
    runtime.dispose();
  });

  it('keeps the catalog unclassified when the Collab projection is unavailable', async () => {
    const runTmuxAsync = vi.fn(async (args: string[]) => {
      if (args[0] === 'list-sessions') {
        return {
          ok: true as const,
          stdout: '$75\tzterm-1\t/Users/fanzhang/.tmux/run/tmux-501/default',
        };
      }
      if (args[0] === 'list-panes') {
        return { ok: true as const, stdout: 'zterm-1\t1234\tcodex' };
      }
      return { ok: true as const, stdout: 'idle' };
    });
    const runtime = createDaemonSessionCatalogRuntime({
      listTmuxSessions: vi.fn(() => []),
      listTerminalSessionCatalog: () => [
        { name: 'zterm-1', backend: 'tmux', cwd: '/Volumes/extension/code/zterm' },
      ],
      runTmuxAsyncAcrossSockets: (args) => runTmuxAsync(args),
      runTmuxAsyncForSession: (args) => runTmuxAsync(args),
      readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
      runCollabWho: vi.fn(async () => {
        throw new Error('collab daemon unavailable');
      }),
    });

    const sampled = await runtime.refresh();
    expect(sampled).toHaveLength(1);
    expect(sampled[0]?.name).toBe('zterm-1');
    expect(sampled[0]).not.toHaveProperty('collab');
    runtime.dispose();
  });

  it('refreshes the Collab projection on the cadence loop while membership is stable', async () => {
    vi.useFakeTimers();
    try {
      let collabRole: 'master' | 'worker' = 'master';
      const listTerminalSessionCatalog = vi.fn(() => [
        { name: 'zterm-1', backend: 'tmux' as const, cwd: '/Volumes/extension/code/zterm' },
      ]);
      const runTmuxAsync = vi.fn(async (args: string[]) => {
        if (args[0] === 'list-sessions') {
          return {
            ok: true as const,
            stdout: '$75\tzterm-1\t/Users/fanzhang/.tmux/run/tmux-501/default',
          };
        }
        if (args[0] === 'list-panes') {
          return { ok: true as const, stdout: 'zterm-1\t1234\tcodex' };
        }
        return { ok: true as const, stdout: 'idle' };
      });
      const runCollabWho = vi.fn(async () => {
        return {
          workers: [
            {
              display_name: 'Jenny',
              role: collabRole,
              agent_state: 'idle',
              transport: {
                kind: 'tmux',
                endpoint: '/Users/fanzhang/.tmux/run/tmux-501/default',
                namespace: '$75',
              },
            },
          ],
        };
      });
      const runtime = createDaemonSessionCatalogRuntime({
        listTmuxSessions: vi.fn(() => []),
        listTerminalSessionCatalog,
        runTmuxAsyncAcrossSockets: (args) => runTmuxAsync(args),
        runTmuxAsyncForSession: (args) => runTmuxAsync(args),
        readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
        runCollabWho,
      });

      // Cold start: the roster (master) is sampled once.
      await runtime.refresh();
      expect(runtime.read()[0]?.collab).toEqual({
        role: 'master',
        displayName: 'Jenny',
        agentState: 'idle',
      });
      expect(runCollabWho).toHaveBeenCalledTimes(1);

      // A worker registers into the already-open tmux session; membership is
      // unchanged so the old loop would never re-sample.
      collabRole = 'worker';
      runtime.startRefreshLoop(1000);
      // First tick is inside the cache TTL window: no new collab sample yet.
      vi.advanceTimersByTime(1000);
      await vi.waitFor(() => {
        expect(listTerminalSessionCatalog).toHaveBeenCalledTimes(2);
      });
      expect(runtime.read()[0]?.collab?.role).toBe('master');
      expect(runCollabWho).toHaveBeenCalledTimes(1);

      // Past the projection cache TTL: the cadence loop re-samples Collab even
      // though membership never changed, and the new role is published.
      vi.advanceTimersByTime(DAEMON_COLLAB_PROJECTION_CACHE_MS);
      await vi.waitFor(() => {
        expect(runCollabWho).toHaveBeenCalledTimes(2);
      });
      await vi.waitFor(() => {
        expect(runtime.read()[0]?.collab?.role).toBe('worker');
      });
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes a complete unclassified catalog when a cadence resample fails and recovers on the next success', async () => {
    vi.useFakeTimers();
    try {
      let collabShouldFail = false;
      const listTerminalSessionCatalog = vi.fn(() => [
        { name: 'zterm-1', backend: 'tmux' as const, cwd: '/Volumes/extension/code/zterm' },
      ]);
      const runTmuxAsync = vi.fn(async (args: string[]) => {
        if (args[0] === 'list-sessions') {
          return {
            ok: true as const,
            stdout: '$75\tzterm-1\t/Users/fanzhang/.tmux/run/tmux-501/default',
          };
        }
        if (args[0] === 'list-panes') {
          return { ok: true as const, stdout: 'zterm-1\t1234\tcodex' };
        }
        return { ok: true as const, stdout: 'idle' };
      });
      const runCollabWho = vi.fn(async () => {
        if (collabShouldFail) {
          throw new Error('collab daemon unavailable');
        }
        return {
          workers: [
            {
              display_name: 'Jenny',
              role: 'master',
              agent_state: 'idle',
              transport: {
                kind: 'tmux',
                endpoint: '/Users/fanzhang/.tmux/run/tmux-501/default',
                namespace: '$75',
              },
            },
          ],
        };
      });
      const runtime = createDaemonSessionCatalogRuntime({
        listTmuxSessions: vi.fn(() => []),
        listTerminalSessionCatalog,
        runTmuxAsyncAcrossSockets: (args) => runTmuxAsync(args),
        runTmuxAsyncForSession: (args) => runTmuxAsync(args),
        readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
        runCollabWho,
      });

      await runtime.refresh();
      expect(runtime.read()[0]?.collab?.role).toBe('master');
      expect(runCollabWho).toHaveBeenCalledTimes(1);

      // The Collab command now fails. The complete session catalog must stay
      // resident with the stale role removed, not keep the old classification.
      collabShouldFail = true;
      runtime.startRefreshLoop(1000);
      vi.advanceTimersByTime(1000 + DAEMON_COLLAB_PROJECTION_CACHE_MS);
      await vi.waitFor(() => {
        expect(runCollabWho).toHaveBeenCalledTimes(2);
      });
      await vi.waitFor(() => {
        expect(runtime.read()[0]).not.toHaveProperty('collab');
      });
      expect(runtime.read()).toHaveLength(1);
      expect(runtime.read()[0]?.name).toBe('zterm-1');
      // Process observations are preserved even though classification is gone.
      expect(runtime.read()[0]?.observation?.foregroundProcess).toBe('codex');
      expect(listTerminalSessionCatalog.mock.calls.length).toBeGreaterThanOrEqual(2);

      // The failure must clear the cache TTL so the next cadence tick samples
      // again and restores the current classification.
      collabShouldFail = false;
      vi.advanceTimersByTime(1_000);
      await vi.waitFor(() => {
        expect(runCollabWho).toHaveBeenCalledTimes(3);
      });
      await vi.waitFor(() => {
        expect(runtime.read()[0]?.collab?.role).toBe('master');
      });
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a worker unclassified when its endpoint socket does not match the namespace', async () => {
    const runTmuxAsync = vi.fn(async (args: string[]) => {
      if (args[0] === 'list-sessions') {
        return {
          ok: true as const,
          stdout: '$1\tzterm-1\t/Users/fanzhang/.tmux/run/tmux-501/socket-b',
        };
      }
      if (args[0] === 'list-panes') {
        return { ok: true as const, stdout: 'zterm-1\t1234\tcodex' };
      }
      return { ok: true as const, stdout: 'idle' };
    });
    const runtime = createDaemonSessionCatalogRuntime({
      listTmuxSessions: vi.fn(() => []),
      listTerminalSessionCatalog: () => [
        { name: 'zterm-1', backend: 'tmux', cwd: '/repo' },
      ],
      runTmuxAsyncAcrossSockets: (args) => runTmuxAsync(args),
      runTmuxAsyncForSession: (args) => runTmuxAsync(args),
      readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
      runCollabWho: vi.fn(async () => ({
        workers: [
          {
            display_name: 'Jenny',
            role: 'master',
            transport: {
              kind: 'tmux',
              endpoint: '/Users/fanzhang/.tmux/run/tmux-501/socket-a',
              namespace: '$1',
            },
          },
        ],
      })),
    });

    const sampled = await runtime.refresh();
    expect(sampled).toHaveLength(1);
    expect(sampled[0]?.name).toBe('zterm-1');
    // The sole enumerated '$1' lives on socket-b, so the socket-a registration
    // must not borrow it.
    expect(sampled[0]).not.toHaveProperty('collab');
    runtime.dispose();
  });

  it('does not let a cached role leak onto a second same-name target that appears inside the TTL', async () => {
    vi.useFakeTimers();
    try {
      const stableA = buildTmuxSessionStableId({
        socketPath: '/socket-a',
        serverPid: '501',
        sessionId: '$1',
        createdAt: 1000,
      });
      const stableB = buildTmuxSessionStableId({
        socketPath: '/socket-b',
        serverPid: '502',
        sessionId: '$2',
        createdAt: 2000,
      });
      let catalog: TerminalSessionCatalogEntry[] = [
        { name: 'shared', backend: 'tmux', stableId: stableA, cwd: '/repo' },
      ];
      let listSessionsOutput = '$1\tshared\t/socket-a\t501\t1000';
      const listTerminalSessionCatalog = vi.fn(() => catalog);
      const runTmuxAsync = vi.fn(async (args: string[]) => {
        if (args[0] === 'list-sessions') {
          return { ok: true as const, stdout: listSessionsOutput };
        }
        if (args[0] === 'list-panes') {
          return { ok: true as const, stdout: 'shared\t1234\tcodex' };
        }
        return { ok: true as const, stdout: 'idle' };
      });
      const runCollabWho = vi.fn(async () => ({
        workers: [
          {
            display_name: 'Jenny',
            role: 'master',
            transport: { kind: 'tmux', endpoint: '/socket-a', namespace: '$1' },
          },
        ],
      }));
      const runtime = createDaemonSessionCatalogRuntime({
        listTmuxSessions: vi.fn(() => []),
        listTerminalSessionCatalog,
        runTmuxAsyncAcrossSockets: (args) => runTmuxAsync(args),
        runTmuxAsyncForSession: (args) => runTmuxAsync(args),
        readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
        runCollabWho,
      });

      await runtime.refresh();
      expect(runtime.read().find((entry) => entry.stableId === stableA)?.collab?.role)
        .toBe('master');

      // A second target with the same display name appears inside the cache TTL.
      catalog = [
        { name: 'shared', backend: 'tmux', stableId: stableA, cwd: '/repo' },
        { name: 'shared', backend: 'tmux', stableId: stableB, cwd: '/repo' },
      ];
      listSessionsOutput = '$1\tshared\t/socket-a\t501\t1000\n$2\tshared\t/socket-b\t502\t2000';
      runtime.startRefreshLoop(1000);
      vi.advanceTimersByTime(1000);
      await vi.waitFor(() => expect(runtime.read()).toHaveLength(2));

      const rows = runtime.read();
      expect(rows.filter((entry) => entry.name === 'shared')).toHaveLength(2);
      expect(rows.every((entry) => !('collab' in entry))).toBe(true);
      // The membership refresh used the cache fast path, so neither row may
      // inherit the pre-change role.
      expect(runCollabWho).toHaveBeenCalledTimes(1);
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reuse a cached role for a replaced target with the same display name inside the TTL', async () => {
    vi.useFakeTimers();
    try {
      const stableOld = buildTmuxSessionStableId({
        socketPath: '/socket-a',
        serverPid: '501',
        sessionId: '$1',
        createdAt: 1000,
      });
      const stableNew = buildTmuxSessionStableId({
        socketPath: '/socket-a',
        serverPid: '501',
        sessionId: '$9',
        createdAt: 9000,
      });
      let catalog: TerminalSessionCatalogEntry[] = [
        { name: 'shared', backend: 'tmux', stableId: stableOld, cwd: '/repo' },
      ];
      let listSessionsOutput = '$1\tshared\t/socket-a\t501\t1000';
      const runTmuxAsync = vi.fn(async (args: string[]) => {
        if (args[0] === 'list-sessions') {
          return { ok: true as const, stdout: listSessionsOutput };
        }
        if (args[0] === 'list-panes') {
          return { ok: true as const, stdout: 'shared\t1234\tcodex' };
        }
        return { ok: true as const, stdout: 'idle' };
      });
      let collabNamespace = '$1';
      const runCollabWho = vi.fn(async () => ({
        workers: [
          {
            display_name: 'Jenny',
            role: 'master',
            transport: { kind: 'tmux', endpoint: '/socket-a', namespace: collabNamespace },
          },
        ],
      }));
      const runtime = createDaemonSessionCatalogRuntime({
        listTmuxSessions: vi.fn(() => []),
        listTerminalSessionCatalog: () => catalog,
        runTmuxAsyncAcrossSockets: (args) => runTmuxAsync(args),
        runTmuxAsyncForSession: (args) => runTmuxAsync(args),
        readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
        runCollabWho,
      });

      await runtime.refresh();
      expect(runtime.read().find((entry) => entry.stableId === stableOld)?.collab?.role)
        .toBe('master');

      // The target is replaced with a new native identity under the same name.
      // The stale registration still points at the old namespace.
      catalog = [{ name: 'shared', backend: 'tmux', stableId: stableNew, cwd: '/repo' }];
      listSessionsOutput = '$9\tshared\t/socket-a\t501\t9000';
      runtime.startRefreshLoop(1000);
      vi.advanceTimersByTime(1000);
      await vi.waitFor(() => {
        expect(runtime.read().find((entry) => entry.stableId === stableNew)).toBeTruthy();
      });
      expect(runtime.read().find((entry) => entry.stableId === stableNew)).not.toHaveProperty('collab');
      expect(runCollabWho).toHaveBeenCalledTimes(1);
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not assign a classified role to a different target that shares a name with the registered target', async () => {
    vi.useFakeTimers();
    try {
      const stableA = buildTmuxSessionStableId({
        socketPath: '/socket-a',
        serverPid: '501',
        sessionId: '$1',
        createdAt: 1000,
      });
      const stableB = buildTmuxSessionStableId({
        socketPath: '/socket-b',
        serverPid: '502',
        sessionId: '$2',
        createdAt: 2000,
      });
      const catalog: TerminalSessionCatalogEntry[] = [
        { name: 'shared', backend: 'tmux', stableId: stableA, cwd: '/repo' },
        { name: 'shared', backend: 'tmux', stableId: stableB, cwd: '/repo' },
      ];
      // Collab registers a master on exactly target A (socket-a / $1).
      const runCollabWho = vi.fn(async () => ({
        workers: [
          {
            display_name: 'Jenny',
            role: 'master',
            transport: { kind: 'tmux', endpoint: '/socket-a', namespace: '$1' },
          },
        ],
      }));
      // The live tmux listing returns both targets; neither shares a stable id
      // with the other, and the name is ambiguous across sockets.
      const listSessionsOutput = '$1\tshared\t/socket-a\t501\t1000\n$2\tshared\t/socket-b\t502\t2000';
      const runTmuxAsync = vi.fn(async (args: string[]) => {
        if (args[0] === 'list-sessions') {
          return { ok: true as const, stdout: listSessionsOutput };
        }
        if (args[0] === 'list-panes') {
          return { ok: true as const, stdout: 'shared\t1234\tcodex' };
        }
        return { ok: true as const, stdout: 'idle' };
      });
      const runtime = createDaemonSessionCatalogRuntime({
        listTmuxSessions: vi.fn(() => []),
        listTerminalSessionCatalog: () => catalog,
        runTmuxAsyncAcrossSockets: (args) => runTmuxAsync(args),
        runTmuxAsyncForSession: (args) => runTmuxAsync(args),
        readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
        runCollabWho,
      });

      const sampled = await runtime.refresh();
      expect(sampled).toHaveLength(2);
      // Only the exact stable-id match keeps the role; the same-name target B
      // stays unclassified both at cold start and after a TTL re-sample.
      expect(sampled.find((entry) => entry.stableId === stableA)?.collab?.role).toBe('master');
      expect(sampled.find((entry) => entry.stableId === stableB)).not.toHaveProperty('collab');

      runtime.startRefreshLoop(1000);
      vi.advanceTimersByTime(1000 + DAEMON_COLLAB_PROJECTION_CACHE_MS);
      await vi.waitFor(() => {
        expect(runCollabWho).toHaveBeenCalledTimes(2);
      });
      const rows = runtime.read();
      expect(rows.find((entry) => entry.stableId === stableA)?.collab?.role).toBe('master');
      expect(rows.find((entry) => entry.stableId === stableB)).not.toHaveProperty('collab');
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dedupes the same registered roster observed across multiple session CWDs', async () => {
    const runTmuxAsync = vi.fn(async (args: string[]) => {
      if (args[0] === 'list-sessions') {
        return {
          ok: true as const,
          stdout: '$1\tzterm-1\t/socket-default\n$2\tzterm-2\t/socket-default',
        };
      }
      if (args[0] === 'list-panes') {
        return {
          ok: true as const,
          stdout: 'zterm-1\t1234\tcodex\nzterm-2\t5678\tcodex',
        };
      }
      return { ok: true as const, stdout: 'idle' };
    });
    const runCollabWho = vi.fn(async () => ({
      workers: [
        {
          display_name: 'Jenny',
          role: 'master',
          transport: { kind: 'tmux', endpoint: '/socket-default', namespace: '$1' },
        },
        {
          display_name: 'Alice',
          role: 'worker',
          transport: { kind: 'tmux', endpoint: '/socket-default', namespace: '$2' },
        },
      ],
    }));
    const runtime = createDaemonSessionCatalogRuntime({
      listTmuxSessions: vi.fn(() => []),
      listTerminalSessionCatalog: () => [
        { name: 'zterm-1', backend: 'tmux', cwd: '/repo/a' },
        { name: 'zterm-2', backend: 'tmux', cwd: '/repo/b' },
      ],
      runTmuxAsyncAcrossSockets: (args) => runTmuxAsync(args),
      runTmuxAsyncForSession: (args) => runTmuxAsync(args),
      readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
      runCollabWho,
    });

    const sampled = await runtime.refresh();
    expect(sampled.find((entry) => entry.name === 'zterm-1')?.collab).toEqual({
      role: 'master',
      displayName: 'Jenny',
    });
    expect(sampled.find((entry) => entry.name === 'zterm-2')?.collab).toEqual({
      role: 'worker',
      displayName: 'Alice',
    });
    // One distinct roster was sampled once per CWD, not once per row.
    expect(runCollabWho).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });

  it('keeps a target unclassified when separate registrations report conflicting roles', async () => {
    const runTmuxAsync = vi.fn(async (args: string[]) => {
      if (args[0] === 'list-sessions') {
        return {
          ok: true as const,
          stdout: '$1\talpha\t/socket-default\n$2\tbeta\t/socket-default',
        };
      }
      if (args[0] === 'list-panes') {
        return {
          ok: true as const,
          stdout: 'alpha\t1234\tcodex\nbeta\t5678\tcodex',
        };
      }
      return { ok: true as const, stdout: 'idle' };
    });
    const runCollabWho = vi.fn(async ({ cwd }: { cwd: string }) => ({
      workers: [
        {
          display_name: 'Jenny',
          role: cwd === '/repo/a' ? 'master' : 'worker',
          transport: { kind: 'tmux', endpoint: '/socket-default', namespace: '$1' },
        },
      ],
    }));
    const runtime = createDaemonSessionCatalogRuntime({
      listTmuxSessions: vi.fn(() => []),
      listTerminalSessionCatalog: () => [
        { name: 'alpha', backend: 'tmux', cwd: '/repo/a' },
        { name: 'beta', backend: 'tmux', cwd: '/repo/b' },
      ],
      runTmuxAsyncAcrossSockets: (args) => runTmuxAsync(args),
      runTmuxAsyncForSession: (args) => runTmuxAsync(args),
      readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
      runCollabWho,
    });

    const sampled = await runtime.refresh();
    expect(sampled.find((entry) => entry.name === 'alpha')).not.toHaveProperty('collab');
    expect(sampled.find((entry) => entry.name === 'beta')).not.toHaveProperty('collab');
    runtime.dispose();
  });

  it('republishes the relay directory after an in-place collab resample', async () => {
    vi.useFakeTimers();
    try {
      let collabRole: 'master' | 'worker' = 'master';
      const listTerminalSessionCatalog = vi.fn(() => [
        { name: 'zterm-1', backend: 'tmux' as const, cwd: '/Volumes/extension/code/zterm' },
      ]);
      const runTmuxAsync = vi.fn(async (args: string[]) => {
        if (args[0] === 'list-sessions') {
          return {
            ok: true as const,
            stdout: '$75\tzterm-1\t/Users/fanzhang/.tmux/run/tmux-501/default',
          };
        }
        if (args[0] === 'list-panes') {
          return { ok: true as const, stdout: 'zterm-1\t1234\tcodex' };
        }
        return { ok: true as const, stdout: 'idle' };
      });
      const runCollabWho = vi.fn(async () => ({
        workers: [
          {
            display_name: 'Jenny',
            role: collabRole,
            transport: {
              kind: 'tmux',
              endpoint: '/Users/fanzhang/.tmux/run/tmux-501/default',
              namespace: '$75',
            },
          },
        ],
      }));
      let runtime: ReturnType<typeof createDaemonSessionCatalogRuntime>;
      // Simulates the server wiring: the publish callback reads the resident
      // catalog exactly as the relay directory builder does.
      const republishedRoles: string[] = [];
      runtime = createDaemonSessionCatalogRuntime({
        listTmuxSessions: vi.fn(() => []),
        listTerminalSessionCatalog,
        runTmuxAsyncAcrossSockets: (args) => runTmuxAsync(args),
        runTmuxAsyncForSession: (args) => runTmuxAsync(args),
        readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
        runCollabWho,
        onCatalogResampled: () => {
          const row = runtime.read().find((entry) => entry.name === 'zterm-1');
          republishedRoles.push(row?.collab?.role ?? 'unclassified');
        },
      });

      await runtime.refresh();
      expect(runtime.read()[0]?.collab?.role).toBe('master');
      expect(republishedRoles).toEqual([]);

      collabRole = 'worker';
      runtime.startRefreshLoop(1000);
      // Inside the TTL the cadence tick does not resample or republish.
      vi.advanceTimersByTime(1000);
      await vi.waitFor(() => {
        expect(listTerminalSessionCatalog.mock.calls.length).toBeGreaterThanOrEqual(2);
      });
      expect(republishedRoles).toEqual([]);

      // Past the TTL the in-place role change is resampled and republished.
      vi.advanceTimersByTime(DAEMON_COLLAB_PROJECTION_CACHE_MS);
      await vi.waitFor(() => {
        expect(republishedRoles).toEqual(['worker']);
      });
      expect(runtime.read()[0]?.collab?.role).toBe('worker');
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('republishes a role change when two targets share a name on different sockets', async () => {
    vi.useFakeTimers();
    try {
      const stableA = buildTmuxSessionStableId({
        socketPath: '/socket-a',
        serverPid: '501',
        sessionId: '$1',
        createdAt: 1000,
      });
      const stableB = buildTmuxSessionStableId({
        socketPath: '/socket-b',
        serverPid: '502',
        sessionId: '$2',
        createdAt: 2000,
      });
      const catalog: TerminalSessionCatalogEntry[] = [
        { name: 'shared', backend: 'tmux', stableId: stableA, cwd: '/repo' },
        { name: 'shared', backend: 'tmux', stableId: stableB, cwd: '/repo' },
      ];
      const listSessionsOutput = '$1\tshared\t/socket-a\t501\t1000\n$2\tshared\t/socket-b\t502\t2000';
      const runTmuxAsync = vi.fn(async (args: string[]) => {
        if (args[0] === 'list-sessions') {
          return { ok: true as const, stdout: listSessionsOutput };
        }
        if (args[0] === 'list-panes') {
          return { ok: true as const, stdout: 'shared\t1234\tcodex' };
        }
        return { ok: true as const, stdout: 'idle' };
      });
      let roleA: 'master' | 'worker' = 'master';
      const runCollabWho = vi.fn(async () => ({
        workers: [
          {
            display_name: 'shared',
            role: roleA,
            transport: { kind: 'tmux', endpoint: '/socket-a', namespace: '$1' },
          },
          {
            display_name: 'shared',
            role: 'worker',
            transport: { kind: 'tmux', endpoint: '/socket-b', namespace: '$2' },
          },
        ],
      }));
      const republishedRoles: string[] = [];
      let runtime: ReturnType<typeof createDaemonSessionCatalogRuntime>;
      runtime = createDaemonSessionCatalogRuntime({
        listTmuxSessions: vi.fn(() => []),
        listTerminalSessionCatalog: () => catalog,
        runTmuxAsyncAcrossSockets: (args) => runTmuxAsync(args),
        runTmuxAsyncForSession: (args) => runTmuxAsync(args),
        readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
        runCollabWho,
        onCatalogResampled: () => {
          const row = runtime.read().find((entry) => entry.stableId === stableA);
          republishedRoles.push(row?.collab?.role ?? 'unclassified');
        },
      });

      await runtime.refresh();
      expect(runtime.read().find((entry) => entry.stableId === stableA)?.collab?.role)
        .toBe('master');
      expect(runtime.read().find((entry) => entry.stableId === stableB)?.collab?.role)
        .toBe('worker');
      expect(republishedRoles).toEqual([]);

      // Only target A changes role. Keying the projection comparison by the
      // shared display name would hide this change behind target B.
      roleA = 'worker';
      runtime.startRefreshLoop(1000);
      vi.advanceTimersByTime(1000 + DAEMON_COLLAB_PROJECTION_CACHE_MS);
      await vi.waitFor(() => {
        expect(republishedRoles).toEqual(['worker']);
      });
      expect(runtime.read().find((entry) => entry.stableId === stableA)?.collab?.role)
        .toBe('worker');
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('omits observations for ambiguous same-name tmux targets while sampling unique names and retaining Herdr', async () => {
    const staleObservation = {
      observedAt: 1,
      foregroundProcess: 'stale-process',
      recentOutput: false,
      oscTitleSeen: false,
      oscProgressSeen: false,
      status: 'unknown' as const,
      statusReason: 'insufficient-evidence' as const,
    };
    const runTmuxAsync = vi.fn(async (args: string[]) => {
      if (args[0] === 'list-panes') {
        return {
          ok: true as const,
          stdout: [
            'shared\t1111\tcodex',
            'shared\t2222\tclaude',
            'unique-a\t3333\tcodex',
            'herdr-shared\t4444\therdr',
          ].join('\n'),
        };
      }
      return { ok: true as const, stdout: 'thinking' };
    });
    const runtime = createDaemonSessionCatalogRuntime({
      listTmuxSessions: vi.fn(() => []),
      listTerminalSessionCatalog: () => [
        { name: 'shared', backend: 'tmux', stableId: 'tmux-a', observation: staleObservation },
        { name: 'shared', backend: 'tmux', stableId: 'tmux-b' },
        { name: 'unique-a', backend: 'tmux', stableId: 'tmux-unique' },
        { name: 'herdr-shared', backend: 'herdr', stableId: 'herdr-a' },
      ],
      runTmuxAsyncAcrossSockets: (args) => runTmuxAsync(args),
      runTmuxAsyncForSession: (args, _sessionName) => runTmuxAsync(args),
      readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
    });

    const sampled = await runtime.refresh();
    const sharedEntries = sampled.filter((entry) => entry.name === 'shared');
    expect(sharedEntries).toHaveLength(2);
    expect(sharedEntries.map((entry) => entry.stableId)).toEqual(['tmux-a', 'tmux-b']);
    // Neither same-name target may inherit the other's sampled facts, and the
    // stale observation carried on the input entry must be stripped.
    expect(sharedEntries[0]).not.toHaveProperty('observation');
    expect(sharedEntries[1]).not.toHaveProperty('observation');

    expect(sampled.find((entry) => entry.name === 'unique-a')?.observation).toMatchObject({
      foregroundProcess: 'codex',
      status: 'unknown',
      statusReason: 'insufficient-evidence',
    });
    expect(sampled.find((entry) => entry.name === 'herdr-shared')).toEqual({
      name: 'herdr-shared',
      backend: 'herdr',
      stableId: 'herdr-a',
    });

    // The ambiguous display name must never be captured by name; only the
    // unique tmux target is sampled.
    expect(runTmuxAsync.mock.calls.filter(([args]) => args[0] === 'capture-pane')).toEqual([
      [['capture-pane', '-p', '-e', '-t', 'unique-a', '-S', '-20']],
    ]);
  });

  it('keeps the last complete snapshot while a cadence refresh is in flight', async () => {
    let releaseCapture: (() => void) | undefined;
    const runTmuxAsync = vi.fn(async (args: string[]) => {
      if (args[0] === 'list-panes') return { ok: true as const, stdout: 'agent-a\t1234\tcodex' };
      await new Promise<void>((resolve) => {
        releaseCapture = resolve;
      });
      return { ok: true as const, stdout: 'thinking' };
    });
    const runtime = createDaemonSessionCatalogRuntime({
      listTmuxSessions: vi.fn(() => []),
      listTerminalSessionCatalog: () => [{ name: 'agent-a', backend: 'tmux' }],
      runTmuxAsyncAcrossSockets: (args) => runTmuxAsync(args),
      runTmuxAsyncForSession: (args, _sessionName) => runTmuxAsync(args),
      readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
    });

    const refresh = runtime.refresh();
    await vi.waitFor(() => {
      expect(releaseCapture).toBeTypeOf('function');
    });
    expect(runtime.read()).toEqual([{ name: 'agent-a', backend: 'tmux' }]);
    releaseCapture?.();
    await refresh;
    expect(runtime.read()[0]?.observation?.foregroundProcess).toBe('codex');
  });

  it('keeps the last complete snapshot when the enumerated session set changes mid-refresh', async () => {
    let releaseCapture: (() => void) | undefined;
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    let gateCaptures = false;
    let capturesStarted = 0;
    const runTmuxAsync = vi.fn(async (args: string[]) => {
      if (args[0] === 'list-panes') {
        return { ok: true as const, stdout: 'alpha\t1234\tcodex\nbeta\t5678\tcodex' };
      }
      if (gateCaptures) {
        capturesStarted += 1;
        await captureGate;
      }
      return { ok: true as const, stdout: 'thinking' };
    });
    let enumerated: TerminalSessionCatalogEntry[] = [{ name: 'alpha', backend: 'tmux' }];
    const runtime = createDaemonSessionCatalogRuntime({
      listTmuxSessions: vi.fn(() => []),
      listTerminalSessionCatalog: () => enumerated,
      runTmuxAsyncAcrossSockets: (args) => runTmuxAsync(args),
      runTmuxAsyncForSession: (args, _sessionName) => runTmuxAsync(args),
      readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
    });

    await runtime.refresh();
    const published = runtime.read();
    expect(published.map((entry) => entry.name)).toEqual(['alpha']);
    expect(published[0]?.observation?.foregroundProcess).toBe('codex');

    enumerated = [
      { name: 'alpha', backend: 'tmux' },
      { name: 'beta', backend: 'tmux' },
    ];
    gateCaptures = true;
    const refresh = runtime.refresh();
    await vi.waitFor(() => {
      expect(capturesStarted).toBeGreaterThan(0);
    });

    // The in-flight refresh enumerated a new session set, but the resident
    // snapshot must stay on the last complete publication until the sampled
    // candidate commits atomically.
    const inFlight = runtime.read();
    expect(inFlight.map((entry) => entry.name)).toEqual(['alpha']);
    expect(inFlight[0]?.observation?.foregroundProcess).toBe('codex');

    releaseCapture?.();
    await refresh;
    const committed = runtime.read();
    expect(committed.map((entry) => entry.name)).toEqual(['alpha', 'beta']);
    expect(committed[1]?.observation?.foregroundProcess).toBe('codex');
    runtime.dispose();
  });

  it('keeps the session list when an async sample reports observation errors', async () => {
    const runTmuxAsync = vi.fn(async (args: string[]) => {
      if (args[0] === 'list-panes') return { ok: true as const, stdout: 'agent-a\t1234\tcodex' };
      return { ok: true as const, stdout: 'thinking' };
    });
    const runtime = createDaemonSessionCatalogRuntime({
      listTmuxSessions: vi.fn(() => []),
      listTerminalSessionCatalog: () => [{ name: 'agent-a', backend: 'tmux' }],
      runTmuxAsyncAcrossSockets: (args) => runTmuxAsync(args),
      runTmuxAsyncForSession: (args, _sessionName) => runTmuxAsync(args),
      readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
    });
    await runtime.refresh();
    runTmuxAsync.mockRejectedValueOnce(new Error('tmux observation failed'));
    await expect(runtime.refresh()).resolves.toEqual([
      {
        name: 'agent-a',
        backend: 'tmux',
        observation: expect.objectContaining({
          status: 'error',
          statusReason: 'observation-error',
        }),
      },
    ]);
    expect(runtime.read()).toHaveLength(1);
    expect(runtime.read()[0]?.name).toBe('agent-a');
  });

  it('serves client catalog requests from the snapshot without re-sampling observation', async () => {
    const runTmuxAsync = vi.fn(async (args: string[]) => ({
      ok: true as const,
      stdout: args[0] === 'list-panes' ? 'agent-a\t1234\tcodex' : 'thinking',
    }));
    const runtime = createDaemonSessionCatalogRuntime({
      listTmuxSessions: vi.fn(() => []),
      listTerminalSessionCatalog: () => [{ name: 'agent-a', backend: 'tmux' }],
      runTmuxAsyncAcrossSockets: (args) => runTmuxAsync(args),
      runTmuxAsyncForSession: (args, _sessionName) => runTmuxAsync(args),
      readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
    });
    // Prime the resident snapshot the same way the daemon refresh loop does.
    await runtime.refresh();
    const samplesAfterRefresh = runTmuxAsync.mock.calls.length;
    expect(samplesAfterRefresh).toBeGreaterThan(0);

    const payload = buildSessionsCatalogPayload({
      listTmuxSessions: () => [],
      listTerminalSessionCatalog: () => runtime.read(),
      runTmuxAsyncAcrossSockets: (args) => runTmuxAsync(args),
      runTmuxAsyncForSession: (args, _sessionName) => runTmuxAsync(args),
      readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
    });
    const repeated = buildSessionsCatalogPayload({
      listTmuxSessions: () => [],
      listTerminalSessionCatalog: () => runtime.read(),
      runTmuxAsyncAcrossSockets: (args) => runTmuxAsync(args),
      runTmuxAsyncForSession: (args, _sessionName) => runTmuxAsync(args),
      readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
    });

    const firstObservation = 'observation' in payload.sessionCatalog[0]!
      ? payload.sessionCatalog[0].observation
      : undefined;
    expect(firstObservation).toMatchObject({ foregroundProcess: 'codex' });
    expect('observation' in repeated.sessionCatalog[0]! ? repeated.sessionCatalog[0].observation : undefined)
      .toEqual(firstObservation);
    expect(runTmuxAsync.mock.calls.length).toBe(samplesAfterRefresh);
    runtime.dispose();
  });

  it('does not re-sample observation on unchanged daemon detection', async () => {
    vi.useFakeTimers();
    try {
      const runTmuxAsync = vi.fn(async (args: string[]) => ({
        ok: true as const,
        stdout: args[0] === 'list-panes' ? 'agent-a\t1234\tcodex' : 'thinking',
      }));
      const runtime = createDaemonSessionCatalogRuntime({
        listTmuxSessions: vi.fn(() => []),
        listTerminalSessionCatalog: () => [{ name: 'agent-a', backend: 'tmux' }],
        runTmuxAsyncAcrossSockets: (args) => runTmuxAsync(args),
        runTmuxAsyncForSession: (args) => runTmuxAsync(args),
        readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
      });

      await runtime.refresh();
      expect(runtime.read()[0]?.observation?.observedAt).toBeGreaterThan(0);
      const samplesAfterRefresh = runTmuxAsync.mock.calls.length;
      runtime.startRefreshLoop(1_000);

      const before = runtime.read()[0]?.observation?.observedAt ?? 0;
      // Client reads in between must not re-sample.
      runtime.read();
      runtime.read();
      expect(runtime.read()[0]?.observation?.observedAt).toBe(before);

      vi.advanceTimersByTime(1_000);
      await vi.waitFor(() => {
        expect(runtime.read()[0]?.observation?.observedAt ?? 0).toBe(before);
      });
      expect(runTmuxAsync).toHaveBeenCalledTimes(samplesAfterRefresh);
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('builds a backend-qualified catalog for backend-opaque list-sessions', () => {
    const deps = makeDeps({
      listTerminalSessionCatalog: vi.fn(() => [
        { name: 'zterm', backend: 'tmux' },
        { name: 'hd-codex', backend: 'herdr' },
      ]),
    });

    const payload = buildSessionsCatalogPayload(deps);

    expect(payload).toEqual({
      sessions: ['zterm', 'hd-codex'],
      sessionCatalog: [
        { name: 'zterm', backend: 'tmux' },
        { name: 'hd-codex', backend: 'herdr' },
      ],
    });
  });

  it('keeps explicit backend list requests backend-qualified', () => {
    const deps = makeDeps({
      listTerminalSessionCatalog: vi.fn(() => [
        { name: 'alpha', backend: 'tmux', cwd: '/tmp/alpha' },
        { name: 'external', backend: 'herdr', cwd: '/tmp/external' },
      ]),
    });

    expect(buildSessionsCatalogPayload(deps, 'tmux')).toEqual({
      sessions: ['alpha'],
      sessionCatalog: [{ name: 'alpha', backend: 'tmux', cwd: '/tmp/alpha' }],
    });
    expect(deps.listTerminalSessionCatalog).toHaveBeenCalledTimes(1);
  });

  it('falls back to terminal session names only when no catalog is available', () => {
    const deps = makeDeps({
      listTerminalSessions: vi.fn(() => ['legacy']),
    });

    expect(buildSessionsCatalogPayload(deps)).toEqual({
      sessions: ['legacy'],
      sessionCatalog: [{ name: 'legacy', backend: 'tmux' }],
    });
  });

  it('publishes the sessions payload and list-time session activity facts', () => {
    const connection = { transport: null } as unknown as TerminalTransportConnection;
    const sendTransportMessage = vi.fn();
    const deps = makeDeps({
      listTerminalSessionCatalog: vi.fn(() => [
        { name: 'live', backend: 'tmux' },
      ]),
      sendTransportMessage,
    });

    handleListSessionsMessageRuntime(deps, connection, { type: 'list-sessions' });

    expect(sendTransportMessage).toHaveBeenCalledWith(null, {
      type: 'sessions',
      payload: {
        sessions: ['live'],
        sessionCatalog: [{ name: 'live', backend: 'tmux' }],
      },
    });
    expect(sendTransportMessage).toHaveBeenCalledWith(null, {
      type: 'session-activity',
      payload: { activities: [] },
    });
  });

  it('publishes daemon status in the real sessions control frame', async () => {
    const connection = { transport: null } as unknown as TerminalTransportConnection;
    const sendTransportMessage = vi.fn();
    const history = new Map();
    const runtime = createDaemonSessionCatalogRuntime({
      listTmuxSessions: vi.fn(() => []),
      listTerminalSessionCatalog: () => [{ name: 'agent-a', backend: 'tmux' }],
      runTmuxAsyncAcrossSockets: async (args: string[]) => ({
        ok: true as const,
        stdout: args[0] === 'list-panes' ? 'agent-a\t42\tcodex' : 'thinking',
      }),
      runTmuxAsyncForSession: async (args: string[]) => ({
        ok: true as const,
        stdout: args[0] === 'list-panes' ? 'agent-a\t42\tcodex' : 'thinking',
      }),
      readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
      observationHistory: history,
    });
    const deps = makeDeps({
      // The daemon session catalog runtime owns observation sampling; the
      // list-sessions handler only projects its resident snapshot.
      listTerminalSessionCatalog: () => runtime.read(),
      sendTransportMessage,
    });

    await runtime.refresh();
    handleListSessionsMessageRuntime(deps, connection, { type: 'list-sessions' });
    const sessionsFrame = sendTransportMessage.mock.calls.find(([_, message]) => message.type === 'sessions')?.[1];
    expect(sessionsFrame).toMatchObject({
      type: 'sessions',
      payload: { sessionCatalog: [{ name: 'agent-a', backend: 'tmux', observation: { status: 'unknown', statusReason: 'insufficient-evidence' } }] },
    });
    runtime.dispose();
  });

  it('keeps list-sessions failure explicit and wire-compatible', () => {
    const connection = { transport: null } as unknown as TerminalTransportConnection;
    const sendTransportMessage = vi.fn();
    const deps = makeDeps({
      listTerminalSessionCatalog: vi.fn(() => {
        throw new Error('backend unavailable');
      }),
      sendTransportMessage,
    });

    handleListSessionsMessageRuntime(deps, connection, { type: 'list-sessions' });

    expect(sendTransportMessage).toHaveBeenCalledWith(null, {
      type: 'error',
      payload: {
        message: 'Failed to list tmux sessions: backend unavailable',
        code: 'list_sessions_failed',
      },
    });
  });
});
