import {
  DEFAULT_TRAVERSAL_PATH_PRIORITY,
  normalizeTraversalPathPriority,
} from '../bridge-settings';
import {
  isPrivateLanIpv4Host,
  parseEndpointHost,
} from '../network-target';
import type {
  TraversalPlanCandidate,
  TraversalResolvedPath,
  TraversalRouteHealthRecord,
  TraversalRouteSelection,
  TraversalRouteSelectionDiagnostic,
} from './types';
import type {
  TraversalRouteHealthCache,
  TraversalRouteHealthScope,
} from './route-health-cache';

interface SelectTraversalRouteOptions {
  candidates: TraversalPlanCandidate[];
  healthCache?: Pick<TraversalRouteHealthCache, 'get'>;
  scope?: TraversalRouteHealthScope;
  traversalPathPriority?: TraversalResolvedPath[];
}

const FAILURE_ROUTE_PENALTY = 500;
const AUTH_FAILURE_ROUTE_PENALTY = 900;
const SUCCESS_ROUTE_LEASE_BONUS = -1000;
const ROUTE_TIER_SPAN = 100;
const LAN_ROUTE_COST = -ROUTE_TIER_SPAN;

function priorityCost(path: TraversalResolvedPath, priority: TraversalResolvedPath[]) {
  const index = priority.indexOf(path);
  return (index >= 0 ? index : priority.length) * ROUTE_TIER_SPAN;
}

function pathCost(
  candidate: TraversalPlanCandidate,
  priority: TraversalResolvedPath[],
  reasons: string[],
) {
  const tierCost = priorityCost(candidate.path, priority);
  if (candidate.path !== 'ipv4') {
    return tierCost;
  }
  const host = parseEndpointHost(candidate.endpoint);
  if (isPrivateLanIpv4Host(host)) {
    reasons.push('ipv4:private-lan');
    return LAN_ROUTE_COST;
  }
  reasons.push('ipv4:non-lan');
  return tierCost;
}

function healthScore(record: TraversalRouteHealthRecord | null, reasons: string[]) {
  if (!record) {
    reasons.push('health:unknown');
    return 20;
  }
  if (record.status === 'auth-failure') {
    reasons.push(`health:auth-failure:${record.error || 'auth failed'}`);
    return AUTH_FAILURE_ROUTE_PENALTY;
  }
  if (record.status === 'failure') {
    reasons.push(`health:failure:${record.error || 'failed'}`);
    return FAILURE_ROUTE_PENALTY;
  }
  reasons.push('health:recent-success');
  if (typeof record.rttMs === 'number' && Number.isFinite(record.rttMs)) {
    reasons.push(`rtt:${record.rttMs}`);
    return SUCCESS_ROUTE_LEASE_BONUS + Math.max(0, Math.min(100, record.rttMs / 10));
  }
  return SUCCESS_ROUTE_LEASE_BONUS;
}

export function selectBestTraversalRoute(options: SelectTraversalRouteOptions): TraversalRouteSelection {
  const priority = normalizeTraversalPathPriority(
    options.traversalPathPriority || DEFAULT_TRAVERSAL_PATH_PRIORITY,
  ) as TraversalResolvedPath[];
  const scope = options.scope || {};

  const diagnostics: TraversalRouteSelectionDiagnostic[] = options.candidates.map((candidate) => {
    const reasons: string[] = [];
    const health = options.healthCache?.get(scope, candidate) || null;
    const basePathCost = pathCost(candidate, priority, reasons);
    const score = basePathCost
      + healthScore(health, reasons);
    const selectable = !health || health.status === 'success';
    reasons.unshift(`path-cost:${basePathCost}`, `priority:${priority.indexOf(candidate.path)}`);
    return {
      candidateId: candidate.id,
      path: candidate.path,
      endpoint: candidate.endpoint,
      selectable,
      score,
      reasons,
      ...(health ? { health } : {}),
    };
  });

  const selectableDiagnostics = diagnostics.filter((diagnostic) => diagnostic.selectable);
  const selectionPool = selectableDiagnostics.length > 0 ? selectableDiagnostics : diagnostics;
  const selectedDiagnostic = [...selectionPool]
    .sort((left, right) => left.score - right.score || left.endpoint.localeCompare(right.endpoint))[0] || null;
  const selected = selectedDiagnostic
    ? options.candidates.find((candidate) =>
        candidate.path === selectedDiagnostic.path
        && candidate.endpoint === selectedDiagnostic.endpoint
        && candidate.id === selectedDiagnostic.candidateId) || null
    : null;

  return {
    selected,
    diagnostics,
  };
}
