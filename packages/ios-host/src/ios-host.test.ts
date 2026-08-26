import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IOS_COMMAND_CHANNEL,
  IOS_EVENT_CHANNEL,
  IosHostGateway,
  createIosCapacitorAdapter,
  decodeIosCommand,
  decodeIosEvent,
  decodeIosSnapshot,
  encodeIosCommand,
  isIosLifecycleSignal,
} from './index.ts';
import { createControlCommand } from '@zterm/runtime-contracts';

const command = createControlCommand('session.open', 'command-1', 'correlation-1', { sessionId: 'session-1' });
const commandWithGen = { ...command, generation: 1 };

test('round-trips valid command, event, and snapshot IPC payloads', () => {
  const event = { eventType: 'session.opened', correlationId: 'correlation-1', payload: { sessionId: 'session-1' }, generation: 1 };
  const snapshot = { revision: 3, generation: 1, data: { sessionId: 'session-1' } };
  const decoded = decodeIosCommand(encodeIosCommand(commandWithGen));
  assert.equal(decoded.commandType, 'session.open');
  assert.equal(decoded.commandId, 'command-1');
  assert.equal(decoded.correlationId, 'correlation-1');
  assert.equal(decoded.generation, 1);
  assert.deepEqual(decoded.params, { sessionId: 'session-1' });
  assert.equal(JSON.stringify(decoded).includes('metadata'), false);
  assert.deepEqual(decodeIosEvent(JSON.stringify(event)), event);
  assert.deepEqual(decodeIosSnapshot(JSON.stringify(snapshot)), snapshot);
});

test('rejects malformed, unknown, and control-metadata payloads explicitly', () => {
  assert.throws(() => decodeIosCommand(JSON.stringify({ ...commandWithGen, commandType: 'ios.unknown' })), /unknown command/);
  assert.throws(() => decodeIosCommand(JSON.stringify({ ...commandWithGen, params: { metadata: { retry: true } } })), /metadata/);
  assert.throws(() => decodeIosEvent(JSON.stringify({ eventType: 'x', generation: 1, payload: { connected: true } })), /control field/);
  assert.throws(() => decodeIosSnapshot(JSON.stringify({ revision: 1, generation: 1, data: null })), /data/);
});

test('accepts current generation and rejects stale generation without changing snapshot truth', async () => {
  const gateway = new IosHostGateway({
    execute: async (wire) => ({ commandId: wire.commandId, generation: wire.generation, outcome: { ok: true, value: { accepted: true } } }),
    readSnapshot: async () => ({ revision: 1, generation: 2, data: { ready: true } }),
  });
  await gateway.acceptEvent(JSON.stringify({ eventType: 'ready', generation: 2, payload: { ready: true } }));
  assert.equal(gateway.currentGeneration(), 2);
  await assert.rejects(
    gateway.acceptEvent(JSON.stringify({ eventType: 'stale', generation: 1, payload: {} })),
    /stale generation/,
  );
  assert.deepEqual(await gateway.readSnapshot(), { revision: 1, generation: 2, data: { ready: true } });
});

test('rejects lifecycle attempts to forge connection truth and projects known signals', () => {
  assert.equal(isIosLifecycleSignal('foreground-resume'), true);
  assert.equal(isIosLifecycleSignal('background-entered'), true);
  assert.equal(isIosLifecycleSignal('connected'), false);
  assert.throws(
    () => createIosCapacitorAdapter({ postMessage: () => undefined }).projectLifecycle('connected'),
    /unsupported lifecycle signal/,
  );
  assert.equal(
    createIosCapacitorAdapter({ postMessage: () => undefined }).projectLifecycle('foreground-resume'),
    'foreground-resume',
  );
});

test('adapter forwards typed command and owns listener cleanup without native objects', async () => {
  const posted: Array<{ channel: string; body: string }> = [];
  let listener: ((body: string) => void) | undefined;
  let removed = 0;
  const adapter = createIosCapacitorAdapter({
    postMessage: (channel, body) => posted.push({ channel, body }),
    onMessage: (channel, next) => {
      assert.equal(channel, IOS_EVENT_CHANNEL);
      listener = next;
    },
    offMessage: () => { removed += 1; },
  });
  const gateway = adapter.gateway({
    execute: async (wire) => ({ commandId: wire.commandId, generation: wire.generation, outcome: { ok: true, value: wire.params } }),
    readSnapshot: async () => ({ revision: 1, generation: 1, data: {} }),
  });
  const result = await gateway.execute(command);
  assert.equal(result.ok, true);
  assert.equal(posted[0]?.channel, IOS_COMMAND_CHANNEL);
  const received: unknown[] = [];
  const dispose = adapter.subscribe((event) => received.push(event));
  listener?.(JSON.stringify({ eventType: 'ready', generation: 1, payload: {} }));
  assert.equal(received.length, 1);
  dispose();
  assert.equal(removed, 1);
});
