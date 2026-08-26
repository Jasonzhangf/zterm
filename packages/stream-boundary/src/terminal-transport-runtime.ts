import {
  createDataEnvelope,
  type DataEnvelope,
} from '@zterm/runtime-contracts';

export type TransportGeneration = number;

export interface TransportBackpressurePolicy {
  readonly highWaterBytes: number;
  readonly lowWaterBytes: number;
}

export const DEFAULT_TRANSPORT_BACKPRESSURE_POLICY: TransportBackpressurePolicy = Object.freeze({
  highWaterBytes: 128_000,
  lowWaterBytes: 64_000,
});

export interface TransportBackpressureSnapshot {
  readonly bufferedBytes: number;
  readonly backpressured: boolean;
  readonly lowWaterDrained: boolean;
  readonly highWaterEnteredAt: number | null;
}

export type TransportChannelState = 'opened' | 'closed';

export interface TransportChannelEvent {
  readonly kind: 'opened' | 'closed';
  readonly channelId: string;
  readonly generation: TransportGeneration;
  readonly reason?: string;
}

export interface TransportChannelHandle {
  readonly channelId: string;
  readonly state: TransportChannelState;
  send(chunk: Uint8Array): void;
  close(reason: string): void;
}

export interface TerminalTransportRuntimeOptions {
  readonly backpressure?: TransportBackpressurePolicy;
  readonly onEnvelope?: (envelope: DataEnvelope<Uint8Array>) => void;
  readonly onChannelEvent?: (event: TransportChannelEvent) => void;
}

export interface TerminalTransportRuntime {
  readonly generation: TransportGeneration;
  getBackpressure(): TransportBackpressureSnapshot;
  shouldHoldSend(): boolean;
  reportBufferedBytes(bufferedBytes: number): TransportBackpressureSnapshot;
  advanceGeneration(): TransportGeneration;
  openChannel(channelId: string): TransportChannelHandle;
  closeChannel(channelId: string, reason: string): void;
  dispose(reason: string): void;
}

interface TerminalTransportChannelState {
  readonly channelId: string;
  generation: TransportGeneration;
  state: TransportChannelState;
  revision: number;
}

export function createTerminalTransportRuntime(
  options: TerminalTransportRuntimeOptions = {},
): TerminalTransportRuntime {
  const policy: TransportBackpressurePolicy = {
    highWaterBytes: Math.max(1, Math.floor(options.backpressure?.highWaterBytes ?? DEFAULT_TRANSPORT_BACKPRESSURE_POLICY.highWaterBytes)),
    lowWaterBytes: Math.max(1, Math.floor(options.backpressure?.lowWaterBytes ?? DEFAULT_TRANSPORT_BACKPRESSURE_POLICY.lowWaterBytes)),
  };
  if (policy.lowWaterBytes >= policy.highWaterBytes) {
    throw new TypeError('transport backpressure lowWaterBytes must be below highWaterBytes');
  }

  const channels = new Map<string, TerminalTransportChannelState>();
  let generation = 1;
  let bufferedBytes = 0;
  let backpressured = false;
  let highWaterEnteredAt: number | null = null;
  let disposed = false;

  function snapshot(): TransportBackpressureSnapshot {
    return {
      bufferedBytes,
      backpressured,
      lowWaterDrained: !backpressured && bufferedBytes <= policy.lowWaterBytes,
      highWaterEnteredAt,
    };
  }

  function reportBufferedBytes(nextBufferedBytes: number): TransportBackpressureSnapshot {
    if (disposed) {
      throw new Error('terminal transport runtime is disposed');
    }
    bufferedBytes = Math.max(0, Math.floor(nextBufferedBytes));
    if (bufferedBytes >= policy.highWaterBytes) {
      backpressured = true;
      highWaterEnteredAt ??= Date.now();
    } else if (bufferedBytes <= policy.lowWaterBytes) {
      backpressured = false;
      highWaterEnteredAt = null;
    }
    return snapshot();
  }

  function shouldHoldSend(): boolean {
    return backpressured;
  }

  function advanceGeneration(): TransportGeneration {
    if (disposed) {
      throw new Error('terminal transport runtime is disposed');
    }
    generation += 1;
    for (const channel of [...channels.values()]) {
      if (channel.state === 'closed') {
        continue;
      }
      channel.state = 'closed';
      options.onChannelEvent?.({
        kind: 'closed',
        channelId: channel.channelId,
        generation,
        reason: `transport generation advanced to ${generation}`,
      });
      channels.delete(channel.channelId);
    }
    return generation;
  }

  function openChannel(channelId: string): TransportChannelHandle {
    if (disposed) {
      throw new Error('terminal transport runtime is disposed');
    }
    if (!channelId.trim()) {
      throw new TypeError('transport channel id must be non-empty');
    }
    if (channels.has(channelId)) {
      throw new Error(`transport channel already open: ${channelId}`);
    }
    const channel: TerminalTransportChannelState = {
      channelId,
      generation,
      state: 'opened',
      revision: 0,
    };
    channels.set(channelId, channel);
    options.onChannelEvent?.({
      kind: 'opened',
      channelId,
      generation,
    });
    return {
      channelId,
      get state() {
        return channel.state;
      },
      send(chunk: Uint8Array) {
        if (disposed) {
          throw new Error(`transport channel disposed: ${channelId}`);
        }
        if (channel.state !== 'opened') {
          throw new Error(`transport channel is not open: ${channelId}`);
        }
        if (channel.generation !== generation) {
          throw new Error(
            `stale transport generation: expected ${generation}, got ${channel.generation}`,
          );
        }
        if (!options.onEnvelope) {
          throw new Error('terminal transport sink is not configured');
        }
        const revision = channel.revision + 1;
        options.onEnvelope(createDataEnvelope(channelId, revision, new Uint8Array(chunk)));
        channel.revision = revision;
      },
      close(reason: string) {
        if (channel.state === 'closed') {
          return;
        }
        channel.state = 'closed';
        channels.delete(channelId);
        options.onChannelEvent?.({
          kind: 'closed',
          channelId,
          generation,
          reason,
        });
      },
    };
  }

  function closeChannel(channelId: string, reason: string): void {
    if (disposed) {
      throw new Error('terminal transport runtime is disposed');
    }
    const channel = channels.get(channelId);
    if (!channel || channel.state === 'closed') {
      throw new Error(`transport channel is not open: ${channelId}`);
    }
    channel.state = 'closed';
    channels.delete(channelId);
    options.onChannelEvent?.({
      kind: 'closed',
      channelId,
      generation,
      reason,
    });
  }

  function dispose(reason: string): void {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const channel of [...channels.values()]) {
      if (channel.state === 'closed') {
        continue;
      }
      channel.state = 'closed';
      options.onChannelEvent?.({
        kind: 'closed',
        channelId: channel.channelId,
        generation,
        reason,
      });
      channels.delete(channel.channelId);
    }
  }

  return {
    get generation() {
      return generation;
    },
    getBackpressure: snapshot,
    shouldHoldSend,
    reportBufferedBytes,
    advanceGeneration,
    openChannel,
    closeChannel,
    dispose,
  };
}
