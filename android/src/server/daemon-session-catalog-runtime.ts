import type {
  TerminalSessionCollabProjection,
  TerminalSessionCatalogEntry,
  TerminalTransportServerFrame,
} from '@zterm/shared/protocol';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
import { buildTmuxSessionStableId } from './terminal-source-adapter';

export interface DaemonSessionCatalogDeps {
  listTmuxSessions: (backend?: 'tmux' | 'herdr') => string[];
  listTerminalSessions?: () => string[];
  listTerminalSessionCatalog?: () => TerminalSessionCatalogEntry[];
  runTmuxAsyncAcrossSockets?: (args: string[]) => Promise<{ ok: true; stdout: string }>;
  runTmuxAsyncForSession?: (args: string[], sessionName: string) => Promise<{ ok: true; stdout: string }>;
  readProcessGroup?: (
    pid: string,
  ) => DaemonProcessGroupObservation | undefined | Promise<DaemonProcessGroupObservation | undefined>;
  observationHistory?: Map<string, import('./daemon-session-agent-status-runtime').DaemonSessionObservationHistoryEntry>;
  /**
   * Read-only Collab projection. The default implementation executes
   * `collab who` in the session cwd. Tests inject a deterministic reader.
   */
  runCollabWho?: (input: { cwd: string }) => Promise<unknown>;
  /**
   * Called after the collab-only cadence resample commits a new resident
   * snapshot so the server can republish the relay directory. This keeps the
   * resample path from silently changing classifications that phone clients
   * never see.
   */
  onCatalogResampled?: () => void;
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
export const DAEMON_COLLAB_PROJECTION_CACHE_MS = 15_000;

export interface DaemonSessionCatalogRuntimeDeps extends DaemonSessionCatalogDeps {
  mirrors: ReadonlyMap<string, SessionMirror>;
  sendTransportMessage: (
    transport: TerminalSessionTransport | null | undefined,
    message: TerminalTransportServerFrame,
  ) => void;
}

function findAmbiguousTmuxNames(entries: readonly TerminalSessionCatalogEntry[]) {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.backend !== 'tmux') continue;
    counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  }
  const ambiguous = new Set<string>();
  for (const [name, count] of counts) {
    if (count > 1) ambiguous.add(name);
  }
  return ambiguous;
}

function withoutObservation(entry: TerminalSessionCatalogEntry): TerminalSessionCatalogEntry {
  if (!entry.observation) {
    return { ...entry };
  }
  const clone = { ...entry };
  delete clone.observation;
  return clone;
}

function stripAmbiguousObservations(entries: readonly TerminalSessionCatalogEntry[]) {
  const ambiguous = findAmbiguousTmuxNames(entries);
  return entries.map((entry) => (
    entry.backend === 'tmux' && ambiguous.has(entry.name)
      ? withoutObservation(entry)
      : { ...entry }
  ));
}

interface CollabWorkerProjection extends TerminalSessionCollabProjection {
  endpoint?: string;
  namespace: string;
}

interface TmuxSessionIdentity {
  sessionId: string;
  name: string;
  socketPath?: string;
  /** Canonical native target identity when pid + created-at are available. */
  stableId?: string;
}

function parseCollabWorkers(raw: unknown): CollabWorkerProjection[] {
  if (!raw || typeof raw !== 'object') {
    return [];
  }
  const workers = (raw as { workers?: unknown }).workers;
  if (!Array.isArray(workers)) {
    return [];
  }
  const parsed: CollabWorkerProjection[] = [];
  for (const candidate of workers) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }
    const worker = candidate as {
      role?: unknown;
      display_name?: unknown;
      agent_state?: unknown;
      transport?: { kind?: unknown; endpoint?: unknown; namespace?: unknown };
    };
    if (worker.transport?.kind !== 'tmux') {
      continue;
    }
    const namespace = typeof worker.transport.namespace === 'string'
      ? worker.transport.namespace.trim()
      : '';
    const displayName = typeof worker.display_name === 'string'
      ? worker.display_name.trim()
      : '';
    if (!namespace || !displayName) {
      continue;
    }
    const role = worker.role === 'master' || worker.role === 'worker'
      ? worker.role
      : null;
    if (!role) {
      continue;
    }
    parsed.push({
      role,
      displayName,
      namespace,
      ...(typeof worker.agent_state === 'string' && worker.agent_state.trim()
        ? { agentState: worker.agent_state.trim() }
        : {}),
      ...(typeof worker.transport.endpoint === 'string' && worker.transport.endpoint.trim()
        ? { endpoint: worker.transport.endpoint.trim() }
        : {}),
    });
  }
  return parsed;
}

