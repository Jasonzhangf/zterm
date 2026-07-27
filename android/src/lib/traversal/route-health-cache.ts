import type {
  TraversalPlanCandidate,
  TraversalRouteHealthRecord,
} from './types';

export interface TraversalRouteHealthScope {
  accountId?: string;
  daemonHostId?: string;
}

export interface TraversalRouteHealthCacheOptions {
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_ROUTE_HEALTH_TTL_MS = 5 * 60_000;
const DEFAULT_ROUTE_FAILURE_TTL_MS = 1000;

function sanitizeKeyPart(value?: string | null) {
  return (value || '').trim() || '-';
}

export function buildTraversalRouteHealthKey(
  scope: TraversalRouteHealthScope,
  candidate: Pick<TraversalPlanCandidate, 'id' | 'path' | 'endpoint'>,
) {
  return [
    sanitizeKeyPart(scope.accountId),
    sanitizeKeyPart(scope.daemonHostId),
    sanitizeKeyPart(candidate.id || `${candidate.path}:${candidate.endpoint}`),
  ].join('::');
}

export class TraversalRouteHealthCache {
  private readonly entries = new Map<string, TraversalRouteHealthRecord>();

  private readonly ttlMs: number;

  private readonly now: () => number;

  public constructor(options: TraversalRouteHealthCacheOptions = {}) {
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs || DEFAULT_ROUTE_HEALTH_TTL_MS));
    this.now = options.now || (() => Date.now());
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
      return null;
    }
    return record;
  }

  public list(scope: TraversalRouteHealthScope = {}) {
    const records: TraversalRouteHealthRecord[] = [];
    for (const record of this.entries.values()) {
      if (this.isExpired(record)) {
        this.entries.delete(record.key);
        continue;
      }
      if (this.matchesScope(scope, record)) {
        records.push(record);
      }
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
  }
}

export const defaultTraversalRouteHealthCache = new TraversalRouteHealthCache();
