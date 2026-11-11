import { ConnectionError } from "./errors.ts";
import type { ConnectionManager } from "./link-port.ts";
import type {
  ChannelCloseInfo,
  ChannelRef,
  LinkCloseInfo,
  LinkRef,
  TerminalBackendKind,
} from "./types.ts";

interface TerminalMuxError extends Error {
  readonly code: string;
  readonly owningModule: "terminal";
  readonly operationId: string;
  readonly channelId?: string;
}

function terminalError(
  code: string,
  message: string,
  options: { channelId?: string; cause?: unknown } = {},
): TerminalMuxError {
  const error = new Error(
    message,
    options.cause === undefined ? undefined : { cause: options.cause },
  ) as Error & {
    code: string;
    owningModule: "terminal";
    operationId: string;
    channelId?: string;
  };
  error.code = code;
  error.owningModule = "terminal";
  error.operationId = "connections-terminal-mux-client";
  if (options.channelId) error.channelId = options.channelId;
  return error;
}

export interface TerminalMuxOpenInput {
  readonly sessionName: string;
  readonly backend?: TerminalBackendKind;
  readonly stableId?: string;
  readonly bodySubscribed?: boolean;
  readonly widthMode?: "adaptive-phone" | "mirror-fixed";
  readonly waitMode?: "bounded" | "persistent";
  readonly cols?: number;
  readonly rows?: number;
}

export interface TerminalMuxChannel {
  readonly channelId: string;
  readonly sessionName: string;
  readonly stableId: string;
  readonly backend: TerminalBackendKind;
  readonly bodySubscribed: boolean;
}

export interface TerminalMuxChannelPromise extends Promise<TerminalMuxChannel> {
  readonly channelId: string;
}

export interface TerminalMuxTargetRequest {
  readonly type: string;
  readonly payload?: unknown;
}

export interface TerminalMuxTargetResult {
  readonly requestId: string;
  readonly message: {
    readonly type: "list-sessions";
    readonly payload: {
      readonly terminalBackend: "tmux";
      readonly sessions: readonly string[];
      readonly sessionCatalog: readonly {
        readonly name: string;
        readonly backend: TerminalBackendKind;
        readonly stableId: string;
      }[];
    };
  };
}

export interface TerminalMuxClient {
  connect(): Promise<void>;
  requestTarget(message: TerminalMuxTargetRequest): Promise<TerminalMuxTargetResult>;
  openChannel(input: TerminalMuxOpenInput): TerminalMuxChannelPromise;
  subscribeChannel(channelId: string, listener: (message: unknown) => void): () => void;
  sendChannelMessage(channelId: string, message: unknown): void;
  closeChannel(channelId: string, reason?: string): void;
  cancelOpenChannel(channelId: string): boolean;
  onClose(listener: (error: unknown) => void): () => void;
  onChannelCloseFailure(listener: (failure: unknown) => void): () => void;
  retryLateOpenClose(channelId: string): boolean;
  getState(): "idle" | "ready" | "closed" | "failed";
  close(): void;
}

export interface TerminalMuxClientOptions {
  readonly connectionManager: ConnectionManager;
  readonly link: LinkRef;
  readonly log?: (entry: Record<string, unknown>) => void;
}

interface PendingOpen {
  readonly resolve: (channel: TerminalMuxChannel) => void;
  readonly reject: (error: unknown) => void;
  cancelled: boolean;
}

interface OpenChannel {
  readonly ref: ChannelRef;
  readonly channel: TerminalMuxChannel;
}

function decodeChannelMessage(data: string | ArrayBuffer): unknown {
  const text = typeof data === "string"
    ? data
    : new TextDecoder().decode(new Uint8Array(data));
  return JSON.parse(text);
}

/**
 * TerminalPort mux-client projection bound to one current machine LinkRef.
 *
 * This adapter translates only the public connections operations. It does not
 * open a socket, parse terminal body frames, or retain a catalog cache.
 */
