export interface ClientSessionLifecycleState {
  clientSessionId: string;
  mirrorKey: string | null;
  transportId: string | null;
  readyTransportId?: string | null;
  closeTransport?: (reason: string) => void;
}

export function attachClientSessionTransport<T extends ClientSessionLifecycleState>(
  session: T,
  transportId: string,
  closeTransport?: (reason: string) => void,
) {
  const replacedTransportId = session.transportId;
  session.transportId = transportId;
  session.closeTransport = closeTransport;
  session.readyTransportId = null;
  return {
    clientSessionId: session.clientSessionId,
    transportId: session.transportId,
    replacedTransportId,
  };
}

export function detachClientSessionTransport<T extends ClientSessionLifecycleState>(
  sessions: Map<string, T>,
  clientSessionId: string,
) {
  const session = sessions.get(clientSessionId) || null;
  if (!session) {
    return null;
  }
  session.transportId = null;
  session.readyTransportId = null;
  session.closeTransport = undefined;
  return session;
}

export function closeClientSession<T extends ClientSessionLifecycleState>(
  sessions: Map<string, T>,
  clientSessionId: string,
) {
  return sessions.delete(clientSessionId);
}

export function shutdownClientSessions<T extends ClientSessionLifecycleState>(
  sessions: Map<string, T>,
  reason: string,
) {
  for (const session of sessions.values()) {
    if (session.transportId && session.closeTransport) {
      session.closeTransport(reason);
    }
  }
  sessions.clear();
}
