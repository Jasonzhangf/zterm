import type {
  TraversalPlanCandidate,
  TraversalRouteHealthRecord,
} from './types';

export interface TraversalRouteHealthScope {
  accountId?: string;
  daemonHostId?: string;
  /** Client network generation. Explicit values isolate route truth across WiFi/cellular/VPN/IP changes. */
  networkGeneration?: number;
}

export interface TraversalRouteHealthCacheOptions {
  ttlMs?: number;
  now?: () => number;
  storage?: TraversalRouteHealthStorage | null;
}

export interface TraversalRouteHealthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): unknown;
  removeItem(key: string): unknown;
}

const DEFAULT_ROUTE_HEALTH_TTL_MS = 5 * 60_000;
// Transient failures use a short circuit-breaker cooldown so a recovered
// endpoint is probe-eligible without restarting Android; auth failures stay
// for the full health TTL.
const DEFAULT_ROUTE_FAILURE_TTL_MS = 1_000;
const ROUTE_HEALTH_STORAGE_KEY = 'zterm:traversal-route-health:v1';

function resolveDefaultStorage(): TraversalRouteHealthStorage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function isRouteHealthRecord(value: unknown): value is TraversalRouteHealthRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<TraversalRouteHealthRecord>;
  return typeof candidate.key === 'string'
    && typeof candidate.path === 'string'
    && typeof candidate.endpoint === 'string'
    && (candidate.status === 'success' || candidate.status === 'failure' || candidate.status === 'auth-failure')
    && typeof candidate.updatedAt === 'number'
    && Number.isFinite(candidate.updatedAt);
}

function sanitizeKeyPart(value?: string | null) {
  return (value || '').trim() || '-';
}

export function buildTraversalRouteHealthKey(
  scope: TraversalRouteHealthScope,
  candidate: Pick<TraversalPlanCandidate, 'id' | 'path' | 'endpoint'>,
) {
  const parts = [
    sanitizeKeyPart(scope.accountId),
    sanitizeKeyPart(scope.daemonHostId),
    sanitizeKeyPart(candidate.id || `${candidate.path}:${candidate.endpoint}`),
  ];
  // Keep legacy three-part keys for callers that have not opted into network
  // identity yet. Explicit generations form isolated route-health buckets so
  // a route that succeeded on WiFi cannot bias a cellular/Tailscale reconnect.
  if (scope.networkGeneration !== undefined) {
    parts.push(`g${Math.max(0, Math.floor(scope.networkGeneration))}`);
  }
  return parts.join('::');
}

export class TraversalRouteHealthCache {
  private readonly entries = new Map<string, TraversalRouteHealthRecord>();

  private readonly ttlMs: number;

  private readonly now: () => number;

  private readonly storage: TraversalRouteHealthStorage | null;

  public constructor(options: TraversalRouteHealthCacheOptions = {}) {
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs || DEFAULT_ROUTE_HEALTH_TTL_MS));
    this.now = options.now || (() => Date.now());
    this.storage = options.storage === undefined ? resolveDefaultStorage() : options.storage;
    this.restore();
  }

  private restore() {
    if (!this.storage) {
      return;
    }
    try {
      const raw = this.storage.getItem(ROUTE_HEALTH_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed) || !parsed.every(isRouteHealthRecord)) {
        throw new Error('invalid route-health persistence payload');
      }
      for (const record of parsed) {
        if (!this.isExpired(record)) {
          this.entries.set(record.key, record);
        }
      }
      this.persist();
    } catch {
      this.entries.clear();
      this.storage.removeItem(ROUTE_HEALTH_STORAGE_KEY);
    }
  }

  private persist() {
    if (!this.storage) {
      return;
    }
    if (this.entries.size === 0) {
      this.storage.removeItem(ROUTE_HEALTH_STORAGE_KEY);
      return;
    }
    this.storage.setItem(
      ROUTE_HEALTH_STORAGE_KEY,
      JSON.stringify(Array.from(this.entries.values()).sort((left, right) => left.key.localeCompare(right.key))),
    );
  }

  public recordSuccess(
    scope: TraversalRouteHealthScope,
    candidate: TraversalPlanCandidate,
    rttMs?: number,
  ) {
    const key = buildTraversalRouteHealthKey(scope, candidate);
    const record: TraversalRouteHealthRecord = {
      key,
      path: candidate.path,
      endpoint: candidate.endpoint,
      candidateId: candidate.id,
      status: 'success',
      updatedAt: this.now(),
      ...(typeof rttMs === 'number' && Number.isFinite(rttMs) ? { rttMs: Math.max(0, Math.floor(rttMs)) } : {}),
    };
    this.entries.set(key, record);
    this.persist();
    return record;
  }

  public recordFailure(
    scope: TraversalRouteHealthScope,
    candidate: TraversalPlanCandidate,
    error: string,
    options?: { authFailure?: boolean },
  ) {
    const key = buildTraversalRouteHealthKey(scope, candidate);
    const record: TraversalRouteHealthRecord = {
      key,
      path: candidate.path,
      endpoint: candidate.endpoint,
      candidateId: candidate.id,
      status: options?.authFailure ? 'auth-failure' : 'failure',
      updatedAt: this.now(),
      error: error.trim() || 'route failed',
    };
    this.entries.set(key, record);
    this.persist();
    return record;
  }

  public get(
    scope: TraversalRouteHealthScope,
    candidate: Pick<TraversalPlanCandidate, 'id' | 'path' | 'endpoint'>,
  ) {
    const record = this.entries.get(buildTraversalRouteHealthKey(scope, candidate));
    if (!record) {
      return null;
    }
    if (this.isExpired(record)) {
      this.entries.delete(record.key);
      this.persist();
      return null;
    }
    return record;
  }

  public list(scope: TraversalRouteHealthScope = {}) {
    const records: TraversalRouteHealthRecord[] = [];
    let changed = false;
    for (const record of this.entries.values()) {
      if (this.isExpired(record)) {
        this.entries.delete(record.key);
        changed = true;
        continue;
      }
      if (this.matchesScope(scope, record)) {
        records.push(record);
      }
    }
    if (changed) {
      this.persist();
    }
    return records.sort((left, right) => right.updatedAt - left.updatedAt || left.key.localeCompare(right.key));
  }

  public snapshot(scope: TraversalRouteHealthScope = {}) {
    return this.list(scope);
  }

  private matchesScope(scope: TraversalRouteHealthScope, record: TraversalRouteHealthRecord) {
    const expectedAccountId = sanitizeKeyPart(scope.accountId);
    const expectedDaemonHostId = sanitizeKeyPart(scope.daemonHostId);
    const parts = record.key.split('::');
    return parts[0] === expectedAccountId && parts[1] === expectedDaemonHostId;
  }

  private isExpired(record: TraversalRouteHealthRecord) {
    if (!record) {
      return true;
    }
    const ttlMs = record.status === 'failure'
      ? Math.min(this.ttlMs, DEFAULT_ROUTE_FAILURE_TTL_MS)
      : this.ttlMs;
    if (this.now() - record.updatedAt > ttlMs) {
      return true;
    }
    return false;
  }

  public clear() {
    this.entries.clear();
    this.persist();
  }
}

export const defaultTraversalRouteHealthCache = new TraversalRouteHealthCache();