class ConnectionsTerminalMuxClient implements TerminalMuxClient {
  private readonly manager: ConnectionManager;
  private readonly link: LinkRef;
  private readonly log: (entry: Record<string, unknown>) => void;
  private readonly closeListeners = new Set<(error: unknown) => void>();
  private readonly channelCloseFailureListeners = new Set<(failure: unknown) => void>();
  private readonly channels = new Map<string, OpenChannel>();
  private readonly pendingOpens = new Map<string, PendingOpen>();
  private sequence = 0;
  private closed = false;
  private unsubscribeLinkClose: (() => void) | null = null;
  private unsubscribeChannelCloseFailure: (() => void) | null = null;

  constructor(options: TerminalMuxClientOptions) {
    this.manager = options.connectionManager;
    this.link = options.link;
    this.log = options.log ?? (() => {});
  }

  async connect(): Promise<void> {
    this.assertReady();
  }

  async requestTarget(message: TerminalMuxTargetRequest): Promise<TerminalMuxTargetResult> {
    this.assertReady();
    if (!message || message.type !== "list-sessions") {
      throw terminalError(
        "V1_TARGET_ERROR",
        `unsupported terminal target request ${String(message?.type ?? "unknown")}`,
      );
    }
    const entries = await this.manager.listSessions(this.link);
    return {
      requestId: `terminal-catalog:${this.link.generation}:${++this.sequence}`,
      message: {
        type: "list-sessions",
        payload: {
          terminalBackend: "tmux",
          sessions: entries.map((entry) => entry.name),
          sessionCatalog: entries,
        },
      },
    };
  }

  openChannel(input: TerminalMuxOpenInput): TerminalMuxChannelPromise {
    const channelId = `terminal:${this.link.generation}:${++this.sequence}`;
    const opening = new Promise<TerminalMuxChannel>((resolve, reject) => {
      this.pendingOpens.set(channelId, { resolve, reject, cancelled: false });
      try {
        this.assertReady();
      } catch (error) {
        this.pendingOpens.delete(channelId);
        reject(error);
        return;
      }
      const sessionName = typeof input?.sessionName === "string" ? input.sessionName.trim() : "";
      if (!sessionName) {
        this.pendingOpens.delete(channelId);
        reject(new ConnectionError("invalid_input", "terminal channel target sessionName is required", {
          machineId: this.link.machineId,
          channelId,
        }));
        return;
      }
      const backend = input.backend ?? "tmux";
      const stableId = typeof input.stableId === "string" ? input.stableId : "";
      const bodySubscribed = input.bodySubscribed !== false;
      const target = {
        sessionName,
        backend,
        ...(stableId ? { expectedSessionIdentity: stableId } : {}),
        existingOnly: true as const,
        bodySubscribed,
        ...(input.cols !== undefined ? { cols: input.cols } : {}),
        ...(input.rows !== undefined ? { rows: input.rows } : {}),
      };

      this.manager.openChannel(this.link, "terminal", target).then((ref) => {
        const pending = this.pendingOpens.get(channelId);
        if (!pending) {
          this.releaseLateOpen(ref, "adapter no longer owns pending open");
          return;
        }
        this.pendingOpens.delete(channelId);
        if (pending.cancelled || this.closed || !this.isCurrentLink()) {
          this.releaseLateOpen(ref, "terminal open was cancelled");
          if (pending.cancelled) {
            pending.reject(terminalError(
              "V1_CHANNEL_OPEN_CANCELLED",
              "V1 mux channel open was cancelled by the client.",
              { channelId },
            ));
          } else {
            pending.reject(terminalError(
              "TRANSPORT_CLOSED",
              "Terminal link closed before the channel was published.",
              { channelId },
            ));
          }
          return;
        }
        const channel: TerminalMuxChannel = {
          channelId,
          sessionName: ref.sessionName ?? sessionName,
          stableId,
          backend,
          bodySubscribed,
        };
        this.channels.set(channelId, { ref, channel });
        pending.resolve(channel);
      }, (error) => {
        const pending = this.pendingOpens.get(channelId);
        if (!pending) return;
        this.pendingOpens.delete(channelId);
        pending.reject(error);
      });
    });
    return Object.assign(opening, { channelId });
  }

