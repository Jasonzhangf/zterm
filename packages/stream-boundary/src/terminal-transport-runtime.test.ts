import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTerminalTransportRuntime,
  type TransportChannelEvent,
} from './index.ts';

test('preserves ordered envelopes on the current transport generation', () => {
  const envelopes: Array<{ channelId: string; revision: number; body: string }> = [];
  const runtime = createTerminalTransportRuntime({
    onEnvelope: (envelope) => {
      envelopes.push({
        channelId: envelope.channelId,
        revision: envelope.revision,
        body: new TextDecoder().decode(envelope.body),
      });
    },
  });
  const channel = runtime.openChannel('terminal-main');

  channel.send(new TextEncoder().encode('first'));
  channel.send(new TextEncoder().encode('second'));

  assert.deepEqual(envelopes, [
    { channelId: 'terminal-main', revision: 1, body: 'first' },
    { channelId: 'terminal-main', revision: 2, body: 'second' },
  ]);
  assert.deepEqual(Object.keys(envelopes[0]), ['channelId', 'revision', 'body']);
});

test('rejects stale transport generation without publishing an envelope', () => {
  let envelopeCount = 0;
  const runtime = createTerminalTransportRuntime({
    onEnvelope: () => {
      envelopeCount += 1;
    },
  });
  const channel = runtime.openChannel('terminal-main');
  runtime.advanceGeneration();

  assert.throws(
    () => channel.send(new TextEncoder().encode('stale')),
    /not open/,
  );
  assert.equal(envelopeCount, 0);

  const fresh = runtime.openChannel('terminal-main');
  assert.equal(fresh.channelId, 'terminal-main');
  fresh.send(new TextEncoder().encode('fresh'));
  assert.equal(envelopeCount, 1);
});

test('advancing generation closes every open channel and emits explicit events', () => {
  const events: TransportChannelEvent[] = [];
  const runtime = createTerminalTransportRuntime({
    onChannelEvent: (event) => events.push(event),
  });
  const first = runtime.openChannel('channel-a');
  const second = runtime.openChannel('channel-b');
  const nextGeneration = runtime.advanceGeneration();

  assert.equal(nextGeneration, 2);
  assert.equal(first.state, 'closed');
  assert.equal(second.state, 'closed');
  assert.deepEqual(
    events.map((event) => ({ kind: event.kind, channelId: event.channelId })),
    [
      { kind: 'opened', channelId: 'channel-a' },
      { kind: 'opened', channelId: 'channel-b' },
      { kind: 'closed', channelId: 'channel-a' },
      { kind: 'closed', channelId: 'channel-b' },
    ],
  );
});

test('channel lifecycle supports explicit close and reopen', () => {
  let reopenedRevision = 0;
  const runtime = createTerminalTransportRuntime({
    onEnvelope: (env) => { reopenedRevision = env.revision; },
  });
  const channel = runtime.openChannel('file-main');
  channel.close('test done');
  assert.equal(channel.state, 'closed');

  const reopened = runtime.openChannel('file-main');
  assert.equal(reopened.channelId, 'file-main');
  reopened.send(new Uint8Array([1]));
  assert.equal(reopenedRevision, 1);
});

test('channel lifecycle rejects duplicates, empty ids, and send after close explicitly', () => {
  const runtime = createTerminalTransportRuntime();
  const channel = runtime.openChannel('file-main');
  assert.throws(() => runtime.openChannel('file-main'), /already open/);
  assert.throws(() => runtime.openChannel(''), /must be non-empty/);
  channel.close('done');
  assert.throws(() => channel.send(new Uint8Array([1])), /not open/);
  assert.throws(() => runtime.closeChannel('file-main', 'again'), /not open/);
});

test('enters backpressure at high-water and holds sends until low-water drain', () => {
  const runtime = createTerminalTransportRuntime({
    backpressure: { highWaterBytes: 100, lowWaterBytes: 50 },
  });

  assert.equal(runtime.reportBufferedBytes(80).backpressured, false);
  assert.equal(runtime.shouldHoldSend(), false);

  const entered = runtime.reportBufferedBytes(100);
  assert.equal(entered.backpressured, true);
  assert.equal(typeof entered.highWaterEnteredAt, 'number');
  assert.equal(runtime.shouldHoldSend(), true);

  const stillHigh = runtime.reportBufferedBytes(90);
  assert.equal(stillHigh.backpressured, true);
  assert.equal(runtime.shouldHoldSend(), true);

  const drained = runtime.reportBufferedBytes(50);
  assert.equal(drained.backpressured, false);
  assert.equal(drained.lowWaterDrained, true);
  assert.equal(runtime.shouldHoldSend(), false);
});

test('backpressure hysteresis never resumes between low-water and high-water', () => {
  const runtime = createTerminalTransportRuntime({
    backpressure: { highWaterBytes: 100, lowWaterBytes: 50 },
  });
  runtime.reportBufferedBytes(150);
  assert.equal(runtime.shouldHoldSend(), true);

  runtime.reportBufferedBytes(75);
  assert.equal(runtime.shouldHoldSend(), true);

  runtime.reportBufferedBytes(50);
  assert.equal(runtime.shouldHoldSend(), false);
});

test('dispose closes all channels once and makes the runtime reject new use', () => {
  const events: TransportChannelEvent[] = [];
  const runtime = createTerminalTransportRuntime({
    onChannelEvent: (event) => events.push(event),
  });
  const channel = runtime.openChannel('terminal-main');
  runtime.dispose('shutdown');
  runtime.dispose('again');

  assert.equal(channel.state, 'closed');
  assert.equal(events.length, 2);
  assert.deepEqual(events[1], {
    kind: 'closed',
    channelId: 'terminal-main',
    generation: 1,
    reason: 'shutdown',
  });
  assert.throws(() => runtime.openChannel('new'), /disposed/);
  assert.throws(() => runtime.reportBufferedBytes(1), /disposed/);
});
