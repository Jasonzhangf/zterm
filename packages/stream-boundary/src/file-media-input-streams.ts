export type DedicatedStreamKind = 'file' | 'video' | 'input';

export type DedicatedStreamMode = 'reliable' | 'lossy';

export interface DedicatedStreamPolicy {
  readonly streamId: string;
  readonly kind: DedicatedStreamKind;
  readonly mode: DedicatedStreamMode;
  readonly highWaterBytes: number;
  readonly lowWaterBytes: number;
}

export interface DedicatedStreamChunk {
  readonly kind: DedicatedStreamKind;
  readonly streamId: string;
  readonly sequence: number;
  readonly generation: number;
  readonly bytes: Uint8Array;
}

export interface DedicatedStreamStats {
  readonly streamId: string;
  readonly kind: DedicatedStreamKind;
  readonly mode: DedicatedStreamMode;
  readonly open: boolean;
  readonly sequence: number;
  readonly generation: number;
  readonly bufferedBytes: number;
  readonly backpressured: boolean;
  readonly droppedLossyChunks: number;
}

export interface DedicatedStreamHandle {
  readonly streamId: string;
  readonly kind: DedicatedStreamKind;
  readonly mode: DedicatedStreamMode;
  getStats(): DedicatedStreamStats;
  write(chunk: Uint8Array): boolean;
  acknowledge(sequence: number): void;
  close(reason: string): void;
}

export interface FileMediaInputStreamRuntimeOptions {
  readonly onChunk?: (chunk: DedicatedStreamChunk) => void;
  readonly onClosed?: (streamId: string, reason: string) => void;
}

export interface FileMediaInputStreamRuntime {
  openStream(policy: DedicatedStreamPolicy): DedicatedStreamHandle;
  closeStream(streamId: string, reason: string): void;
  getStats(streamId: string): DedicatedStreamStats;
  listStats(): readonly DedicatedStreamStats[];
  advanceGeneration(): number;
  dispose(reason: string): void;
}

interface StreamState {
  readonly streamId: string;
  readonly kind: DedicatedStreamKind;
  readonly mode: DedicatedStreamMode;
  readonly highWaterBytes: number;
  readonly lowWaterBytes: number;
  generation: number;
  open: boolean;
  sequence: number;
  acknowledged: number;
  pendingSequences: number[];
  pendingBytes: number[];
  droppedLossyChunks: number;
}

