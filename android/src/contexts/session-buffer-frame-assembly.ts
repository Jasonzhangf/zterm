import { normalizeWireLines } from '../lib/terminal-buffer';
import type { TerminalBufferPayload, TerminalCell } from '../lib/types';
import {
  TERMINAL_BUFFER_SYNC_FRAME_MAX_AGE_MS,
  TERMINAL_BUFFER_SYNC_FRAME_MAX_CHUNKS,
  TERMINAL_BUFFER_SYNC_FRAME_MAX_RETAINED_BYTES,
  TERMINAL_BUFFER_SYNC_FRAME_MAX_SPAN_LINES,
} from '@zterm/shared/types';
import type {
  BufferFrameAssemblyError,
  BufferFrameAssemblyRepairRange,
  BufferFrameAssemblyState,
} from './session-buffer-frame-assembly-state';

export {
  BUFFER_FRAME_REPAIR_LEDGER_MAX_REVISIONS,
  clearPendingBufferSyncFrameAssembly,
  hasBufferFrameRepairDispatch,
  recordBufferFrameRepairDispatch,
  resetBufferSyncFrameAssemblyEpoch,
} from './session-buffer-frame-assembly-state';
export type {
  BufferFrameAssemblyError,
  BufferFrameAssemblyErrorTruth,
  BufferFrameAssemblyRepairRange,
  BufferFrameAssemblyRepairTruth,
  BufferFrameAssemblyResourceState,
  BufferFrameAssemblyState,
} from './session-buffer-frame-assembly-state';

declare const bufferSyncIn02FrameAssemblyBrand: unique symbol;

export type BufferSyncIn02FrameAssemblyOutput = TerminalBufferPayload & {
  readonly [bufferSyncIn02FrameAssemblyBrand]: 'BufferSyncIn02FrameAssembly';
};

export type BufferSyncIn03SparseApplyInput = BufferSyncIn02FrameAssemblyOutput;

function buildBufferSyncIn02FrameAssemblyOutput(
  payload: TerminalBufferPayload,
): BufferSyncIn03SparseApplyInput {
  return payload as BufferSyncIn03SparseApplyInput;
}

export type BufferFrameAssemblyResult =
  | { kind: 'passthrough'; payload: BufferSyncIn03SparseApplyInput; state: BufferFrameAssemblyState | null }
  | { kind: 'pending'; state: BufferFrameAssemblyState; supersededFrameKey?: string }
  | { kind: 'complete'; payload: BufferSyncIn03SparseApplyInput; state: null }
  | {
      kind: 'rejected';
      error: BufferFrameAssemblyError;
      state: BufferFrameAssemblyState | null;
      repairRange: BufferFrameAssemblyRepairRange | null;
      repairRevision: number | null;
    };

interface ValidatedFrameChunk {
  frameKey: string;
  revision: number;
  frameStartIndex: number;
  frameEndIndex: number;
  frameChunkIndex: number;
  frameChunkCount: number;
  generatedAt: number;
  startIndex: number;
  endIndex: number;
}

function readStrictInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : null;
}

function requireReceivedAt(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('buffer frame assembly receivedAt must be a non-negative safe integer');
  }
  return value;
}

function measurePayloadBytes(payload: TerminalBufferPayload) {
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
}

function stateRepairRange(state: BufferFrameAssemblyState | null): BufferFrameAssemblyRepairRange | null {
  return state
    ? { startIndex: state.frameStartIndex, endIndex: state.frameEndIndex }
    : null;
}

function payloadFrameRepairRange(payload: TerminalBufferPayload): BufferFrameAssemblyRepairRange | null {
  const startIndex = readStrictInteger(payload.frameStartIndex);
  const endIndex = readStrictInteger(payload.frameEndIndex);
  return startIndex !== null && startIndex >= 0 && endIndex !== null && endIndex > startIndex
    ? { startIndex, endIndex }
    : null;
}

function rejectedFrameRepairRange(
  current: BufferFrameAssemblyState | null,
  payload: TerminalBufferPayload,
) {
  return stateRepairRange(current) ?? payloadFrameRepairRange(payload);
}

function rejectedFrame(
  error: BufferFrameAssemblyError,
  state: BufferFrameAssemblyState | null,
  repairRange: BufferFrameAssemblyRepairRange | null,
  repairRevision: number | null,
): BufferFrameAssemblyResult {
  return { kind: 'rejected', error, state, repairRange, repairRevision };
}

