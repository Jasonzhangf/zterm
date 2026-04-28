import { randomUUID } from 'crypto';

export interface SessionTransportTicketRecord {
  token: string;
  clientSessionId: string;
  issuedAt: number;
}

export interface SessionTransportTicketStore {
  byToken: Map<string, SessionTransportTicketRecord>;
  tokenBySessionId: Map<string, string>;
}

export function createSessionTransportTicketStore(): SessionTransportTicketStore {
  return {
    byToken: new Map(),
    tokenBySessionId: new Map(),
  };
}

function normalizeToken(token: string | null | undefined) {
  return typeof token === 'string' ? token.trim() : '';
}

export function getSessionTransportTicketBySessionId(
  store: SessionTransportTicketStore,
  clientSessionId: string,
) {
  const token = store.tokenBySessionId.get(clientSessionId) || '';
  if (!token) {
    return null;
  }
  return store.byToken.get(token) || null;
}

export function revokeSessionTransportTicket(
  store: SessionTransportTicketStore,
  clientSessionId: string,
) {
  const token = store.tokenBySessionId.get(clientSessionId) || '';
  if (!token) {
    return null;
  }
  store.tokenBySessionId.delete(clientSessionId);
  const existing = store.byToken.get(token) || null;
  if (existing) {
    store.byToken.delete(token);
  }
  return existing;
}

export function issueSessionTransportTicket(
  store: SessionTransportTicketStore,
  clientSessionId: string,
  options?: {
    issuedAt?: number;
    tokenFactory?: () => string;
  },
) {
  revokeSessionTransportTicket(store, clientSessionId);
  const nextToken = normalizeToken(options?.tokenFactory?.()) || randomUUID();
  const issuedAt = Number.isFinite(options?.issuedAt) ? Math.max(0, Math.floor(options!.issuedAt!)) : Date.now();
  const record: SessionTransportTicketRecord = {
    token: nextToken,
    clientSessionId,
    issuedAt,
  };
  store.byToken.set(record.token, record);
  store.tokenBySessionId.set(clientSessionId, record.token);
  return record;
}

export function takeSessionTransportTicket(
  store: SessionTransportTicketStore,
  token: string,
) {
  const normalizedToken = normalizeToken(token);
  if (!normalizedToken) {
    return null;
  }
  const record = store.byToken.get(normalizedToken) || null;
  if (!record) {
    return null;
  }
  store.byToken.delete(normalizedToken);
  if (store.tokenBySessionId.get(record.clientSessionId) === normalizedToken) {
    store.tokenBySessionId.delete(record.clientSessionId);
  }
  return record;
}
