import type { RelayEndpointCandidate } from '@zterm/shared/relay-directory';
import { selectBestTraversalRoute } from './route-selector';
import type {
  TraversalPlanCandidate,
  TraversalResolvedPath,
  TraversalRouteHealthRecord,
  TraversalRouteSelectionDiagnostic,
} from './types';
import type { TraversalRouteHealthCache, TraversalRouteHealthScope } from './route-health-cache';

export interface RouteDiagnosticsSummary {
  badge: string;
  selectedPath: TraversalResolvedPath | null;
  selectedCandidateId?: string;
  selectedEndpoint?: string;
  selectedRttLabel?: string;
  lastSuccessLabel?: string;
  lastErrorLabel?: string;
  attempts: TraversalRouteSelectionDiagnostic[];
}

export interface BuildRouteDiagnosticsOptions {
  accountId?: string;
  daemonHostId?: string;
  endpointCandidates?: RelayEndpointCandidate[];
  traversalPathPriority?: TraversalResolvedPath[];
  routeHealthCache?: Pick<TraversalRouteHealthCache, 'get' | 'list'>;
}

function asString(value?: string | null) {
  return (value || '').trim();
}

function formatRouteLabel(path: TraversalResolvedPath) {
  switch (path) {
    case 'tailscale':
      return 'Tailscale';
    case 'ipv6':
      return 'IPv6';
    case 'ipv4':
      return 'IPv4';
    case 'rtc-relay':
      return 'Relay RTC';
  }
}

function formatAgeLabel(updatedAt: number) {
  const diff = Math.max(0, Date.now() - updatedAt);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}

function buildTraversalRouteCandidates(endpointCandidates: RelayEndpointCandidate[]): TraversalPlanCandidate[] {
  const seen = new Set<string>();
  const candidates: TraversalPlanCandidate[] = [];

  for (const endpoint of endpointCandidates) {
    const id = asString(endpoint.id) || `${endpoint.kind}:${endpoint.host || endpoint.wsUrl || endpoint.relayHostId || 'route'}`;
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);

    if (endpoint.kind === 'relay-rtc') {
      candidates.push({
        id,
        kind: 'rtc',
        path: 'rtc-relay',
        endpoint: asString(endpoint.relayHostId) || id,
        signalUrl: asString(endpoint.wsUrl) || `wss://${asString(endpoint.relayHostId) || 'relay.invalid'}`,
        iceServers: [],
        iceTransportPolicy: 'relay',
      });
      continue;
    }

    if (endpoint.kind === 'tailscale' || endpoint.kind === 'ipv6' || endpoint.kind === 'ipv4') {
      const endpointLabel = asString(endpoint.host) || asString(endpoint.wsUrl) || asString(endpoint.relayHostId) || id;
      candidates.push({
        id,
        kind: 'ws',
        path: endpoint.kind,
        endpoint: endpointLabel,
        url: asString(endpoint.wsUrl) || `ws://${endpointLabel}`,
      });
    }
  }

  return candidates;
}

function pickNewestRecord(records: TraversalRouteHealthRecord[], status: TraversalRouteHealthRecord['status']) {
  return records
    .filter((record) => record.status === status)
    .sort((left, right) => right.updatedAt - left.updatedAt || left.key.localeCompare(right.key))[0] || null;
}

export function buildRouteDiagnosticsSummary(options: BuildRouteDiagnosticsOptions): RouteDiagnosticsSummary | null {
  const candidates = buildTraversalRouteCandidates(options.endpointCandidates || []);
  if (candidates.length === 0) {
    return null;
  }

  const scope: TraversalRouteHealthScope = {
    accountId: options.accountId,
    daemonHostId: options.daemonHostId,
  };
  const healthCache = options.routeHealthCache;
  const selection = selectBestTraversalRoute({
    candidates,
    healthCache,
    scope,
    traversalPathPriority: options.traversalPathPriority,
  });
  const records = healthCache?.list(scope) || [];
  const selected = selection.selected;
  const selectedDiagnostic = selection.diagnostics.find((item) =>
    item.candidateId === selected?.id
    && item.path === selected?.path
    && item.endpoint === selected?.endpoint,
  ) || null;
  const selectedHealth = selectedDiagnostic?.health || null;
  const latestSuccess = pickNewestRecord(records, 'success');
  const latestFailure = pickNewestRecord(records, 'failure') || pickNewestRecord(records, 'auth-failure');

  return {
    badge: selected ? `Route ${formatRouteLabel(selected.path)}` : 'Route unknown',
    selectedPath: selected?.path || null,
    selectedCandidateId: selected?.id,
    selectedEndpoint: selected?.endpoint,
    selectedRttLabel: selectedHealth?.status === 'success' && typeof selectedHealth.rttMs === 'number'
      ? `${selectedHealth.rttMs}ms`
      : undefined,
    lastSuccessLabel: latestSuccess ? formatAgeLabel(latestSuccess.updatedAt) : undefined,
    lastErrorLabel: latestFailure
      ? `${latestFailure.error || 'route failed'} · ${formatAgeLabel(latestFailure.updatedAt)}`
      : undefined,
    attempts: selection.diagnostics,
  };
}
