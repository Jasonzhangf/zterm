export const sessionIdBrand = Symbol('zterm.session-id');

export type SessionId = string & { readonly [sessionIdBrand]: true };

export type TerminalBackend = 'tmux' | 'herdr';

export interface SessionTargetIdentity {
  readonly backend: TerminalBackend;
  readonly daemonId: string;
  readonly sessionName: string;
}

export type RouteCandidateKind = 'direct' | 'tailscale' | 'rtc-direct' | 'rtc-relay';

export interface RouteCandidate {
  readonly kind: RouteCandidateKind;
  readonly endpoint: string;
  readonly priority: number;
}

export interface RoutePlan {
  readonly target: SessionTargetIdentity;
  readonly candidates: readonly RouteCandidate[];
}

export type SessionLifecycleStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'error'
  | 'closed';

export interface SessionDomainState {
  readonly sessionId: SessionId;
  readonly target: SessionTargetIdentity;
  readonly status: SessionLifecycleStatus;
  readonly selectedRoute: RouteCandidate | null;
  readonly reconnectAttempt: number;
  readonly lastError: string | null;
}

export type SessionAction =
  | { readonly type: 'select-route'; readonly sessionId: SessionId; readonly candidate: RouteCandidate }
  | { readonly type: 'request-connect'; readonly sessionId: SessionId }
  | { readonly type: 'confirm-connected'; readonly sessionId: SessionId }
  | { readonly type: 'report-disconnected'; readonly sessionId: SessionId }
  | { readonly type: 'request-reconnect'; readonly sessionId: SessionId }
  | { readonly type: 'report-error'; readonly sessionId: SessionId; readonly message: string }
  | { readonly type: 'close'; readonly sessionId: SessionId };

export class DomainContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainContractError';
  }
}

export function createSessionId(value: string): SessionId {
  const normalized = value.trim();
  if (!normalized) {
    throw new DomainContractError('session_id_required', 'sessionId must be a non-empty string');
  }
  return normalized as SessionId;
}

export function createSessionTargetIdentity(input: {
  backend: TerminalBackend;
  daemonId: string;
  sessionName: string;
}): SessionTargetIdentity {
  const daemonId = input.daemonId.trim();
  const sessionName = input.sessionName.trim();
  if (!daemonId || !sessionName) {
    throw new DomainContractError('target_identity_invalid', 'daemonId and sessionName must be non-empty');
  }
  return Object.freeze({ backend: input.backend, daemonId, sessionName });
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeRouteCandidate(candidate: RouteCandidate): RouteCandidate {
  const endpoint = candidate.endpoint.trim();
  if (!endpoint) {
    throw new DomainContractError('route_endpoint_required', 'route endpoint must be a non-empty string');
  }
  if (!Number.isSafeInteger(candidate.priority) || candidate.priority < 0) {
    throw new DomainContractError('route_priority_invalid', 'route priority must be a non-negative safe integer');
  }
  return Object.freeze({ kind: candidate.kind, endpoint, priority: candidate.priority });
}

export function createRoutePlan(
  target: SessionTargetIdentity,
  candidates: readonly RouteCandidate[],
): RoutePlan {
  if (candidates.length === 0) {
    throw new DomainContractError('route_plan_empty', 'route plan requires at least one candidate');
  }
  const normalized = candidates.map(normalizeRouteCandidate);
  const endpoints = new Set(normalized.map((candidate) => candidate.endpoint));
  if (endpoints.size !== normalized.length) {
    throw new DomainContractError('route_endpoint_duplicate', 'route endpoints must be unique');
  }
  normalized.sort((left, right) =>
    left.priority - right.priority
    || compareText(left.kind, right.kind)
    || compareText(left.endpoint, right.endpoint),
  );
  return Object.freeze({ target, candidates: Object.freeze(normalized) });
}

export function selectPreferredRoute(plan: RoutePlan): RouteCandidate | null {
  return plan.candidates[0] ?? null;
}

function requireSameSession(state: SessionDomainState, action: SessionAction): void {
  if (action.sessionId !== state.sessionId) {
    throw new DomainContractError('session_mismatch', 'action sessionId does not match domain state');
  }
}

export function reduceSessionState(state: SessionDomainState, action: SessionAction): SessionDomainState {
  requireSameSession(state, action);

  switch (action.type) {
    case 'select-route': {
      if (state.status === 'connected' || state.status === 'closed') {
        throw new DomainContractError('invalid_route_transition', `cannot select a route while ${state.status}`);
      }
      return { ...state, selectedRoute: normalizeRouteCandidate(action.candidate) };
    }
    case 'request-connect': {
      if (state.status !== 'idle' && state.status !== 'disconnected' && state.status !== 'error') {
        throw new DomainContractError('invalid_connect_transition', `cannot connect from ${state.status}`);
      }
      if (!state.selectedRoute) {
        throw new DomainContractError('route_not_selected', 'connect requires an explicitly selected route');
      }
      return { ...state, status: 'connecting', reconnectAttempt: 0, lastError: null };
    }
    case 'confirm-connected': {
      if (state.status !== 'connecting' && state.status !== 'reconnecting') {
        throw new DomainContractError('invalid_connected_transition', `cannot confirm connection from ${state.status}`);
      }
      return { ...state, status: 'connected', reconnectAttempt: 0, lastError: null };
    }
    case 'report-disconnected': {
      if (state.status !== 'connected') {
        throw new DomainContractError('invalid_disconnect_transition', `cannot disconnect from ${state.status}`);
      }
      return { ...state, status: 'disconnected' };
    }
    case 'request-reconnect': {
      if (state.status !== 'disconnected' && state.status !== 'error') {
        throw new DomainContractError('invalid_reconnect_transition', `cannot reconnect from ${state.status}`);
      }
      return { ...state, status: 'reconnecting', reconnectAttempt: state.reconnectAttempt + 1, lastError: null };
    }
    case 'report-error': {
      if (state.status === 'closed') {
        throw new DomainContractError('invalid_error_transition', 'cannot report an error after close');
      }
      return { ...state, status: 'error', lastError: action.message };
    }
    case 'close': {
      if (state.status === 'closed') {
        throw new DomainContractError('invalid_close_transition', 'session is already closed');
      }
      return { ...state, status: 'closed' };
    }
  }
}

export function canAcceptInput(state: SessionDomainState): boolean {
  return state.status === 'connected';
}
