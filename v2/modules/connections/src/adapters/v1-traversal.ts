/**
 * Reuse V1 shared traversal as the physical transport backend.
 *
 * Candidate ordering is V1's tier-first policy (lan/ipv4/ipv6 -> rtc-direct ->
 * tailscale -> rtc-relay). We do NOT write a second candidate sort. The adapter
 * records the actual resolved path only after the socket opens and the peer
 * completes the terminal-mux hello/ready handshake, so an unconnected endpoint
 * is never reported as connected.
 *
 * Channel truth: terminal mux `channelEnvelope` is a transport capability for
 * terminal session channels, NOT a declaration of generic message/file
 * services. A channel only exists after the daemon accepted a real
 * mux-channel-open for a concrete session target; payload is sent only after
 * that accept. Generic message/file belong to the separate V1 /app service and
 * are not advertised here.
 */
import { createRequire } from "node:module";
import {
  buildTerminalMuxChannelBinary,
  buildTerminalMuxChannelOpen,
  buildTerminalMuxHello,
  isTerminalMuxServerFrame,
  TERMINAL_MUX_PROTOCOL_VERSION,
  type TerminalMuxCapabilities,
} from "@zterm/shared/connection/protocol";
import {
  TraversalRouteHealthCache,
  TraversalSocket,
  type TraversalResolvedPath,
} from "@zterm/shared/connection/traversal";
import { ConnectionError } from "../public/errors";
import type {
  ChannelOpenRequest,
  ChannelOpenResult,
  LinkKind,
  TerminalChannelTarget,
} from "../public/types";
import type { AuthorizedMachineLink } from "../ports/accounts-authorization";
import type { TransportHandle, TransportPort } from "../ports/transport";

const MUX_READY_TIMEOUT_MS = 8000;
const CHANNEL_OPEN_TIMEOUT_MS = 8000;
const OPEN_STATE = 1;

interface NodeTraversalDependencies {
  WebSocket: new (url: string) => unknown;
  RTCPeerConnection: new (config: unknown) => unknown;
  RTCSessionDescription: new (init: unknown) => unknown;
  RTCIceCandidate: new (init: unknown) => unknown;
}

function mapResolvedPath(path: TraversalResolvedPath): "direct" | "relay" {
  return path === "rtc-relay" ? "relay" : "direct";
}

/**
 * Derive the V2 logical channel kinds from the capabilities the daemon really
 * advertised in `mux-ready`. `channelEnvelope` enables real terminal session
 * channels. There is no generic message/file service on terminal mux, so those
 * kinds are never derived here.
 */
function deriveChannelKinds(capabilities: TerminalMuxCapabilities): LinkKind[] {
  return capabilities.channelEnvelope === true ? ["terminal"] : [];
}

function classifyConnectionError(message: unknown): "unauthorized" | "unreachable" | "unknown" {
  const text = String(message ?? "");
  if (/auth|unauthorized|401|403|token|4001/i.test(text)) return "unauthorized";
  if (/timed? ?out|unreachable|refused|closed|failed|system|connect/i.test(text)) return "unreachable";
  return "unknown";
}

function channelOpenPayload(channelId: string, target: TerminalChannelTarget) {
  return {
    channelId,
    sessionName: target.sessionName,
    ...(target.backend ? { backend: target.backend } : {}),
    ...(target.expectedSessionIdentity ? { expectedSessionIdentity: target.expectedSessionIdentity } : {}),
    ...(target.existingOnly ? { existingOnly: true as const } : {}),
    ...(target.cols !== undefined ? { cols: target.cols } : {}),
    ...(target.rows !== undefined ? { rows: target.rows } : {}),
    ...(target.bodySubscribed !== undefined ? { bodySubscribed: target.bodySubscribed } : {}),
  };
}

