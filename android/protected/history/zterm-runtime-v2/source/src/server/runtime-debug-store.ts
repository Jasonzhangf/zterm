import type {
  RuntimeDebugLogEntry,
} from '@zterm/shared/protocol';
import {
  BoundedDebugEventStore,
  DebugRegistry,
  SnapshotCoordinator,
  type DebugEvent,
} from '@zterm/shared/terminal/debug-contract';
import type { NodeIdentity } from '@zterm/shared/terminal/node-contract';

export interface RuntimeDebugSourceMeta {
  sessionId: string;
  tmuxSessionName: string;
  requestOrigin?: string;
}

export interface RuntimeDebugStoredEntry extends RuntimeDebugLogEntry {
  ingestedAt: string;
  sessionId: string;
  tmuxSessionName: string;
  requestOrigin?: string;
}

export interface RuntimeDebugSnapshotRecord {
  sessionId: string;
  tmuxSessionName: string;
  requestOrigin?: string;
  updatedAt: string;
  schemaVersion: number;
  snapshotId: string;
  generation: number;
  sequence: number;
  sensitivity: 'public' | 'internal' | 'restricted';
  snapshot: unknown;
}

interface RuntimeDebugSessionSummary {
  sessionId: string;
  tmuxSessionName: string;
  requestOrigin?: string;
  entryCount: number;
  latestSeq: number;
  latestScope: string;
  latestTs: string;
  latestIngestedAt: string;
}

interface RuntimeDebugStoreOptions {
  maxEntries?: number;
}

export interface RuntimeDebugEntryQuery {
  sessionId?: string;
  tmuxSessionName?: string;
  scopeIncludes?: string;
  limit?: number;
}

const DEFAULT_MAX_STORED_ENTRIES = 2000;
const MAX_QUERY_LIMIT = 1000;

const daemonDebugModuleIdentity: NodeIdentity = {
  nodeId: 'daemon.runtime.debug',
  moduleId: 'observability.debug_channel',
  featureId: 'daemon.cli_node',
  resources: ['resource.debug_snapshot_registry', 'resource.debug_channel'],
};

export class RuntimeDebugStore {
  private readonly maxEntries: number;
  private readonly entries: RuntimeDebugStoredEntry[] = [];
  private readonly snapshots = new Map<string, RuntimeDebugSnapshotRecord>();
  private readonly boundedHistory: BoundedDebugEventStore<RuntimeDebugStoredEntry>;
  private readonly snapshotRegistry = new DebugRegistry();
  private readonly snapshotCoordinator: SnapshotCoordinator;

  constructor(options?: RuntimeDebugStoreOptions) {
    const requestedMaxEntries = Math.floor(options?.maxEntries || DEFAULT_MAX_STORED_ENTRIES);
    this.maxEntries = Math.max(1, requestedMaxEntries);
    this.boundedHistory = new BoundedDebugEventStore(this.maxEntries);
    this.snapshotCoordinator = new SnapshotCoordinator(this.snapshotRegistry);
  }

  appendBatch(source: RuntimeDebugSourceMeta, entries: RuntimeDebugLogEntry[]) {
    const ingestedAt = new Date().toISOString();
    for (const entry of entries) {
      const storedEntry: RuntimeDebugStoredEntry = {
        ...entry,
        ingestedAt,
        sessionId: source.sessionId,
        tmuxSessionName: source.tmuxSessionName,
        requestOrigin: source.requestOrigin,
      };
      this.entries.push(storedEntry);
      this.boundedHistory.push({
        eventId: `${source.sessionId}:${entry.seq}`,
        nodeId: daemonDebugModuleIdentity.nodeId,
        kind: 'runtime-log',
        sequence: entry.seq,
        capturedAt: entry.ts,
        sensitivity: 'internal',
        payload: storedEntry,
      });
    }

    const overflow = this.entries.length - this.maxEntries;
    if (overflow > 0) {
      this.entries.splice(0, overflow);
    }
  }

