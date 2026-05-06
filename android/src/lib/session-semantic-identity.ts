export interface SessionSemanticIdentityInput {
  daemonHostId?: string | null;
  relayHostId?: string | null;
  bridgeHost?: string | null;
  bridgePort?: number | null;
  sessionName: string;
}

export interface SessionSemanticOwnerInput {
  daemonHostId?: string | null;
  relayHostId?: string | null;
  bridgeHost?: string | null;
  bridgePort?: number | null;
}

function asTrimmedString(value?: string | null) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBridgePort(value?: number | null) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

export function resolveSessionSemanticDaemonId(input: SessionSemanticOwnerInput) {
  return asTrimmedString(input.daemonHostId) || asTrimmedString(input.relayHostId);
}

export function buildSessionSemanticOwnerKey(input: SessionSemanticOwnerInput) {
  const daemonHostId = resolveSessionSemanticDaemonId(input);
  if (daemonHostId) {
    return `daemon:${daemonHostId}`;
  }

  const bridgeHost = asTrimmedString(input.bridgeHost);
  const bridgePort = normalizeBridgePort(input.bridgePort);
  return `bridge:${bridgeHost}::${bridgePort}`;
}

export function buildSessionSemanticReuseKey(input: SessionSemanticIdentityInput) {
  return `${buildSessionSemanticOwnerKey(input)}::session:${asTrimmedString(input.sessionName)}`;
}

export function buildSessionSemanticOwnerKeyVariants(input: SessionSemanticOwnerInput) {
  const variants: string[] = [];
  const daemonHostId = resolveSessionSemanticDaemonId(input);
  const bridgeHost = asTrimmedString(input.bridgeHost);
  const bridgePort = normalizeBridgePort(input.bridgePort);

  if (daemonHostId) {
    variants.push(`daemon:${daemonHostId}`);
  }
  if (bridgeHost || bridgePort > 0) {
    variants.push(`bridge:${bridgeHost}::${bridgePort}`);
  }

  return [...new Set(variants)];
}

export function buildSessionSemanticReuseKeyVariants(input: SessionSemanticIdentityInput) {
  const sessionName = asTrimmedString(input.sessionName);
  return buildSessionSemanticOwnerKeyVariants(input).map((ownerKey) => `${ownerKey}::session:${sessionName}`);
}

export function sessionSemanticOwnersMatch(
  left: SessionSemanticOwnerInput,
  right: SessionSemanticOwnerInput,
) {
  const leftDaemonId = resolveSessionSemanticDaemonId(left);
  const rightDaemonId = resolveSessionSemanticDaemonId(right);
  if (leftDaemonId && rightDaemonId) {
    return leftDaemonId === rightDaemonId;
  }

  return (
    asTrimmedString(left.bridgeHost) === asTrimmedString(right.bridgeHost)
    && normalizeBridgePort(left.bridgePort) === normalizeBridgePort(right.bridgePort)
  );
}

export function sessionSemanticReuseMatch(
  left: SessionSemanticIdentityInput,
  right: SessionSemanticIdentityInput,
) {
  return (
    asTrimmedString(left.sessionName) === asTrimmedString(right.sessionName)
    && sessionSemanticOwnersMatch(left, right)
  );
}
