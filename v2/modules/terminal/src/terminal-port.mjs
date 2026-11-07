import { createTerminalBufferRenderRuntime } from "@zterm/stream-boundary";
import { normalizeWireLines } from "@zterm/shared/terminal-buffer";
import { TypedError } from "../../errors/src/typed-error.mjs";
import { observation } from "../../status/src/observation.mjs";
import { createV1MuxClient } from "./v1-mux-client.mjs";

const SESSION_CACHE_MS = 2000;
const TMUX_STABLE_PREFIX = "tmux:v1:";

function targetKey(session) {
  return session.stableId || session.name;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeRepairRange(rawRange) {
  if (!rawRange) {
    return null;
  }
  const startIndex = rawRange.startIndex;
  const endIndex = rawRange.endIndex;
  if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)) {
    return null;
  }
  if (startIndex < 0 || endIndex <= startIndex) {
    return null;
  }
  return { startIndex, endIndex };
}

function parseStableIdentity(stableId) {
  if (typeof stableId !== "string" || !stableId.startsWith(TMUX_STABLE_PREFIX)) {
    return null;
  }
  try {
    const parsed = JSON.parse(decodeURIComponent(stableId.slice(TMUX_STABLE_PREFIX.length)));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeSession(catalogEntry) {
  const name = String(catalogEntry.name);
  const stableId = catalogEntry.stableId ? String(catalogEntry.stableId) : "";
  const identity = parseStableIdentity(stableId);
  const createdAt = identity && Number.isFinite(identity.createdAt) ? identity.createdAt : undefined;
  return {
    id: stableId || `${TMUX_STABLE_PREFIX}name:${name}`,
    name,
    backend: catalogEntry.backend || "tmux",
    stableId: stableId || undefined,
    ...(createdAt !== undefined
      ? { createdAt, createdIso: new Date(createdAt * 1000).toISOString() }
      : {}),
  };
}

function toFrameChunk(payload) {
  const cols = Number.isFinite(payload.cols) && payload.cols > 0 ? Math.floor(payload.cols) : 80;
  const rows = Number.isFinite(payload.rows) && payload.rows > 0 ? Math.floor(payload.rows) : 24;
  const normalized = normalizeWireLines(Array.isArray(payload.lines) ? payload.lines : [], cols);
  const startIndex = Number.isFinite(payload.startIndex) ? Math.floor(payload.startIndex) : 0;
  const endIndex = Number.isFinite(payload.endIndex) ? Math.floor(payload.endIndex) : startIndex + normalized.length;
  return {
    revision: Number.isFinite(payload.revision) ? Math.floor(payload.revision) : 0,
    frameStartIndex: Number.isFinite(payload.frameStartIndex) ? Math.floor(payload.frameStartIndex) : startIndex,
    frameEndIndex: Number.isFinite(payload.frameEndIndex) ? Math.floor(payload.frameEndIndex) : endIndex,
    frameChunkIndex: Number.isFinite(payload.frameChunkIndex) ? Math.floor(payload.frameChunkIndex) : 0,
    frameChunkCount: Number.isFinite(payload.frameChunkCount) ? Math.floor(payload.frameChunkCount) : 1,
    startIndex,
    endIndex,
    generatedAt: Number.isFinite(payload.generatedAt) && payload.generatedAt > 0 ? Math.floor(payload.generatedAt) : Date.now(),
    cols,
    rows,
    cursor: payload.cursor && typeof payload.cursor === "object"
      ? {
          rowIndex: Number.isFinite(payload.cursor.rowIndex) ? Math.floor(payload.cursor.rowIndex) : 0,
          col: Number.isFinite(payload.cursor.col) ? Math.floor(payload.cursor.col) : 0,
          visible: payload.cursor.visible !== false,
        }
      : null,
    lines: normalized.map((line) => ({
      index: line.index,
      cells: line.cells.map((cell) => ({
        char: cell.char,
        fg: cell.fg,
        bg: cell.bg,
        flags: cell.flags,
        width: cell.width,
      })),
    })),
  };
}

function snapshotToFrame(snapshot) {
  const lines = snapshot.lines.map((cells, offset) => (
    cells ? { index: snapshot.startIndex + offset, cells } : { index: snapshot.startIndex + offset, cells: null }
  ));
  return {
    revision: snapshot.revision,
    startIndex: snapshot.startIndex,
    endIndex: snapshot.endIndex,
    cols: snapshot.cols,
    rows: snapshot.rows,
    cursor: snapshot.cursor ? { ...snapshot.cursor } : null,
    gapRanges: snapshot.gapRanges.map((range) => ({ ...range })),
    lines,
  };
}

/**
 * Client projection over the V1 daemon's public WS/mux terminal API.
 *
 * Owns one physical WS connection and one ref-counted channel per target.
 * It holds no tmux mirror and never spawns tmux or capture loops; committed
 * frames are produced by the public client buffer render runtime.
 */
export class TerminalPort {
  constructor(options = {}) {
    this.log = options.log || (() => {});
    this.client = options.muxClient || createV1MuxClient({
      wsUrl: options.wsUrl,
      clientInstanceId: options.clientInstanceId,
      WebSocketImpl: options.WebSocketImpl,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
      requestTimeoutMs: options.requestTimeoutMs,
      pingIntervalMs: options.pingIntervalMs,
      log: this.log,
    });
    this.sessions = [];
    this.sessionsFetchedAt = 0;
    this.targets = new Map();
    this.closed = false;
    this.closeListeners = new Set();
    this.channelCloseFailureListeners = new Set();
    this.pendingLateOpenCloses = new Map();
    this.client.onClose((error) => {
      this.closed = true;
      this.pendingLateOpenCloses.clear();
      for (const entry of this.targets.values()) {
        if (!entry || !entry.subscribers) {
          continue;
        }
        for (const subscriber of entry.subscribers) {
          try {
            subscriber.onError?.(error);
          } catch {}
        }
      }
      for (const listener of this.closeListeners) {
        try {
          listener(error);
        } catch {}
      }
    });
    this.client.onChannelCloseFailure?.((error) => {
      const channelId = error && typeof error.channelId === "string" ? error.channelId : "";
      if (channelId) {
        this.pendingLateOpenCloses.set(channelId, error);
      }
      for (const listener of this.channelCloseFailureListeners) {
        try {
          listener(error);
        } catch {}
      }
    });
  }

  async listSessions() {
    await this.client.connect();
    const result = await this.client.requestTarget({
      type: "list-sessions",
      payload: { terminalBackend: "tmux" },
    });
    const payload = result.message && result.message.payload ? result.message.payload : {};
    const names = Array.isArray(payload.sessions) ? payload.sessions.map((name) => String(name)) : [];
    const catalog = Array.isArray(payload.sessionCatalog) ? payload.sessionCatalog : [];
    const byName = new Map();
    for (const entry of catalog) {
      if (entry && entry.name) {
        byName.set(String(entry.name), entry);
      }
    }
    this.sessions = names.map((name) => normalizeSession(byName.get(name) || { name, backend: "tmux" }));
    this.sessionsFetchedAt = Date.now();
    return this.sessions.map((session) => ({ ...session }));
  }

  async resolveSession(target) {
    const reference = String(target || "");
    let match = this.sessions.find((session) => session.name === reference || session.id === reference);
    const cacheFresh = this.sessionsFetchedAt > 0 && Date.now() - this.sessionsFetchedAt < SESSION_CACHE_MS;
    if (!match || !cacheFresh) {
      const sessions = await this.listSessions();
      match = sessions.find((session) => session.name === reference || session.id === reference);
    }
    if (!match) {
      throw new TypedError({
        code: "TARGET_NOT_FOUND",
        owningModule: "terminal",
        operationId: "resolveSession",
        cause: { target: reference },
        message: `Terminal target ${reference} was not found.`,
      });
    }
    return match;
  }

  ensureTarget(session) {
    const key = targetKey(session);
    const existing = this.targets.get(key);
    if (existing) {
      return existing;
    }
    const runtime = createTerminalBufferRenderRuntime();
    const entry = {
      key,
      session,
      channel: null,
      runtime,
      subscribers: new Set(),
      leases: 0,
      lastFrame: null,
      lastHead: null,
      closed: false,
      unsubscribe: null,
      openCancelled: false,
    };
    const openPromise = this.client.openChannel({
      sessionName: session.name,
      backend: session.backend,
      stableId: session.stableId,
      bodySubscribed: true,
      widthMode: "mirror-fixed",
      waitMode: "persistent",
    });
    entry.channelId = openPromise.channelId;
    entry.openPromise = openPromise;
    entry.openWaiters = [];
    this.targets.set(key, entry);
    entry.openPromise.then((channel) => {
      this.handleChannelOpened(entry, channel);
    }, (error) => {
      this.failTargetOpen(entry, error);
    });
    return entry;
  }

  handleChannelOpened(entry, channel) {
    if (entry.closed || entry.openCancelled || this.targets.get(entry.key) !== entry) {
      try {
        this.client.closeChannel(channel.channelId, "v2 target released before open");
      } catch {}
      return;
    }
    entry.channel = channel;
    entry.unsubscribe = this.client.subscribeChannel(channel.channelId, (message) => {
      this.handleChannelMessage(entry, message);
    });
    for (const waiter of entry.openWaiters.splice(0, entry.openWaiters.length)) {
      waiter.resolve(entry);
    }
    this.log({
      event: "terminal.target.opened",
      target: entry.session.name,
      channelId: channel.channelId,
      stableId: entry.session.stableId || null,
    });
  }

  failTargetOpen(entry, error) {
    if (entry.openFailed) {
      return;
    }
    entry.openFailed = true;
    if (this.targets.get(entry.key) === entry) {
      this.targets.delete(entry.key);
    }
    for (const subscriber of entry.subscribers) {
      try {
        subscriber.onError?.(error);
      } catch {}
    }
    for (const waiter of entry.openWaiters.splice(0, entry.openWaiters.length)) {
      waiter.reject(error);
    }
  }

  awaitTargetOpen(entry) {
    if (entry.channel) {
      return Promise.resolve(entry);
    }
    return new Promise((resolve, reject) => {
      entry.openWaiters.push({ resolve, reject });
    });
  }

  async awaitChannel(entry) {
    if (entry.channel) {
      return entry.channel;
    }
    if (entry.openCancelled) {
      throw new TypedError({
        code: "TERMINAL_CHANNEL_CLOSED",
        owningModule: "terminal",
        operationId: "awaitChannel",
        cause: "The channel open was cancelled.",
        message: "The terminal channel is closed.",
      });
    }
    await this.awaitTargetOpen(entry);
    if (!entry.channel || entry.openCancelled || entry.closed) {
      throw new TypedError({
        code: "TERMINAL_CHANNEL_CLOSED",
        owningModule: "terminal",
        operationId: "awaitChannel",
        cause: "The channel open was cancelled.",
        message: "The terminal channel is closed.",
      });
    }
    return entry.channel;
  }

  handleChannelMessage(entry, message) {
    if (!message || typeof message.type !== "string") {
      return;
    }
    if (message.type === "channel-closed" || message.type === "mux-channel-closed") {
      if (entry.closed) {
        return;
      }
      entry.closed = true;
      const error = new Error(String(message.payload && message.payload.reason ? message.payload.reason : "channel closed"));
      error.code = "TERMINAL_CHANNEL_CLOSED";
      for (const subscriber of entry.subscribers) {
        try {
          subscriber.onError?.(error);
        } catch {}
      }
      if (this.targets.get(entry.key) === entry) {
        this.targets.delete(entry.key);
      }
      return;
    }
    if (entry.closed) {
      return;
    }
    if (message.type === "buffer-head") {
      entry.lastHead = message.payload;
      return;
    }
    if (message.type !== "buffer-sync") {
      return;
    }
    if (!entry.headRequested) {
      entry.headRequested = true;
      try {
        this.client.sendChannelMessage(entry.channel.channelId, { type: "buffer-head-request" });
      } catch (error) {
        this.log({ event: "terminal.head.request.failed", target: entry.session.name, message: String(error && error.message ? error.message : error) });
      }
    }
    const chunk = toFrameChunk(message.payload || {});
    const result = entry.runtime.applyFrameChunk(chunk);
    if (result.kind === "rejected") {
      this.handleFrameRejected(entry, chunk, result);
      return;
    }
    if (result.kind === "pending") {
      this.log({ event: "terminal.frame.pending", target: entry.session.name, revision: chunk.revision });
      return;
    }
    const frame = snapshotToFrame(result.snapshot);
    entry.lastFrame = frame;
    this.log({ event: "terminal.frame.committed", target: entry.session.name, revision: frame.revision, startIndex: frame.startIndex, endIndex: frame.endIndex });
    for (const subscriber of Array.from(entry.subscribers)) {
      try {
        subscriber.onFrame?.(frame, { target: entry.session.name, observedAt: nowIso() });
      } catch (error) {
        this.log({ event: "terminal.subscriber.failed", message: String(error && error.message ? error.message : error) });
      }
    }
  }


  /**
   * Every rejected frame that carries a valid non-empty repair range is
   * repaired on the wire, regardless of the rejection kind (conflicting,
   * interleaved, or invalid). Stale frames and null ranges are not repaired.
   *
   * The wire request carries the exact runtime range. The local cache is only
   * used to attach the overlap of already-known lines; it never clips the
   * request range. A revision is marked dispatched only after the wire write
   * succeeds, and never more than once.
   */
  handleFrameRejected(entry, chunk, result) {
    const error = result && result.error;
    const repairRange = normalizeRepairRange(result && result.repairRange);
    if (!repairRange) {
      this.log({ event: "terminal.frame.rejected.no-repair", target: entry.session.name, error, repairRange: null });
      return;
    }
    const revision = Number.isFinite(chunk.revision) ? Math.floor(chunk.revision) : 0;
    if (!entry.repairRequests) {
      entry.repairRequests = new Map();
    }
    const existing = entry.repairRequests.get(revision);
    if (existing && existing.status === "dispatched") {
      return;
    }
    const snapshot = entry.runtime.getSnapshot();
    const localStart = Math.max(0, Math.floor(snapshot.startIndex));
    const localEnd = Math.max(localStart, Math.floor(snapshot.endIndex));
    const start = repairRange.startIndex;
    const end = repairRange.endIndex;
    const overlapStart = Math.max(start, localStart);
    const overlapEnd = Math.min(end, localEnd);
    const lines = overlapEnd > overlapStart
      ? snapshot.lines.slice(overlapStart - localStart, overlapEnd - localStart).map((cells, offset) => ({
          index: overlapStart + offset,
          cells: cells ? cells.map((cell) => ({ ...cell })) : null,
        }))
      : [];
    const payload = {
      type: "buffer-sync-request",
      payload: {
        knownRevision: snapshot.revision,
        localStartIndex: localStart,
        localEndIndex: localEnd,
        requestStartIndex: start,
        requestEndIndex: end,
        requestedAt: Date.now(),
        cols: Number.isFinite(chunk.cols) && chunk.cols > 0 ? Math.floor(chunk.cols) : 80,
        rows: Number.isFinite(chunk.rows) && chunk.rows > 0 ? Math.floor(chunk.rows) : 24,
        lines,
      },
    };
    entry.repairRequests.set(revision, { repairRange, status: "pending" });
    try {
      this.client.sendChannelMessage(entry.channel.channelId, payload);
      entry.repairRequests.set(revision, { repairRange, status: "dispatched" });
      this.log({ event: "terminal.frame.repair-requested", target: entry.session.name, revision, repairRange, knownRevision: snapshot.revision });
    } catch (sendError) {
      entry.repairRequests.set(revision, { repairRange, status: "failed" });
      this.log({ event: "terminal.frame.repair-request.failed", target: entry.session.name, revision, repairRange, message: String(sendError && sendError.message ? sendError.message : sendError) });
    }
  }

  async attach(target) {
    const session = await this.resolveSession(target);
    const entry = await this.ensureTarget(session);
    const channel = await this.awaitChannel(entry);
    return observation("v1-mux", { target: entry.session.name, channelId: channel.channelId, stableId: entry.session.stableId || null });
  }

  async subscribe(target, listener, options = {}) {
    const session = await this.resolveSession(target);
    const entry = await this.ensureTarget(session);
    const subscriber = typeof listener === "function"
      ? { onFrame: listener, onError: options.onError }
      : listener;
    entry.subscribers.add(subscriber);
    const cachedFrame = entry.lastFrame;
    if (cachedFrame) {
      queueMicrotask(() => {
        if (!entry.subscribers.has(subscriber) || entry.closed || this.targets.get(entry.key) !== entry) {
          return;
        }
        try {
          subscriber.onFrame?.(cachedFrame, { target: entry.session.name, observedAt: nowIso(), cached: true });
        } catch {}
      });
    }
    const ready = this.awaitTargetOpen(entry);
    ready.catch(() => {});
    return {
      ready,
      close: () => {
        this.releaseSubscriber(entry, subscriber);
      },
    };
  }

  releaseSubscriber(entry, subscriber) {
    if (!entry.subscribers.delete(subscriber)) {
      return;
    }
    this.maybeCloseTarget(entry);
  }

  maybeCloseTarget(entry) {
    if (this.targets.get(entry.key) !== entry) {
      return;
    }
    if (entry.subscribers.size > 0 || entry.leases > 0 || entry.closed) {
      return;
    }

    entry.closed = true;
    entry.openCancelled = !entry.channel;
    if (entry.openCancelled) {
      const error = new TypedError({
        code: "TERMINAL_CHANNEL_CLOSED",
        owningModule: "terminal",
        operationId: "subscribe",
        cause: "The channel open was cancelled.",
        message: "The terminal channel is closed.",
      });
      for (const waiter of entry.openWaiters.splice(0, entry.openWaiters.length)) {
        waiter.reject(error);
      }
    }
    if (entry.unsubscribe) {
      entry.unsubscribe();
    }
    if (this.targets.get(entry.key) === entry) {
      this.targets.delete(entry.key);
    }
    if (entry.channel) {
      this.client.closeChannel(entry.channel.channelId, "v2 last subscriber closed");
      this.log({ event: "terminal.target.closed", target: entry.session.name, channelId: entry.channel.channelId });
    } else if (entry.channelId) {
      try {
        this.client.cancelOpenChannel(entry.channelId);
      } catch {}
      this.log({ event: "terminal.target.open.cancelled", target: entry.session.name, channelId: entry.channelId });
    }
  }

  async input(target, data) {
    if (typeof data !== "string" || data.length === 0) {
      throw new TypedError({
        code: "INPUT_INVALID",
        owningModule: "terminal",
        operationId: "input",
        cause: "Input must be a non-empty string.",
        message: "Terminal input is invalid.",
      });
    }
    const session = await this.resolveSession(target);
    const entry = await this.ensureTarget(session);
    entry.leases += 1;
    try {
      const channel = await this.awaitChannel(entry);
      this.client.sendChannelMessage(channel.channelId, { type: "input", payload: data });
      return {
        target: entry.session.name,
        channelId: channel.channelId,
        source: "v1-mux",
        deliveredAt: nowIso(),
      };
    } finally {
      entry.leases -= 1;
      this.maybeCloseTarget(entry);
    }
  }

  onClose(listener) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onChannelCloseFailure(listener) {
    this.channelCloseFailureListeners.add(listener);
    return () => this.channelCloseFailureListeners.delete(listener);
  }

  retryLateOpenClose(channelId) {
    if (typeof channelId !== "string" || channelId.length === 0) {
      return false;
    }
    if (!this.pendingLateOpenCloses.has(channelId)) {
      return false;
    }
    const released = this.client.retryLateOpenClose(channelId) === true;
    if (released) {
      this.pendingLateOpenCloses.delete(channelId);
    }
    return released;
  }

  async close() {
    for (const entry of Array.from(this.targets.values())) {
      if (!entry) {
        continue;
      }
      entry.closed = true;
      entry.openCancelled = !entry.channel;
      if (entry.unsubscribe) {
        entry.unsubscribe();
      }
      if (entry.channel) {
        this.client.closeChannel(entry.channel.channelId, "v2 daemon closing");
      } else if (entry.channelId) {
        try {
          this.client.cancelOpenChannel(entry.channelId);
        } catch {}
      }
    }
    this.targets.clear();
    this.client.close();
  }
}
