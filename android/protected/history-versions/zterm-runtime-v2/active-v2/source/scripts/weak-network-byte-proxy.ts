import { once } from 'node:events';
import {
  createServer,
  Socket,
  type AddressInfo,
  type Server,
} from 'node:net';
import { pathToFileURL } from 'node:url';

export interface PeriodicStallProfile {
  everyMs: number;
  durationMs: number;
}

export interface ExplicitDisconnectProfile {
  afterMs: number;
  durationMs: number;
}

export interface WeakNetworkByteProxyProfile {
  name: string;
  bandwidthBytesPerSecond: number | null;
  oneWayLatencyMs: number;
  jitterMs: readonly [number, number];
  chunkBytes: number;
  periodicStall: PeriodicStallProfile | null;
  disconnect: ExplicitDisconnectProfile | null;
}

export interface WeakNetworkByteProxyOptions {
  listenHost: string;
  listenPort: number;
  targetHost: string;
  targetPort: number;
  profile: WeakNetworkByteProxyProfile;
  random?: () => number;
}

interface DirectionMetrics {
  bytesRead: number;
  bytesWritten: number;
  chunksWritten: number;
  maxQueuedBytes: number;
  stallCount: number;
}

interface ConnectionRuntime {
  client: Socket;
  target: Socket;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
}

export const WEAK_NETWORK_PROXY_PROFILES: Record<
  'good' | 'narrow' | 'unstable' | 'reconnect',
  WeakNetworkByteProxyProfile
> = {
  good: {
    name: 'good',
    bandwidthBytesPerSecond: null,
    oneWayLatencyMs: 0,
    jitterMs: [0, 0],
    chunkBytes: 16 * 1024,
    periodicStall: null,
    disconnect: null,
  },
  narrow: {
    name: 'narrow-256kbps-300ms-rtt',
    bandwidthBytesPerSecond: 32_000,
    oneWayLatencyMs: 150,
    jitterMs: [25, 75],
    chunkBytes: 2 * 1024,
    periodicStall: null,
    disconnect: null,
  },
  unstable: {
    name: 'unstable-256kbps-300ms-rtt-stall',
    bandwidthBytesPerSecond: 32_000,
    oneWayLatencyMs: 150,
    jitterMs: [25, 75],
    chunkBytes: 2 * 1024,
    periodicStall: {
      everyMs: 15_000,
      durationMs: 1_500,
    },
    disconnect: null,
  },
  reconnect: {
    name: 'reconnect-256kbps-300ms-rtt',
    bandwidthBytesPerSecond: 32_000,
    oneWayLatencyMs: 150,
    jitterMs: [25, 75],
    chunkBytes: 2 * 1024,
    periodicStall: null,
    disconnect: {
      afterMs: 10_000,
      durationMs: 2_000,
    },
  },
};

function assertFiniteNonNegative(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
}

function validateProfile(profile: WeakNetworkByteProxyProfile) {
  if (!profile.name.trim()) {
    throw new Error('profile.name is required');
  }
  if (
    profile.bandwidthBytesPerSecond !== null &&
    (!Number.isFinite(profile.bandwidthBytesPerSecond) ||
      profile.bandwidthBytesPerSecond <= 0)
  ) {
    throw new Error('profile.bandwidthBytesPerSecond must be null or positive');
  }
  assertFiniteNonNegative(profile.oneWayLatencyMs, 'profile.oneWayLatencyMs');
  assertFiniteNonNegative(profile.jitterMs[0], 'profile.jitterMs[0]');
  assertFiniteNonNegative(profile.jitterMs[1], 'profile.jitterMs[1]');
  if (profile.jitterMs[1] < profile.jitterMs[0]) {
    throw new Error('profile.jitterMs max must be >= min');
  }
  if (!Number.isInteger(profile.chunkBytes) || profile.chunkBytes <= 0) {
    throw new Error('profile.chunkBytes must be a positive integer');
  }
  if (profile.periodicStall) {
    if (
      !Number.isFinite(profile.periodicStall.everyMs) ||
      profile.periodicStall.everyMs <= 0 ||
      !Number.isFinite(profile.periodicStall.durationMs) ||
      profile.periodicStall.durationMs <= 0 ||
      profile.periodicStall.durationMs >= profile.periodicStall.everyMs
    ) {
      throw new Error(
        'periodic stall requires 0 < durationMs < everyMs',
      );
    }
  }
  if (profile.disconnect) {
    if (
      !Number.isFinite(profile.disconnect.afterMs) ||
      profile.disconnect.afterMs < 0 ||
      !Number.isFinite(profile.disconnect.durationMs) ||
      profile.disconnect.durationMs <= 0
    ) {
      throw new Error(
        'disconnect requires afterMs >= 0 and durationMs > 0',
      );
    }
  }
}

