import { describe, expect, it, vi } from 'vitest';
import {
  buildSessionsCatalogPayload,
  handleListSessionsMessageRuntime,
  probeDaemonSessionAgentStatus,
  SESSION_AGENT_OPTIONS,
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
  it('accepts only a fresh explicit running/idle registration on the exact session', () => {
    const values = new Map<string, string>([
      [SESSION_AGENT_OPTIONS.name, 'agent-a'],
      [SESSION_AGENT_OPTIONS.state, 'running'],
      [SESSION_AGENT_OPTIONS.heartbeatMs, '9700'],
    ]);
    const readOption = vi.fn((option: string) => values.get(option) || null);
    expect(probeDaemonSessionAgentStatus({
      sessionName: 'session-a', nowMs: 10_000, sessionExists: true, readOption,
    })).toEqual({ kind: 'running', agentName: 'agent-a', reason: 'fresh_agent_registration' });
    values.set(SESSION_AGENT_OPTIONS.state, 'idle');
    expect(probeDaemonSessionAgentStatus({
      sessionName: 'session-a', nowMs: 10_000, sessionExists: true, readOption,
    }).kind).toBe('idle');
    expect(readOption).toHaveBeenCalledWith(SESSION_AGENT_OPTIONS.name);
  });

  it('invokes the daemon tmux option reader from catalog construction', () => {
    const values: Record<string, string> = {
      'agent-a:@zterm_agent_name': 'agent-a',
      'agent-a:@zterm_agent_state': 'running',
      'agent-a:@zterm_agent_heartbeat_ms': String(Date.now()),
    };
    const readOption = vi.fn((sessionName: string, option: string) => values[`${sessionName}:${option}`] || null);
    const payload = buildSessionsCatalogPayload({
      listTmuxSessions: () => ['agent-a'],
      readTmuxSessionAgentOption: readOption,
    });
    expect(payload.sessionCatalog[0]?.sessionAgent).toMatchObject({
      kind: 'running', agentName: 'agent-a', reason: 'fresh_agent_registration',
    });
    expect(readOption).toHaveBeenCalledWith('agent-a', SESSION_AGENT_OPTIONS.name);
  });

  it('returns unknown for absent, disappeared, and stale registrations', () => {
    expect(probeDaemonSessionAgentStatus({ sessionName: 'missing', nowMs: 10_000, sessionExists: true }))
      .toEqual({ kind: 'unknown', reason: 'agent_registration_absent' });
    expect(probeDaemonSessionAgentStatus({ sessionName: 'gone', nowMs: 10_000, sessionExists: false }))
      .toEqual({ kind: 'unknown', reason: 'session_disappeared' });
    const readOption = (option: string) => ({
      [SESSION_AGENT_OPTIONS.name]: 'agent-a',
      [SESSION_AGENT_OPTIONS.state]: 'idle',
      [SESSION_AGENT_OPTIONS.heartbeatMs]: '1',
    }[option] || null);
    expect(probeDaemonSessionAgentStatus({ sessionName: 'stale', nowMs: 40_000, sessionExists: true, readOption }))
      .toEqual({ kind: 'unknown', agentName: 'agent-a', reason: 'stale_heartbeat' });
  });

  it('returns explicit errors for invalid registration or tmux read failure', () => {
    const invalid = (state: string, heartbeat: string) => (option: string) => ({
      [SESSION_AGENT_OPTIONS.name]: 'agent-a', [SESSION_AGENT_OPTIONS.state]: state,
      [SESSION_AGENT_OPTIONS.heartbeatMs]: heartbeat,
    }[option] || null);
    expect(probeDaemonSessionAgentStatus({ sessionName: 'bad', nowMs: 10_000, sessionExists: true, readOption: invalid('blocked', '9000') }))
      .toMatchObject({ kind: 'error', reason: 'agent_registration_state_invalid' });
    expect(probeDaemonSessionAgentStatus({ sessionName: 'bad', nowMs: 10_000, sessionExists: true, readOption: invalid('idle', 'NaN') }))
      .toMatchObject({ kind: 'error', reason: 'agent_registration_heartbeat_invalid' });
    expect(probeDaemonSessionAgentStatus({
      sessionName: 'error', nowMs: 10_000, sessionExists: true, readOption: () => { throw new Error('tmux unavailable'); },
    })).toEqual({ kind: 'error', reason: 'agent_registration_read_failed: tmux unavailable' });
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
      listTmuxSessions: vi.fn(() => ['alpha']),
    });

    expect(buildSessionsCatalogPayload(deps, 'tmux')).toEqual({
      sessions: ['alpha'],
      sessionCatalog: [{ name: 'alpha', backend: 'tmux' }],
    });
    expect(deps.listTmuxSessions).toHaveBeenCalledWith('tmux');
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