  setSnapshot(source: RuntimeDebugSourceMeta, snapshot: unknown) {
    const producerNodeId = `${daemonDebugModuleIdentity.nodeId}:${source.sessionId}`;
    if (this.snapshotRegistry.has(producerNodeId)) {
      this.snapshotRegistry.unregister(producerNodeId);
    }
    const producer = {
      identity: {
        ...daemonDebugModuleIdentity,
        nodeId: producerNodeId,
      } satisfies NodeIdentity,
      debugSnapshot: () => snapshot,
    };
    this.snapshotRegistry.register(producer);
    const envelope = this.snapshotCoordinator.capture(
      producer,
      'running',
      {},
      'internal',
    );
    this.snapshots.set(source.sessionId, {
      sessionId: source.sessionId,
      tmuxSessionName: source.tmuxSessionName,
      requestOrigin: source.requestOrigin,
      updatedAt: new Date().toISOString(),
      schemaVersion: envelope.schemaVersion,
      snapshotId: envelope.snapshotId,
      generation: envelope.generation,
      sequence: envelope.sequence,
      sensitivity: envelope.sensitivity,
      snapshot: envelope.payload,
    });
  }

  getSnapshot(sessionId: string) {
    return this.snapshots.get(sessionId.trim()) || null;
  }

  listSnapshots() {
    return Array.from(this.snapshots.values()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  listEntries(query?: RuntimeDebugEntryQuery) {
    const sessionId = query?.sessionId?.trim();
    const tmuxSessionName = query?.tmuxSessionName?.trim();
    const scopeIncludes = query?.scopeIncludes?.trim().toLowerCase();
    const limit = Math.max(1, Math.min(MAX_QUERY_LIMIT, Math.floor(query?.limit || 200)));

    const filtered = this.entries.filter((entry) => {
      if (sessionId && entry.sessionId !== sessionId) {
        return false;
      }
      if (tmuxSessionName && entry.tmuxSessionName !== tmuxSessionName) {
        return false;
      }
      if (scopeIncludes && !entry.scope.toLowerCase().includes(scopeIncludes)) {
        return false;
      }
      return true;
    });

    return filtered.slice(Math.max(0, filtered.length - limit)).reverse();
  }

  getSummary() {
    const sessions = new Map<string, RuntimeDebugSessionSummary>();
    for (const entry of this.entries) {
      const current = sessions.get(entry.sessionId);
      if (!current) {
        sessions.set(entry.sessionId, {
          sessionId: entry.sessionId,
          tmuxSessionName: entry.tmuxSessionName,
          requestOrigin: entry.requestOrigin,
          entryCount: 1,
          latestSeq: entry.seq,
          latestScope: entry.scope,
          latestTs: entry.ts,
          latestIngestedAt: entry.ingestedAt,
        });
        continue;
      }

      current.entryCount += 1;
      if (entry.seq >= current.latestSeq) {
        current.latestSeq = entry.seq;
        current.latestScope = entry.scope;
        current.latestTs = entry.ts;
        current.latestIngestedAt = entry.ingestedAt;
        current.tmuxSessionName = entry.tmuxSessionName;
        current.requestOrigin = entry.requestOrigin;
      }
    }

    return {
      totalEntries: this.entries.length,
      droppedEntries: this.boundedHistory.getDropCount(),
      sessions: Array.from(sessions.values()).sort((left, right) => right.latestSeq - left.latestSeq),
      snapshotCount: this.snapshots.size,
    };
  }

  listDebugEvents(): readonly DebugEvent<RuntimeDebugStoredEntry>[] {
    return this.boundedHistory.list();
  }

  getDroppedEntryCount(): number {
    return this.boundedHistory.getDropCount();
  }
}

export function createRuntimeDebugStore(options?: RuntimeDebugStoreOptions) {
  return new RuntimeDebugStore(options);
}

export function resolveDebugRouteLimit(input: string | null | undefined) {
  const parsed = Number.parseInt(input || '', 10);
  if (!Number.isFinite(parsed)) {
    return 200;
  }
  return Math.max(1, Math.min(MAX_QUERY_LIMIT, parsed));
}
