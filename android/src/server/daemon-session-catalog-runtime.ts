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
import { readDaemonSessionObservation } from './daemon-session-agent-status-runtime';

export interface DaemonSessionCatalogDeps {
  listTmuxSessions: (backend?: 'tmux' | 'herdr') => string[];
  listTerminalSessions?: () => string[];
  listTerminalSessionCatalog?: () => TerminalSessionCatalogEntry[];
  runTmux?: (args: string[]) => { ok: true; stdout: string } | { ok: false; error: string };
  readProcessGroup?: (pid: string) => { groupId: string; alive: boolean } | undefined;
  observationHistory?: Map<string, import('./daemon-session-agent-status-runtime').DaemonSessionObservationHistoryEntry>;
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
  const observe = (entries: TerminalSessionCatalogEntry[]) => entries.map((entry) => ({
    ...entry,
    ...(deps.runTmux && entry.backend === 'tmux'
      ? { observation: readDaemonSessionObservation({ runTmux: deps.runTmux!, history: deps.observationHistory, readProcessGroup: deps.readProcessGroup }, entry.name, Date.now()) }
      : {}),
  }));
  if (backend) {
    if (!deps.listTerminalSessionCatalog) {
      throw new Error('backend session catalog requires daemon-owned terminal session catalog');
    }
    const sessionCatalog = observe(
      deps.listTerminalSessionCatalog().filter((entry) => entry.backend === backend),
    );
    return {
      sessions: sessionCatalog.map((entry) => entry.name),
      sessionCatalog,
    };
  }
  if (deps.listTerminalSessionCatalog) {
    const sessionCatalog = observe(deps.listTerminalSessionCatalog());
    return {
      sessions: sessionCatalog.map((entry) => entry.name),
      sessionCatalog,
    };
  }
  const sessions = deps.listTerminalSessions ? deps.listTerminalSessions() : deps.listTmuxSessions();
  return {
    sessions,
    sessionCatalog: observe(sessions.map((name) => ({ name, backend: 'tmux' as const }))),
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
