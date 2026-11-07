import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeliveryClient, TypedError } from '../../src/clients/delivery-client.mjs';

function createTransport() {
  const calls = [];
  const subscribers = new Map();
  return {
    calls,
    subscribers,
    send: async (request) => {
      calls.push(request);
      return { ok: true, type: request.type, payload: request.payload };
    },
    subscribe: (topic, payload, handler) => {
      subscribers.set(`${topic}:${payload.workspaceId}:${payload.memberId}`, { topic, payload, handler });
      return () => subscribers.delete(`${topic}:${payload.workspaceId}:${payload.memberId}`);
    },
  };
}

test('submitMessage calls delivery.submitMessage and returns the transport result', async () => {
  const transport = createTransport();
  const client = createDeliveryClient({ transport });
  const result = await client.submitMessage({
    workspaceId: 'ws-1',
    senderMemberId: 'm1',
    recipientMemberId: 'm2',
    body: 'hello',
    clientMessageId: 'msg-1',
    metadata: { kind: 'text' },
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(transport.calls.length, 1);
  assert.strictEqual(transport.calls[0].type, 'delivery.submitMessage');
  assert.strictEqual(transport.calls[0].payload.workspaceId, 'ws-1');
  assert.strictEqual(transport.calls[0].payload.body, 'hello');
});

test('submitMessage rejects missing required fields without sending', async () => {
  const transport = createTransport();
  const client = createDeliveryClient({ transport });
  await assert.rejects(
    client.submitMessage({ workspaceId: 'ws-1', recipientMemberId: 'm2' }),
    (error) => error instanceof TypedError && error.code === 'DELIVERY_INVALID_ARGUMENT' && error.category === 'invalid_argument',
  );
  assert.strictEqual(transport.calls.length, 0);
});

test('transport failure becomes a retryable TypedError and never fabricates delivered', async () => {
  const transport = {
    send: async () => { throw new Error('wire down'); },
  };
  const client = createDeliveryClient({ transport });
  await assert.rejects(
    client.submitMessage({ workspaceId: 'ws-1', recipientMemberId: 'm2', body: 'hello' }),
    (error) => error instanceof TypedError
      && error.code === 'DELIVERY_TRANSPORT_FAILURE'
      && error.category === 'transport'
      && error.retryable === true
      && error.details.originalMessage === 'wire down',
  );
});

test('beginFile, writeChunk, commitFile, queryReceipt, and queryTransfer use the delivery port types', async () => {
  const transport = createTransport();
  const client = createDeliveryClient({ transport });
  await client.beginFile({
    workspaceId: 'ws-1',
    senderMemberId: 'm1',
    recipientMemberId: 'm2',
    fileName: 'report.pdf',
    totalBytes: 1024,
    mimeType: 'application/pdf',
    sha256: 'abc123',
  });
  await client.writeChunk({ transferId: 't1', chunkIndex: 0, byteOffset: 0, data: 'abc', isLastChunk: false });
  await client.commitFile({ transferId: 't1', totalChunks: 1, totalBytes: 1024 });
  await client.queryReceipt({ messageId: 'msg-1' });
  await client.queryTransfer({ transferId: 't1' });
  assert.deepEqual(transport.calls.map((call) => call.type), [
    'delivery.beginFile',
    'delivery.writeChunk',
    'delivery.commitFile',
    'delivery.queryReceipt',
    'delivery.queryTransfer',
  ]);
  assert.strictEqual(transport.calls[3].payload.messageId, 'msg-1');
  assert.strictEqual(transport.calls[4].payload.transferId, 't1');
});

test('subscribeInbox subscribes to delivery.inbox and returns an unsubscribe function', async () => {
  const transport = createTransport();
  const client = createDeliveryClient({ transport });
  let called = 0;
  const handler = () => { called += 1; };
  const unsubscribe = client.subscribeInbox({ workspaceId: 'ws-1', memberId: 'm2' }, handler);
  assert.strictEqual(typeof unsubscribe, 'function');
  const entry = transport.subscribers.get('delivery.inbox:ws-1:m2');
  assert.ok(entry);
  entry.handler();
  assert.strictEqual(called, 1);
  unsubscribe();
  assert.strictEqual(transport.subscribers.size, 0);
});

test('subscribeInbox rejects missing scope and invalid handler', () => {
  const transport = createTransport();
  const client = createDeliveryClient({ transport });
  assert.throws(() => client.subscribeInbox({ memberId: 'm2' }, () => {}), TypedError);
  assert.throws(() => client.subscribeInbox({ workspaceId: 'ws-1', memberId: 'm2' }, null), TypedError);
});
