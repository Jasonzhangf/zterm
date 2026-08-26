import type { Host } from '../connection/types';
import type { RelayEndpointCandidate } from '../connection/relay-directory';
import type { BridgeTarget } from '../connection/tmux-sessions';
import {
  DomainContractError,
  createRoutePlan,
  createSessionTargetIdentity,
  reduceSessionState,
  selectPreferredRoute,
  type RouteCandidate,
  type RouteCandidateKind,
  type RoutePlan,
  type SessionAction,
  type SessionDomainState,
  type SessionId,
  type SessionTargetIdentity,
} from './session-domain';

/**
 * Framework-neutral bridge between domain session state and connection
 * target types. This module must not import runtime transport or platform
 * bridge code.
 */
export type ConnectionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'connecting'; readonly sessionId: SessionId; readonly route: RouteCandidate }
  | { readonly kind: 'connected'; readonly sessionId: SessionId; readonly route: RouteCandidate }
  | { readonly kind: 'disconnected'; readonly sessionId: SessionId; readonly route: RouteCandidate }
  | { readonly kind: 'reconnecting'; readonly sessionId: SessionId; readonly route: RouteCandidate; readonly attempt: number }
  | { readonly kind: 'error'; readonly sessionId: SessionId; readonly route: RouteCandidate | null; readonly message: string }
  | { readonly kind: 'closed'; readonly sessionId: SessionId };

export interface SessionConnectionProjection {
  readonly sessionId: SessionId;
  readonly target: SessionTargetIdentity;
  readonly state: ConnectionState;
  readonly route: RoutePlan;
}

export type SessionConnectionEvent =
  | { readonly type: 'route-selected'; readonly sessionId: SessionId; readonly route: RouteCandidate }
  | { readonly type: 'connect-requested'; readonly sessionId: SessionId; readonly route: RouteCandidate }
  | { readonly type: 'connected'; readonly sessionId: SessionId; readonly route: RouteCandidate }
  | { readonly type: 'disconnected'; readonly sessionId: SessionId; readonly route: RouteCandidate }
  | { readonly type: 'reconnect-requested'; readonly sessionId: SessionId; readonly attempt: number; readonly route: RouteCandidate }
  | { readonly type: 'error'; readonly sessionId: SessionId; readonly route: RouteCandidate | null; readonly message: string }
  | { readonly type: 'closed'; readonly sessionId: SessionId };

const ROUTE_KIND_SET: ReadonlySet<RouteCandidateKind> = new Set<RouteCandidateKind>([
  'direct',
  'tailscale',
  'rtc-direct',
  'rtc-relay',
]);

function requireNonEmptyString(value: unknown, code: string, message: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DomainContractError(code, message);
  }
  return value.trim();
}

function normalizeRouteKind(value: unknown): RouteCandidateKind {
  if (typeof value !== 'string' || !ROUTE_KIND_SET.has(value as RouteCandidateKind)) {
    throw new DomainContractError('route_kind_invalid', 'route kind must be a known candidate kind');
  }
  return value as RouteCandidateKind;
}

function normalizeBridgeTarget(input: unknown): BridgeTarget {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DomainContractError('target_invalid', 'bridge target must be an object');
  }
  const candidate = input as Record<string, unknown>;
  const bridgeHost = requireNonEmptyString(candidate.bridgeHost, 'target_bridge_host_required', 'bridgeHost is required');
  const bridgePort = candidate.bridgePort;
  if (typeof bridgePort !== 'number' || !Number.isSafeInteger(bridgePort) || bridgePort <= 0) {
    throw new DomainContractError('target_bridge_port_invalid', 'bridgePort must be a positive integer');
  }
  const backend = candidate.terminalBackend;
  if (backend !== undefined && backend !== 'tmux' && backend !== 'herdr') {
    throw new DomainContractError('target_backend_invalid', 'terminalBackend must be tmux or herdr');
  }
  const authToken = candidate.authToken;
  if (authToken !== undefined && typeof authToken !== 'string') {
    throw new DomainContractError('target_auth_invalid', 'authToken must be a string');
  }
  return {
    bridgeHost,
    bridgePort,
    ...(authToken ? { authToken } : {}),
    ...(backend ? { terminalBackend: backend } : {}),
  };
}

function normalizeHostTarget(input: Host): SessionTargetIdentity {
  const daemonId = input.daemonHostId?.trim() || input.relayHostId?.trim() || input.id.trim();
  const sessionName = input.sessionName?.trim() || input.name.trim();
  return createSessionTargetIdentity({
    backend: input.terminalBackend ?? 'tmux',
    daemonId,
    sessionName,
  });
}

