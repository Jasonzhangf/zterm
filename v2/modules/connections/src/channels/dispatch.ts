/** Channel negotiation and isolation over one physical link. */
import { ConnectionError } from "../public/errors";
import type {
  ChannelEventHandler,
  ChannelMessage,
  ChannelRef,
  LinkKind,
  TerminalChannelTarget,
} from "../public/types";
import type { TransportHandle } from "../ports/transport";

export interface ChannelRecord {
  readonly ref: ChannelRef;
  readonly handlers: Set<ChannelEventHandler>;
  readonly transport: TransportHandle;
  readonly address: string;
  readonly unsubscribe: () => void;
}

const CHANNEL_KINDS: readonly LinkKind[] = ["terminal", "message", "file", "receipt", "status"];

export function isChannelKind(value: unknown): value is LinkKind {
  return typeof value === "string" && (CHANNEL_KINDS as readonly string[]).includes(value);
}

export class ChannelDispatcher {
  private readonly channels = new Map<string, ChannelRecord>();
  private sequence = 0;
  private readonly linkCloseUnsubscribes = new Map<TransportHandle, () => void>();

  /**
   * Open a channel by asking the peer to accept a real target. The channel is
   * registered only after the transport proves the remote open/ack, so we never
   * hand out a local-only address that the peer does not know about.
   */
  async open(
    linkId: string,
    transport: TransportHandle,
    channelKinds: readonly LinkKind[],
    kind: LinkKind,
    target?: TerminalChannelTarget,
  ): Promise<ChannelRef> {
    if (!isChannelKind(kind)) {
      throw new ConnectionError("unsupported_channel", `unsupported channel kind ${String(kind)}`, { machineId: linkId });
    }
    // A link can only offer channels the peer declared and the transport supports.
    if (!channelKinds.includes(kind)) {
      throw new ConnectionError(
        "unsupported_channel",
        `peer does not offer channel kind ${kind}`,
        { machineId: linkId },
      );
    }
    if (kind === "terminal" && !target?.sessionName?.trim()) {
      throw new ConnectionError(
        "invalid_input",
        "terminal channel requires a target sessionName",
        { machineId: linkId },
      );
    }
    // Real channel addressing: every open channel gets its own address, so two
    // channels of the same kind cannot collide or share frames.
    const address = `${linkId}#${kind}#${++this.sequence}`;
    let accepted: { sessionName?: string };
    try {
      accepted = await transport.openChannel({ channelId: address, kind, ...(target ? { target } : {}) });
    } catch (error) {
      if (error instanceof ConnectionError) throw error;
      throw new ConnectionError("unknown", `channel open failed: ${String((error as { message?: unknown })?.message ?? error)}`, {
        machineId: linkId,
        cause: error,
      });
    }
    const ref: ChannelRef = {
      id: address,
      linkId,
      kind,
      ...(accepted.sessionName ? { sessionName: accepted.sessionName } : {}),
    };
    const unsubscribe = transport.onChannelMessage((inboundAddress, data) => {
      // Isolation: a frame addressed to another channel is never reinterpreted
      // as this channel's kind; it is delivered only to the addressed channel.
      if (inboundAddress !== address) return;
      const record = this.channels.get(address);
      if (!record) return;
      const message: ChannelMessage = { kind, channelId: address, linkId, data };
      for (const handler of [...record.handlers]) {
        try {
          handler(message);
        } catch {
          // A single consumer must not take down the channel or the link.
        }
      }
    });
    this.channels.set(address, { ref, handlers: new Set(), transport, address, unsubscribe });
    this.ensureChannelClosedHook(transport);
    return ref;
  }

  onMessage(ref: ChannelRef, handler: ChannelEventHandler): () => void {
    const record = this.channels.get(ref.id);
    if (!record) {
      throw new ConnectionError("link_closed", `channel ${ref.id} is not open`, { machineId: ref.linkId });
    }
    record.handlers.add(handler);
    return () => {
      record.handlers.delete(handler);
    };
  }

  send(ref: ChannelRef, data: string | ArrayBuffer): void {
    const record = this.channels.get(ref.id);
    if (!record) {
      throw new ConnectionError("link_closed", `channel ${ref.id} is not open`, { machineId: ref.linkId });
    }
    // Only a channel the peer accepted may carry payload. Always a legal
    // addressed channel envelope, never a bare broadcast payload.
    record.transport.sendChannel(record.address, data);
  }

  close(ref: ChannelRef): void {
    const record = this.channels.get(ref.id);
    if (!record) {
      throw new ConnectionError("link_closed", `channel ${ref.id} is not open`, { machineId: ref.linkId });
    }
    try {
      record.transport.closeChannel(record.address, "client-closed");
    } catch (error) {
      // A teardown failure must not be reported as a successful close: keep the
      // recoverable channel so the caller can retry, and surface the typed failure.
      throw new ConnectionError("link_closed", "channel " + ref.id + " close failed: " + String((error as { message?: unknown })?.message ?? error), {
        machineId: ref.linkId,
        cause: error,
      });
    }
    record.unsubscribe();
    this.channels.delete(ref.id);
  }

  isOpen(ref: ChannelRef): boolean {
    return this.channels.has(ref.id);
  }

  /**
   * Forward a remote peer close into the single channel registry so an open
   * ChannelRef stops being usable and send/close can no longer reach the peer.
   * Registered once per physical link; sibling channels are untouched.
   */
  private ensureChannelClosedHook(transport: TransportHandle): void {
    if (this.linkCloseUnsubscribes.has(transport)) return;
    const unsubscribe = transport.onChannelClosed((channelId) => {
      const record = this.channels.get(channelId);
      if (!record) return;
      record.unsubscribe();
      record.handlers.clear();
      this.channels.delete(channelId);
    });
    this.linkCloseUnsubscribes.set(transport, unsubscribe);
  }

  /** Drop every channel owned by a link that is no longer current. */
  removeLink(transport: TransportHandle): void {
    const unsubscribe = this.linkCloseUnsubscribes.get(transport);
    if (unsubscribe) {
      unsubscribe();
      this.linkCloseUnsubscribes.delete(transport);
    }
    for (const [address, record] of this.channels) {
      if (record.transport !== transport) continue;
      record.unsubscribe();
      record.handlers.clear();
      this.channels.delete(address);
    }
  }
}