function readWireLineIndex(line: TerminalBufferPayload['lines'][number]) {
  if ('i' in line) {
    return readStrictInteger(line.i);
  }
  return readStrictInteger(line.index);
}

function validateFrameChunkMetadata(payload: TerminalBufferPayload): ValidatedFrameChunk | null {
  const frameChunkCount = readStrictInteger(payload.frameChunkCount);
  if (frameChunkCount === null || frameChunkCount <= 1) {
    return null;
  }
  const revision = readStrictInteger(payload.revision);
  const frameStartIndex = readStrictInteger(payload.frameStartIndex);
  const frameEndIndex = readStrictInteger(payload.frameEndIndex);
  const frameChunkIndex = readStrictInteger(payload.frameChunkIndex);
  const generatedAt = readStrictInteger(payload.generatedAt);
  const startIndex = readStrictInteger(payload.startIndex);
  const endIndex = readStrictInteger(payload.endIndex);
  if (
    revision === null || revision <= 0
    || frameStartIndex === null || frameStartIndex < 0
    || frameEndIndex === null || frameEndIndex <= frameStartIndex
    || frameChunkIndex === null || frameChunkIndex < 0 || frameChunkIndex >= frameChunkCount
    || generatedAt === null || generatedAt <= 0
    || startIndex === null || startIndex < frameStartIndex
    || endIndex === null || endIndex <= startIndex || endIndex > frameEndIndex
    || frameChunkCount > frameEndIndex - frameStartIndex
  ) {
    return null;
  }
  return {
    frameKey: `${revision}:${frameStartIndex}:${frameEndIndex}:${generatedAt}:${frameChunkCount}`,
    revision,
    frameStartIndex,
    frameEndIndex,
    frameChunkIndex,
    frameChunkCount,
    generatedAt,
    startIndex,
    endIndex,
  };
}

function rowsEqual(left: TerminalCell[], right: TerminalCell[]) {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      !a || !b
      || a.char !== b.char
      || a.fg !== b.fg
      || a.bg !== b.bg
      || a.flags !== b.flags
      || a.width !== b.width
    ) {
      return false;
    }
  }
  return true;
}

function chunkLinesAreDense(payload: TerminalBufferPayload, chunk: ValidatedFrameChunk) {
  const indexes = payload.lines.map(readWireLineIndex);
  if (indexes.some((index) => index === null) || indexes.length !== chunk.endIndex - chunk.startIndex) {
    return false;
  }
  for (let offset = 0; offset < indexes.length; offset += 1) {
    if (indexes[offset] !== chunk.startIndex + offset) {
      return false;
    }
  }
  return true;
}

function cursorEqual(left: TerminalBufferPayload['cursor'], right: TerminalBufferPayload['cursor']) {
  return (
    (left?.rowIndex ?? null) === (right?.rowIndex ?? null)
    && (left?.col ?? null) === (right?.col ?? null)
    && (left?.visible ?? null) === (right?.visible ?? null)
  );
}

function frameMetadataEqual(left: TerminalBufferPayload, right: TerminalBufferPayload) {
  return (
    left.revision === right.revision
    && left.frameStartIndex === right.frameStartIndex
    && left.frameEndIndex === right.frameEndIndex
    && left.frameChunkCount === right.frameChunkCount
    && left.generatedAt === right.generatedAt
    && left.requestSentAt === right.requestSentAt
    && left.availableStartIndex === right.availableStartIndex
    && left.availableEndIndex === right.availableEndIndex
    && left.cols === right.cols
    && left.rows === right.rows
    && left.cursorKeysApp === right.cursorKeysApp
    && cursorEqual(left.cursor, right.cursor)
  );
}

function chunksEqual(left: TerminalBufferPayload, right: TerminalBufferPayload) {
  if (
    left.startIndex !== right.startIndex
    || left.endIndex !== right.endIndex
    || !frameMetadataEqual(left, right)
  ) {
    return false;
  }
  const leftLines = normalizeWireLines(left.lines, left.cols);
  const rightLines = normalizeWireLines(right.lines, right.cols);
  return leftLines.length === rightLines.length && leftLines.every((line, index) => (
    line.index === rightLines[index]?.index
    && rowsEqual(line.cells, rightLines[index]!.cells)
  ));
}

function createFrameState(
  chunk: ValidatedFrameChunk,
  firstReceivedAt: number,
  retainedBytes: number,
): BufferFrameAssemblyState {
  return {
    frameKey: chunk.frameKey,
    revision: chunk.revision,
    frameStartIndex: chunk.frameStartIndex,
    frameEndIndex: chunk.frameEndIndex,
    frameChunkCount: chunk.frameChunkCount,
    generatedAt: chunk.generatedAt,
    firstReceivedAt,
    retainedBytes,
    chunks: new Map(),
  };
}

