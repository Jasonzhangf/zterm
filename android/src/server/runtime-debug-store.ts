import type { RuntimeDebugLogEntry } from '../lib/types';

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

export class RuntimeDebugStore {
  private readonly maxEntries: number;
  private readonly entries: RuntimeDebugStoredEntry[] = [];

  constructor(options?: RuntimeDebugStoreOptions) {
    const requestedMaxEntries = Math.floor(options?.maxEntries || DEFAULT_MAX_STORED_ENTRIES);
    this.maxEntries = Math.max(1, requestedMaxEntries);
  }

  appendBatch(source: RuntimeDebugSourceMeta, entries: RuntimeDebugLogEntry[]) {
    const ingestedAt = new Date().toISOString();
    for (const entry of entries) {
      this.entries.push({
        ...entry,
        ingestedAt,
        sessionId: source.sessionId,
        tmuxSessionName: source.tmuxSessionName,
        requestOrigin: source.requestOrigin,
      });
    }

    const overflow = this.entries.length - this.maxEntries;
    if (overflow > 0) {
      this.entries.splice(0, overflow);
    }
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
      sessions: Array.from(sessions.values()).sort((left, right) => right.latestSeq - left.latestSeq),
    };
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
