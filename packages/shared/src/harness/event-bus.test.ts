import { describe, it, expect, vi } from 'vitest';
import { createEventBus } from './event-bus';
import { createEvent } from '../interaction/event';

describe('event-bus', () => {
  it('emit delivers to all listeners', () => {
    const bus = createEventBus();
    const fn = vi.fn();
    bus.on(fn);
    const ev = createEvent('session/created', {
      sessionId: 's1', host: 'h', port: 4444, sessionName: 'test',
    });
    bus.emit(ev);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(ev);
  });

  it('onType only receives matching type', () => {
    const bus = createEventBus();
    const created = vi.fn();
    const closed = vi.fn();
    bus.onType('session/created', created);
    bus.onType('session/closed', closed);
    bus.emit(createEvent('session/created', {
      sessionId: 's1', host: 'h', port: 4444, sessionName: 'test',
    }));
    expect(created).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(0);
  });

  it('unsubscribe stops delivery', () => {
    const bus = createEventBus();
    const fn = vi.fn();
    const unsub = bus.on(fn);
    bus.emit(createEvent('app/foreground-resumed', {}));
    unsub();
    bus.emit(createEvent('app/background-paused', {}));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('last returns most recent event of that type', () => {
    const bus = createEventBus();
    expect(bus.last('session/created')).toBeUndefined();
    const ev1 = createEvent('session/created', {
      sessionId: 's1', host: 'h', port: 4444, sessionName: 'test',
    });
    bus.emit(ev1);
    const ev2 = createEvent('session/created', {
      sessionId: 's2', host: 'h', port: 4444, sessionName: 'test2',
    });
    bus.emit(ev2);
    expect(bus.last('session/created')).toBe(ev2);
  });

  it('clear removes all listeners and cache', () => {
    const bus = createEventBus();
    const fn = vi.fn();
    bus.on(fn);
    bus.emit(createEvent('app/foreground-resumed', {}));
    bus.clear();
    bus.emit(createEvent('app/background-paused', {}));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(bus.last('app/foreground-resumed')).toBeUndefined();
  });
});

