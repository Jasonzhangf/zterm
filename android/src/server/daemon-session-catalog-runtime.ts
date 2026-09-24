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
import {
  readDaemonSessionObservations,
  type DaemonProcessGroupObservation,
} from './daemon-session-agent-status-runtime';

export interface DaemonSessionCatalogDeps {
  listTmuxSessions: (backend?: 'tmux' | 'herdr') => string[];
  listTerminalSessions?: () => string[];
  listTerminalSessionCatalog?: () => TerminalSessionCatalogEntry[];
  runTmuxAsync?: (args: string[]) => Promise<{ ok: true; stdout: string }>;
  runTmuxAsyncAcrossSockets?: (args: string[]) => Promise<{ ok: true; stdout: string }>;
  runTmuxAsyncForSession?: (args: string[], sessionName: string) => Promise<{ ok: true; stdout: string }>;
  readProcessGroup?: (
    pid: string,
  ) => DaemonProcessGroupObservation | undefined | Promise<DaemonProcessGroupObservation | undefined>;
  observationHistory?: Map<string, import('./daemon-session-agent-status-runtime').DaemonSessionObservationHistoryEntry>;
}

export interface DaemonSessionCatalogRuntime {
  read: (backend?: 'tmux' | 'herdr') => TerminalSessionCatalogEntry[];
  refresh: (
    backend?: 'tmux' | 'herdr',
    detectedEntries?: TerminalSessionCatalogEntry[],
  ) => Promise<TerminalSessionCatalogEntry[]>;
  startRefreshLoop: (
    intervalMs?: number,
    refresh?: (entries?: TerminalSessionCatalogEntry[]) => Promise<TerminalSessionCatalogEntry[]>,
  ) => void;
  dispose: () => void;
}

export const DAEMON_SESSION_CATALOG_REFRESH_INTERVAL_MS = 5_000;

export interface DaemonSessionCatalogRuntimeDeps extends DaemonSessionCatalogDeps {
  mirrors: ReadonlyMap<string, SessionMirror>;
  sendTransportMessage: (
    transport: TerminalSessionTransport | null | undefined,
    message: TerminalTransportServerFrame,
  ) => void;
}

