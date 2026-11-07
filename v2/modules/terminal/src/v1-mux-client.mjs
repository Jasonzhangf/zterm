import { TypedError } from "../../errors/src/typed-error.mjs";

const VERSION = 1;
const HANDSHAKE_TIMEOUT_MS = 8000;
const REQUEST_TIMEOUT_MS = 10000;
const PING_INTERVAL_MS = 25000;

function muxError(code, message, cause) {
  return new TypedError({
    code,
    owningModule: "terminal",
    operationId: "v1-mux-client",
    cause: cause ? { detail: String(cause) } : undefined,
    message,
  });
}

function clearTimer(timer) {
  if (timer) {
    clearTimeout(timer);
  }
}

function authFailure(detail) {
  return muxError("V1_CONNECTION_AUTH_FAILED", "V1 mux connection authentication failed.", detail);
}

/**
 * One physical V1 terminal WS/mux connection.
 *
 * The client owns only transport and per-target channel references. It never
 * holds tmux truth or a canonical terminal buffer; frames are forwarded to the
 * consumer unchanged.
 */
export function createV1MuxClient(options = {}) {
  const wsUrl = options.wsUrl;
  const clientInstanceId = options.clientInstanceId || "zterm-v2-mux-client";
  const WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
  const log = options.log || (() => {});
  const handshakeTimeoutMs = options.handshakeTimeoutMs || HANDSHAKE_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs || REQUEST_TIMEOUT_MS;
  const pingIntervalMs = options.pingIntervalMs || PING_INTERVAL_MS;

  let socket = null;
  let state = "idle";
  let readyPromise = null;
  let resolveReady = null;
  let rejectReady = null;
  let handshakeTimer = null;
  let pingTimer = null;
  let requestSeq = 0;
  let channelSeq = 0;
  const pendingRequests = new Map();
  const pendingOpens = new Map();
  const channels = new Map();
  const channelMessageListeners = new Map();
  const channelPendingMessages = new Map();
  const closeListeners = new Set();
  let lastAuthFailure = null;
  const lateOpenChannelIds = new Set();
  const lateOpenCloseListeners = new Set();
  const openStatusListeners = new Set();

  function currentOpenSocket() {
    return socket && socket.readyState === WebSocketImpl.OPEN;
  }

  function sendRaw(frame) {
    if (!currentOpenSocket()) {
      throw muxError("TRANSPORT_CLOSED", "V1 mux transport is not open.");
    }
    socket.send(JSON.stringify(frame));
  }

  function notifyLateOpenCloseFailure(channelId, error) {
    const typed = muxError("V1_CHANNEL_CLOSE_FAILED", `V1 mux channel ${channelId} late-open close failed to send.`, error);
    typed.channelId = channelId;
    for (const listener of lateOpenCloseListeners) {
      try {
        listener(typed);
      } catch {}
    }
  }

  function notifyOpenStatus(status) {
    for (const listener of openStatusListeners) {
      try {
        listener(status);
      } catch {}
    }
  }

  function sendLateOpenClose(channelId) {
    try {
      sendRaw({ type: "mux-channel-close", payload: { channelId, reason: "late mux-channel-opened after client timeout" } });
    } catch (releaseError) {
      notifyLateOpenCloseFailure(channelId, releaseError);
      throw releaseError;
    }
    lateOpenChannelIds.delete(channelId);
  }

  function failPending(error) {
    for (const entry of pendingRequests.values()) {
      clearTimer(entry.timer);
      entry.reject(error);
    }
    pendingRequests.clear();
    for (const entry of pendingOpens.values()) {
      clearTimer(entry.timer);
      entry.reject(error);
    }
    pendingOpens.clear();
  }

  function detachChannels(reason) {
    for (const channelId of Array.from(channels.keys())) {
      channels.delete(channelId);
      channelPendingMessages.delete(channelId);
      const listeners = channelMessageListeners.get(channelId);
      if (listeners) {
        channelMessageListeners.delete(channelId);
        for (const listener of listeners) {
          try {
            listener({ type: "mux-channel-closed", payload: { channelId, reason } });
          } catch {}
        }
      }
    }
  }

  function shutdown(error) {
    clearTimer(handshakeTimer);
    clearTimer(pingTimer);
    handshakeTimer = null;
    pingTimer = null;
    if (socket) {
      try {
        socket.close();
      } catch {}
      socket = null;
    }
    const wasReady = state === "ready";
    state = error ? "failed" : "closed";
    const terminalError = error || muxError("TRANSPORT_CLOSED", "V1 mux transport closed.");
    failPending(terminalError);
    detachChannels(terminalError.message);
    lateOpenChannelIds.clear();
    if (rejectReady) {
      rejectReady(terminalError);
      rejectReady = null;
    }
    resolveReady = null;
    readyPromise = null;
    if (wasReady || error) {
      for (const listener of closeListeners) {
        try {
          listener(terminalError);
        } catch {}
      }
    }
  }

  function startHandshakeTimer() {
    clearTimer(handshakeTimer);
    handshakeTimer = setTimeout(() => {
      handshakeTimer = null;
      shutdown(muxError("V1_MUX_HANDSHAKE_TIMEOUT", "Timed out waiting for V1 mux-ready."));
    }, handshakeTimeoutMs);
  }

  function startPing() {
    clearTimer(pingTimer);
    pingTimer = setInterval(() => {
      try {
        sendRaw({ type: "mux-ping", payload: { sentAt: Date.now() } });
      } catch (error) {
        log({ event: "v1-mux.ping.failed", message: String(error && error.message ? error.message : error) });
      }
    }, pingIntervalMs);
  }

  function resolveReadyOnce() {
    clearTimer(handshakeTimer);
    handshakeTimer = null;
    state = "ready";
    const resolve = resolveReady;
    resolveReady = null;
    rejectReady = null;
    startPing();
    if (resolve) {
      resolve();
    }
  }

  function handleRawError(frame) {
    const code = frame && frame.payload && frame.payload.code ? String(frame.payload.code) : "";
    if (code === "unauthorized") {
      lastAuthFailure = authFailure("V1 daemon rejected the mux credential.");
      shutdown(lastAuthFailure);
    }
  }

  function handleTargetMessage(frame) {
    const requestId = frame && frame.payload && frame.payload.requestId
      ? String(frame.payload.requestId)
      : "";
    const message = frame && frame.payload ? frame.payload.message : null;
    const pending = requestId ? pendingRequests.get(requestId) : null;
    if (!pending) {
      return;
    }
    pendingRequests.delete(requestId);
    clearTimer(pending.timer);
    if (message && message.type === "error") {
      pending.reject(muxError("V1_TARGET_ERROR", String(message.payload && message.payload.message ? message.payload.message : "V1 target request failed.")));
      return;
    }
    pending.resolve({ requestId, message });
  }

  function handleChannelOpened(frame) {
    const channelId = frame && frame.payload && frame.payload.channelId
      ? String(frame.payload.channelId)
      : "";
    const pending = channelId ? pendingOpens.get(channelId) : null;
    if (!pending) {
      if (!lateOpenChannelIds.has(channelId)) {
        return;
      }
      try {
        sendLateOpenClose(channelId);
      } catch (releaseError) {
        log({ event: "v1-mux.late-open.release.failed", channelId, message: String(releaseError && releaseError.message ? releaseError.message : releaseError) });
      }
      return;
    }
    pendingOpens.delete(channelId);
    lateOpenChannelIds.delete(channelId);
    clearTimer(pending.timer);
    const channel = {
      channelId,
      sessionName: String(frame.payload.sessionName || pending.sessionName),
      stableId: String(frame.payload.stableId || pending.stableId),
      backend: pending.backend,
      bodySubscribed: pending.bodySubscribed !== false,
    };
    channels.set(channelId, channel);
    if (channel.bodySubscribed) {
      try {
        sendRaw({
          type: "mux-channel-message",
          payload: {
            channelId,
            message: {
              type: "body-subscription",
              payload: {
                version: 1,
                subscribed: true,
                ...(pending.widthMode && pending.widthMode === "adaptive-phone"
                  ? { widthMode: "adaptive-phone", cols: pending.cols, rows: pending.rows }
                  : {}),
              },
            },
          },
        });
      } catch (error) {
        log({ event: "v1-mux.body-subscription.failed", channelId, message: String(error && error.message ? error.message : error) });
      }
    }
    pending.resolve(channel);
  }

  function handleChannelMessage(frame) {
    const channelId = frame && frame.payload && frame.payload.channelId
      ? String(frame.payload.channelId)
      : "";
    if (!channelId || !channels.has(channelId)) {
      return;
    }
    const listeners = channelMessageListeners.get(channelId);
    if (!listeners || listeners.size === 0) {
      const queue = channelPendingMessages.get(channelId) || [];
      if (queue.length < 64) {
        queue.push(frame.payload.message);
        channelPendingMessages.set(channelId, queue);
      }
      return;
    }
    const message = frame.payload.message;
    for (const listener of Array.from(listeners)) {
      try {
        listener(message);
      } catch (error) {
        log({ event: "v1-mux.channel-listener.failed", message: String(error && error.message ? error.message : error) });
      }
    }
  }

  function handleChannelClosed(frame) {
    const channelId = frame && frame.payload && frame.payload.channelId
      ? String(frame.payload.channelId)
      : "";
    if (!channelId) {
      return;
    }
    const reason = String(frame.payload.reason || "channel closed");
    const pending = pendingOpens.get(channelId);
    if (pending) {
      pendingOpens.delete(channelId);
      clearTimer(pending.timer);
      pending.reject(muxError("V1_CHANNEL_OPEN_REJECTED", reason));
      return;
    }
    channels.delete(channelId);
    channelPendingMessages.delete(channelId);
    const listeners = channelMessageListeners.get(channelId);
    if (listeners) {
      channelMessageListeners.delete(channelId);
      for (const listener of listeners) {
        try {
          listener({ type: "mux-channel-closed", payload: { channelId, reason } });
        } catch {}
      }
    }
  }

  function handleMessage(data) {
    let frame;
    try {
      frame = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    } catch (error) {
      log({ event: "v1-mux.invalid-json", message: String(error && error.message ? error.message : error) });
      return;
    }
    if (!frame || typeof frame.type !== "string") {
      return;
    }
    switch (frame.type) {
      case "mux-ready":
        resolveReadyOnce();
        return;
      case "mux-target-message":
        handleTargetMessage(frame);
        return;
      case "mux-channel-opened":
        handleChannelOpened(frame);
        return;
      case "mux-channel-message":
        handleChannelMessage(frame);
        return;
      case "mux-channel-closed":
        handleChannelClosed(frame);
        return;
      case "mux-error": {
        const channelId = frame.payload && frame.payload.channelId ? String(frame.payload.channelId) : "";
        const message = String(frame.payload && frame.payload.message ? frame.payload.message : "V1 mux error.");
        if (channelId && pendingOpens.has(channelId)) {
          const pending = pendingOpens.get(channelId);
          pendingOpens.delete(channelId);
          clearTimer(pending.timer);
          pending.reject(muxError("V1_CHANNEL_OPEN_REJECTED", message));
        } else if (state !== "ready") {
          shutdown(muxError("V1_MUX_REJECTED", message));
        }
        return;
      }
      case "mux-pong":
        return;
      case "error":
        handleRawError(frame);
        return;
      default:
        log({ event: "v1-mux.unhandled-frame", type: frame.type });
        return;
    }
  }

  function connect() {
    if (state === "ready") {
      return Promise.resolve();
    }
    if (readyPromise) {
      return readyPromise;
    }
    if (!WebSocketImpl) {
      return Promise.reject(muxError("TRANSPORT_UNAVAILABLE", "No WebSocket implementation is available."));
    }
    state = "connecting";
    readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
      let nextSocket;
      try {
        nextSocket = new WebSocketImpl(wsUrl);
      } catch (error) {
        reject(muxError("V1_CONNECTION_FAILED", "Failed to create V1 mux socket.", error));
        readyPromise = null;
        state = "failed";
        return;
      }
      socket = nextSocket;
      nextSocket.onopen = () => {
        if (socket !== nextSocket) {
          return;
        }
        try {
          nextSocket.send(JSON.stringify({
            type: "mux-hello",
            payload: { version: VERSION, clientInstanceId },
          }));
        } catch (error) {
          shutdown(muxError("V1_MUX_HELLO_FAILED", "Failed to send mux-hello.", error));
          return;
        }
        startHandshakeTimer();
      };
      nextSocket.onmessage = (event) => {
        if (socket !== nextSocket) {
          return;
        }
        handleMessage(event.data);
      };
      nextSocket.onclose = (event) => {
        if (socket !== nextSocket) {
          return;
        }
        if (state === "ready" || state === "connecting") {
          const code = event && event.code !== undefined ? Number(event.code) : 0;
          if (code === 4001 || lastAuthFailure) {
            shutdown(lastAuthFailure || authFailure("V1 daemon closed the mux socket with 4001."));
          } else {
            shutdown(muxError("TRANSPORT_CLOSED", "V1 mux socket closed."));
          }
        }
      };
      nextSocket.onerror = () => {
        if (socket !== nextSocket) {
          return;
        }
        if (state !== "ready") {
          shutdown(lastAuthFailure || muxError("V1_CONNECTION_FAILED", "V1 mux socket failed before readiness."));
        }
      };
      startHandshakeTimer();
    });
    return readyPromise;
  }

  function requestTarget(message) {
    if (state !== "ready") {
      return Promise.reject(muxError("NOT_READY", "V1 mux transport is not ready."));
    }
    const requestId = `${++requestSeq}:${clientInstanceId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(muxError("V1_TARGET_TIMEOUT", "Timed out waiting for V1 target response."));
      }, requestTimeoutMs);
      pendingRequests.set(requestId, { resolve, reject, timer });
      try {
        sendRaw({
          type: "mux-target-message",
          payload: { requestId, message },
        });
      } catch (error) {
        pendingRequests.delete(requestId);
        clearTimer(timer);
        reject(error);
      }
    });
  }

  function openChannel(input) {
    if (state !== "ready") {
      return Promise.reject(muxError("NOT_READY", "V1 mux transport is not ready."));
    }
    const waitMode = input.waitMode ?? "bounded";
    if (waitMode !== "bounded" && waitMode !== "persistent") {
      return Promise.reject(muxError("V1_INVALID_OPEN_WAIT_MODE", `Unsupported V1 mux open wait mode: ${waitMode}.`));
    }
    const channelId = `${++channelSeq}:${clientInstanceId}`;
    const openPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (waitMode === "persistent") {
          clearTimer(timer);
          const boundary = muxError(
            "V1_OPEN_WAIT_BOUNDARY_REACHED",
            "V1 mux channel open reached the wait boundary without completion.",
          );
          boundary.channelId = channelId;
          boundary.waitMode = "persistent";
          const pending = pendingOpens.get(channelId);
          if (pending) {
            pending.timer = null;
          }
          notifyOpenStatus(boundary);
          return;
        }
        pendingOpens.delete(channelId);
        lateOpenChannelIds.add(channelId);
        const timeout = muxError("V1_CHANNEL_OPEN_TIMEOUT", "Timed out waiting for mux-channel-opened.");
        timeout.channelId = channelId;
        reject(timeout);
      }, requestTimeoutMs);
      pendingOpens.set(channelId, {
        resolve,
        reject,
        timer,
        sessionName: input.sessionName,
        stableId: input.stableId,
        backend: input.backend,
        bodySubscribed: input.bodySubscribed !== false,
        widthMode: input.widthMode || "mirror-fixed",
        cols: input.cols,
        rows: input.rows,
      });
      try {
        sendRaw({
          type: "mux-channel-open",
          payload: {
            channelId,
            sessionName: input.sessionName,
            backend: input.backend,
            expectedSessionIdentity: input.stableId,
            existingOnly: true,
            bodySubscribed: input.bodySubscribed !== false,
            widthMode: input.widthMode || "mirror-fixed",
            ...(input.cols ? { cols: input.cols } : {}),
            ...(input.rows ? { rows: input.rows } : {}),
          },
        });
      } catch (error) {
        pendingOpens.delete(channelId);
        clearTimer(timer);
        reject(error);
      }
    });
    openPromise.channelId = channelId;
    return openPromise;
  }

  function closeChannel(channelId, reason = "client close") {
    const channel = channels.get(channelId);
    if (!channel) {
      throw muxError("V1_CHANNEL_CLOSED", `V1 mux channel ${channelId} is not open.`);
    }
    try {
      sendRaw({ type: "mux-channel-close", payload: { channelId, reason } });
    } catch (sendError) {
      channelPendingMessages.delete(channelId);
      channelMessageListeners.delete(channelId);
      const failure = muxError("V1_CHANNEL_CLOSE_FAILED", `V1 mux channel ${channelId} close frame failed to send.`, sendError);
      failure.channelId = channelId;
      throw failure;
    }
    channels.delete(channelId);
    channelPendingMessages.delete(channelId);
    channelMessageListeners.delete(channelId);
  }

  function sendChannelMessage(channelId, message) {
    if (!channels.has(channelId)) {
      throw muxError("V1_CHANNEL_CLOSED", "V1 mux channel is not open.");
    }
    sendRaw({ type: "mux-channel-message", payload: { channelId, message } });
  }

  function subscribeChannel(channelId, listener) {
    if (!channels.has(channelId)) {
      throw muxError("V1_CHANNEL_CLOSED", "V1 mux channel is not open.");
    }
    let listeners = channelMessageListeners.get(channelId);
    if (!listeners) {
      listeners = new Set();
      channelMessageListeners.set(channelId, listeners);
    }
    listeners.add(listener);
    const pending = channelPendingMessages.get(channelId);
    if (pending && pending.length > 0) {
      channelPendingMessages.delete(channelId);
      for (const message of pending) {
        try {
          listener(message);
        } catch (error) {
          log({ event: "v1-mux.channel-listener.failed", message: String(error && error.message ? error.message : error) });
        }
      }
    }
    return () => {
      const current = channelMessageListeners.get(channelId);
      if (!current) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        channelMessageListeners.delete(channelId);
      }
    };
  }

  function onClose(listener) {
    closeListeners.add(listener);
    return () => closeListeners.delete(listener);
  }

  function onChannelCloseFailure(listener) {
    lateOpenCloseListeners.add(listener);
    return () => lateOpenCloseListeners.delete(listener);
  }

  function retryLateOpenClose(channelId) {
    if (!lateOpenChannelIds.has(channelId)) {
      return false;
    }
    try {
      sendLateOpenClose(channelId);
    } catch (releaseError) {
      log({ event: "v1-mux.late-open.retry.failed", channelId, message: String(releaseError && releaseError.message ? releaseError.message : releaseError) });
      return false;
    }
    return true;
  }

  function onOpenStatus(listener) {
    openStatusListeners.add(listener);
    return () => openStatusListeners.delete(listener);
  }

  function cancelOpenChannel(channelId) {
    const pending = pendingOpens.get(channelId);
    if (!pending) {
      return false;
    }
    pendingOpens.delete(channelId);
    clearTimer(pending.timer);
    pending.timer = null;
    const cancelError = muxError("V1_CHANNEL_OPEN_CANCELLED", "V1 mux channel open was cancelled by the client.");
    cancelError.channelId = channelId;
    try {
      if (currentOpenSocket()) {
        sendRaw({ type: "mux-channel-close", payload: { channelId, reason: "client cancelled open" } });
      }
    } catch (sendError) {
      log({
        event: "v1-mux.cancel-open-close.failed",
        channelId,
        message: String(sendError && sendError.message ? sendError.message : sendError),
      });
    }
    pending.reject(cancelError);
    return true;
  }

  function getState() {
    return state;
  }

  function close() {
    shutdown(null);
  }

  return {
    connect,
    requestTarget,
    openChannel,
    closeChannel,
    sendChannelMessage,
    subscribeChannel,
    onClose,
    onChannelCloseFailure,
    retryLateOpenClose,
    onOpenStatus,
    cancelOpenChannel,
    getState,
    close,
  };
}
