import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DesktopCommandHandler,
  DesktopGatewayError,
  createDesktopGatewayPreloadApi,
  DESKTOP_COMMAND_CHANNEL,
  DESKTOP_SUBSCRIBE_CHANNEL,
  isDesktopCommandWire,
  isDesktopResultWire,
} from './index.js';

function createHandler() {
  let generation = 0;
  return {
    handler: new DesktopCommandHandler({
      getGeneration: () => generation,
      setGeneration: (next) => {
        generation = next;
      },
    }),
    getGeneration: () => generation,
  };
}

function validWire(overrides: Partial<Record<'commandType' | 'commandId' | 'correlationId' | 'generation' | 'params', unknown>> = {}) {
  return {
    commandType: 'desktop.listSessions',
    commandId: 'cmd-1',
    correlationId: 'corr-1',
    params: undefined,
    generation: 1,
    ...overrides,
  };
}

test('accepts valid wire and calls registered executor', async () => {
  const { handler } = createHandler();
  let called = 0;
  handler.register('desktop.listSessions', async () => {
    called += 1;
    return { sessions: ['main'] };
  });

  const result = await handler.execute(validWire());

  assert.equal(result.commandId, 'cmd-1');
  assert.equal(result.generation, 1);
  assert.equal(result.outcome.ok, true);
  if (result.outcome.ok) assert.deepEqual(result.outcome.value, { sessions: ['main'] });
  assert.equal(called, 1);
});

test('rejects invalid wire without calling executor', async () => {
  const { handler } = createHandler();
  let called = 0;
  handler.register('desktop.listSessions', async () => {
    called += 1;
    return { sessions: [] };
  });

  const result = await handler.execute(null);

  assert.equal(result.outcome.ok, false);
  if (!result.outcome.ok) assert.equal(result.outcome.error.code, 'INVALID_COMMAND');
  assert.equal(called, 0);
});

test('rejects missing command fields without calling executor', async () => {
  const { handler } = createHandler();
  let called = 0;
  handler.register('desktop.listSessions', async () => {
    called += 1;
    return { sessions: [] };
  });

  const result = await handler.execute(validWire({ commandType: undefined }));

  assert.equal(result.outcome.ok, false);
  if (!result.outcome.ok) assert.equal(result.outcome.error.code, 'INVALID_COMMAND');
  assert.equal(called, 0);
});

test('rejects stale generation without calling executor or updating state', async () => {
  const { handler, getGeneration } = createHandler();
  let called = 0;
  handler.register('desktop.listSessions', async () => {
    called += 1;
    return { sessions: ['new'] };
  });

  const first = await handler.execute(validWire({ generation: 2 }));
  assert.equal(first.outcome.ok, true);
  assert.equal(getGeneration(), 2);

  const stale = await handler.execute(validWire({ generation: 1 }));
  assert.equal(stale.outcome.ok, false);
  if (!stale.outcome.ok) assert.equal(stale.outcome.error.code, 'STALE_GENERATION');
  assert.equal(called, 1);
  assert.equal(getGeneration(), 2);
});

test('rejects generation zero explicitly', async () => {
  const { handler } = createHandler();
  handler.register('desktop.listSessions', async () => ({ sessions: [] }));

  const result = await handler.execute(validWire({ generation: 0 }));

  assert.equal(result.outcome.ok, false);
  if (!result.outcome.ok) assert.equal(result.outcome.error.code, 'INVALID_GENERATION');
});

test('returns UNKNOWN_COMMAND for unregistered command', async () => {
  const { handler } = createHandler();

  const result = await handler.execute(validWire({ commandType: 'desktop.missing' }));

  assert.equal(result.outcome.ok, false);
  if (!result.outcome.ok) assert.equal(result.outcome.error.code, 'UNKNOWN_COMMAND');
});

test('returns explicit EXECUTION_ERROR when executor throws', async () => {
  const { handler } = createHandler();
  handler.register('desktop.tmuxConnect', async () => {
    throw new DesktopGatewayError('PLATFORM_CAPABILITY_UNAVAILABLE', 'session not found');
  });

  const result = await handler.execute(validWire({
    commandType: 'desktop.tmuxConnect',
    params: { clientId: 'c1', sessionName: 'missing', cols: 80, rows: 24 },
  }));

  assert.equal(result.outcome.ok, false);
  if (!result.outcome.ok) {
    assert.equal(result.outcome.error.code, 'PLATFORM_CAPABILITY_UNAVAILABLE');
    assert.match(result.outcome.error.message, /session not found/);
  }
});

test('wire and result guards reject malformed payloads', () => {
  assert.equal(isDesktopCommandWire(validWire()), true);
  assert.equal(isDesktopCommandWire({ ...validWire(), generation: '0' }), false);
  assert.equal(isDesktopCommandWire(null), false);
  assert.equal(isDesktopResultWire({
    commandId: 'cmd-1',
    generation: 1,
    outcome: { ok: true, value: {} },
  }), true);
  assert.equal(isDesktopResultWire({ commandId: 'cmd-1' }), false);
});

test('preload api increments generation and subscribes with cleanup', async () => {
  const sent: unknown[] = [];
  const listeners = new Map<string, (event: unknown, payload: { eventType: string; correlationId?: string; payload: unknown }) => void>();
  const api = createDesktopGatewayPreloadApi(
    async (channel, wire) => {
      sent.push({ channel, wire });
      return { commandId: wire.commandId, generation: wire.generation, outcome: { ok: true, value: { sessions: [] } } };
    },
    (channel, listener) => listeners.set(channel, listener),
    (channel, listener) => {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    },
  );

  const first = await api.execute('desktop.listSessions', 'cmd-1', 'corr-1');
  const second = await api.execute('desktop.listSessions', 'cmd-2', 'corr-2');
  assert.equal(first.generation, 1);
  assert.equal(second.generation, 2);
  assert.equal(sent.length, 2);
  assert.equal((sent[0] as { channel: string }).channel, DESKTOP_COMMAND_CHANNEL);
  assert.equal((sent[1] as { channel: string }).channel, DESKTOP_COMMAND_CHANNEL);

  const received: unknown[] = [];
  const unsubscribe = api.subscribe((event) => received.push(event));
  listeners.get(DESKTOP_SUBSCRIBE_CHANNEL)?.('ignored', { eventType: 'desktop.ready', payload: {} });
  assert.equal(received.length, 1);
  unsubscribe();
  assert.equal(listeners.has(DESKTOP_SUBSCRIBE_CHANNEL), false);
});
