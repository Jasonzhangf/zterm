import { describe, expect, it, vi } from 'vitest';
import {
  buildSessionsCatalogPayload,
  handleListSessionsMessageRuntime,
  type DaemonSessionCatalogRuntimeDeps,
} from './daemon-session-catalog-runtime';
import type { TerminalTransportConnection } from './terminal-runtime-types';

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
  it('runs the passive observation reader only for catalog sessions', () => {
    const observation = {
      observedAt: 1000,
      foregroundProcess: 'codex',
      processGroupAlive: true,
      recentOutput: true,
      oscTitleSeen: false,
      oscProgressSeen: true,
      status: 'unknown',
      statusReason: 'insufficient-evidence',
    } as const;
    const runTmux = vi.fn((args: string[]) => ({
      ok: true as const,
      stdout: args[0] === 'list-panes' ? '1234\tcodex' : '\u001b]133;A\u0007output',
    }));
    const payload = buildSessionsCatalogPayload({
      listTerminalSessionCatalog: () => [
        { name: 'agent-a', backend: 'tmux' },
        { name: 'external-a', backend: 'herdr' },
      ],
      listTmuxSessions: () => [],
      runTmux,
      readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
    });
    expect(payload.sessionCatalog[0]).toMatchObject({
      name: 'agent-a', backend: 'tmux', observation: { ...observation, observedAt: expect.any(Number) },
    });
    expect(payload.sessionCatalog[1]).toEqual({ name: 'external-a', backend: 'herdr' });
    expect(payload.sessionCatalog[0]?.observation).toMatchObject({ foregroundProcess: 'codex', recentOutput: true, oscProgressSeen: true });
    expect(runTmux).toHaveBeenCalledWith(['list-panes', '-t', 'agent-a', '-F', '#{pane_pid}\t#{pane_current_command}']);
    expect(runTmux).toHaveBeenCalledWith(['capture-pane', '-p', '-e', '-t', 'agent-a', '-S', '-20']);
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

  it('publishes daemon status in the real sessions control frame', () => {
    const connection = { transport: null } as unknown as TerminalTransportConnection;
    const sendTransportMessage = vi.fn();
    const history = new Map();
    const deps = makeDeps({
      listTerminalSessionCatalog: () => [{ name: 'agent-a', backend: 'tmux' }],
      runTmux: (args: string[]) => ({
        ok: true as const,
        stdout: args[0] === 'list-panes' ? '42\tcodex' : 'thinking',
      }),
      readProcessGroup: () => ({ groupId: 'pg-1', alive: true }),
      observationHistory: history,
      sendTransportMessage,
    });

    handleListSessionsMessageRuntime(deps, connection, { type: 'list-sessions' });
    const sessionsFrame = sendTransportMessage.mock.calls.find(([_, message]) => message.type === 'sessions')?.[1];
    expect(sessionsFrame).toMatchObject({
      type: 'sessions',
      payload: { sessionCatalog: [{ name: 'agent-a', backend: 'tmux', observation: { status: 'unknown', statusReason: 'insufficient-evidence' } }] },
    });
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