  subscribeChannel(channelId: string, listener: (message: unknown) => void): () => void {
    const entry = this.requireChannel(channelId);
    const unsubscribeMessage = this.manager.onChannelMessage(entry.ref, (message) => {
      if (this.closed || !this.isCurrentLink()) return;
      try {
        listener(decodeChannelMessage(message.data));
      } catch (error) {
        this.log({
          event: "connections.terminal.channel-message.invalid",
          channelId,
          message: String((error as { message?: unknown })?.message ?? error),
        });
      }
    });
    const unsubscribeClose = this.manager.onChannelClosed(entry.ref, (info) => {
      if (this.closed || !this.isCurrentLink()) return;
      this.channels.delete(channelId);
      listener({
        type: "mux-channel-closed",
        payload: {
          channelId,
          ...(info?.reason ? { reason: info.reason } : {}),
          ...(info?.code ? { code: info.code } : {}),
        },
      });
    });
    return () => {
      unsubscribeMessage();
      unsubscribeClose();
    };
  }

  sendChannelMessage(channelId: string, message: unknown): void {
    this.assertReady();
    const entry = this.requireChannel(channelId);
    this.manager.sendChannel(entry.ref, JSON.stringify(message));
  }

  closeChannel(channelId: string, reason = "client close"): void {
    const entry = this.requireChannel(channelId);
    try {
      this.manager.closeChannel(entry.ref);
      this.channels.delete(channelId);
    } catch (error) {
      const failure = terminalError(
        "V1_CHANNEL_CLOSE_FAILED",
        `Terminal channel ${channelId} close failed.`,
        { channelId, cause: error },
      );
      for (const listener of [...this.channelCloseFailureListeners]) {
        try {
          listener(failure);
        } catch {}
      }
      throw failure;
    }
    this.log({ event: "connections.terminal.channel.closed", channelId, reason });
  }

  cancelOpenChannel(channelId: string): boolean {
    const pending = this.pendingOpens.get(channelId);
    if (!pending || pending.cancelled) return false;
    pending.cancelled = true;
    pending.reject(terminalError(
      "V1_CHANNEL_OPEN_CANCELLED",
      "V1 mux channel open was cancelled by the client.",
      { channelId },
    ));
    return true;
  }

  onClose(listener: (error: unknown) => void): () => void {
    this.closeListeners.add(listener);
    this.ensureLinkCloseSubscription();
    return () => this.closeListeners.delete(listener);
  }

  onChannelCloseFailure(listener: (failure: unknown) => void): () => void {
    this.channelCloseFailureListeners.add(listener);
    this.ensureChannelCloseFailureSubscription();
    return () => this.channelCloseFailureListeners.delete(listener);
  }

  retryLateOpenClose(channelId: string): boolean {
    try {
      this.manager.retryLateOpenClose(this.link, channelId);
    } catch (error) {
      this.log({
        event: "connections.terminal.late-open-retry.failed",
        channelId,
        message: String((error as { message?: unknown })?.message ?? error),
      });
      return false;
    }
    // The transport does not expose whether a matching late-open release was
    // sent, so this adapter does not claim a successful retry.
    return false;
  }

  getState(): "idle" | "ready" | "closed" | "failed" {
    if (this.closed) return "closed";
    try {
      return this.manager.observeLink(this.link).status === "connected" ? "ready" : "failed";
    } catch {
      return "failed";
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [channelId, pending] of [...this.pendingOpens]) {
      pending.cancelled = true;
      pending.reject(terminalError(
        "V1_CHANNEL_CLOSED",
        "Terminal adapter closed before the channel opened.",
        { channelId },
      ));
    }
    this.pendingOpens.clear();
    for (const [channelId, entry] of [...this.channels]) {
      try {
        this.manager.closeChannel(entry.ref);
      } catch (error) {
        this.log({
          event: "connections.terminal.channel-close.failed",
          channelId,
          message: String((error as { message?: unknown })?.message ?? error),
        });
      }
    }
    this.channels.clear();
    this.unsubscribeLinkClose?.();
    this.unsubscribeLinkClose = null;
    this.unsubscribeChannelCloseFailure?.();
    this.unsubscribeChannelCloseFailure = null;
    this.closeListeners.clear();
    this.channelCloseFailureListeners.clear();
  }

