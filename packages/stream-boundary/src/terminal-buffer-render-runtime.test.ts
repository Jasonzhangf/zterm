import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTerminalBufferRenderRuntime,
  type TerminalBufferFrameChunk,
  type TerminalRenderCell,
} from './terminal-buffer-render-runtime.ts';

const cell = (char: number): TerminalRenderCell => ({ char, fg: 256, bg: 256, flags: 0, width: 1 });
const row = (index: number, char = index): TerminalBufferFrameChunk['lines'][number] => ({
  index,
  cells: [cell(char)],
});
const chunk = (overrides: Partial<TerminalBufferFrameChunk>): TerminalBufferFrameChunk => ({
  revision: 1,
  frameStartIndex: 10,
  frameEndIndex: 14,
  frameChunkIndex: 0,
  frameChunkCount: 2,
  startIndex: 10,
  endIndex: 12,
  generatedAt: 100,
  cols: 80,
  rows: 24,
  cursor: null,
  lines: [row(10), row(11)],
  ...overrides,
});

test('atomically assembles out-of-order chunks and renders one complete frame', () => {
  const runtime = createTerminalBufferRenderRuntime();
  assert.equal(runtime.applyFrameChunk(chunk({
    frameChunkIndex: 1,
    startIndex: 12,
    endIndex: 14,
    lines: [row(12), row(13)],
  })).kind, 'pending');

  const result = runtime.applyFrameChunk(chunk({}));
  assert.equal(result.kind, 'committed');
  assert.deepEqual(runtime.getSnapshot().lines.map((line) => line?.[0]?.char), [10, 11, 12, 13]);
  assert.deepEqual(runtime.getSnapshot().gapRanges, []);
});

test('rejects a hole and does not publish a partial frame', () => {
  const runtime = createTerminalBufferRenderRuntime();
  const result = runtime.applyFrameChunk(chunk({ lines: [row(10)] }));
  assert.deepEqual(result, {
    kind: 'rejected',
    error: 'invalid-frame',
    repairRange: { startIndex: 10, endIndex: 14 },
  });
  assert.equal(runtime.getSnapshot().revision, 0);
  assert.equal(runtime.getSnapshot().lines.length, 0);
});

test('rejects same-revision interleaving and preserves the exact repair range', () => {
  const runtime = createTerminalBufferRenderRuntime();
  assert.equal(runtime.applyFrameChunk(chunk({})).kind, 'pending');
  const result = runtime.applyFrameChunk(chunk({
    frameStartIndex: 20,
    frameEndIndex: 24,
    startIndex: 20,
    endIndex: 22,
    lines: [row(20), row(21)],
  }));
  assert.deepEqual(result, {
    kind: 'rejected',
    error: 'interleaved-frame',
    repairRange: { startIndex: 10, endIndex: 14 },
  });
  assert.equal(runtime.getSnapshot().revision, 0);
});

test('rejects stale frames and conflicting duplicate chunks without changing truth', () => {
  const runtime = createTerminalBufferRenderRuntime();
  assert.equal(runtime.applyFrameChunk(chunk({
    revision: 2,
    frameChunkIndex: 0,
    frameChunkCount: 1,
    frameEndIndex: 12,
    endIndex: 12,
    lines: [row(10), row(11)],
  })).kind, 'committed');
  const stale = runtime.applyFrameChunk(chunk({
    revision: 1,
    frameChunkCount: 1,
    frameEndIndex: 12,
    endIndex: 12,
    lines: [row(10), row(11)],
  }));
  assert.deepEqual(stale, {
    kind: 'rejected',
    error: 'stale-frame',
    repairRange: null,
  });

  const pending = createTerminalBufferRenderRuntime();
  assert.equal(pending.applyFrameChunk(chunk({})).kind, 'pending');
  const conflict = pending.applyFrameChunk(chunk({ lines: [row(10, 999), row(11)] }));
  assert.deepEqual(conflict, {
    kind: 'rejected',
    error: 'conflicting-frame',
    repairRange: { startIndex: 10, endIndex: 14 },
  });
  assert.equal(pending.getSnapshot().revision, 0);
});

test('supersedes an incomplete frame when a newer revision arrives', () => {
  const runtime = createTerminalBufferRenderRuntime();
  assert.equal(runtime.applyFrameChunk(chunk({ revision: 1 })).kind, 'pending');
  assert.equal(runtime.applyFrameChunk(chunk({
    revision: 2,
    generatedAt: 200,
    frameChunkIndex: 0,
  })).kind, 'pending');
  const result = runtime.applyFrameChunk(chunk({
    revision: 2,
    generatedAt: 200,
    frameChunkIndex: 1,
    startIndex: 12,
    endIndex: 14,
    lines: [row(12), row(13)],
  }));
  assert.equal(result.kind, 'committed');
  assert.equal(runtime.getSnapshot().revision, 2);
});

test('projects gaps without requesting upstream synchronization', () => {
  const runtime = createTerminalBufferRenderRuntime();
  runtime.applyFrameChunk(chunk({
    frameChunkCount: 1,
    frameEndIndex: 12,
    endIndex: 12,
    lines: [row(10), row(11)],
  }));
  const window = runtime.projectRenderWindow(8, 13);
  assert.deepEqual(window.lines.map((line) => line === null), [true, true, false, false, true]);
  assert.deepEqual(window.gapRanges, [
    { startIndex: 8, endIndex: 10 },
    { startIndex: 12, endIndex: 13 },
  ]);
});
