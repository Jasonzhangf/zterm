import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  AttemptFailure,
  AttemptId,
  FailureDecision,
  FailureStage,
  InitialAttemptControl,
  InitialAttemptEvent,
  InitialAttemptPort,
  TraversalCandidateScope,
  TraversalWebSocketLike,
} from './index';

describe('traversal public types', () => {
  it('exports failure facts and decisions with the amend field names', () => {
    expectTypeOf<AttemptId>().toEqualTypeOf<number>();
    expectTypeOf<TraversalCandidateScope>().toEqualTypeOf<'mode-default' | 'bound-initial'>();
    expectTypeOf<FailureStage>().toEqualTypeOf<'connect' | 'signal' | 'rtc' | 'mux'>();

    const failures = [
      { kind: 'http', stage: 'connect', status: 401 },
      { kind: 'system', stage: 'connect', code: 'ECONNREFUSED' },
      { kind: 'ws-close', stage: 'mux', code: 1006, reason: 'lost' },
      { kind: 'rtc-state', stage: 'rtc', state: 'failed' },
      { kind: 'rtc-rejection', stage: 'signal', messageType: 'rtc-error', code: 4001 },
      { kind: 'timeout', stage: 'mux', timer: 'hello' },
      { kind: 'protocol', stage: 'mux', code: 'invalid-mux' },
      {
        kind: 'binding',
        stage: 'mux',
        expectedDaemonHostId: 'daemon-a',
        actualDaemonHostId: 'daemon-b',
      },
      { kind: 'mux-rejection', stage: 'mux', code: 'denied' },
      { kind: 'unknown', stage: 'connect', cause: new Error('unknown') },
    ] satisfies AttemptFailure[];

    const decisions = [
      { action: 'advance', failure: failures[1] },
      { action: 'terminate', category: 'auth', failure: failures[0] },
      { action: 'terminate', category: 'protocol', failure: failures[6] },
      { action: 'terminate', category: 'binding', failure: failures[7] },
      { action: 'terminate', category: 'service', failure: failures[8] },
      { action: 'terminate', category: 'unknown', failure: failures[9] },
    ] satisfies FailureDecision[];

    expect(failures).toHaveLength(10);
    expect(decisions).toHaveLength(6);
  });

  it('exposes initial attempt events, port, control, and compatible failure callback', () => {
    const events: InitialAttemptEvent[] = [];
    const port: InitialAttemptPort = {
      onEvent(event) {
        events.push(event);
      },
    };
    const control: InitialAttemptControl = {
      sendForAttempt(id, data) {
        return id === 1 && (typeof data === 'string' || data instanceof ArrayBuffer);
      },
      confirmAttempt(id) {
        return id === 1;
      },
      failAttempt(id) {
        return id === 1;
      },
    };
    const legacySocket: TraversalWebSocketLike = {
      readyState: 1,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send() {},
      close() {},
    };
    const factSocket: TraversalWebSocketLike = {
      ...legacySocket,
      onfailure: (failure: AttemptFailure) => {
        port.onEvent({ type: 'terminal', attemptId: 1, failure });
      },
    };

    port.onEvent({ type: 'begin', attemptId: 1 });
    port.onEvent({ type: 'message', attemptId: 1, data: 'hello' });
    port.onEvent({
      type: 'invalidated',
      attemptId: 1,
      reason: 'failure',
      failure: { kind: 'timeout', stage: 'mux', timer: 'confirmation' },
    });
    factSocket.onfailure?.({ kind: 'unknown', stage: 'connect' });

    expect(control.sendForAttempt(1, 'hello')).toBe(true);
    expect(control.confirmAttempt(1)).toBe(true);
    expect(control.failAttempt(1, { kind: 'unknown', stage: 'connect' })).toBe(true);
    expect(legacySocket.onfailure).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual([
      'begin',
      'message',
      'invalidated',
      'terminal',
    ]);
  });
});
