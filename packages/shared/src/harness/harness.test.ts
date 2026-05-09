import { describe, it, expect, vi } from 'vitest';
import { createTestHarness, type BlockContext } from './harness';
import { createOperation } from '../interaction/operation';
import { createEvent } from '../interaction/event';

describe('test-harness', () => {
  it('dispatch triggers matching block handler', () => {
    const harness = createTestHarness();
    const handler = vi.fn((_op, ctx: BlockContext) => []);
    harness.registerBlock(['update/check'], handler);

    const op = createOperation('update/check', {});
    harness.dispatch(op);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('non-matching block is not invoked', () => {
    const harness = createTestHarness();
    const handler = vi.fn((_op, ctx: BlockContext) => []);
    harness.registerBlock(['update/check'], handler);

    const op = createOperation('session/create', { host: 'h', port: 4444, sessionName: 'test' });
    harness.dispatch(op);

    expect(handler).toHaveBeenCalledTimes(0);
  });

  it('events emitted by block are delivered to bus', () => {
    const harness = createTestHarness();
    const listener = vi.fn();
    harness.bus.on(listener);

    harness.registerBlock(['session/create'], (_op, ctx: BlockContext) => {
      return [createEvent('session/created', {
        sessionId: 's1', host: 'h', port: 4444, sessionName: 'test',
      })];
    });

    harness.dispatch(createOperation('session/create', { host: 'h', port: 4444, sessionName: 'test' }));

    expect(listener).toHaveBeenCalledTimes(1);
    const ev = listener.mock.calls[0][0];
    expect(ev.type).toBe('session/created');
  });

  it('block can read and write projection', () => {
    const harness = createTestHarness();

    harness.registerBlock(['update/check'], (_op, ctx: BlockContext) => {
      ctx.setProjection('check-count', 1);
      return [];
    });

    harness.dispatch(createOperation('update/check', {}));

    expect(harness.getProjection('check-count')).toBe(1);
  });

  it('unregister stops block from being invoked', () => {
    const harness = createTestHarness();
    const handler = vi.fn((_op, ctx: BlockContext) => []);
    const unreg = harness.registerBlock(['update/check'], handler);
    unreg();

    harness.dispatch(createOperation('update/check', {}));

    expect(handler).toHaveBeenCalledTimes(0);
  });

  it('clear resets everything', () => {
    const harness = createTestHarness();
    const handler = vi.fn((_op, ctx: BlockContext) => []);
    const listener = vi.fn();
    harness.registerBlock(['update/check'], handler);
    harness.bus.on(listener);
    harness.bus.emit(createEvent('app/foreground-resumed', {}));

    harness.clear();

    harness.dispatch(createOperation('update/check', {}));
    expect(handler).toHaveBeenCalledTimes(0);
    harness.bus.emit(createEvent('app/background-paused', {}));
    expect(listener).toHaveBeenCalledTimes(1); // original call before clear
    expect(harness.bus.last('app/foreground-resumed')).toBeUndefined();
  });
});

