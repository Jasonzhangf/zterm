import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFileMediaInputStreamRuntime,
  type DedicatedStreamChunk,
  type DedicatedStreamPolicy,
} from './file-media-input-streams.ts';

const policy = (overrides: Partial<DedicatedStreamPolicy> = {}): DedicatedStreamPolicy => ({
  kind: 'file',
  mode: 'reliable',
  highWaterBytes: 100,
  lowWaterBytes: 50,
  streamId: 'file-main',
  ...overrides,
});

test('dedicated reliable stream preserves sequence and allows ack drain', () => {
  const chunks: DedicatedStreamChunk[] = [];
  const runtime = createFileMediaInputStreamRuntime({
    onChunk: (chunk) => chunks.push(chunk),
  });
  const stream = runtime.openStream(policy());
  assert.equal(stream.write(new Uint8Array([1, 2, 3])), true);
  assert.equal(stream.write(new Uint8Array([4])), true);
  assert.deepEqual(chunks.map((chunk) => chunk.sequence), [1, 2]);
  stream.acknowledge(1);
  assert.equal(stream.getStats().bufferedBytes, 1);
  stream.acknowledge(2);
  assert.equal(stream.getStats().bufferedBytes, 0);
  stream.close('done');
  assert.throws(() => runtime.getStats('file-main'), /not open/);
});

test('reliable stream holds writes at high water and resumes after low water', () => {
  const runtime = createFileMediaInputStreamRuntime();
  const stream = runtime.openStream(policy());
  assert.equal(stream.write(new Uint8Array(80)), true);
  assert.equal(stream.getStats().backpressured, false);
  assert.equal(stream.write(new Uint8Array(30)), false);
  assert.equal(stream.write(new Uint8Array(20)), true);
  assert.equal(stream.getStats().backpressured, true);
  assert.equal(stream.write(new Uint8Array(1)), false);
  stream.acknowledge(1);
  assert.equal(stream.getStats().backpressured, false);
  assert.equal(stream.write(new Uint8Array(20)), true);
});

test('lossy stream drops chunks instead of blocking the sender', () => {
  const runtime = createFileMediaInputStreamRuntime();
  const stream = runtime.openStream(policy({ mode: 'lossy' }));
  assert.equal(stream.write(new Uint8Array(60)), true);
  assert.equal(stream.write(new Uint8Array(60)), false);
  assert.equal(stream.getStats().droppedLossyChunks, 1);
  assert.equal(stream.getStats().sequence, 1);
});

test('generation advance closes every stream and rejects stale writes', () => {
  let closed = 0;
  const runtime = createFileMediaInputStreamRuntime({
    onClosed: () => { closed += 1; },
  });
  const file = runtime.openStream(policy());
  const input = runtime.openStream(policy({ kind: 'input', streamId: 'input-main' }));
  assert.equal(runtime.advanceGeneration(), 2);
  assert.equal(closed, 2);
  assert.equal(file.getStats().open, false);
  assert.equal(input.getStats().open, false);
  assert.throws(() => file.write(new Uint8Array([1])), /not open/);
});

test('dispose is idempotent and rejects new streams', () => {
  const runtime = createFileMediaInputStreamRuntime();
  const stream = runtime.openStream(policy());
  runtime.dispose('shutdown');
  runtime.dispose('again');
  assert.equal(stream.getStats().open, false);
  assert.throws(() => runtime.openStream(policy({ streamId: 'new' })), /disposed/);
  assert.throws(() => runtime.openStream(policy({ streamId: 'same' })), /disposed/);
});

test('stale generation is rejected without fallback', () => {
  const runtime = createFileMediaInputStreamRuntime();
  const first = runtime.openStream(policy({ streamId: 'file-a' }));
  const second = runtime.openStream(policy({ streamId: 'file-b' }));
  runtime.advanceGeneration();
  assert.equal(first.getStats().open, false);
  assert.equal(second.getStats().open, false);
  assert.throws(() => runtime.getStats('file-a'), /not open/);
});