export function createDaemonSessionCatalogRuntime(
  deps: DaemonSessionCatalogDeps,
): DaemonSessionCatalogRuntime {
  let snapshot: TerminalSessionCatalogEntry[] | null = null;
  let invalidated = false;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let refreshInFlight: Promise<TerminalSessionCatalogEntry[]> | null = null;

  function enumerate() {
    if (deps.listTerminalSessionCatalog) {
      return deps.listTerminalSessionCatalog();
    }
    const sessions = deps.listTerminalSessions ? deps.listTerminalSessions() : deps.listTmuxSessions();
    return sessions.map((name) => ({ name, backend: 'tmux' as const }));
  }

  async function sampleObservations(entries: TerminalSessionCatalogEntry[]) {
    if (!deps.runTmuxAsync) {
      return entries.map((entry) => ({ ...entry }));
    }
    if (!deps.runTmuxAsyncForSession) {
      throw new Error('daemon session catalog sampling requires runTmuxAsyncForSession so session-scoped tmux reads resolve the owning socket');
    }
    if (!deps.runTmuxAsyncAcrossSockets) {
      throw new Error('daemon session catalog sampling requires runTmuxAsyncAcrossSockets so global pane reads span every live tmux socket');
    }
    const tmuxEntries = entries.filter((entry) => entry.backend === 'tmux');
    const observations = await readDaemonSessionObservations(
      {
        runTmuxAsyncAcrossSockets: deps.runTmuxAsyncAcrossSockets,
        runTmuxAsyncForSession: deps.runTmuxAsyncForSession,
        history: deps.observationHistory,
        readProcessGroup: deps.readProcessGroup,
      },
      tmuxEntries.map((entry) => entry.name),
      Date.now(),
    );
    return entries.map((entry) => {
      const observation = entry.backend === 'tmux' ? observations.get(entry.name) : undefined;
      return observation ? { ...entry, observation } : { ...entry };
    });
  }

  function rebuild(
    backend?: 'tmux' | 'herdr',
    detectedEntries?: TerminalSessionCatalogEntry[],
  ): Promise<TerminalSessionCatalogEntry[]> {
    if (refreshInFlight) {
      return refreshInFlight.then(() => read(backend), () => read(backend));
    }
    refreshInFlight = (async () => {
      let entries: TerminalSessionCatalogEntry[];
      if (detectedEntries) {
        entries = detectedEntries;
      } else {
        try {
          entries = enumerate();
        } catch (error) {
          snapshot = null;
          invalidated = true;
          throw error;
        }
      }
      if (snapshot === null) {
        // Cold start: there is no last complete snapshot to preserve, so the
        // real enumerated session list is published immediately and the
        // sampled candidate replaces it when sampling commits.
        snapshot = entries.map((entry) => ({ ...entry }));
      }
      let candidate: TerminalSessionCatalogEntry[];
      try {
        candidate = await sampleObservations(entries);
      } catch (error) {
        // Enumeration already produced the real session list; a failed
        // observation sample must not hide live sessions or surface as a
        // catalog failure to the caller. Publish the enumeration-only
        // candidate explicitly instead of leaving a partially refreshed
        // snapshot resident.
        console.warn(
          `[daemon.session_catalog] observation sampling failed; publishing enumeration-only snapshot: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        candidate = entries.map((entry) => ({ ...entry }));
      }
      // Publish only after the candidate is complete so an in-flight cadence
      // refresh keeps serving the last complete snapshot. The cold-start
      // publication above is the only enumeration-only read window.
      snapshot = candidate;
      invalidated = false;
      return read(backend);
    })().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  function read(backend?: 'tmux' | 'herdr') {
    if (invalidated) {
      throw new Error('daemon session catalog is stale; explicit refresh required');
    }
    if (!snapshot) {
      throw new Error('daemon session catalog is not initialized; explicit refresh required');
    }
    const current = snapshot;
    return (backend ? current.filter((entry) => entry.backend === backend) : current)
      .map((entry) => (
        entry.observation
          ? { ...entry, observation: { ...entry.observation } }
          : { ...entry }
      ));
  }

  return {
    read,
    refresh: rebuild,
    startRefreshLoop(
      intervalMs = DAEMON_SESSION_CATALOG_REFRESH_INTERVAL_MS,
      refresh = (entries) => rebuild(undefined, entries),
    ) {
      if (refreshTimer) {
        return;
      }
      refreshTimer = setInterval(() => {
        if (refreshInFlight) {
          return;
        }
        let entries: TerminalSessionCatalogEntry[];
        try {
          entries = enumerate();
        } catch (error) {
          console.warn(
            `[daemon.session_catalog] new-session detection failed; keeping resident snapshot: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return;
        }
        const residentIdentities = new Set(
          snapshot?.map((entry) => `${entry.backend}:${entry.name}`) ?? [],
        );
        const detectedIdentities = new Set(
          entries.map((entry) => `${entry.backend}:${entry.name}`),
        );
        const hasCatalogMembershipChange = residentIdentities.size !== detectedIdentities.size
          || [...residentIdentities].some((identity) => !detectedIdentities.has(identity));
        if (snapshot && !hasCatalogMembershipChange) {
          return;
        }
        void refresh(entries).catch((error) => {
          console.warn(
            `[daemon.session_catalog] new-session refresh failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }, intervalMs);
      refreshTimer.unref?.();
    },
    dispose() {
      if (!refreshTimer) {
        return;
      }
      clearInterval(refreshTimer);
      refreshTimer = null;
    },
  };
}

export function buildSessionsCatalogPayload(
  deps: DaemonSessionCatalogDeps,
  backend?: 'tmux' | 'herdr',
) {
  // Pure read-time projection: the daemon session catalog owner already sampled
  // passive observation into its resident snapshot.
  if (backend) {
    if (!deps.listTerminalSessionCatalog) {
      throw new Error('backend session catalog requires daemon-owned terminal session catalog');
    }
    const sessionCatalog = deps.listTerminalSessionCatalog()
      .filter((entry) => entry.backend === backend);
    return {
      sessions: sessionCatalog.map((entry) => entry.name),
      sessionCatalog,
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