function routeCandidateFromEndpoint(input: {
  kind: RouteCandidateKind;
  endpoint: string;
  priority: number;
}): RouteCandidate {
  const kind = normalizeRouteKind(input.kind);
  const endpoint = requireNonEmptyString(input.endpoint, 'route_endpoint_required', 'route endpoint is required');
  const priority = input.priority;
  if (typeof priority !== 'number' || !Number.isSafeInteger(priority) || priority < 0) {
    throw new DomainContractError('route_priority_invalid', 'route priority must be a non-negative integer');
  }
  return Object.freeze({ kind, endpoint, priority });
}

function directCandidateFromHost(host: Host, priority: number): RouteCandidate {
  const bridgeHost = host.bridgeHost.trim();
  if (!bridgeHost) {
    throw new DomainContractError('host_endpoint_required', 'host bridgeHost is required');
  }
  if (!Number.isSafeInteger(host.bridgePort) || host.bridgePort <= 0) {
    throw new DomainContractError('target_bridge_port_invalid', 'bridgePort must be a positive integer');
  }
  return routeCandidateFromEndpoint({
    kind: 'direct',
    endpoint: `${bridgeHost}:${host.bridgePort}`,
    priority,
  });
}

function relayKindToRouteKind(kind: RelayEndpointCandidate['kind']): RouteCandidateKind {
  switch (kind) {
    case 'relay-rtc':
      return 'rtc-relay';
    case 'rtc-direct':
      return 'rtc-direct';
    case 'tailscale':
      return 'tailscale';
    case 'lan':
    case 'ipv4':
    case 'ipv6':
      return 'direct';
  }
  throw new DomainContractError('route_kind_invalid', 'relay endpoint kind must be known');
}

export function buildRoutePlanFromHost(host: Host): RoutePlan {
  const target = normalizeHostTarget(host);
  const candidates: RouteCandidate[] = [];

  if (host.tailscaleHost?.trim()) {
    candidates.push(routeCandidateFromEndpoint({
      kind: 'tailscale',
      endpoint: `${host.tailscaleHost.trim()}:${host.bridgePort}`,
      priority: 0,
    }));
  }
  if (host.ipv4Host?.trim()) {
    candidates.push(routeCandidateFromEndpoint({
      kind: 'direct',
      endpoint: `${host.ipv4Host.trim()}:${host.bridgePort}`,
      priority: 1,
    }));
  }
  if (host.ipv6Host?.trim()) {
    candidates.push(routeCandidateFromEndpoint({
      kind: 'direct',
      endpoint: `${host.ipv6Host.trim()}:${host.bridgePort}`,
      priority: 2,
    }));
  }
  candidates.push(directCandidateFromHost(host, candidates.length));

  for (const relay of host.relayEndpointCandidates ?? []) {
    candidates.push(routeCandidateFromEndpoint({
      kind: relayKindToRouteKind(relay.kind),
      endpoint: relay.wsUrl ?? `${relay.host ?? 'relay'}:${relay.port ?? 0}`,
      priority: candidates.length,
    }));
  }

  return createRoutePlan(target, candidates);
}

export function buildRoutePlanFromBridgeTarget(
  target: BridgeTarget,
  sessionName: string,
  daemonId?: string,
): RoutePlan {
  const normalizedTarget = normalizeBridgeTarget(target);
  return createRoutePlan(
    createSessionTargetIdentity({
      backend: normalizedTarget.terminalBackend ?? 'tmux',
      daemonId: daemonId?.trim() || normalizedTarget.bridgeHost,
      sessionName,
    }),
    [
      routeCandidateFromEndpoint({
        kind: 'direct',
        endpoint: `${normalizedTarget.bridgeHost}:${normalizedTarget.bridgePort}`,
        priority: 0,
      }),
    ],
  );
}

export function selectBestRoute(plan: RoutePlan): RouteCandidate | null {
  return selectPreferredRoute(plan);
}

export function toBridgeTarget(plan: RoutePlan): BridgeTarget {
  const route = plan.candidates[0];
  if (!route) {
    throw new DomainContractError('route_plan_empty', 'route plan requires at least one candidate');
  }
  const separatorIndex = route.endpoint.lastIndexOf(':');
  const bridgeHost = separatorIndex > 0 ? route.endpoint.slice(0, separatorIndex) : route.endpoint;
  const portLiteral = separatorIndex > 0 ? route.endpoint.slice(separatorIndex + 1) : '';
  const bridgePort = Number.parseInt(portLiteral, 10);
  if (!Number.isSafeInteger(bridgePort) || bridgePort <= 0) {
    throw new DomainContractError('target_bridge_port_invalid', 'route endpoint must contain a valid bridge port');
  }
  return {
    bridgeHost,
    bridgePort,
    terminalBackend: plan.target.backend,
  };
}

