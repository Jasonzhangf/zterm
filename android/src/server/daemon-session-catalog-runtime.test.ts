import { describe, expect, it, vi } from 'vitest';
import {
  buildSessionsCatalogPayload,
  handleListSessionsMessageRuntime,
  probeHerdrSessionAgentStatus,
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
  it('projects Herdr authoritative working and idle states without reading terminal output', () => {
    const runCommand = vi.fn(() => ({
      stdout: JSON.stringify({
        snapshot: {
          workspaces: [{ tabs: [{ panes: [{
            pane_id: 'pane-1',
            agent: 'codex',
            agent_session: 'agentpi',
            agent_status: 'working',
          }] }] }],
        },
      }),
    }));

    expect(probeHerdrSessionAgentStatus({
      entry: { name: 'agentpi', backend: 'herdr' },
      runCommand,
      executable: 'herdr',
    })).toEqual({ kind: 'running', name: 'codex', session: 'agentpi' });
    expect(runCommand).toHaveBeenCalledWith('herdr', ['api', 'snapshot']);
  });

  it('maps Herdr idle/done and refuses to guess unresolved identities', () => {
    const snapshot = (status: string) => ({ stdout: JSON.stringify({
      snapshot: { panes: [{ pane_id: 'pane-1', agent: 'codex', agent_session: 'agentpi', agent_status: status }] },
    }) });
    expect(probeHerdrSessionAgentStatus({
      entry: { name: 'agentpi', backend: 'herdr' }, runCommand: () => snapshot('done'), executable: 'herdr',
    })).toMatchObject({ kind: 'idle', name: 'codex' });
    expect(probeHerdrSessionAgentStatus({
      entry: { name: 'other', backend: 'herdr' }, runCommand: () => snapshot('working'), executable: 'herdr',
    })).toEqual({ kind: 'unknown', reason: 'herdr_agent_identity_unresolved' });
  });

  it('reports probe failure explicitly and never turns it into idle/running', () => {
    expect(probeHerdrSessionAgentStatus({
      entry: { name: 'agentpi', backend: 'herdr' },
      runCommand: () => { throw new Error('server_not_running'); },
      executable: 'herdr',
    })).toEqual({ kind: 'error', reason: 'herdr_agent_status_probe_failed: server_not_running' });
    expect(probeHerdrSessionAgentStatus({
      entry: { name: 'agentpi', backend: 'herdr' },
      runCommand: () => ({ stdout: JSON.stringify({ error: { code: 'server_not_running' } }) }),
      executable: 'herdr',
    })).toEqual({ kind: 'error', reason: 'herdr_agent_status_probe_failed: server_not_running' });
    expect(probeHerdrSessionAgentStatus({
      entry: { name: 'zterm', backend: 'tmux' }, runCommand: vi.fn(), executable: 'herdr',
    })).toEqual({ kind: 'unknown', reason: 'agent_status_not_available_for_backend' });
  });

  it('keeps agent projection daemon-owned in the backend-qualified catalog', () => {
    const probeSessionAgentStatus = vi.fn(() => ({ kind: 'unknown' as const, reason: 'unresolved' }));
    expect(buildSessionsCatalogPayload({
      listTmuxSessions: () => [],
      listTerminalSessionCatalog: () => [{ name: 'agentpi', backend: 'herdr' }],
      probeSessionAgentStatus,
    })).toEqual({
      sessions: ['agentpi'],
      sessionCatalog: [{ name: 'agentpi', backend: 'herdr', agent: { kind: 'unknown', reason: 'unresolved' } }],
    });
    expect(probeSessionAgentStatus).toHaveBeenCalledWith({ name: 'agentpi', backend: 'herdr' });
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