function frameMetadataExceedsResourceLimits(payload: TerminalBufferPayload) {
  const frameChunkCount = readStrictInteger(payload.frameChunkCount);
  const frameStartIndex = readStrictInteger(payload.frameStartIndex);
  const frameEndIndex = readStrictInteger(payload.frameEndIndex);
  if (
    frameChunkCount === null
    || frameStartIndex === null
    || frameEndIndex === null
    || frameEndIndex <= frameStartIndex
  ) {
    return false;
  }
  return (
    frameChunkCount > TERMINAL_BUFFER_SYNC_FRAME_MAX_CHUNKS
    || frameEndIndex - frameStartIndex > TERMINAL_BUFFER_SYNC_FRAME_MAX_SPAN_LINES
  );
}

export function expireBufferSyncFrameAssembly(
  current: BufferFrameAssemblyState | null,
  receivedAt: number,
): BufferFrameAssemblyResult | null {
  const now = requireReceivedAt(receivedAt);
  if (!current || now - current.firstReceivedAt <= TERMINAL_BUFFER_SYNC_FRAME_MAX_AGE_MS) {
    return null;
  }
  return rejectedFrame(
    'frame-assembly-expired',
    null,
    stateRepairRange(current),
    current.revision,
  );
}

function assembleCompleteFrame(state: BufferFrameAssemblyState): BufferFrameAssemblyResult {
  if (state.chunks.size !== state.frameChunkCount) {
    return { kind: 'pending', state };
  }
  const orderedChunks = Array.from(state.chunks.entries()).sort(([left], [right]) => left - right);
  let expectedStartIndex = state.frameStartIndex;
  const firstPayload = orderedChunks[0]?.[1];
  if (!firstPayload) {
    return rejectedFrame('non-contiguous-frame', null, stateRepairRange(state), state.revision);
  }
  for (let chunkIndex = 0; chunkIndex < orderedChunks.length; chunkIndex += 1) {
    const [actualChunkIndex, payload] = orderedChunks[chunkIndex]!;
    if (
      actualChunkIndex !== chunkIndex
      || payload.startIndex !== expectedStartIndex
      || !frameMetadataEqual(firstPayload, payload)
    ) {
      return rejectedFrame(
        actualChunkIndex !== chunkIndex || payload.startIndex !== expectedStartIndex
          ? 'non-contiguous-frame'
          : 'inconsistent-frame-metadata',
        null,
        stateRepairRange(state),
        state.revision,
      );
    }
    expectedStartIndex = payload.endIndex;
  }
  if (expectedStartIndex !== state.frameEndIndex) {
    return rejectedFrame('non-contiguous-frame', null, stateRepairRange(state), state.revision);
  }
  return {
    kind: 'complete',
    state: null,
    payload: buildBufferSyncIn02FrameAssemblyOutput({
      ...firstPayload,
      startIndex: state.frameStartIndex,
      endIndex: state.frameEndIndex,
      frameChunkIndex: 0,
      frameChunkCount: 1,
      lines: orderedChunks.flatMap(([, payload]) => payload.lines),
    }),
  };
}

