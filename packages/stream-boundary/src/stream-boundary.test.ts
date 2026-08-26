import assert from 'node:assert/strict';
import test from 'node:test';

import { DataStreamGateway } from './index.ts';

test('publishes ordered data envelopes without control fields', async () => {
  const envelopes: Array<{
    channelId: string;
    revision: number;
    body: Uint8Array;
  }> = [];
  const gateway = new DataStreamGateway({
    onEnvelope: (envelope) => envelopes.push(envelope),
  });

  const handle = await gateway.openDataStream({ channelId: 'terminal', mode: 'reliable' });
  const first = new TextEncoder().encode('first');
  handle.send(first);
  first[0] = 0;
  handle.send(new TextEncoder().encode('second'));

  assert.deepEqual(
    envelopes.map((envelope) => ({
      channelId: envelope.channelId,
      revision: envelope.revision,
      body: new TextDecoder().decode(envelope.body),
    })),
    [
      { channelId: 'terminal', revision: 1, body: 'first' },
      { channelId: 'terminal', revision: 2, body: 'second' },
    ],
  );
  assert.deepEqual(Object.keys(envelopes[0]), ['channelId', 'revision', 'body']);
  handle.dispose('test');
  assert.equal(envelopes.length, 2);
});

test('reopens a channel after explicit disposal', () => {
  const gateway = new DataStreamGateway();
  const first = gateway.open({ channelId: 'file', mode: 'lossy' });
  first.dispose('test');
  const reopened = gateway.open({ channelId: 'file', mode: 'lossy' });
  assert.equal(reopened.channelId, 'file');
});

test('rejects duplicate, disposed, and unsupported streams explicitly', () => {
  const gateway = new DataStreamGateway();
  const first = gateway.open({ channelId: 'file', mode: 'lossy' });
  assert.throws(() => gateway.open({ channelId: 'file', mode: 'lossy' }), /already open/);
  assert.throws(() => gateway.open({ channelId: '', mode: 'reliable' }), /non-empty/);
  assert.throws(
    () => gateway.open({ channelId: 'bad', mode: 'unsupported' as never }),
    /unsupported stream mode/,
  );
  first.dispose('test');
  assert.throws(() => first.send(new Uint8Array(0)), /disposed/);
});

test('fails explicitly when no data-plane sink is configured', () => {
  const gateway = new DataStreamGateway();
  const handle = gateway.open({ channelId: 'terminal', mode: 'reliable' });
  assert.throws(() => handle.send(new Uint8Array([1])), /sink is not configured/);
});

test('does not route stream data through a control/event surface', () => {
  const gateway = new DataStreamGateway({
    onEnvelope: (envelope) => {
      assert.equal('eventType' in envelope, false);
      assert.equal('correlationId' in envelope, false);
      assert.equal('metadata' in envelope, false);
    },
  });
  gateway.open({ channelId: 'terminal', mode: 'reliable' }).send(new Uint8Array([1, 2, 3]));
});
