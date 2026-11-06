/** Candidate-to-connection orchestration for the connections module. */
import { randomUUID } from "node:crypto";
import { ConnectionError } from "../public/errors";
import type {
  ChannelEventHandler,
  ChannelRef,
  Freshness,
  LinkBackpressure,
  LinkCapabilities,
  LinkKind,
  LinkObservation,
  LinkPath,
  LinkRef,
  LinkState,
  TerminalChannelTarget,
} from "../public/types";
import { ChannelDispatcher } from "../channels/dispatch";
import { LinkStore, isCurrentGeneration, type LinkRecord } from "../domain/link-state";
import type {
  AccountsAuthorizationPort,
  AuthorizedMachineLink,
} from "../ports/accounts-authorization";
import type { TransportCloseInfo, TransportHandle, TransportPort } from "../ports/transport";

export interface ConnectionManagerOptions {
  readonly authorizationPort: AccountsAuthorizationPort;
  readonly transport: TransportPort;
  readonly now?: () => number;
}

function linkIdFor(machineId: string) {
  return `link:${machineId}`;
}

function pathFromTransport(path: LinkPath): LinkPath {
  return path;
}

function freshnessFor(status: LinkState): Freshness {
  if (status === "connected") return "fresh";
  if (status === "connecting") return "unavailable";
  return "stale";
}

function stateForError(code: string): LinkState {
  switch (code) {
    case "unauthorized":
    case "directory_rejected":
    case "machine_mismatch":
    case "peer_identity_mismatch":
      return "rejected";
    case "unreachable":
      return "unreachable";
    default:
      return "unreachable";
  }
}

export class ConnectionManager {
  private readonly authorizationPort: AccountsAuthorizationPort;
  private readonly transport: TransportPort;
  private readonly now: () => number;
  private readonly store = new LinkStore();
  private readonly dispatcher = new ChannelDispatcher();
  private readonly channelCloseFailureHandlers = new Map<TransportHandle, Set<(failure: ConnectionError) => void>>();
  private readonly channelCloseFailureUnsubscribes = new Map<TransportHandle, () => void>();

  constructor(options: ConnectionManagerOptions) {
    this.authorizationPort = options.authorizationPort;
    this.transport = options.transport;
    this.now = options.now ?? (() => Date.now());
  }