function parseTmuxSessionIdentities(stdout: string): TmuxSessionIdentity[] {
  const identities: TmuxSessionIdentity[] = [];
  for (const line of stdout.split('\n')) {
    const [sessionId, name, socketPath, serverPid, createdAtRaw] = line.split('\t');
    const normalizedId = sessionId?.trim();
    const normalizedName = name?.trim();
    if (!normalizedId || !normalizedName) {
      continue;
    }
    const normalizedSocketPath = socketPath?.trim() || undefined;
    const normalizedServerPid = serverPid?.trim() || '';
    const createdAt = Number.parseInt(createdAtRaw ?? '', 10);
    const stableId = normalizedServerPid && Number.isFinite(createdAt)
      ? buildTmuxSessionStableId({
          ...(normalizedSocketPath ? { socketPath: normalizedSocketPath } : {}),
          serverPid: normalizedServerPid,
          sessionId: normalizedId,
          createdAt,
        })
      : undefined;
    identities.push({
      sessionId: normalizedId,
      name: normalizedName,
      ...(normalizedSocketPath ? { socketPath: normalizedSocketPath } : {}),
      ...(stableId ? { stableId } : {}),
    });
  }
  return identities;
}

function resolveCollabBinary() {
  const override = process.env.ZTERM_COLLAB_BINARY?.trim();
  if (override) {
    return override;
  }
  const candidates = [
    join(homedir(), '.cargo/bin/collab'),
    '/opt/homebrew/bin/collab',
    '/usr/local/bin/collab',
    '/usr/bin/collab',
  ];
  return candidates.find((candidate) => existsSync(candidate)) || 'collab';
}

