import type { TerminalBufferPayload } from '../lib/types';

export interface BufferFrameAssemblyState {
  frameKey: string;
  revision: number;
  frameStartIndex: number;
  frameEndIndex: number;
  frameChunkCount: number;
  generatedAt: number;
  firstReceivedAt: number;
  retainedBytes: number;
  chunks: Map<number, TerminalBufferPayload>;
}

export type BufferFrameAssemblyError =
  | 'invalid-frame-metadata'
  | 'invalid-chunk-lines'
  | 'conflicting-duplicate-chunk'
  | 'interleaved-same-revision-frame'
  | 'stale-frame'
  | 'inconsistent-frame-metadata'
  | 'non-contiguous-frame'
  | 'frame-resource-limit-exceeded'
  | 'frame-assembly-expired';

export interface BufferFrameAssemblyRepairRange {
  startIndex: number;
  endIndex: number;
}

export interface BufferFrameAssemblyRepairTruth {
  status: 'not-required' | 'unavailable' | 'pending' | 'dispatched';
  range: BufferFrameAssemblyRepairRange | null;
}

export interface BufferFrameAssemblyErrorTruth {
  error: BufferFrameAssemblyError;
  revision: number | null;
  repair: BufferFrameAssemblyRepairTruth;
}

export interface BufferFrameAssemblyResourceState {
  pending: BufferFrameAssemblyState | null;
  error: BufferFrameAssemblyErrorTruth | null;
  repairDispatchedRevisions: readonly number[];
}

export const BUFFER_FRAME_REPAIR_LEDGER_MAX_REVISIONS = 512;

export function clearPendingBufferSyncFrameAssembly(
  resource: BufferFrameAssemblyResourceState | null,
): BufferFrameAssemblyResourceState | null {
  return resource
    ? {
        ...resource,
        pending: null,
      }
    : null;
}

export function resetBufferSyncFrameAssemblyEpoch(
  resource: BufferFrameAssemblyResourceState | null,
): BufferFrameAssemblyResourceState | null {
  return resource
    ? {
        pending: null,
        error: null,
        repairDispatchedRevisions: [],
      }
    : null;
}

export function hasBufferFrameRepairDispatch(
  revisions: readonly number[],
  revision: number,
) {
  return revisions.includes(revision);
}

export function recordBufferFrameRepairDispatch(
  revisions: readonly number[],
  revision: number,
) {
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new TypeError('buffer frame repair revision must be a positive safe integer');
  }
  if (hasBufferFrameRepairDispatch(revisions, revision)) {
    return revisions;
  }
  return [...revisions, revision].slice(-BUFFER_FRAME_REPAIR_LEDGER_MAX_REVISIONS);
}
