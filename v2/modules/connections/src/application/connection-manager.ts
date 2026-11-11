/** Candidate-to-connection orchestration for the connections module. */
import { randomUUID } from "node:crypto";
import { ConnectionError } from "../public/errors.ts";
import type {
  AppMessageRequest,
  AppMessageResult,
  ChannelCloseInfo,
  ChannelEventHandler,
  ChannelRef,
  Freshness,
  LinkBackpressure,
  LinkCapabilities,
  LinkCloseInfo,
  LinkKind,
  LinkObservation,
  LinkPath,
  LinkRef,
  LinkState,
  SessionCatalogEntry,
  TerminalChannelTarget,
} from "../public/types.ts";
import { ChannelDispatcher } from "../channels/dispatch.ts";
import { buildAuthorizedAppTarget, isAppFrameTransport } from "../adapters/app-websocket.ts";
import {
  validateAppClientFrame,
  type AppClientFrame,
  type AppServerFrame,
} from "../../../../../packages/shared/src/connection/app-protocol.ts";
import { LinkStore, isCurrentGeneration, type LinkRecord } from "../domain/link-state.ts";
import type {
  AccountsAuthorizationPort,
  AuthorizedMachineLink,
} from "../ports/accounts-authorization.ts";
import type { TransportCloseInfo, TransportHandle, TransportPort } from "../ports/transport.ts";

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

function peerIdentityMatches(auth: AuthorizedMachineLink, transport: TransportHandle): boolean {
  return transport.peerIdentity !== null
    && transport.peerIdentityVerified
    && transport.peerIdentity === auth.daemonHostId;
}

/** A stable, request-scoped error reference for inconclusive send outcomes. */
function appSendErrorRef(messageId: string, reason: string) {
  return `app-send:${messageId}:${reason}`;
}

function mapAppServerFrame(frame: AppServerFrame, v1MessageId: string): AppMessageResult {
  if (frame.type === "app-send-result") {
    const payload = frame.payload;
    if (payload.requestId !== v1MessageId || payload.messageId !== v1MessageId) {
      return {
        kind: "unknown",
        requestId: v1MessageId,
        messageId: v1MessageId,
        errorRef: appSendErrorRef(v1MessageId, "uncorrelated-result"),
      };
    }
    return {
      kind: "result",
      requestId: payload.requestId,
      messageId: payload.messageId,
      status: payload.status,
      stage: payload.stage,
    };
  }
  if (frame.type === "app-error") {
    const payload = frame.payload;
    // A protocol error only settles the request when it carries the matching
    // request identity. App-error may legitimately omit messageId (a real V1
    // initialization failure does), so an absent id is accepted; a present
    // conflicting id stays inconclusive.
    const messageIdMatches = payload.messageId === undefined || payload.messageId === v1MessageId;
    if (payload.requestId !== v1MessageId || !messageIdMatches) {
      return {
        kind: "unknown",
        requestId: v1MessageId,
        messageId: v1MessageId,
        errorRef: appSendErrorRef(v1MessageId, "uncorrelated-error"),
      };
    }
    return {
      kind: "rejected",
      code: payload.code,
      stage: payload.stage,
      errorRef: appSendErrorRef(v1MessageId, payload.code),
      cause: payload.message,
    };
  }
  return {
    kind: "unknown",
    requestId: v1MessageId,
    messageId: v1MessageId,
    errorRef: appSendErrorRef(v1MessageId, "uncorrelated-frame"),
  };
}

export class ConnectionManager {
  private readonly authorizationPort: AccountsAuthorizationPort;
  private readonly transport: TransportPort;
  private readonly now: () => number;
  private readonly store = new LinkStore();
  private readonly dispatcher = new ChannelDispatcher();
  /** In-flight requestMessage correlation keys, keyed by v1MessageId. */
  private readonly pendingMessageRequests = new Set<string>();
  private readonly channelCloseFailureHandlers = new Map<TransportHandle, Set<(failure: ConnectionError) => void>>();
  private readonly channelCloseFailureUnsubscribes = new Map<TransportHandle, () => void>();
  private readonly linkCloseHandlers = new Map<TransportHandle, Set<(info: LinkCloseInfo) => void>>();

  constructor(options: ConnectionManagerOptions) {
    this.authorizationPort = options.authorizationPort;
    this.transport = options.transport;
    this.now = options.now ?? (() => Date.now());
  }

