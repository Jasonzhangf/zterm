import type {
  TerminalSessionAgentStatus,
  TerminalSessionCatalogEntry,
  TerminalSessionAgentStatusKind,
  TerminalTransportServerFrame,
} from '@zterm/shared/protocol';
import type {
  SessionMirror,
  TerminalSessionTransport,
  TerminalTransportConnection,
} from './terminal-runtime-types';
import { publishSessionActivitiesRuntime } from './terminal-session-activity-runtime';

export interface DaemonSessionCatalogDeps {
  listTmuxSessions: (backend?: 'tmux' | 'herdr') => string[];
  listTerminalSessions?: () => string[];
  listTerminalSessionCatalog?: () => TerminalSessionCatalogEntry[];
  probeSessionAgentStatus?: (entry: TerminalSessionCatalogEntry) => TerminalSessionAgentStatus;
}

export interface DaemonSessionCatalogRuntimeDeps extends DaemonSessionCatalogDeps {
  mirrors: ReadonlyMap<string, SessionMirror>;
  sendTransportMessage: (
    transport: TerminalSessionTransport | null | undefined,
    message: TerminalTransportServerFrame,
  ) => void;
}

export function buildSessionsCatalogPayload(
  deps: DaemonSessionCatalogDeps,
  backend?: 'tmux' | 'herdr',
) {
  const addAgentStatus = (entries: TerminalSessionCatalogEntry[]) => entries.map((entry) => ({
    ...entry,
    ...(deps.probeSessionAgentStatus ? { agent: deps.probeSessionAgentStatus(entry) } : {}),
  }));
  if (backend) {
    const sessions = deps.listTmuxSessions(backend);
    return {
      sessions,
      sessionCatalog: addAgentStatus(sessions.map((name) => ({ name, backend }))),
    };
  }
  if (deps.listTerminalSessionCatalog) {
    const sessionCatalog = addAgentStatus(deps.listTerminalSessionCatalog());
    return {
      sessions: sessionCatalog.map((entry) => entry.name),
      sessionCatalog,
    };
  }
  const sessions = deps.listTerminalSessions ? deps.listTerminalSessions() : deps.listTmuxSessions();
  return {
    sessions,
    sessionCatalog: addAgentStatus(sessions.map((name) => ({ name, backend: 'tmux' as const }))),
  };
}

type HerdrAgentStatusPayload = {
  agent?: string;
  agent_session?: string;
  agent_status?: string;
  pane_id?: string;
  session_name?: string;
  session?: string;
  name?: string;
};

function collectHerdrPanes(value: unknown, result: HerdrAgentStatusPayload[] = []) {
  if (!value || typeof value !== 'object') return result;
  if ('pane_id' in value || 'paneId' in value) {
    const pane = value as HerdrAgentStatusPayload & { paneId?: string; agentStatus?: string; agentSession?: string };
    result.push({
      ...pane,
      pane_id: pane.pane_id || pane.paneId,
      agent_status: pane.agent_status || pane.agentStatus,
      agent_session: pane.agent_session || pane.agentSession,
    });
  }
  for (const child of Object.values(value)) collectHerdrPanes(child, result);
  return result;
}

function normalizeHerdrAgentStatus(status: string | undefined): TerminalSessionAgentStatusKind {
  if (status === 'working') return 'running';
  if (status === 'idle' || status === 'done') return 'idle';
  return 'unknown';
}

export function probeHerdrSessionAgentStatus(options: {
  entry: TerminalSessionCatalogEntry;
  runCommand: (command: string, args: string[]) => { stdout?: unknown };
  executable: string;
}): TerminalSessionAgentStatus {
  if (options.entry.backend !== 'herdr') {
    return { kind: 'unknown', reason: 'agent_status_not_available_for_backend' };
  }
  let snapshot: unknown;
  try {
    const result = options.runCommand(options.executable, ['api', 'snapshot']);
    snapshot = JSON.parse(String(result.stdout || ''));
  } catch (error) {
    return {
      kind: 'error',
      reason: `herdr_agent_status_probe_failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (snapshot && typeof snapshot === 'object' && 'error' in snapshot) {
    const probeError = (snapshot as { error?: { code?: string; message?: string } }).error;
    return {
      kind: 'error',
      reason: `herdr_agent_status_probe_failed: ${probeError?.code || probeError?.message || 'api_error'}`,
    };
  }
  const pane = collectHerdrPanes(snapshot).find((candidate) => (
    candidate.agent_session === options.entry.name
      || candidate.session_name === options.entry.name
      || candidate.session === options.entry.name
      || candidate.name === options.entry.name
  ));
  if (!pane || !pane.agent) {
    return { kind: 'unknown', reason: 'herdr_agent_identity_unresolved' };
  }
  return {
    kind: normalizeHerdrAgentStatus(pane.agent_status),
    name: pane.agent,
    ...(pane.agent_session ? { session: pane.agent_session } : {}),
    ...(!pane.agent_status ? { reason: 'herdr_agent_status_unreported' } : {}),
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
