import {
  createDataEnvelope,
} from '@zterm/runtime-contracts';
import type {
  DataStreamRequest,
  DataStreamHandle,
  DataEnvelope,
} from '@zterm/runtime-contracts';

export interface StreamGatewayOptions {
  readonly onEnvelope?: (envelope: DataEnvelope<Uint8Array>) => void;
}

export class DataStreamGateway {
  readonly #options: StreamGatewayOptions;
  readonly #channels = new Map<string, DataStreamChannel>();

  constructor(options: StreamGatewayOptions = {}) {
    this.#options = options;
  }

  open(request: DataStreamRequest): DataStreamHandle {
    if (!request.channelId.trim()) {
      throw new TypeError('channelId must be non-empty');
    }
    if (request.mode !== 'reliable' && request.mode !== 'lossy') {
      throw new TypeError(`unsupported stream mode: ${String(request.mode)}`);
    }
    if (this.#channels.has(request.channelId)) {
      throw new Error(`data stream already open: ${request.channelId}`);
    }
    const channel = new DataStreamChannel(
      request.channelId,
      this.#publish.bind(this),
      this.#close.bind(this),
    );
    this.#channels.set(request.channelId, channel);
    return channel;
  }

  async openDataStream(request: DataStreamRequest): Promise<DataStreamHandle> {
    return this.open(request);
  }

  #publish(channelId: string, revision: number, body: Uint8Array): void {
    if (!this.#options.onEnvelope) {
      throw new Error('data stream sink is not configured');
    }
    const envelope = createDataEnvelope(channelId, revision, new Uint8Array(body));
    this.#options.onEnvelope(envelope);
  }

  #close(channelId: string): void {
    this.#channels.delete(channelId);
  }
}

class DataStreamChannel implements DataStreamHandle {
  readonly channelId: string;
  #revision = 0;
  #disposed = false;
  readonly #publish: (channelId: string, revision: number, body: Uint8Array) => void;
  readonly #close: (channelId: string) => void;

  constructor(
    channelId: string,
    publish: (channelId: string, revision: number, body: Uint8Array) => void,
    close: (channelId: string) => void,
  ) {
    this.channelId = channelId;
    this.#publish = publish;
    this.#close = close;
  }

  send(chunk: Uint8Array): void {
    if (this.#disposed) {
      throw new Error(`data stream disposed: ${this.channelId}`);
    }
    const revision = this.#revision + 1;
    this.#publish(this.channelId, revision, chunk);
    this.#revision = revision;
  }

  dispose(reason: string): void {
    if (this.#disposed) return;
    this.#disposed = true;
    void reason;
    this.#close(this.channelId);
  }
}
