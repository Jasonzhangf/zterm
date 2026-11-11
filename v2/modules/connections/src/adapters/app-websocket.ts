/**
 * Explicit old /app compatibility adapter.
 *
 * `createAppCodec` is a pure codec boundary: it validates frames using the V1
 * app protocol parser.
 *
 * `AppWebSocketTransport` is the real /app physical transport: it opens the
 * authenticated, bearer-protected source-daemon loopback gateway, performs the
 * app-hello/app-ready handshake, proves the source daemon identity, advertises
 * the `message` channel, and correlates one `app-send-message` with its
 * `app-send-result` / `app-error`. Credentials stay in the accounts-produced
 * target; this module never reads a credential store, never logs the token, and
 * never sends a bare frame on an unnegotiated channel.
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  APP_PROTOCOL_VERSION,
  validateAppClientFrame,
  validateAppServerFrame,
  type AppClientFrame,
  type AppReadyPayload,
  type AppServerFrame,
} from "../../../../../packages/shared/src/connection/app-protocol.ts";
import { ConnectionError } from "../public/errors.ts";
import type {
  ChannelOpenRequest,
  ChannelOpenResult,
} from "../public/types.ts";
import type { AuthorizedMachineLink } from "../ports/accounts-authorization.ts";
import type { TransportHandle, TransportPort } from "../ports/transport.ts";

export interface AppSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface AppCodec {
  encode(frame: Parameters<typeof validateAppClientFrame>[0]): string;
  decode(raw: string): ReturnType<typeof validateAppServerFrame>;
}

export function createAppCodec(): AppCodec {
  return {
    encode: (frame) => {
      validateAppClientFrame(frame);
      return JSON.stringify(frame);
    },
    decode: (raw) => {
      const parsed: unknown = JSON.parse(raw);
      return validateAppServerFrame(parsed);
    },
  };
}

const APP_URL_PATH = "/app";
const HANDSHAKE_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
const OPEN_STATE = 1;

/** Minimal structural view of a ws-compatible WebSocket. */
interface SocketLike {
  readyState: number;
  bufferedAmount: number;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface AppWebSocketDependencies {
  WebSocket?: new (url: string, options?: unknown) => SocketLike;
}

interface PendingAppRequest {
  resolve: (frame: AppServerFrame) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  expectedMessageId?: string;
}

/**
 * Transport handle returned by the /app adapter. `requestAppFrame` is the
 * awaited, correlated send edge used by `ConnectionManager.requestMessage`; the
 * generic `TransportHandle` members stay for the shared channel lifecycle.
 */
export interface AppFrameTransportHandle extends TransportHandle {
  requestAppFrame(frame: AppClientFrame, timeoutMs?: number): Promise<AppServerFrame>;
}

export function isAppFrameTransport(handle: TransportHandle): handle is AppFrameTransportHandle {
  return typeof (handle as { requestAppFrame?: unknown }).requestAppFrame === "function";
}

function loopbackHost(host: string): string {
  if (host === "0.0.0.0" || host === "::" || host === "[::]" || !host) return "127.0.0.1";
  return host;
}

function hostForUrl(host: string): string {
  const normalized = loopbackHost(host);
  return normalized.includes(":") && !normalized.startsWith("[") ? `[${normalized}]` : normalized;
}

/**
 * Build the source gateway URL from the accounts-produced endpoint. The local
 * /app gateway is loopback-only; a wildcard bind host maps to 127.0.0.1.
 */
export function buildAppGatewayUrl(target: AuthorizedMachineLink["target"]): string {
  return `ws://${hostForUrl(target.bridgeHost)}:${target.bridgePort}${APP_URL_PATH}`;
}

/**
 * Build the exact V1 AppTarget paid on the wire from an accounts-authorized
 * destination link. The destination device identity and daemon identity are
 * resolved by accounts, never derived from the source handshake.
 */
export function buildAuthorizedAppTarget(link: AuthorizedMachineLink) {
  const deviceId = link.deviceId?.trim() ?? "";
  const authToken = link.target.authToken?.trim() ?? "";
  if (!deviceId || !authToken || !link.daemonHostId.trim()) {
    throw new ConnectionError("unauthorized", "authorized destination identity is incomplete", {
      machineId: link.machineId,
    });
  }
  return {
    deviceId,
    daemonHostId: link.daemonHostId,
    wsUrl: buildAppGatewayUrl(link.target),
    authToken,
  };
}

export class AppWebSocketTransport implements TransportPort {
  private readonly dependencies: AppWebSocketDependencies;
  private readonly requestTimeoutMs: number;

