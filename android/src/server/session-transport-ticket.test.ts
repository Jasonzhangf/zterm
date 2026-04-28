import { describe, expect, it } from 'vitest';
import {
  createSessionTransportTicketStore,
  getSessionTransportTicketBySessionId,
  issueSessionTransportTicket,
  revokeSessionTransportTicket,
  takeSessionTransportTicket,
} from './session-transport-ticket';

describe('session transport ticket truth', () => {
  it('issues one active transport ticket per logical client session', () => {
    const store = createSessionTransportTicketStore();

    const first = issueSessionTransportTicket(store, 'client-1', {
      issuedAt: 10,
      tokenFactory: () => 'ticket-a',
    });
    const second = issueSessionTransportTicket(store, 'client-1', {
      issuedAt: 11,
      tokenFactory: () => 'ticket-b',
    });

    expect(first.token).toBe('ticket-a');
    expect(second.token).toBe('ticket-b');
    expect(getSessionTransportTicketBySessionId(store, 'client-1')).toEqual(second);
    expect(takeSessionTransportTicket(store, 'ticket-a')).toBeNull();
  });

  it('takes a ticket exactly once and clears both token and session indexes together', () => {
    const store = createSessionTransportTicketStore();
    const issued = issueSessionTransportTicket(store, 'client-1', {
      issuedAt: 20,
      tokenFactory: () => 'ticket-a',
    });

    expect(takeSessionTransportTicket(store, 'ticket-a')).toEqual(issued);
    expect(takeSessionTransportTicket(store, 'ticket-a')).toBeNull();
    expect(getSessionTransportTicketBySessionId(store, 'client-1')).toBeNull();
  });

  it('can explicitly revoke the current ticket when the logical session closes', () => {
    const store = createSessionTransportTicketStore();
    issueSessionTransportTicket(store, 'client-1', {
      issuedAt: 30,
      tokenFactory: () => 'ticket-a',
    });

    const revoked = revokeSessionTransportTicket(store, 'client-1');

    expect(revoked?.token).toBe('ticket-a');
    expect(getSessionTransportTicketBySessionId(store, 'client-1')).toBeNull();
    expect(takeSessionTransportTicket(store, 'ticket-a')).toBeNull();
  });
});