export function projectSessionConnection(
  state: SessionDomainState,
  plan: RoutePlan,
): SessionConnectionProjection {
  if (
    state.target.backend !== plan.target.backend
    || state.target.daemonId !== plan.target.daemonId
    || state.target.sessionName !== plan.target.sessionName
  ) {
    throw new DomainContractError('session_target_mismatch', 'domain target must match route plan target');
  }
  const route = state.selectedRoute ?? null;
  if (route && !plan.candidates.some((candidate) =>
    candidate.kind === route.kind && candidate.endpoint === route.endpoint
  )) {
    throw new DomainContractError('route_not_in_plan', 'selected route must belong to the route plan');
  }

  let connectionState: ConnectionState;
  switch (state.status) {
    case 'idle':
      connectionState = { kind: 'idle' };
      break;
    case 'connecting':
    case 'connected':
    case 'disconnected': {
      if (!route) {
        throw new DomainContractError('route_not_selected', 'active session requires a selected route');
      }
      connectionState = { kind: state.status, sessionId: state.sessionId, route };
      break;
    }
    case 'reconnecting': {
      if (!route) {
        throw new DomainContractError('route_not_selected', 'active session requires a selected route');
      }
      connectionState = {
        kind: state.status,
        sessionId: state.sessionId,
        route,
        attempt: state.reconnectAttempt,
      };
      break;
    }
    case 'error':
      connectionState = {
        kind: 'error',
        sessionId: state.sessionId,
        route,
        message: state.lastError ?? '',
      };
      break;
    case 'closed':
      connectionState = { kind: 'closed', sessionId: state.sessionId };
      break;
  }

  return {
    sessionId: state.sessionId,
    target: state.target,
    state: connectionState,
    route: plan,
  };
}

export function projectSessionEvent(
  action: SessionAction,
  next: SessionDomainState,
): SessionConnectionEvent {
  const sessionId = next.sessionId;
  switch (action.type) {
    case 'select-route':
      if (!next.selectedRoute) {
        throw new DomainContractError('route_not_selected', 'route selection did not produce a route');
      }
      return { type: 'route-selected', sessionId, route: next.selectedRoute };
    case 'request-connect':
      if (!next.selectedRoute) {
        throw new DomainContractError('route_not_selected', 'connect requires an explicitly selected route');
      }
      return { type: 'connect-requested', sessionId, route: next.selectedRoute };
    case 'confirm-connected':
      if (!next.selectedRoute) {
        throw new DomainContractError('route_not_selected', 'connected requires a selected route');
      }
      return { type: 'connected', sessionId, route: next.selectedRoute };
    case 'report-disconnected':
      if (!next.selectedRoute) {
        throw new DomainContractError('route_not_selected', 'disconnected requires a selected route');
      }
      return { type: 'disconnected', sessionId, route: next.selectedRoute };
    case 'request-reconnect':
      if (!next.selectedRoute) {
        throw new DomainContractError('route_not_selected', 'reconnect requires a selected route');
      }
      return {
        type: 'reconnect-requested',
        sessionId,
        attempt: next.reconnectAttempt,
        route: next.selectedRoute,
      };
    case 'report-error':
      return { type: 'error', sessionId, route: next.selectedRoute, message: next.lastError ?? '' };
    case 'close':
      return { type: 'closed', sessionId };
  }
}

export function replaySessionConnection(
  initialState: SessionDomainState,
  actions: readonly SessionAction[],
  plan: RoutePlan,
): SessionConnectionProjection[] {
  let state = initialState;
  const snapshots: SessionConnectionProjection[] = [projectSessionConnection(state, plan)];
  for (const action of actions) {
    state = reduceSessionState(state, action);
    snapshots.push(projectSessionConnection(state, plan));
  }
  return snapshots;
}

export function replaySessionEvents(
  initialState: SessionDomainState,
  actions: readonly SessionAction[],
): SessionConnectionEvent[] {
  let previous = initialState;
  const events: SessionConnectionEvent[] = [];
  for (const action of actions) {
    const next = reduceSessionState(previous, action);
    events.push(projectSessionEvent(action, next));
    previous = next;
  }
  return events;
}
