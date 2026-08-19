import { describe, expect, it } from 'vitest';
import {
  createAndroidConnectionServiceStateMachine,
  type AndroidConnectionServiceEvent,
} from './android-connection-service-snapshot';

const target = {
  targetKey: 'daemon:mac-studio',
  bridgeHost: '100.66.1.82',
  bridgePort: 3333,
  authToken: 'token',
};

function send(
  machine: ReturnType<typeof createAndroidConnectionServiceStateMachine>,
  event: AndroidConnectionServiceEvent,
) {
  machine.dispatch(event);
  return machine.readSnapshot();
}

describe('Android connection service state machine', () => {
  it('keeps the healthy path service-owned', () => {
    const machine = createAndroidConnectionServiceStateMachine({ now: () => 1000 });

    expect(send(machine, { type: 'bind-target', target }).state).toBe('resolving-target');
    expect(send(machine, { type: 'transport-opening', generation: 'g1' }).state).toBe('connecting');
    expect(send(machine, { type: 'mux-ready', generation: 'g1' }).state).toBe('mux-ready');
    expect(send(machine, { type: 'channel-opened', generation: 'g1', channelId: 'c1' }).state).toBe('channels-ready');
    expect(send(machine, { type: 'heartbeat-pong', generation: 'g1', at: 1100 }).state).toBe('healthy');
    expect(machine.readSnapshot().generation).toBe('g1');
  });

  it('retires one generation after exactly three heartbeat misses', () => {
    const machine = createAndroidConnectionServiceStateMachine({ now: () => 1000 });
    send(machine, { type: 'bind-target', target });
    send(machine, { type: 'transport-opening', generation: 'g1' });
    send(machine, { type: 'mux-ready', generation: 'g1' });
    send(machine, { type: 'channel-opened', generation: 'g1', channelId: 'c1' });
    send(machine, { type: 'heartbeat-pong', generation: 'g1', at: 1100 });

    expect(send(machine, { type: 'heartbeat-missed', generation: 'g1' }).state).toBe('healthy');
    expect(send(machine, { type: 'heartbeat-missed', generation: 'g1' }).state).toBe('healthy');
    const retired = send(machine, { type: 'heartbeat-missed', generation: 'g1' });
    expect(retired.state).toBe('backoff-reconnect');
    expect(retired.nextRetryAt).not.toBeNull();
    expect(retired.error?.code).toBe('heartbeat-timeout');
  });

  it('stops automatic reconnect on authentication failure', () => {
    const machine = createAndroidConnectionServiceStateMachine({ now: () => 1000 });
    send(machine, { type: 'bind-target', target });
    send(machine, { type: 'transport-opening', generation: 'g1' });

    const snapshot = send(machine, {
      type: 'authentication-failure',
      generation: 'g1',
      message: '401 unauthorized',
    });

    expect(snapshot.state).toBe('authentication-error');
    expect(snapshot.nextRetryAt).toBeNull();
    expect(snapshot.error?.code).toBe('authentication');
  });

  it('schedules reconnect only from a service-owned transport failure', () => {
    const machine = createAndroidConnectionServiceStateMachine({ now: () => 1000 });
    send(machine, { type: 'bind-target', target });
    send(machine, { type: 'transport-opening', generation: 'g1' });

    const snapshot = send(machine, {
      type: 'transport-failure',
      generation: 'g1',
      message: 'socket closed',
    });

    expect(snapshot).toMatchObject({
      state: 'backoff-reconnect',
      generation: null,
      nextRetryAt: 2000,
      error: { code: 'transport', message: 'socket closed' },
    });
  });

  it('rejects stale generation events without changing current truth', () => {
    const machine = createAndroidConnectionServiceStateMachine({ now: () => 1000 });
    send(machine, { type: 'bind-target', target });
    send(machine, { type: 'transport-opening', generation: 'g2' });
    const before = machine.readSnapshot();

    const accepted = machine.dispatch({ type: 'heartbeat-pong', generation: 'g1', at: 900 });

    expect(accepted).toBe(false);
    expect(machine.readSnapshot()).toEqual(before);
  });

  it('preserves the latest service snapshot while the UI is detached', () => {
    const machine = createAndroidConnectionServiceStateMachine({ now: () => 1000 });
    send(machine, { type: 'bind-target', target });
    send(machine, { type: 'transport-opening', generation: 'g1' });
    machine.detachProjection();
    send(machine, { type: 'mux-ready', generation: 'g1' });

    expect(machine.attachProjection()).toMatchObject({
      state: 'mux-ready',
      generation: 'g1',
    });
  });
});