  private assertReady(): void {
    if (this.closed) {
      throw terminalError("TRANSPORT_CLOSED", "Terminal link adapter is closed.");
    }
    const observation = this.manager.observeLink(this.link);
    if (observation.generation !== this.link.generation) {
      throw new ConnectionError("stale_generation", `link ${this.link.id} generation is stale`, {
        machineId: this.link.machineId,
      });
    }
    if (observation.status !== "connected" || observation.freshness !== "fresh") {
      throw terminalError("TRANSPORT_CLOSED", "Terminal link is not connected.", {
        cause: observation.errorCode,
      });
    }
  }

  private isCurrentLink(): boolean {
    try {
      return this.manager.observeLink(this.link).generation === this.link.generation;
    } catch {
      return false;
    }
  }

  private requireChannel(channelId: string): OpenChannel {
    const entry = this.channels.get(channelId);
    if (!entry) {
      throw terminalError("V1_CHANNEL_CLOSED", `Terminal channel ${channelId} is not open.`, { channelId });
    }
    return entry;
  }

  private releaseLateOpen(ref: ChannelRef, reason: string): void {
    try {
      this.manager.closeChannel(ref);
    } catch (error) {
      this.log({
        event: "connections.terminal.late-open-release.failed",
        channelId: ref.id,
        reason,
        message: String((error as { message?: unknown })?.message ?? error),
      });
    }
  }

  private ensureLinkCloseSubscription(): void {
    if (this.unsubscribeLinkClose || this.closed) return;
    try {
      this.unsubscribeLinkClose = this.manager.onLinkClose(this.link, (info) => {
        this.handleLinkClose(info);
      });
    } catch (error) {
      this.log({
        event: "connections.terminal.link-close-subscribe.failed",
        message: String((error as { message?: unknown })?.message ?? error),
      });
    }
  }

  private ensureChannelCloseFailureSubscription(): void {
    if (this.unsubscribeChannelCloseFailure || this.closed) return;
    try {
      this.unsubscribeChannelCloseFailure = this.manager.onChannelCloseFailure(this.link, (failure) => {
        for (const listener of [...this.channelCloseFailureListeners]) {
          try {
            listener(failure);
          } catch {}
        }
      });
    } catch (error) {
      this.log({
        event: "connections.terminal.close-failure-subscribe.failed",
        message: String((error as { message?: unknown })?.message ?? error),
      });
    }
  }

  private handleLinkClose(info: LinkCloseInfo): void {
    if (this.closed) return;
    this.closed = true;
    const error = terminalError(
      info.code === 4001 ? "V1_CONNECTION_AUTH_FAILED" : "TRANSPORT_CLOSED",
      info.reason || "Terminal link closed.",
      { cause: info.code },
    );
    for (const [channelId, pending] of [...this.pendingOpens]) {
      pending.cancelled = true;
      pending.reject(terminalError(
        "TRANSPORT_CLOSED",
        "Terminal link closed before the channel opened.",
        { channelId, cause: error },
      ));
    }
    this.pendingOpens.clear();
    this.channels.clear();
    this.unsubscribeLinkClose = null;
    this.unsubscribeChannelCloseFailure?.();
    this.unsubscribeChannelCloseFailure = null;
    for (const listener of [...this.closeListeners]) {
      try {
        listener(error);
      } catch {}
    }
    this.closeListeners.clear();
    this.channelCloseFailureListeners.clear();
  }
}

export function createTerminalMuxClient(options: TerminalMuxClientOptions): TerminalMuxClient {
  return new ConnectionsTerminalMuxClient(options);
}
