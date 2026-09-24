import { describe, expect, it, vi } from 'vitest';
import {
  buildSessionsCatalogPayload,
  createDaemonSessionCatalogRuntime,
  handleListSessionsMessageRuntime,
  type DaemonSessionCatalogRuntimeDeps,
} from './daemon-session-catalog-runtime';
import type { TerminalTransportConnection } from './terminal-runtime-types';
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
      await vi.waitFor(() => {
        expect(refresh).toHaveBeenCalledTimes(1);
      });

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh.mock.calls[0]?.[0]).toEqual([
        { name: 'alpha', backend: 'tmux' },
        { name: 'beta', backend: 'tmux' },
      ]);
      expect(listTerminalSessionCatalog).toHaveBeenCalledTimes(2);
      expect(runtime.read()).toEqual([
        { name: 'alpha', backend: 'tmux' },
        { name: 'beta', backend: 'tmux' },
      ]);
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

      expect(runtime.read()).toEqual([
        { name: 'alpha', backend: 'tmux' },
        { name: 'herdr-one', backend: 'herdr' },
      ]);
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
      expect(runtime.read()).toEqual([{ name: 'herdr-one', backend: 'herdr' }]);

      entries = [];
      vi.advanceTimersByTime(1000);
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
      expect(runtime.read()).toEqual([]);
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