export function resolvePeriodicStallDelayMs(
  elapsedMs: number,
  stall: PeriodicStallProfile | null,
) {
  if (!stall || elapsedMs < stall.everyMs) {
    return 0;
  }
  const phaseMs = elapsedMs % stall.everyMs;
  return phaseMs < stall.durationMs ? stall.durationMs - phaseMs : 0;
}

function wait(delayMs: number) {
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function writeSocket(socket: Socket, chunk: Buffer) {
  if (socket.destroyed || !socket.writable) {
    throw new Error('proxy destination socket is not writable');
  }
  if (socket.write(chunk)) {
    return;
  }
  await once(socket, 'drain');
}

export class WeakNetworkByteProxy {
  private readonly options: WeakNetworkByteProxyOptions;
  private readonly random: () => number;
  private readonly server: Server;
  private readonly connections = new Set<ConnectionRuntime>();
  private readonly clientToTarget: DirectionMetrics = {
    bytesRead: 0,
    bytesWritten: 0,
    chunksWritten: 0,
    maxQueuedBytes: 0,
    stallCount: 0,
  };
  private readonly targetToClient: DirectionMetrics = {
    bytesRead: 0,
    bytesWritten: 0,
    chunksWritten: 0,
    maxQueuedBytes: 0,
    stallCount: 0,
  };
  private startedAt = 0;
  private forcedDisconnects = 0;
  private rejectedDuringDisconnect = 0;
  private disconnectRejectUntil = 0;

  constructor(options: WeakNetworkByteProxyOptions) {
    validateProfile(options.profile);
    if (!options.listenHost.trim() || !options.targetHost.trim()) {
      throw new Error('listenHost and targetHost are required');
    }
    if (
      !Number.isInteger(options.listenPort) ||
      options.listenPort < 0 ||
      options.listenPort > 65_535 ||
      !Number.isInteger(options.targetPort) ||
      options.targetPort <= 0 ||
      options.targetPort > 65_535
    ) {
      throw new Error('proxy ports are invalid');
    }
    this.options = options;
    this.random = options.random ?? Math.random;
    this.server = createServer((client) => {
      void this.acceptConnection(client);
    });
  }

  async start() {
    if (this.server.listening) {
      return this.address();
    }
    this.startedAt = Date.now();
    await new Promise<void>((resolve) => {
      this.server.listen(
        this.options.listenPort,
        this.options.listenHost,
        resolve,
      );
    });
    return this.address();
  }

  private address() {
    const address = this.server.address() as AddressInfo | null;
    if (!address) {
      throw new Error('weak-network proxy is not listening');
    }
    return {
      host: address.address,
      port: address.port,
    };
  }

  async stop() {
    for (const connection of this.connections) {
      if (connection.disconnectTimer) {
        clearTimeout(connection.disconnectTimer);
      }
      connection.client.destroy();
      connection.target.destroy();
    }
    this.connections.clear();
    if (!this.server.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  getSnapshot() {
    return {
      profile: {
        name: this.options.profile.name,
        bandwidthBytesPerSecond:
          this.options.profile.bandwidthBytesPerSecond,
        oneWayLatencyMs: this.options.profile.oneWayLatencyMs,
        jitterMs: [...this.options.profile.jitterMs],
        chunkBytes: this.options.profile.chunkBytes,
        periodicStall: this.options.profile.periodicStall,
        disconnect: this.options.profile.disconnect,
      },
      activeConnections: this.connections.size,
      totals: {
        clientToTargetBytesRead: this.clientToTarget.bytesRead,
        clientToTargetBytesWritten: this.clientToTarget.bytesWritten,
        targetToClientBytesRead: this.targetToClient.bytesRead,
        targetToClientBytesWritten: this.targetToClient.bytesWritten,
        clientToTargetChunksWritten: this.clientToTarget.chunksWritten,
        targetToClientChunksWritten: this.targetToClient.chunksWritten,
        maxQueuedBytes: Math.max(
          this.clientToTarget.maxQueuedBytes,
          this.targetToClient.maxQueuedBytes,
        ),
        stallCount:
          this.clientToTarget.stallCount +
          this.targetToClient.stallCount,
        forcedDisconnects: this.forcedDisconnects,
        rejectedDuringDisconnect: this.rejectedDuringDisconnect,
      },
    };
  }

  private async acceptConnection(client: Socket) {
    if (Date.now() < this.disconnectRejectUntil) {
      this.rejectedDuringDisconnect += 1;
      client.destroy();
      return;
    }

    client.pause();
    const target = new Socket();
    const runtime: ConnectionRuntime = {
      client,
      target,
      disconnectTimer: null,
    };
    this.connections.add(runtime);
    const close = () => {
      if (runtime.disconnectTimer) {
        clearTimeout(runtime.disconnectTimer);
        runtime.disconnectTimer = null;
      }
      this.connections.delete(runtime);
      client.destroy();
      target.destroy();
    };
    client.once('error', close);
    target.once('error', close);
    client.once('close', close);
    target.once('close', close);

    target.connect(this.options.targetPort, this.options.targetHost);
    try {
      await once(target, 'connect');
    } catch {
      close();
      return;
    }

    this.bindDirection(
      client,
      target,
      this.clientToTarget,
    );
    this.bindDirection(
      target,
      client,
      this.targetToClient,
    );
    client.resume();
    target.resume();

    const disconnect = this.options.profile.disconnect;
    if (disconnect) {
      runtime.disconnectTimer = setTimeout(() => {
        this.forcedDisconnects += 1;
        this.disconnectRejectUntil = Date.now() + disconnect.durationMs;
        close();
      }, disconnect.afterMs);
    }
  }

  private bindDirection(
    source: Socket,
    destination: Socket,
    metrics: DirectionMetrics,
  ) {
    source.on('data', (input) => {
      source.pause();
      metrics.bytesRead += input.length;
      void this.forwardBuffer(destination, Buffer.from(input), metrics)
        .then(() => {
          if (!source.destroyed) {
            source.resume();
          }
        })
        .catch(() => {
          source.destroy();
          destination.destroy();
        });
    });
  }

  private async forwardBuffer(
    destination: Socket,
    input: Buffer,
    metrics: DirectionMetrics,
  ) {
    const jitterMin = this.options.profile.jitterMs[0];
    const jitterMax = this.options.profile.jitterMs[1];
    const jitterMs =
      jitterMin +
      Math.round(this.random() * Math.max(0, jitterMax - jitterMin));
    await wait(this.options.profile.oneWayLatencyMs + jitterMs);

    for (
      let offset = 0;
      offset < input.length;
      offset += this.options.profile.chunkBytes
    ) {
      const chunk = input.subarray(
        offset,
        Math.min(input.length, offset + this.options.profile.chunkBytes),
      );
      metrics.maxQueuedBytes = Math.max(
        metrics.maxQueuedBytes,
        chunk.length,
      );
      const stallDelayMs = resolvePeriodicStallDelayMs(
        Date.now() - this.startedAt,
        this.options.profile.periodicStall,
      );
      if (stallDelayMs > 0) {
        metrics.stallCount += 1;
        await wait(stallDelayMs);
      }
      if (this.options.profile.bandwidthBytesPerSecond) {
        await wait(
          (chunk.length /
            this.options.profile.bandwidthBytesPerSecond) *
            1_000,
        );
      }
      await writeSocket(destination, chunk);
      metrics.bytesWritten += chunk.length;
      metrics.chunksWritten += 1;
    }
  }
}

function readArg(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parsePort(value: string | undefined, fallback: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`invalid port: ${value}`);
  }
  return parsed;
}

async function runCli() {
  const profileName = (readArg('--profile') ?? 'good') as keyof typeof WEAK_NETWORK_PROXY_PROFILES;
  const profile = WEAK_NETWORK_PROXY_PROFILES[profileName];
  if (!profile) {
    throw new Error(
      `unknown profile ${profileName}; expected ${Object.keys(
        WEAK_NETWORK_PROXY_PROFILES,
      ).join(', ')}`,
    );
  }
  const proxy = new WeakNetworkByteProxy({
    listenHost: readArg('--listen-host') ?? '127.0.0.1',
    listenPort: parsePort(readArg('--listen-port'), 34_333),
    targetHost: readArg('--target-host') ?? '127.0.0.1',
    targetPort: parsePort(readArg('--target-port'), 3_333),
    profile,
  });
  const address = await proxy.start();
  process.stdout.write(
    `${JSON.stringify({
      type: 'weak-network-proxy-ready',
      profile: profile.name,
      listenHost: address.host,
      listenPort: address.port,
      targetHost: readArg('--target-host') ?? '127.0.0.1',
      targetPort: parsePort(readArg('--target-port'), 3_333),
    })}\n`,
  );

  const reportTimer = setInterval(() => {
    process.stdout.write(
      `${JSON.stringify({
        type: 'weak-network-proxy-metrics',
        snapshot: proxy.getSnapshot(),
      })}\n`,
    );
  }, 5_000);
  const shutdown = async () => {
    clearInterval(reportTimer);
    await proxy.stop();
    process.stdout.write(
      `${JSON.stringify({
        type: 'weak-network-proxy-stopped',
        snapshot: proxy.getSnapshot(),
      })}\n`,
    );
  };
  process.once('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runCli().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
