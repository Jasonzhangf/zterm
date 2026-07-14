export type OpenTabOpenSource =
  | 'explicit-open'
  | 'cold-restore';

interface OpenTabOpenPolicy {
  connectOnCreate: boolean;
  clearClosedReuseOnOpen: boolean;
}

const OPEN_TAB_OPEN_POLICIES: Record<OpenTabOpenSource, OpenTabOpenPolicy> = {
  'explicit-open': {
    connectOnCreate: true,
    clearClosedReuseOnOpen: true,
  },
  'cold-restore': {
    connectOnCreate: false,
    clearClosedReuseOnOpen: false,
  },
};

export function resolveOpenTabOpenPolicy(source: OpenTabOpenSource): OpenTabOpenPolicy {
  return OPEN_TAB_OPEN_POLICIES[source];
}

export function buildOpenTabSessionCreateOptions(
  source: OpenTabOpenSource,
  options?: {
    customName?: string;
    createdAt?: number;
    sessionId?: string;
  },
) {
  const policy = resolveOpenTabOpenPolicy(source);
  return {
    activate: false as const,
    connect: policy.connectOnCreate,
    customName: options?.customName,
    createdAt: options?.createdAt,
    sessionId: options?.sessionId,
  };
}