  async connect(
    machineId: string,
    callerToken?: string,
    verifiedAuthorization?: AuthorizedMachineLink,
  ): Promise<LinkRef> {
    if (!machineId.trim()) {
      throw new ConnectionError("invalid_input", "machineId is required");
    }
    const token = typeof callerToken === "string" ? callerToken.trim() : "";
    if (!verifiedAuthorization && !token) {
      throw new ConnectionError("unauthorized", "callerToken is required", {
        machineId,
      });
    }
    const auth = verifiedAuthorization
      ?? (await this.authorizationPort.authorizeCallerMachine(machineId, token));
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
        // The close event cannot arrive after a failed close call.
        this.removeLinkCloseHandlers(previous.transport);
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

    if (!peerIdentityMatches(auth, transport)) {
      let closeCause: unknown;
      try {
        transport.close(1000, "peer-identity-mismatch");
      } catch (error) {
        closeCause = error;
      }
      this.store.update(id, {
        status: "rejected",
        path: transport.path,
        transportKind: transport.transportKind,
        observedAt: this.now(),
        errorCode: "peer_identity_mismatch",
      });
      throw new ConnectionError(
        "peer_identity_mismatch",
        `peer daemon identity ${transport.peerIdentity} does not match ${auth.daemonHostId}`,
        { machineId, cause: closeCause },
      );
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
      const closeHandlers = [...(this.linkCloseHandlers.get(transport) ?? [])];
      this.removeLinkCloseHandlers(transport);
      for (const handler of closeHandlers) {
        try {
          handler({ code: info.code, reason: info.reason });
        } catch {
          // A close observer must not prevent the link state from settling.
        }
      }
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

  onChannelClosed(channel: ChannelRef, handler: (info?: ChannelCloseInfo) => void): () => void {
    return this.dispatcher.onClosed(channel, handler);
  }

  sendChannel(channel: ChannelRef, data: string | ArrayBuffer): void {
    this.dispatcher.send(channel, data);
  }

  /**
   * Send one authorized `app-send-message` on an accepted `message` channel and
   * return the correlated public result. This is the delivery send edge, not
   * the low-level `sendChannel` frame writer.
   *
   * Order is fixed: validate the channel and current link, resolve and
   * authorize the destination selector through accounts, build and validate the
   * exact V1 frame, then send. A duplicate still-pending `v1MessageId` is
   * rejected without a second frame. A close or timeout after the frame may
   * have been written returns `unknown`, never a fabricated success.
   */
  async requestMessage(channel: ChannelRef, request: AppMessageRequest): Promise<AppMessageResult> {
    if (channel.kind !== "message") {
      throw new ConnectionError("unsupported_channel", `channel ${channel.id} is not a message channel`, {
        channelId: channel.id,
      });
    }
    const v1MessageId = typeof request.v1MessageId === "string" ? request.v1MessageId.trim() : "";
    if (!v1MessageId) {
      throw new ConnectionError("invalid_input", "v1MessageId is required", { channelId: channel.id });
    }
    const targetMachineId = typeof request.targetMachineId === "string" ? request.targetMachineId.trim() : "";
    if (!targetMachineId) {
      throw new ConnectionError("invalid_input", "targetMachineId is required", { channelId: channel.id });
    }
    if (this.pendingMessageRequests.has(v1MessageId)) {
      throw new ConnectionError("invalid_input", `message ${v1MessageId} is already pending`, {
        channelId: channel.id,
      });
    }

    // Pre-write state: a missing, closed, superseded or wrong-generation link
    // must reject before any payload is written.
    const record = this.store.get(channel.linkId);
    if (!record) {
      throw new ConnectionError("link_not_found", `unknown link ${channel.linkId}`, { channelId: channel.id });
    }
    const transport = record.transport;
    if (record.status !== "connected" || !transport) {
      throw new ConnectionError("link_closed", `link ${channel.linkId} is not connected`, {
        machineId: record.machineId,
        channelId: channel.id,
      });
    }
    const channelTransport = this.dispatcher.transportOf(channel);
    if (!channelTransport) {
      throw new ConnectionError("link_closed", `channel ${channel.id} is not open`, { channelId: channel.id });
    }
    if (channelTransport !== transport) {
      throw new ConnectionError("stale_generation", `channel ${channel.id} belongs to a stale link`, {
        machineId: record.machineId,
        channelId: channel.id,
      });
    }
    if (!isAppFrameTransport(transport)) {
      throw new ConnectionError("unsupported_channel", `transport does not provide the /app send edge`, {
        machineId: record.machineId,
        channelId: channel.id,
      });
    }

    this.pendingMessageRequests.add(v1MessageId);
    try {
      // Authorization happens before any wire write. A denied or unresolved
      // destination never reaches the socket.
      let targetLink: AuthorizedMachineLink;
      try {
        targetLink = await this.authorizationPort.authorizeMachine(targetMachineId);
      } catch (error) {
        throw new ConnectionError("unauthorized", `target machine ${targetMachineId} is not authorized`, {
          machineId: targetMachineId,
          cause: error,
        });
      }
      if (targetLink.machineId !== targetMachineId) {
        throw new ConnectionError("machine_mismatch", `authorization is for ${targetLink.machineId}, requested ${targetMachineId}`, {
          machineId: targetMachineId,
        });
      }
      const target = buildAuthorizedAppTarget(targetLink);

      // The destination authorization is async; re-check link validity before
      // writing so a link that closed meanwhile never receives a payload.
      const current = this.store.get(channel.linkId);
      if (!current || current.transport !== transport || current.status !== "connected") {
        throw new ConnectionError("stale_generation", `link ${channel.linkId} changed before send`, {
          machineId: record.machineId,
          channelId: channel.id,
        });
      }
      // The channel itself may have been closed during the await while the
      // source link stays connected. Re-check the exact open channel so a
      // closed channel never reaches the transport.
      if (this.dispatcher.transportOf(channel) !== transport) {
        throw new ConnectionError("link_closed", `channel ${channel.id} was closed before send`, {
          machineId: record.machineId,
          channelId: channel.id,
        });
      }

      const frame: AppClientFrame = {
        type: "app-send-message",
        payload: {
          requestId: v1MessageId,
          messageId: v1MessageId,
          target,
          subject: request.subject,
          body: request.body,
        },
      };
      try {
        validateAppClientFrame(frame);
      } catch (error) {
        throw new ConnectionError("invalid_input", `invalid app-send-message frame: ${String((error as { message?: unknown })?.message ?? error)}`, {
          channelId: channel.id,
          cause: error,
        });
      }

      let serverFrame: AppServerFrame;
      try {
        serverFrame = await transport.requestAppFrame(frame);
      } catch (error) {
        if (
          error instanceof ConnectionError
          && (error.code === "link_closed"
            || error.code === "stale_generation"
            || error.code === "invalid_input"
            || error.code === "unsupported_channel")
        ) {
          // A pre-write rejection keeps its typed error; nothing was sent.
          throw error;
        }
        // A post-write close, timeout or protocol failure is inconclusive.
        const cause = error instanceof Error ? error.message : String(error);
        return {
          kind: "unknown",
          requestId: v1MessageId,
          messageId: v1MessageId,
          errorRef: appSendErrorRef(v1MessageId, "transport"),
          cause,
        };
      }
      return mapAppServerFrame(serverFrame, v1MessageId);
    } finally {
      this.pendingMessageRequests.delete(v1MessageId);
    }
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

  onLinkClose(link: LinkRef, handler: (info: LinkCloseInfo) => void): () => void {
    const record = this.requireCurrent(link);
    if (!record.transport || record.status !== "connected") {
      throw new ConnectionError("link_closed", `link ${link.id} is not connected`, { machineId: link.machineId });
    }
    let handlers = this.linkCloseHandlers.get(record.transport);
    if (!handlers) {
      handlers = new Set();
      this.linkCloseHandlers.set(record.transport, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers!.delete(handler);
      if (handlers!.size === 0) this.linkCloseHandlers.delete(record.transport!);
    };
  }

  retryLateOpenClose(link: LinkRef, channelId: string): void {
    const record = this.requireCurrent(link);
    if (!record.transport || record.status !== "connected") {
      throw new ConnectionError("link_closed", `link ${link.id} is not connected`, { machineId: link.machineId });
    }
    record.transport.retryLateOpenClose(channelId);
  }

  async listSessions(link: LinkRef): Promise<readonly SessionCatalogEntry[]> {
    const record = this.requireCurrent(link);
    if (record.status !== "connected" || !record.transport) {
      throw new ConnectionError("link_closed", `link ${link.id} is not connected`, { machineId: link.machineId });
    }
    const sessions = await record.transport.listSessions();
    // Fence the async read: a superseded or closed link must not hand a stale
    // transport's catalog to the caller as if it were current truth.
    const current = this.store.get(link.id);
    if (
      !current ||
      !isCurrentGeneration(current, link.generation) ||
      current.status !== "connected" ||
      current.transport !== record.transport
    ) {
      throw new ConnectionError("stale_generation", `link ${link.id} changed while reading sessions`, {
        machineId: link.machineId,
      });
    }
    return sessions;
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
        this.removeLinkCloseHandlers(record.transport);
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

  private removeLinkCloseHandlers(transport: TransportHandle): void {
    this.linkCloseHandlers.delete(transport);
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