  async connect(machineId: string, verifiedAuthorization?: AuthorizedMachineLink): Promise<LinkRef> {
    if (!machineId.trim()) {
      throw new ConnectionError("invalid_input", "machineId is required");
    }
    const auth = verifiedAuthorization ?? (await this.authorizationPort.authorizeMachine(machineId));
    if (auth.machineId !== machineId) {
      throw new ConnectionError(
        "machine_mismatch",
        `authorization is for ${auth.machineId}, requested ${machineId}`,
        { machineId },
      );
    }

    const id = linkIdFor(machineId);
    const generation = this.store.nextGeneration(id);
    const previous = this.store.get(id);
    if (previous?.transport) {
      // Retire the previous socket without letting its callbacks win, and drop
      // any channels it still owned so stale handles cannot be reused.
      try {
        previous.transport.close(1000, "superseded");
      } catch {
        // ignore
      }
      this.dispatcher.removeLink(previous.transport);
      this.removeChannelCloseFailureHandlers(previous.transport);
    }

    const record: LinkRecord = {
      id,
      machineId,
      generation,
      status: "connecting",
      path: "unknown",
      transportKind: auth.capabilities.transportKind,
      // The requested daemon identity is not observed truth; it stays null until
      // the peer proves one during the handshake.
      peerIdentity: null,
      peerIdentityVerified: false,
      capabilities: auth.capabilities,
      observedAt: this.now(),
      backpressure: { queuedBytes: 0, bufferedBytes: 0, backpressured: false },
    };
    this.store.put(record);

    let transport: TransportHandle;
    try {
      transport = await this.transport.open(auth, { clientInstanceId: randomUUID() });
    } catch (error) {
      const code = error instanceof ConnectionError ? error.code : "unknown";
      const active = this.store.get(id);
      // Generation fencing on the failure path too: a superseded attempt must
      // not overwrite the current link, even when it fails after a newer
      // connection has already succeeded.
      if (!active || !isCurrentGeneration(active, generation)) {
        throw error instanceof ConnectionError
          ? error
          : new ConnectionError("unknown", "link open failed", { machineId, cause: error });
      }
      this.store.update(id, {
        status: stateForError(code),
        path: "unknown",
        observedAt: this.now(),
        errorCode: code,
      });
      throw error instanceof ConnectionError
        ? error
        : new ConnectionError("unknown", "link open failed", { machineId, cause: error });
    }

    // If a newer generation superseded us while opening, fence silently.
    const active = this.store.get(id);
    if (!active || !isCurrentGeneration(active, generation)) {
      try { transport.close(1000, "superseded"); } catch { /* ignore */ }
      throw new ConnectionError("stale_generation", "link superseded during open", { machineId });
    }

    active.transport = transport;
    active.status = "connected";
    active.path = pathFromTransport(transport.path);
    active.transportKind = transport.transportKind;
    // Token authorization proves access, not the expected machine. Only a
    // proven handshake identity becomes observed truth.
    active.peerIdentity = transport.peerIdentity;
    active.peerIdentityVerified = transport.peerIdentityVerified;
    active.capabilities = {
      channelKinds: transport.peerChannelKinds,
      transportKind: transport.transportKind,
    };
    active.observedAt = this.now();
    active.backpressure = {
      queuedBytes: 0,
      bufferedBytes: transport.bufferedBytes,
      backpressured: transport.bufferedBytes > 0,
    };

    const unsubscribeCloseFailure = transport.onChannelCloseFailure((failure) => {
      const current = this.store.get(id);
      if (
        !current ||
        !isCurrentGeneration(current, generation) ||
        current.transport !== transport
      ) {
        return;
      }
      for (const handler of [...(this.channelCloseFailureHandlers.get(transport) ?? [])]) {
        handler(failure);
      }
    });
    this.channelCloseFailureUnsubscribes.set(transport, unsubscribeCloseFailure);

    const capturedGeneration = generation;
    transport.onClose((info: TransportCloseInfo) => {
      // A physical close invalidates every channel owned by this transport,
      // including callbacks from an already superseded generation.
      this.dispatcher.removeLink(transport);
      this.removeChannelCloseFailureHandlers(transport);
      const current = this.store.get(id);
      // Generation fencing: an old socket callback must not overwrite a new link.
      if (!current || !isCurrentGeneration(current, capturedGeneration)) {
        return;
      }
      this.store.update(id, {
        status: info.code === 4001 ? "rejected" : "closed",
        observedAt: this.now(),
        errorCode: info.code === 4001 ? "unauthorized" : current.errorCode,
      });
    });

    return { id, machineId, generation };
  }

  async openChannel(link: LinkRef, kind: LinkKind, target?: TerminalChannelTarget): Promise<ChannelRef> {
    const record = this.requireCurrent(link);
    if (record.status !== "connected" || !record.transport) {
      throw new ConnectionError("link_closed", `link ${link.id} is not connected`, { machineId: link.machineId });
    }
    const channel = await this.dispatcher.open(link.id, record.transport, record.capabilities.channelKinds, kind, target);
    // Re-check generation after the async open: a stale/superseded link must not
    // register a zombie channel bound to an old transport.
    const current = this.store.get(link.id);
    if (
      !current ||
      !isCurrentGeneration(current, link.generation) ||
      current.status !== "connected" ||
      current.transport !== record.transport
    ) {
      try {
        this.closeChannel(channel);
      } catch {
        // Best-effort release; the transport may already be gone.
      }
      // closeChannel can fail on a dying socket. Remove the local channel in
      // every case so a stale generation cannot leave a zombie registry entry.
      this.dispatcher.removeLink(record.transport);
      throw new ConnectionError("stale_generation", `link ${link.id} changed while opening channel`, {
        machineId: link.machineId,
      });
    }
    return channel;
  }