export function assembleBufferSyncFrameChunk(
  current: BufferFrameAssemblyState | null,
  payload: TerminalBufferPayload,
  receivedAt: number,
): BufferFrameAssemblyResult {
  const now = requireReceivedAt(receivedAt);
  const payloadRevision = readStrictInteger(payload.revision);
  if (current && payloadRevision !== null && payloadRevision < current.revision) {
    return rejectedFrame('stale-frame', current, null, payloadRevision);
  }
  const incomingSupersedesCurrent = current !== null
    && payloadRevision !== null
    && payloadRevision > current.revision;
  const expired = incomingSupersedesCurrent
    ? null
    : expireBufferSyncFrameAssembly(current, now);
  if (expired) {
    return expired;
  }
  const retainedCurrent = incomingSupersedesCurrent ? null : current;
  const repairRevision = retainedCurrent?.revision
    ?? (payloadRevision !== null && payloadRevision > 0 ? payloadRevision : null);
  const hasChunkWindowMetadata = payload.frameStartIndex !== undefined
    || payload.frameEndIndex !== undefined
    || payload.frameChunkIndex !== undefined;
  const declaredChunkCount = readStrictInteger(payload.frameChunkCount);
  if (
    retainedCurrent
    && payloadRevision === retainedCurrent.revision
    && (payload.frameChunkCount === undefined || declaredChunkCount === null || declaredChunkCount <= 1)
  ) {
    return rejectedFrame(
      'interleaved-same-revision-frame',
      null,
      stateRepairRange(retainedCurrent),
      retainedCurrent.revision,
    );
  }
  if (payload.frameChunkCount === undefined) {
    if (hasChunkWindowMetadata) {
      return rejectedFrame(
        'invalid-frame-metadata',
        null,
        rejectedFrameRepairRange(retainedCurrent, payload),
        repairRevision,
      );
    }
    return {
      kind: 'passthrough',
      payload: buildBufferSyncIn02FrameAssemblyOutput(payload),
      state: null,
    };
  }
  if (declaredChunkCount === null || declaredChunkCount < 1) {
    return rejectedFrame(
      'invalid-frame-metadata',
      null,
      rejectedFrameRepairRange(retainedCurrent, payload),
      repairRevision,
    );
  }
  if (declaredChunkCount === 1) {
    if (hasChunkWindowMetadata && (
      payload.frameStartIndex !== payload.startIndex
      || payload.frameEndIndex !== payload.endIndex
      || payload.frameChunkIndex !== 0
    )) {
      return rejectedFrame(
        'invalid-frame-metadata',
        null,
        payloadFrameRepairRange(payload),
        repairRevision,
      );
    }
    return {
      kind: 'passthrough',
      payload: buildBufferSyncIn02FrameAssemblyOutput(payload),
      state: null,
    };
  }

  const chunk = validateFrameChunkMetadata(payload);
  if (!chunk) {
    if (retainedCurrent && payloadRevision === retainedCurrent.revision) {
      return rejectedFrame(
        'interleaved-same-revision-frame',
        null,
        stateRepairRange(retainedCurrent),
        retainedCurrent.revision,
      );
    }
    return rejectedFrame(
      'invalid-frame-metadata',
      null,
      rejectedFrameRepairRange(retainedCurrent, payload),
      repairRevision,
    );
  }

  let state = retainedCurrent;
  let supersededFrameKey = incomingSupersedesCurrent ? current.frameKey : undefined;
  if (state && state.frameKey !== chunk.frameKey) {
    if (chunk.revision < state.revision) {
      return rejectedFrame('stale-frame', state, null, chunk.revision);
    }
    if (chunk.revision === state.revision) {
      return rejectedFrame(
        'interleaved-same-revision-frame',
        null,
        stateRepairRange(state),
        state.revision,
      );
    }
    supersededFrameKey = state.frameKey;
    state = null;
  }
  if (frameMetadataExceedsResourceLimits(payload)) {
    return rejectedFrame(
      'frame-resource-limit-exceeded',
      null,
      {
        startIndex: chunk.frameStartIndex,
        endIndex: chunk.frameEndIndex,
      },
      chunk.revision,
    );
  }
  if (!chunkLinesAreDense(payload, chunk)) {
    return rejectedFrame(
      'invalid-chunk-lines',
      null,
      stateRepairRange(state) ?? {
        startIndex: chunk.frameStartIndex,
        endIndex: chunk.frameEndIndex,
      },
      state?.revision ?? chunk.revision,
    );
  }
  const payloadBytes = measurePayloadBytes(payload);
  const nextState = state || createFrameState(chunk, now, 0);
  const previousChunk = nextState.chunks.get(chunk.frameChunkIndex);
  if (previousChunk) {
    if (!chunksEqual(previousChunk, payload)) {
      return rejectedFrame(
        'conflicting-duplicate-chunk',
        null,
        stateRepairRange(nextState),
        nextState.revision,
      );
    }
    return { kind: 'pending', state: nextState, supersededFrameKey };
  }
  if (nextState.retainedBytes + payloadBytes > TERMINAL_BUFFER_SYNC_FRAME_MAX_RETAINED_BYTES) {
    return rejectedFrame(
      'frame-resource-limit-exceeded',
      null,
      stateRepairRange(nextState),
      nextState.revision,
    );
  }
  nextState.chunks.set(chunk.frameChunkIndex, payload);
  nextState.retainedBytes += payloadBytes;
  const result = assembleCompleteFrame(nextState);
  if (result.kind === 'pending' && supersededFrameKey) {
    return { ...result, supersededFrameKey };
  }
  return result;
}