function runCollabWhoDefault(input: { cwd: string }): Promise<unknown> {
  if (!input.cwd || !existsSync(input.cwd)) {
    return Promise.resolve({ workers: [] });
  }
  const binary = resolveCollabBinary();
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      ['who'],
      {
        cwd: input.cwd,
        timeout: 2_000,
        maxBuffer: 1_000_000,
        windowsHide: true,
        env: process.env,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          resolve(JSON.parse(stdout) as unknown);
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

function withoutCollab(entry: TerminalSessionCatalogEntry): TerminalSessionCatalogEntry {
  if (!entry.collab) {
    return { ...entry };
  }
  const clone = { ...entry };
  delete clone.collab;
  return clone;
}

interface CollabProjectionSample {
  projection: Map<string, TerminalSessionCollabProjection>;
  ok: boolean;
}

/**
 * Native identity key for a tmux catalog row. The stable id (socket + server
 * pid + session id + created-at) is the catalog's exact native target
 * identity; a name-only key is a last-resort fallback for rows that predate
 * stable ids. Cached projections are bound to this key so a reused cache can
 * only apply to the target that was actually observed.
 */
function nativeTmuxKey(entry: TerminalSessionCatalogEntry): string {
  return `tmux:${entry.stableId ?? `name:${entry.name}`}`;
}

export function createDaemonSessionCatalogRuntime(
  deps: DaemonSessionCatalogDeps,
): DaemonSessionCatalogRuntime {
  let snapshot: TerminalSessionCatalogEntry[] | null = null;
  let invalidated = false;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let refreshInFlight: Promise<TerminalSessionCatalogEntry[]> | null = null;
  let collabProjectionCache = new Map<string, TerminalSessionCollabProjection>();
  let collabProjectionCacheKeySignature: string | null = null;
  let collabProjectionSampledAt = 0;
  let collabProjectionInFlight: Promise<CollabProjectionSample> | null = null;

  function enumerate() {
    if (deps.listTerminalSessionCatalog) {
      return deps.listTerminalSessionCatalog();
    }
    const sessions = deps.listTerminalSessions ? deps.listTerminalSessions() : deps.listTmuxSessions();
    return sessions.map((name) => ({ name, backend: 'tmux' as const }));
  }

  async function sampleObservations(entries: TerminalSessionCatalogEntry[]) {
    const ambiguousTmuxNames = findAmbiguousTmuxNames(entries);
    if (!deps.runTmuxAsyncForSession && !deps.runTmuxAsyncAcrossSockets) {
      return stripAmbiguousObservations(entries);
    }
    if (!deps.runTmuxAsyncForSession) {
      throw new Error('daemon session catalog sampling requires runTmuxAsyncForSession so session-scoped tmux reads resolve the owning socket');
    }
    if (!deps.runTmuxAsyncAcrossSockets) {
      throw new Error('daemon session catalog sampling requires runTmuxAsyncAcrossSockets so global pane reads span every live tmux socket');
    }
    // The observation sampler is keyed by tmux session name. When the catalog
    // exposes multiple stable targets with the same display name, a name-keyed
    // observation cannot prove which target it belongs to, so omit it rather
    // than stamping one target's facts onto its sibling.
    const sampleNames = [
      ...new Set(
        entries
          .filter((entry) => entry.backend === 'tmux' && !ambiguousTmuxNames.has(entry.name))
          .map((entry) => entry.name),
      ),
    ];
    const observations = await readDaemonSessionObservations(
      {
        runTmuxAsyncAcrossSockets: deps.runTmuxAsyncAcrossSockets,
        runTmuxAsyncForSession: deps.runTmuxAsyncForSession,
        history: deps.observationHistory,
        readProcessGroup: deps.readProcessGroup,
      },
      sampleNames,
      Date.now(),
    );
    return entries.map((entry) => {
      if (entry.backend !== 'tmux') {
        return { ...entry };
      }
      if (ambiguousTmuxNames.has(entry.name)) {
        return withoutObservation(entry);
      }
      const observation = observations.get(entry.name);
      return observation ? { ...withoutObservation(entry), observation } : withoutObservation(entry);
    });
  }

  function attachCollabProjection(
    entries: TerminalSessionCatalogEntry[],
    projection: Map<string, TerminalSessionCollabProjection>,
  ) {
    // A stable-id keyed match is the exact observed native target and keeps
    // its role even when another row shares the display name. A name-keyed
    // fallback cannot survive ambiguity: once a same-name target appears, the
    // cached name key no longer identifies one native target.
    const ambiguousNames = findAmbiguousTmuxNames(entries);
    return entries.map((entry) => {
      if (entry.backend !== 'tmux') {
        return withoutCollab(entry);
      }
      const collab = projection.get(nativeTmuxKey(entry));
      if (entry.stableId) {
        return collab
          ? { ...withoutCollab(entry), collab: { ...collab } }
          : withoutCollab(entry);
      }
      return ambiguousNames.has(entry.name)
        ? withoutCollab(entry)
        : collab
          ? { ...withoutCollab(entry), collab: { ...collab } }
          : withoutCollab(entry);
    });
  }

  async function sampleCollabProjection(
    entries: TerminalSessionCatalogEntry[],
  ): Promise<TerminalSessionCatalogEntry[]> {
    if (collabProjectionSampledAt > 0
      && Date.now() - collabProjectionSampledAt < DAEMON_COLLAB_PROJECTION_CACHE_MS) {
      if (collabProjectionCacheKeySignature !== buildCatalogNativeKeySignature(entries)) {
        // The roster changed but the cache window is still open. The cached
        // projection is bound to the prior native identity set and must not be
        // replayed onto a new roster; invalidate it now so this attachment
        // yields no stale role and the next cadence tick samples fresh.
        collabProjectionCache = new Map();
        collabProjectionCacheKeySignature = null;
        collabProjectionSampledAt = 0;
        return attachCollabProjection(entries, new Map());
      }
      return attachCollabProjection(entries, collabProjectionCache);
    }
    if (collabProjectionInFlight) {
      const sample = await collabProjectionInFlight;
      return attachCollabProjection(entries, sample.projection);
    }
    collabProjectionInFlight = (async (): Promise<CollabProjectionSample> => {
      const ambiguousNames = findAmbiguousTmuxNames(entries);
      const entriesByStableId = new Map<string, TerminalSessionCatalogEntry>();
      const entriesByName = new Map<string, TerminalSessionCatalogEntry[]>();
      for (const entry of entries) {
        if (entry.backend !== 'tmux') {
          continue;
        }
        if (entry.stableId) {
          entriesByStableId.set(entry.stableId, entry);
        }
        const group = entriesByName.get(entry.name) ?? [];
        group.push(entry);
        entriesByName.set(entry.name, group);
      }
      // Resolve a live tmux identity to its exact catalog row. Never let a
      // display name rescue a target whose exact identity differs: if the live
      // identity carries a stable id that does not match a catalog row, the row
      // is unclassified. A name-only match is allowed only when the identity
      // itself has no stable id AND the name is unique and unambiguous.
      const resolveCatalogEntry = (
        identity: TmuxSessionIdentity,
      ): TerminalSessionCatalogEntry | null => {
        if (identity.stableId) {
          return entriesByStableId.get(identity.stableId) ?? null;
        }
        const byName = entriesByName.get(identity.name);
        if (byName && byName.length === 1 && !ambiguousNames.has(identity.name)) {
          return byName[0]!;
        }
        return null;
      };

      const cwdByName = new Map<string, string>();
      for (const entry of entries) {
        if (
          entry.backend !== 'tmux'
          || !entry.cwd?.trim()
          || cwdByName.has(entry.name)
        ) {
          continue;
        }
        cwdByName.set(entry.name, entry.cwd.trim());
      }
      if (cwdByName.size === 0 || !deps.runTmuxAsyncAcrossSockets) {
        // No way to observe this round: publish nothing rather than reuse an
        // obsolete classification.
        return { projection: new Map(), ok: false };
      }

      let identities: TmuxSessionIdentity[] = [];
      try {
        const listed = await deps.runTmuxAsyncAcrossSockets([
          'list-sessions',
          '-F',
          '#{session_id}\t#{session_name}\t#{socket_path}\t#{pid}\t#{session_created}',
        ]);
        identities = parseTmuxSessionIdentities(listed.stdout);
      } catch {
        identities = [];
      }
      if (identities.length === 0) {
        return { projection: new Map(), ok: false };
      }
      const identitiesByKey = new Map<string, TmuxSessionIdentity>();
      const identitiesBySessionId = new Map<string, TmuxSessionIdentity[]>();
      for (const identity of identities) {
        identitiesByKey.set(`${identity.sessionId}\u0000${identity.socketPath || ''}`, identity);
        const group = identitiesBySessionId.get(identity.sessionId) || [];
        group.push(identity);
        identitiesBySessionId.set(identity.sessionId, group);
      }

      const runCollabWho = deps.runCollabWho || runCollabWhoDefault;
      const uniqueCwds = [...new Set(cwdByName.values())];
      // Group observations by the native catalog identity before checking
      // conflicts. The same registered worker observed from several session
      // CWDs must collapse to one observation; only genuinely distinct or
      // conflicting registrations for one target stay unclassified.
      const observationsByNativeKey = new Map<string, TerminalSessionCollabProjection[]>();
      const failedCwds = new Set<string>();
      let collabWhoFailed = false;
      await Promise.all(uniqueCwds.map(async (cwd) => {
        let raw: unknown;
        try {
          raw = await runCollabWho({ cwd });
        } catch (error) {
          collabWhoFailed = true;
          failedCwds.add(cwd);
          console.warn(
            `[daemon.session_catalog] collab projection unavailable for ${cwd}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return;
        }
        for (const worker of parseCollabWorkers(raw)) {
          // A supplied endpoint is authoritative: without a socket-qualified
          // match the target is unknown, so never fall back to a same-namespace
          // session on a different tmux socket.
          const direct = worker.endpoint
            ? identitiesByKey.get(`${worker.namespace}\u0000${worker.endpoint}`)
            : undefined;
          const candidates = identitiesBySessionId.get(worker.namespace) || [];
          const identity = worker.endpoint
            ? direct
            : (candidates.length === 1 ? candidates[0] : undefined);
          if (!identity) {
            continue;
          }
          const entry = resolveCatalogEntry(identity);
          if (!entry || (entry.cwd?.trim() && failedCwds.has(entry.cwd.trim()))) {
            continue;
          }
          const key = nativeTmuxKey(entry);
          const group = observationsByNativeKey.get(key) || [];
          group.push({
            role: worker.role,
            displayName: worker.displayName,
            ...(worker.agentState ? { agentState: worker.agentState } : {}),
          });
          observationsByNativeKey.set(key, group);
        }
      }));

      const failedNativeKeys = new Set<string>();
      if (failedCwds.size > 0) {
        for (const entry of entries) {
          if (entry.backend === 'tmux' && entry.cwd?.trim() && failedCwds.has(entry.cwd.trim())) {
            failedNativeKeys.add(nativeTmuxKey(entry));
          }
        }
      }

      const next = new Map<string, TerminalSessionCollabProjection>();
      for (const [key, observations] of observationsByNativeKey) {
        if (failedNativeKeys.has(key)) {
          continue;
        }
        const distinct = new Map<string, TerminalSessionCollabProjection>();
        for (const observation of observations) {
          distinct.set(
            `${observation.role}\u0000${observation.displayName}\u0000${observation.agentState ?? ''}`,
            observation,
          );
        }
        if (distinct.size !== 1) {
          continue;
        }
        next.set(key, distinct.values().next().value!);
      }
      return { projection: next, ok: !collabWhoFailed };
    })().then((sample) => {
      collabProjectionCache = sample.projection;
      collabProjectionCacheKeySignature = sample.ok
        ? buildCatalogNativeKeySignature(entries)
        : null;
      // Renew the TTL only on a successful sample so a failure is retried on
      // the next cadence tick instead of waiting out the full cache window.
      collabProjectionSampledAt = sample.ok ? Date.now() : 0;
      return sample;
    }).catch((error) => {
      collabProjectionCache = new Map();
      collabProjectionCacheKeySignature = null;
      collabProjectionSampledAt = 0;
      console.warn(
        `[daemon.session_catalog] collab projection sampling failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { projection: new Map(), ok: false } satisfies CollabProjectionSample;
    }).finally(() => {
      collabProjectionInFlight = null;
    });
    const sample = await collabProjectionInFlight;
    return attachCollabProjection(entries, sample.projection);
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
        snapshot = stripAmbiguousObservations(entries);
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
        candidate = stripAmbiguousObservations(entries);
      }
      candidate = await sampleCollabProjection(candidate);
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

  // Collab-only refresh: re-sample the projection at most once per cache TTL
  // without re-running process observation. Used by the cadence loop so a
  // worker that registers inside an already-open tmux session, a role change,
  // or a Collab daemon restart is not left unclassified until the next
  // membership change. Publishes a new resident snapshot only when the
  // projected map actually differs; on failure the prior projection is kept.
  async function resampleCollabProjection(): Promise<void> {
    if (!snapshot) {
      return;
    }
    const current = snapshot;
    const priorProjection = new Map<string, TerminalSessionCollabProjection>();
    for (const entry of current) {
      if (entry.collab) {
        priorProjection.set(entry.name, entry.collab);
      }
    }
    const nextEntries = await sampleCollabProjection(current);
    // A membership refresh may have replaced the snapshot while we sampled.
    // Do not overwrite that newer catalog with an attachment of the old rows.
    if (snapshot !== current) {
      return;
    }
    const nextProjection = new Map<string, TerminalSessionCollabProjection>();
    for (const entry of nextEntries) {
      if (entry.collab) {
        nextProjection.set(entry.name, entry.collab);
      }
    }
    if (projectionsEqual(priorProjection, nextProjection)) {
      return;
    }
    snapshot = nextEntries;
    invalidated = false;
    // The resident catalog changed without a membership refresh, so the
    // server must republish the relay directory or phone clients keep the
    // stale role until something else triggers a publish.
    deps.onCatalogResampled?.();
  }

  function projectionsEqual(
    a: Map<string, TerminalSessionCollabProjection>,
    b: Map<string, TerminalSessionCollabProjection>,
  ): boolean {
    if (a.size !== b.size) {
      return false;
    }
    for (const [name, projection] of a) {
      const other = b.get(name);
      if (!other) {
        return false;
      }
      if (
        other.role !== projection.role
        || other.displayName !== projection.displayName
        || other.agentState !== projection.agentState
      ) {
        return false;
      }
    }
    return true;
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
          ? {
              ...entry,
              observation: { ...entry.observation },
              ...(entry.collab ? { collab: { ...entry.collab } } : {}),
            }
          : {
              ...entry,
              ...(entry.collab ? { collab: { ...entry.collab } } : {}),
            }
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
          snapshot?.map((entry) => `${entry.backend}:${entry.stableId || entry.name}`) ?? [],
        );
        const detectedIdentities = new Set(
          entries.map((entry) => `${entry.backend}:${entry.stableId || entry.name}`),
        );
        const hasCatalogMembershipChange = residentIdentities.size !== detectedIdentities.size
          || [...residentIdentities].some((identity) => !detectedIdentities.has(identity));
        if (snapshot && !hasCatalogMembershipChange) {
          // Membership is stable, but Collab registration, roles, or a daemon
          // restart can change the projection. Re-sample at most once per
          // cache TTL so newly registered workers are not left unclassified.
          void resampleCollabProjection().catch((error) => {
            console.warn(
              `[daemon.session_catalog] collab projection cadence resample failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
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
function buildCatalogNativeKeySignature(entries: readonly TerminalSessionCatalogEntry[]): string {
  return entries
    .filter((entry) => entry.backend === 'tmux')
    .map((entry) => nativeTmuxKey(entry))
    .sort()
    .join('\n');
}