  onChannelMessage(channel: ChannelRef, handler: ChannelEventHandler): () => void {
    return this.dispatcher.onMessage(channel, handler);
  }

  sendChannel(channel: ChannelRef, data: string | ArrayBuffer): void {
    this.dispatcher.send(channel, data);
  }

  closeChannel(channel: ChannelRef): void {
    this.dispatcher.close(channel);
  }

  onChannelCloseFailure(link: LinkRef, handler: (failure: ConnectionError) => void): () => void {
    const record = this.requireCurrent(link);
    if (!record.transport || record.status !== "connected") {
      throw new ConnectionError("link_closed", `link ${link.id} is not connected`, { machineId: link.machineId });
    }
    let handlers = this.channelCloseFailureHandlers.get(record.transport);
    if (!handlers) {
      handlers = new Set();
      this.channelCloseFailureHandlers.set(record.transport, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers!.delete(handler);
      if (handlers!.size === 0) this.channelCloseFailureHandlers.delete(record.transport!);
    };
  }

  retryLateOpenClose(link: LinkRef, channelId: string): void {
    const record = this.requireCurrent(link);
    if (!record.transport || record.status !== "connected") {
      throw new ConnectionError("link_closed", `link ${link.id} is not connected`, { machineId: link.machineId });
    }
    record.transport.retryLateOpenClose(channelId);
  }

  observeLink(link: LinkRef): LinkObservation {
    const record = this.requireCurrent(link);
    const capabilities: LinkCapabilities = record.capabilities;
    // Backpressure is a live transport projection, not a connect-time snapshot.
    const bufferedBytes = record.transport?.bufferedBytes ?? record.backpressure.bufferedBytes;
    const backpressure: LinkBackpressure = {
      queuedBytes: record.backpressure.queuedBytes,
      bufferedBytes,
      backpressured: bufferedBytes > 0,
    };
    return {
      machineId: record.machineId,
      generation: record.generation,
      path: record.path,
      status: record.status,
      freshness: freshnessFor(record.status),
      observedAt: record.observedAt,
      transportKind: record.transportKind,
      peerIdentity: record.peerIdentity,
      peerIdentityVerified: record.peerIdentityVerified,
      capabilities,
      backpressure,
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
    };
  }

  closeOwnLink(link: LinkRef): void {
    const record = this.requireCurrent(link);
    if (record.transport) {
      try {
        record.transport.close(1000, "client-closed");
      } catch {
        // ignore
      } finally {
        this.dispatcher.removeLink(record.transport);
        this.removeChannelCloseFailureHandlers(record.transport);
      }
    }
    record.status = "closed";
    record.observedAt = this.now();
    record.backpressure = { ...record.backpressure, backpressured: false };
  }

  private removeChannelCloseFailureHandlers(transport: TransportHandle): void {
    const unsubscribe = this.channelCloseFailureUnsubscribes.get(transport);
    if (unsubscribe) {
      unsubscribe();
      this.channelCloseFailureUnsubscribes.delete(transport);
    }
    this.channelCloseFailureHandlers.delete(transport);
  }

  private requireCurrent(link: LinkRef): LinkRecord {
    const record = this.store.get(link.id);
    if (!record) {
      throw new ConnectionError("link_not_found", `unknown link ${link.id}`, { machineId: link.machineId });
    }
    if (!isCurrentGeneration(record, link.generation)) {
      throw new ConnectionError("stale_generation", `link ${link.id} generation is stale`, {
        machineId: link.machineId,
      });
    }
    return record;
  }
}