interface PendingChannelOpen {
  resolve: (result: ChannelOpenResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class V1TraversalTransport implements TransportPort {
  constructor(private readonly dependencies: { WebSocket?: new (url: string) => unknown } = {}) {}

  private factory: ReturnType<typeof this.buildFactory> | null = null;

  private buildFactory(deps: NodeTraversalDependencies) {
    const platform = {
      createWebSocket: (url: string) => new deps.WebSocket(url) as never,
      createPeerConnection: (config: unknown) => new deps.RTCPeerConnection(config) as never,
      createSessionDescription: (init: unknown) => new deps.RTCSessionDescription(init) as never,
      createIceCandidate: (init: unknown) => new deps.RTCIceCandidate(init) as never,
      timers: {
        setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
        clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
      },
    };
    const health = new TraversalRouteHealthCache({ storage: null });
    return {
      createSocket: (
        target: AuthorizedMachineLink["target"],
        settings: AuthorizedMachineLink["settings"],
        options: Record<string, unknown>,
      ) => new TraversalSocket(target, settings, {
        ...options,
        platform,
        routeHealthCache: health,
      } as never),
    };
  }

  private getFactory(): ReturnType<typeof this.buildFactory> {
    if (!this.factory) {
      // v2 modules are not yet pnpm workspace members, so in this repo the
      // runtime dependencies resolve from the CLI package tree. Local
      // resolution comes first so a properly installed module still uses its
      // own dependency graph.
      const localRequire = createRequire(import.meta.url);
      const cliRequire = createRequire(new URL("../../../../../packages/cli/package.json", import.meta.url));
      const load = <T>(id: string): T => {
        try {
          return localRequire(id) as T;
        } catch {
          return cliRequire(id) as T;
        }
      };
      const ws = load<{ WebSocket: new (url: string) => unknown }>("ws");
      const wrtc = load<{
        RTCPeerConnection: new (config: unknown) => unknown;
        RTCSessionDescription: new (init: unknown) => unknown;
        RTCIceCandidate: new (init: unknown) => unknown;
      }>("@roamhq/wrtc");
      this.factory = this.buildFactory({
        WebSocket: this.dependencies.WebSocket ?? ws.WebSocket,
        RTCPeerConnection: wrtc.RTCPeerConnection,
        RTCSessionDescription: wrtc.RTCSessionDescription,
        RTCIceCandidate: wrtc.RTCIceCandidate,
      });
    }
    return this.factory;
  }

  async open(auth: AuthorizedMachineLink, context: { clientInstanceId: string }): Promise<TransportHandle> {
    const factory = this.getFactory();
    const socket = factory.createSocket(auth.target, auth.settings, {
      autoReconnect: false,
      requireOpenConfirmation: false,
      routeHealthScope: {
        accountId: auth.accountId,
        daemonHostId: auth.daemonHostId,
      },
    });

    const channelHandlers = new Set<(channelId: string, data: string | ArrayBuffer) => void>();
    const pendingOpens = new Map<string, PendingChannelOpen>();
    // A channel may carry payload only after the peer accepted it.
    const acceptedChannels = new Set<string>();
    // An open that timed out may still receive a late ack; we answer it with a
    // close so the remote channel is released instead of leaked.
    const pendingRelease = new Set<string>();
    const channelCloseHandlers = new Set<(channelId: string, info?: { reason?: string; code?: string }) => void>();
    const channelCloseFailureHandlers = new Set<(failure: ConnectionError) => void>();
    const notifyChannelClosed = (channelId: string, info?: { reason?: string; code?: string }) => {
      for (const handler of [...channelCloseHandlers]) handler(channelId, info);
    };
    const notifyChannelCloseFailure = (failure: ConnectionError) => {
      for (const handler of [...channelCloseFailureHandlers]) handler(failure);
    };
    let closeHandler: ((info: { code?: number; reason?: string }) => void) | null = null;

    const rejectAllPending = (error: Error) => {
      for (const pending of pendingOpens.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      pendingOpens.clear();
    };

    const sendLateOpenClose = (channelId: string) => {
      try {
        socket.send(JSON.stringify({
          type: "mux-channel-close",
          payload: { channelId, reason: "late-open-release" },
        }));
        pendingRelease.delete(channelId);
      } catch (cause) {
        notifyChannelCloseFailure(new ConnectionError(
          "channel_close_failed",
          `failed to release late-open channel ${channelId}`,
          { machineId: auth.machineId, channelId, cause },
        ));
      }
    };

    // Post-handshake data phase. Only real mux frames are interpreted, and
    // channel payload is delivered only to the addressed channel id.
    const routeChannelFrame = (frame: unknown) => {
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) return;
      const candidate = frame as { type?: unknown; payload?: unknown };
      if (!candidate.payload || typeof candidate.payload !== "object" || Array.isArray(candidate.payload)) return;
      const payload = candidate.payload as {
        channelId?: unknown;
        sessionName?: unknown;
        stableId?: unknown;
        reason?: unknown;
        code?: unknown;
        dataBase64?: unknown;
        message?: unknown;
      };
      const channelId = typeof payload.channelId === "string" ? payload.channelId : "";
      if (candidate.type === "mux-channel-opened") {
        if (!channelId) return;
        const pending = pendingOpens.get(channelId);
        if (pending) {
          pendingOpens.delete(channelId);
          clearTimeout(pending.timer);
          pendingRelease.delete(channelId);
          acceptedChannels.add(channelId);
          pending.resolve({
            ...(typeof payload.sessionName === "string" ? { sessionName: payload.sessionName } : {}),
            ...(typeof payload.stableId === "string" ? { stableId: payload.stableId } : {}),
          });
          return;
        }
        // The open already timed out; the peer accepted it late. Release the
        // remote channel instead of leaking it.
        if (pendingRelease.has(channelId)) {
          sendLateOpenClose(channelId);
        }
        return;
      }
      if (candidate.type === "mux-channel-closed") {
        if (!channelId) return;
        const reason = typeof payload.reason === "string" ? payload.reason : "channel closed";
        const pending = pendingOpens.get(channelId);
        if (pending) {
          pendingOpens.delete(channelId);
          clearTimeout(pending.timer);
          pendingRelease.delete(channelId);
          pending.reject(new ConnectionError("link_closed", `mux channel ${channelId} rejected: ${reason}`, {
            machineId: auth.machineId,
          }));
          return;
        }
        if (acceptedChannels.has(channelId)) {
          acceptedChannels.delete(channelId);
          const code = typeof payload.code === "string" ? payload.code : undefined;
          notifyChannelClosed(channelId, { reason, code });
        }
        return;
      }
      if (candidate.type === "mux-error") {
        if (!channelId) return;
        const reason = typeof payload.message === "string" ? payload.message : "mux error";
        const pending = pendingOpens.get(channelId);
        if (pending) {
          pendingOpens.delete(channelId);
          clearTimeout(pending.timer);
          pendingRelease.delete(channelId);
          pending.reject(new ConnectionError("unknown", `mux channel ${channelId} open failed: ${reason}`, {
            machineId: auth.machineId,
          }));
          return;
        }
        if (acceptedChannels.has(channelId)) {
          acceptedChannels.delete(channelId);
          const code = typeof payload.code === "string" ? payload.code : undefined;
          notifyChannelClosed(channelId, { reason, code });
        }
        return;
      }
      if (!channelId) return;
      if (candidate.type === "mux-channel-binary") {
        const dataBase64 = typeof payload.dataBase64 === "string" ? payload.dataBase64 : "";
        if (!dataBase64) return;
        const bytes = Buffer.from(dataBase64, "base64");
        const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        for (const handler of [...channelHandlers]) handler(channelId, data);
        return;
      }
      if (candidate.type === "mux-channel-message") {
        const data = JSON.stringify(payload.message ?? null);
        for (const handler of [...channelHandlers]) handler(channelId, data);
      }
    };

    const attachChannelRouting = () => {
      socket.onmessage = (event) => {
        let parsed: unknown;
        try {
          const raw = typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(new Uint8Array(event.data));
          parsed = JSON.parse(raw);
        } catch {
          return;
        }
        routeChannelFrame(parsed);
      };
      socket.onclose = (event) => {
        rejectAllPending(new ConnectionError("link_closed", "transport closed before channel open completed", {
          machineId: auth.machineId,
        }));
        pendingRelease.clear();
        closeHandler?.({ code: event?.code, reason: event?.reason });
      };
    };

    const peer = await new Promise<{ peerIdentity: string | null; peerIdentityVerified: boolean; capabilities: TerminalMuxCapabilities }>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const clearTimer = () => {
        if (timer) clearTimeout(timer);
        timer = null;
      };
      // Release this socket's handshake handlers on every terminal outcome so a
      // failed handshake leaves neither callbacks nor an open socket behind.
      const releaseHandshakeHandlers = () => {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
      };
      const settleOk = (value: { peerIdentity: string | null; peerIdentityVerified: boolean; capabilities: TerminalMuxCapabilities }) => {
        if (settled) return;
        settled = true;
        clearTimer();
        // The handshake error handler must not fire on the data phase.
        socket.onerror = null;
        resolve(value);
      };
      const settleFail = (error: ConnectionError) => {
        if (settled) return;
        settled = true;
        clearTimer();
        releaseHandshakeHandlers();
        let failure = error;
        try {
          socket.close(1000, "handshake-failed");
        } catch (closeError) {
          // Do not swallow a close error and then claim the socket is gone.
          failure = new ConnectionError(error.code, `${error.message}; socket close failed`, {
            ...(error.machineId ? { machineId: error.machineId } : {}),
            cause: closeError,
          });
        }
        reject(failure);
      };
      timer = setTimeout(() => {
        settleFail(new ConnectionError("unreachable", "machine link open timed out", { machineId: auth.machineId }));
      }, MUX_READY_TIMEOUT_MS);
      timer.unref?.();

      socket.onopen = () => {
        const diagnostics = socket.getDiagnostics();
        if (!diagnostics.resolvedPath) {
          settleFail(new ConnectionError("unreachable", "no resolved traversal path", { machineId: auth.machineId }));
          return;
        }
        socket.send(JSON.stringify(buildTerminalMuxHello(context.clientInstanceId, auth.daemonHostId)));
      };
      socket.onmessage = (event) => {
        let parsed: unknown;
        try {
          const raw = typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(new Uint8Array(event.data));
          parsed = JSON.parse(raw);
        } catch {
          settleFail(new ConnectionError("unknown", "invalid mux frame", { machineId: auth.machineId }));
          return;
        }
        // V1 bridge auth failures arrive as a bridge "error" frame before the
        // 4001 close. Classify it as unauthorized instead of "unexpected mux".
        const bridgeError = parsed as { type?: unknown; payload?: { code?: unknown; message?: unknown } };
        if (bridgeError?.type === "error") {
          const code = String(bridgeError.payload?.code ?? "");
          const message = String(bridgeError.payload?.message ?? "bridge error");
          settleFail(new ConnectionError(
            /unauthorized|auth|401|403|forbidden/i.test(code || message) ? "unauthorized" : "unknown",
            `bridge error: ${message}`,
            { machineId: auth.machineId },
          ));
          return;
        }
        if (!isTerminalMuxServerFrame(parsed)) {
          settleFail(new ConnectionError("unknown", "unexpected mux frame", { machineId: auth.machineId }));
          return;
        }
        if (parsed.type === "mux-ready") {
          const ready = parsed.payload;
          if (ready.version !== TERMINAL_MUX_PROTOCOL_VERSION) {
            settleFail(new ConnectionError("unknown", `mux protocol version ${ready.version}`, { machineId: auth.machineId }));
            return;
          }
          // daemonHostId is optional on the wire (the live V1 daemon omits it).
          // When present it must match the verified authorization. When absent,
          // peer identity stays null because bearer access does not prove the
          // machine identity.
          const actual = ready.daemonHostId ?? null;
          if (actual !== null && actual !== auth.daemonHostId) {
            settleFail(new ConnectionError(
              "peer_identity_mismatch",
              `peer daemon identity ${actual} does not match ${auth.daemonHostId}`,
              { machineId: auth.machineId },
            ));
            return;
          }
          attachChannelRouting();
          settleOk({ peerIdentity: actual, peerIdentityVerified: actual !== null, capabilities: ready.capabilities });
        } else if (parsed.type === "mux-error") {
          const category = classifyConnectionError(parsed.payload.message);
          settleFail(new ConnectionError(
            category === "unauthorized" ? "unauthorized" : "unknown",
            `mux error ${parsed.payload.code}: ${parsed.payload.message}`,
            { machineId: auth.machineId },
          ));
        } else {
          settleFail(new ConnectionError("unknown", "unexpected mux frame", { machineId: auth.machineId }));
        }
      };
      socket.onclose = (event) => {
        if (settled) return;
        if (event?.code === 4001) {
          settleFail(new ConnectionError("unauthorized", "peer rejected authorization", { machineId: auth.machineId }));
        } else {
          settleFail(new ConnectionError("unreachable", event?.reason || `websocket closed ${event?.code ?? "unknown"}`, { machineId: auth.machineId }));
        }
      };
      socket.onerror = (event) => {
        if (settled) return;
        settleFail(new ConnectionError("unreachable", String((event as { message?: unknown })?.message ?? "socket error"), { machineId: auth.machineId }));
      };
    });

    const diagnostics = socket.getDiagnostics();
    const path = mapResolvedPath(diagnostics.resolvedPath ?? "ipv4");
    const peerChannelKinds = deriveChannelKinds(peer.capabilities);

    return {
      path,
      transportKind: diagnostics.resolvedPath ?? "unknown",
      peerIdentity: peer.peerIdentity,
      peerIdentityVerified: peer.peerIdentityVerified,
      peerChannelKinds,
      get bufferedBytes() {
        return socket.bufferedAmount || 0;
      },
      openChannel: (request: ChannelOpenRequest) => {
        if (request.kind !== "terminal") {
          return Promise.reject(new ConnectionError(
            "unsupported_channel",
            `terminal mux does not provide ${request.kind}; use the real /app service`,
            { machineId: auth.machineId },
          ));
        }
        if (!request.target?.sessionName?.trim()) {
          return Promise.reject(new ConnectionError("invalid_input", "terminal channel target sessionName is required", {
            machineId: auth.machineId,
          }));
        }
        if (socket.readyState !== OPEN_STATE) {
          return Promise.reject(new ConnectionError("link_closed", "transport is not open", { machineId: auth.machineId }));
        }
        if (pendingOpens.has(request.channelId)) {
          return Promise.reject(new ConnectionError("unknown", `channel ${request.channelId} open already pending`, {
            machineId: auth.machineId,
          }));
        }
        return new Promise<ChannelOpenResult>((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingOpens.delete(request.channelId);
            // Keep the address so a late ack is answered with a close, not leaked.
            pendingRelease.add(request.channelId);
            reject(new ConnectionError("unreachable", "channel open timed out", { machineId: auth.machineId }));
          }, CHANNEL_OPEN_TIMEOUT_MS);
          timer.unref?.();
          pendingOpens.set(request.channelId, { resolve, reject, timer });
          try {
            socket.send(JSON.stringify(buildTerminalMuxChannelOpen(channelOpenPayload(request.channelId, request.target!))));
          } catch (error) {
            pendingOpens.delete(request.channelId);
            clearTimeout(timer);
            reject(error instanceof ConnectionError ? error : new ConnectionError("link_closed", "channel open send failed", {
              machineId: auth.machineId,
              cause: error,
            }));
          }
        });
      },
      sendChannel: (channelId, data) => {
        if (socket.readyState !== OPEN_STATE) {
          throw new ConnectionError("link_closed", "transport is not open", { machineId: auth.machineId });
        }
        // Only a channel the peer actually accepted may carry payload. A stale
        // local handle must not write to a closed remote channel.
        if (!acceptedChannels.has(channelId)) {
          throw new ConnectionError("link_closed", `channel ${channelId} is not accepted by the peer`, {
            machineId: auth.machineId,
          });
        }
        const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
        socket.send(JSON.stringify(buildTerminalMuxChannelBinary(channelId, bytes.toString("base64"))));
      },
      closeChannel: (channelId, reason) => {
        if (socket.readyState !== OPEN_STATE) return;
        if (!acceptedChannels.has(channelId) && !pendingRelease.has(channelId)) return;
        socket.send(JSON.stringify({ type: "mux-channel-close", payload: { channelId, ...(reason ? { reason } : {}) } }));
      },
      close: (code, reason) => socket.close(code, reason),
      onChannelMessage: (handler) => {
        channelHandlers.add(handler);
        return () => { channelHandlers.delete(handler); };
      },
      onClose: (handler) => { closeHandler = handler; },
      // Physical close is the only cleanup for a release that never sent.
      onChannelClosed: (handler) => {
        channelCloseHandlers.add(handler);
        return () => { channelCloseHandlers.delete(handler); };
      },
      onChannelCloseFailure: (handler) => {
        channelCloseFailureHandlers.add(handler);
        return () => { channelCloseFailureHandlers.delete(handler); };
      },
      retryLateOpenClose: (channelId) => {
        if (pendingRelease.has(channelId)) sendLateOpenClose(channelId);
      },
    };
  }
}
