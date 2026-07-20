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

const PATH_COST: Record<TraversalResolvedPath, number> = {
  'rtc-direct': 35,
  tailscale: 10,
  ipv6: 30,
  ipv4: 55,
  'rtc-relay': 80,
};

const FAILURE_ROUTE_PENALTY = 500;
const AUTH_FAILURE_ROUTE_PENALTY = 900;

function priorityCost(path: TraversalResolvedPath, priority: TraversalResolvedPath[]) {
  const index = priority.indexOf(path);
  return index >= 0 ? index * 5 : 50;
}

function pathCost(candidate: TraversalPlanCandidate, reasons: string[]) {
  if (candidate.path !== 'ipv4') {
    return PATH_COST[candidate.path];
  }
  const host = parseEndpointHost(candidate.endpoint);
  if (isPrivateLanIpv4Host(host)) {
    reasons.push('ipv4:private-lan');
    return 0;
  }
  reasons.push('ipv4:non-lan');
  return PATH_COST.ipv4;
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
    return Math.max(0, Math.min(100, record.rttMs / 10)) - 25;
  }
  return -10;
}

export function selectBestTraversalRoute(options: SelectTraversalRouteOptions): TraversalRouteSelection {
  const priority = normalizeTraversalPathPriority(
    options.traversalPathPriority || DEFAULT_TRAVERSAL_PATH_PRIORITY,
  ) as TraversalResolvedPath[];
  const scope = options.scope || {};

  const diagnostics: TraversalRouteSelectionDiagnostic[] = options.candidates.map((candidate) => {
    const reasons: string[] = [];
    const health = options.healthCache?.get(scope, candidate) || null;
    const basePathCost = pathCost(candidate, reasons);
    const score = basePathCost
      + priorityCost(candidate.path, priority)
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
