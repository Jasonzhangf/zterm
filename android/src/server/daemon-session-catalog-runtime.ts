import type {
  TerminalSessionCatalogEntry,
  TerminalTransportServerFrame,
} from '@zterm/shared/protocol';
import type {
  SessionMirror,
  TerminalSessionTransport,
  TerminalTransportConnection,
} from './terminal-runtime-types';
import { publishSessionActivitiesRuntime } from './terminal-session-activity-runtime';

export const SESSION_AGENT_HEARTBEAT_MAX_AGE_MS = 30_000;
export type DaemonSessionAgentStatusKind = 'running' | 'idle' | 'unknown' | 'error';
export interface DaemonSessionAgentStatus {
  kind: DaemonSessionAgentStatusKind;
  agentName?: string;
  reason: string;
}

export const SESSION_AGENT_OPTIONS = {
  name: '@zterm_agent_name',
  state: '@zterm_agent_state',
  heartbeatMs: '@zterm_agent_heartbeat_ms',
} as const;

export interface DaemonSessionCatalogDeps {
  listTmuxSessions: (backend?: 'tmux' | 'herdr') => string[];
  listTerminalSessions?: () => string[];
  listTerminalSessionCatalog?: () => TerminalSessionCatalogEntry[];
  readTmuxSessionAgentOption?: (sessionName: string, option: string) => string | null;
}

export interface DaemonSessionCatalogRuntimeDeps extends DaemonSessionCatalogDeps {
  mirrors: ReadonlyMap<string, SessionMirror>;
  sendTransportMessage: (
    transport: TerminalSessionTransport | null | undefined,
    message: TerminalTransportServerFrame,
  ) => void;
}

export function probeDaemonSessionAgentStatus(options: {
  sessionName: string;
  nowMs: number;
  sessionExists: boolean;
  readOption?: (option: string) => string | null;
}): DaemonSessionAgentStatus {
  if (!options.sessionExists) {
    return { kind: 'unknown', reason: 'session_disappeared' };
  }
  if (!options.readOption) {
    return { kind: 'unknown', reason: 'agent_registration_absent' };
  }
  let name: string | null;
  let state: string | null;
  let heartbeatRaw: string | null;
  try {
    name = options.readOption(SESSION_AGENT_OPTIONS.name)?.trim() || null;
    state = options.readOption(SESSION_AGENT_OPTIONS.state)?.trim() || null;
    heartbeatRaw = options.readOption(SESSION_AGENT_OPTIONS.heartbeatMs)?.trim() || null;
  } catch (error) {
    return { kind: 'error', reason: `agent_registration_read_failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!name) return { kind: 'unknown', reason: 'agent_registration_absent' };
  if (state !== 'running' && state !== 'idle') {
    return { kind: 'error', agentName: name, reason: 'agent_registration_state_invalid' };
  }
  if (!heartbeatRaw || !/^\d+$/u.test(heartbeatRaw)) {
    return { kind: 'error', agentName: name, reason: 'agent_registration_heartbeat_invalid' };
  }
  const heartbeatMs = Number(heartbeatRaw);
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs > options.nowMs) {
    return { kind: 'error', agentName: name, reason: 'agent_registration_heartbeat_invalid' };
  }
  if (options.nowMs - heartbeatMs > SESSION_AGENT_HEARTBEAT_MAX_AGE_MS) {
    return { kind: 'unknown', agentName: name, reason: 'stale_heartbeat' };
  }
  return { kind: state, agentName: name, reason: 'fresh_agent_registration' };
}

export function buildSessionsCatalogPayload(
  deps: DaemonSessionCatalogDeps,
  backend?: 'tmux' | 'herdr',
) {
  if (backend) {
    const sessions = deps.listTmuxSessions(backend);
    return {
      sessions,
      sessionCatalog: sessions.map((name) => ({ name, backend })),
    };
  }
  if (deps.listTerminalSessionCatalog) {
    const sessionCatalog = deps.listTerminalSessionCatalog();
    return {
      sessions: sessionCatalog.map((entry) => entry.name),
      sessionCatalog,
    };
  }
  const sessions = deps.listTerminalSessions ? deps.listTerminalSessions() : deps.listTmuxSessions();
  return {
    sessions,
    sessionCatalog: sessions.map((name) => ({ name, backend: 'tmux' as const })),
  };
}

export function handleListSessionsMessageRuntime(
  deps: DaemonSessionCatalogRuntimeDeps,
  connection: TerminalTransportConnection,
  message: { type: 'list-sessions'; payload?: { terminalBackend?: 'tmux' | 'herdr' } } = { type: 'list-sessions' },
) {
  try {
    const payload = buildSessionsCatalogPayload(deps, message.payload?.terminalBackend);
    deps.sendTransportMessage(connection.transport, { type: 'sessions', payload });
    publishSessionActivitiesRuntime({
      connection,
      mirrors: deps.mirrors,
      now: Date.now(),
      sendTransportMessage: deps.sendTransportMessage,
    });
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    deps.sendTransportMessage(connection.transport, {
      type: 'error',
      payload: { message: `Failed to list tmux sessions: ${err}`, code: 'list_sessions_failed' },
    });
  }
}