  constructor(
    dependencies: AppWebSocketDependencies = {},
    options: { requestTimeoutMs?: number } = {},
  ) {
    this.dependencies = dependencies;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  private socketFactory: (new (url: string, options?: unknown) => SocketLike) | null = null;

  private getSocketFactory(): new (url: string, options?: unknown) => SocketLike {
    if (this.dependencies.WebSocket) return this.dependencies.WebSocket;
    if (!this.socketFactory) {
      // v2 modules are not pnpm workspace members yet; resolve `ws` the same
      // way V1TraversalTransport does so an installed module keeps its own
      // dependency graph when present.
      const localRequire = createRequire(import.meta.url);
      const cliRequire = createRequire(new URL("../../../../../packages/cli/package.json", import.meta.url));
      const load = (): { WebSocket: new (url: string, options?: unknown) => SocketLike } => {
        try {
          return localRequire("ws") as { WebSocket: new (url: string, options?: unknown) => SocketLike };
        } catch {
          return cliRequire("ws") as { WebSocket: new (url: string, options?: unknown) => SocketLike };
        }
      };
      this.socketFactory = load().WebSocket;
    }
    return this.socketFactory;
  }

  async open(auth: AuthorizedMachineLink, context: { clientInstanceId: string }): Promise<TransportHandle> {
    const deviceId = auth.deviceId?.trim() ?? "";
    if (!deviceId) {
      throw new ConnectionError("peer_identity_mismatch", "source device identity is not resolved", {
        machineId: auth.machineId,
      });
    }
    const authToken = auth.target.authToken?.trim() ?? "";
    if (!authToken) {
      throw new ConnectionError("unauthorized", "source /app gateway token is missing", {
        machineId: auth.machineId,
      });
    }

    const SocketCtor = this.getSocketFactory();
    const url = buildAppGatewayUrl(auth.target);
    const socket = new SocketCtor(url, { headers: { Authorization: `Bearer ${authToken}` } });
    const codec = createAppCodec();
    const pending = new Map<string, PendingAppRequest>();
    let closeHandler: ((info: { code?: number; reason?: string }) => void) | null = null;
    let closed = false;

    const rejectAllPending = (cause: string) => {
      for (const [requestId, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new ConnectionError("unknown", cause, { machineId: auth.machineId, channelId: requestId }));
      }
      pending.clear();
    };

    const routeServerFrame = (frame: AppServerFrame) => {
      const requestId = (frame.payload as { requestId?: unknown }).requestId;
      if (typeof requestId !== "string" || !requestId) return;
      const entry = pending.get(requestId);
      if (!entry) return;
      if (frame.type !== "app-error" && frame.type !== "app-send-result") return;
      const messageId = (frame.payload as { messageId?: unknown }).messageId;
      if (
        entry.expectedMessageId !== undefined
        && typeof messageId === "string"
        && messageId !== entry.expectedMessageId
      ) {
        // A frame carrying a conflicting message id is stray: it must not
        // settle, succeed, or fail this request. App-error may legitimately
        // omit messageId (a real V1 initialization failure does), so only a
        // present and different id is a conflict; the real result (or timeout)
        // decides.
        return;
      }
      pending.delete(requestId);
      clearTimeout(entry.timer);
      entry.resolve(frame);
    };

    const ready = await new Promise<AppReadyPayload>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const requestId = `hello-${randomUUID()}`;
      const cleanupHandshake = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
      };
      const fail = (error: ConnectionError) => {
        if (settled) return;
        settled = true;
        cleanupHandshake();
        try {
          socket.close(1000, "handshake-failed");
        } catch {
          // A socket that never opened has nothing to release.
        }
        reject(error);
      };
      timer = setTimeout(() => {
        fail(new ConnectionError("unreachable", "source /app handshake timed out", { machineId: auth.machineId }));
      }, HANDSHAKE_TIMEOUT_MS);
      timer.unref?.();

      socket.onopen = () => {
        try {
          socket.send(codec.encode({
            type: "app-hello",
            payload: {
              protocolVersion: APP_PROTOCOL_VERSION,
              requestId,
              role: "local",
              clientInstanceId: context.clientInstanceId,
              deviceId,
              daemonHostId: auth.daemonHostId,
              capabilities: {},
            },
          }));
        } catch (error) {
          fail(new ConnectionError("unreachable", "source /app hello send failed", {
            machineId: auth.machineId,
            cause: error,
          }));
        }
      };
      socket.onmessage = (event) => {
        let frame: AppServerFrame;
        try {
          frame = codec.decode(String(event.data));
        } catch {
          fail(new ConnectionError("invalid_response", "source /app returned an invalid handshake frame", {
            machineId: auth.machineId,
          }));
          return;
        }
        if (frame.type === "app-ready" && frame.payload.requestId === requestId) {
          if (frame.payload.protocolVersion !== APP_PROTOCOL_VERSION) {
            fail(new ConnectionError("unknown", `source /app protocol version ${frame.payload.protocolVersion}`, {
              machineId: auth.machineId,
            }));
            return;
          }
          if (frame.payload.daemonHostId !== auth.daemonHostId) {
            fail(new ConnectionError("peer_identity_mismatch", "source /app daemon identity mismatch", {
              machineId: auth.machineId,
            }));
            return;
          }
          if (frame.payload.deviceId !== deviceId) {
            fail(new ConnectionError("peer_identity_mismatch", "source /app device identity mismatch", {
              machineId: auth.machineId,
            }));
            return;
          }
          settled = true;
          cleanupHandshake();
          resolve(frame.payload);
          return;
        }
        if (frame.type === "app-error" && frame.payload.requestId === requestId) {
          const code = frame.payload.code;
          fail(new ConnectionError(
            code === "unauthorized" || code === "forbidden_role" || code === "missing_identity" ? "unauthorized" : "unknown",
            `source /app rejected handshake: ${frame.payload.message}`,
            { machineId: auth.machineId },
          ));
        }
      };
      socket.onclose = (event) => {
        if (settled) return;
        fail(new ConnectionError(
          event?.code === 4001 ? "unauthorized" : "unreachable",
          event?.reason || `source /app closed ${event?.code ?? "unknown"}`,
          { machineId: auth.machineId },
        ));
      };
      socket.onerror = () => {
        fail(new ConnectionError("unreachable", "source /app socket error", { machineId: auth.machineId }));
      };
    });