function validatePolicy(policy: DedicatedStreamPolicy): void {
  if (!['file', 'video', 'input'].includes(policy.kind)) {
    throw new TypeError(`unsupported dedicated stream kind: ${String(policy.kind)}`);
  }
  if (policy.mode !== 'reliable' && policy.mode !== 'lossy') {
    throw new TypeError(`unsupported dedicated stream mode: ${String(policy.mode)}`);
  }
  if (!Number.isSafeInteger(policy.highWaterBytes) || policy.highWaterBytes <= 0) {
    throw new TypeError('dedicated stream highWaterBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(policy.lowWaterBytes) || policy.lowWaterBytes <= 0 || policy.lowWaterBytes >= policy.highWaterBytes) {
    throw new TypeError('dedicated stream lowWaterBytes must be below highWaterBytes');
  }
}

function bufferedBytesOf(stream: StreamState): number {
  return stream.pendingBytes.reduce((sum, size) => sum + size, 0);
}

export function createFileMediaInputStreamRuntime(
  options: FileMediaInputStreamRuntimeOptions = {},
): FileMediaInputStreamRuntime {
  let generation = 1;
  let disposed = false;
  const streams = new Map<string, StreamState>();

  function ensureOpen(streamId: string): StreamState {
    const stream = streams.get(streamId);
    if (!stream || !stream.open) {
      throw new Error(`dedicated stream is not open: ${streamId}`);
    }
    return stream;
  }

  function statsOf(stream: StreamState): DedicatedStreamStats {
    return {
      streamId: stream.streamId,
      kind: stream.kind,
      mode: stream.mode,
      open: stream.open,
      sequence: stream.sequence,
      generation: stream.generation,
      bufferedBytes: bufferedBytesOf(stream),
      backpressured: bufferedBytesOf(stream) >= stream.highWaterBytes,
      droppedLossyChunks: stream.droppedLossyChunks,
    };
  }

  function openStream(policy: DedicatedStreamPolicy): DedicatedStreamHandle {
    if (disposed) {
      throw new Error('file/media/input stream runtime is disposed');
    }
    validatePolicy(policy);
    if (streams.has(policy.streamId)) {
      throw new Error(`dedicated stream already open: ${policy.streamId}`);
    }
    const stream: StreamState = {
      streamId: policy.streamId,
      kind: policy.kind,
      mode: policy.mode,
      highWaterBytes: policy.highWaterBytes,
      lowWaterBytes: policy.lowWaterBytes,
      generation,
      open: true,
      sequence: 0,
      acknowledged: 0,
      pendingSequences: [],
      pendingBytes: [],
      droppedLossyChunks: 0,
    };
    streams.set(stream.streamId, stream);
    return {
      streamId: stream.streamId,
      kind: stream.kind,
      mode: stream.mode,
      getStats: () => statsOf(stream),
      write(chunk: Uint8Array) {
        return writeStream(stream, chunk);
      },
      acknowledge(sequence: number) {
        acknowledgeStream(stream, sequence);
      },
      close(reason: string) {
        closeStream(stream.streamId, reason);
      },
    };
  }

  function writeStream(stream: StreamState, chunk: Uint8Array): boolean {
    const current = ensureOpen(stream.streamId);
    if (current !== stream) {
      throw new Error(`dedicated stream generation changed: ${stream.streamId}`);
    }
    const buffered = bufferedBytesOf(current);
    if (current.mode === 'lossy') {
      if (buffered + chunk.byteLength > current.highWaterBytes) {
        current.droppedLossyChunks += 1;
        return false;
      }
      current.sequence += 1;
      current.pendingSequences.push(current.sequence);
      current.pendingBytes.push(chunk.byteLength);
      options.onChunk?.({
        kind: current.kind,
        streamId: current.streamId,
        sequence: current.sequence,
        generation: current.generation,
        bytes: new Uint8Array(chunk),
      });
      return true;
    }
    if (buffered + chunk.byteLength > current.highWaterBytes) {
      return false;
    }
    current.sequence += 1;
    current.pendingSequences.push(current.sequence);
    current.pendingBytes.push(chunk.byteLength);
    options.onChunk?.({
      kind: current.kind,
      streamId: current.streamId,
      sequence: current.sequence,
      generation: current.generation,
      bytes: new Uint8Array(chunk),
    });
    return true;
  }

  function acknowledgeStream(stream: StreamState, sequence: number): void {
    const current = ensureOpen(stream.streamId);
    if (!Number.isSafeInteger(sequence) || sequence <= 0 || sequence > current.sequence) {
      throw new RangeError(`invalid dedicated stream ack sequence: ${sequence}`);
    }
    if (sequence > current.acknowledged) {
      while (
        current.pendingBytes.length > 0
        && (current.pendingSequences[0] ?? Number.MAX_SAFE_INTEGER) <= sequence
      ) {
        current.pendingSequences.shift();
        current.pendingBytes.shift();
      }
      current.acknowledged = sequence;
    }
  }

  function closeStream(streamId: string, reason: string): void {
    const stream = streams.get(streamId);
    if (!stream) {
      throw new Error(`dedicated stream is not open: ${streamId}`);
    }
    if (!stream.open) {
      return;
    }
    stream.open = false;
    streams.delete(streamId);
    options.onClosed?.(streamId, reason);
  }

  function advanceGeneration(): number {
    if (disposed) {
      throw new Error('file/media/input stream runtime is disposed');
    }
    generation += 1;
    for (const stream of Array.from(streams.values())) {
      stream.open = false;
      streams.delete(stream.streamId);
      options.onClosed?.(stream.streamId, `transport generation advanced to ${generation}`);
    }
    return generation;
  }

  function dispose(reason: string): void {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const stream of Array.from(streams.values())) {
      stream.open = false;
      streams.delete(stream.streamId);
      options.onClosed?.(stream.streamId, reason);
    }
  }

  return {
    openStream,
    closeStream,
    getStats(streamId: string) {
      return statsOf(ensureOpen(streamId));
    },
    listStats() {
      return Array.from(streams.values()).map(statsOf);
    },
    advanceGeneration,
    dispose,
  };
}