    // Data phase: correlate each pending request with its matching frame.
    socket.onmessage = (event) => {
      let frame: AppServerFrame;
      try {
        frame = codec.decode(String(event.data));
      } catch {
        rejectAllPending("source /app returned an invalid frame");
        return;
      }
      routeServerFrame(frame);
    };
    socket.onclose = (event) => {
      closed = true;
      rejectAllPending(`source /app closed after write: ${event?.reason || event?.code || "no reason"}`);
      closeHandler?.({ code: event?.code, reason: event?.reason });
    };
    socket.onerror = () => {
      closed = true;
      rejectAllPending("source /app socket error after write");
    };

    const handle: AppFrameTransportHandle = {
      path: "direct",
      transportKind: "app-websocket",
      peerIdentity: ready.daemonHostId,
      peerIdentityVerified: true,
      peerChannelKinds: ["message"],
      get bufferedBytes() {
        return socket.bufferedAmount || 0;
      },
      listSessions: () => Promise.reject(new ConnectionError(
        "unsupported_channel",
        "the /app link has no terminal session catalog",
        { machineId: auth.machineId },
      )),
      openChannel: (request: ChannelOpenRequest) => {
        if (request.kind !== "message") {
          return Promise.reject(new ConnectionError(
            "unsupported_channel",
            `the /app link does not provide ${request.kind}`,
            { machineId: auth.machineId },
          ));
        }
        if (closed || socket.readyState !== OPEN_STATE) {
          return Promise.reject(new ConnectionError("link_closed", "source /app link is not open", {
            machineId: auth.machineId,
          }));
        }
        const result: ChannelOpenResult = {};
        return Promise.resolve(result);
      },
      sendChannel: (channelId, data) => {
        if (closed || socket.readyState !== OPEN_STATE) {
          throw new ConnectionError("link_closed", "source /app link is not open", {
            machineId: auth.machineId,
            channelId,
          });
        }
        socket.send(typeof data === "string" ? data : Buffer.from(data).toString("base64"));
      },
      closeChannel: () => undefined,
      close: (code, reason) => {
        try {
          socket.close(code, reason);
        } catch {
          // A socket already closing needs no release.
        }
      },
      onChannelMessage: () => () => undefined,
      onClose: (handler) => {
        closeHandler = handler;
      },
      onChannelClosed: () => () => undefined,
      onChannelCloseFailure: () => () => undefined,
      retryLateOpenClose: () => undefined,
      requestAppFrame: (frame: AppClientFrame, timeoutMs?: number) => {
        const requestId = (frame.payload as { requestId?: unknown }).requestId;
        if (typeof requestId !== "string" || !requestId) {
          return Promise.reject(new ConnectionError("invalid_input", "app frame requestId is required", {
            machineId: auth.machineId,
          }));
        }
        if (pending.has(requestId)) {
          return Promise.reject(new ConnectionError("invalid_input", `app request ${requestId} is already pending`, {
            machineId: auth.machineId,
            channelId: requestId,
          }));
        }
        if (closed || socket.readyState !== OPEN_STATE) {
          return Promise.reject(new ConnectionError("link_closed", "source /app link is not open", {
            machineId: auth.machineId,
            channelId: requestId,
          }));
        }
        const expectedMessageId = frame.type === "app-send-message"
          ? (frame.payload as { messageId?: unknown }).messageId as string | undefined
          : undefined;
        const encoded = codec.encode(frame);
        return new Promise<AppServerFrame>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new ConnectionError("unknown", "app request timed out", {
              machineId: auth.machineId,
              channelId: requestId,
            }));
          }, timeoutMs ?? this.requestTimeoutMs);
          timer.unref?.();
          pending.set(requestId, {
            resolve,
            reject,
            timer,
            ...(expectedMessageId !== undefined ? { expectedMessageId } : {}),
          });
          try {
            socket.send(encoded, (error) => {
              if (!error) return;
              const entry = pending.get(requestId);
              if (!entry) return;
              pending.delete(requestId);
              clearTimeout(entry.timer);
              // The frame may already have left the process; treat a send
              // callback failure as an unknown outcome, never as unsent.
              entry.reject(new ConnectionError("unknown", `app frame send failed: ${error.message}`, {
                machineId: auth.machineId,
                channelId: requestId,
              }));
            });
          } catch (error) {
            pending.delete(requestId);
            clearTimeout(timer);
            reject(new ConnectionError("link_closed", "app frame send failed before write", {
              machineId: auth.machineId,
              channelId: requestId,
              cause: error,
            }));
          }
        });
      },
    };
    return handle;
  }
}
