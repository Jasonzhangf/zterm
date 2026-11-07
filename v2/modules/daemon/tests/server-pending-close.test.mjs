import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { test } from "node:test";
import { createDaemon } from "../src/server.mjs";
import { TerminalPort } from "../../terminal/src/terminal-port.mjs";

const TOKEN = "pending-close-token";
const AUTH = `Bearer ${TOKEN}`;

function createTerminalStub() {
  const pending = [];
  return {
    pending,
    subscribe(target, handlers) {
      let resolve;
      let reject;
      const settled = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const entry = { target, handlers, resolve, reject, closed: 0 };
      pending.push(entry);
      return settled;
    },
  };
}

async function startDaemon(t, terminal) {
  const daemon = createDaemon({
    v1WsUrl: "ws://127.0.0.1:1/ws",
    v2Token: TOKEN,
    webuiDir: "/definitely-missing-webui",
    log: () => {},
    terminalPort: terminal,
  });
  const port = await new Promise((resolve, reject) => {
    daemon.server.once("error", reject);
    daemon.server.listen(0, "127.0.0.1", () => resolve(daemon.server.address().port));
  });
  t.after(() => new Promise((resolve) => {
    for (const entry of terminal.pending || []) {
      entry.resolve(settledSubscription());
    }
    daemon.server.close(resolve);
    daemon.server.closeAllConnections();
  }));
  return port;
}

function openTargetSocket(port, target) {
  const socket = createConnection(port, "127.0.0.1");
  const chunks = [];
  socket.on("data", (chunk) => chunks.push(chunk));
  socket.on("connect", () => {
    socket.write(
      `GET /api/terminal/stream?target=${encodeURIComponent(target)} HTTP/1.1\r\n`
        + `host: 127.0.0.1:${port}\r\n`
        + `authorization: ${AUTH}\r\n`
        + "connection: keep-alive\r\n\r\n",
    );
  });
  return {
    socket,
    text() {
      return Buffer.concat(chunks).toString("utf8");
    },
    close() {
      socket.destroy();
    },
  };
}

async function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for a condition.");
}

function settledSubscription() {
  return { close() { this.closed += 1; }, closed: 0 };
}

function createDeferredFakeMux() {
  const pendingOpens = new Map();
  const channels = new Map();
  const cancelOpenCalls = [];
  const closedChannelIds = [];
  const closeListeners = new Set();
  let nextChannel = 0;
  let lastOpenChannelId = null;

  function openChannel(input) {
    const channelId = `channel-${++nextChannel}`;
    lastOpenChannelId = channelId;
    const channel = {
      channelId,
      sessionName: input.sessionName,
      stableId: input.stableId,
      bodySubscribed: input.bodySubscribed !== false,
      listener: null,
      retainedListener: null,
      closed: false,
    };
    channels.set(channelId, channel);
    const open = new Promise((resolve) => {
      pendingOpens.set(channelId, resolve);
    });
    open.channelId = channelId;
    return open;
  }

  return {
    cancelOpenCalls,
    closedChannelIds,
    get pendingOpenCount() {
      return pendingOpens.size;
    },
    get lastOpenChannelId() {
      return lastOpenChannelId;
    },
    async connect() {},
    async requestTarget() {
      return {
        message: {
          payload: {
            sessions: ["target", "other"],
            sessionCatalog: [
              { name: "target", backend: "tmux", stableId: "tmux:v1:target" },
              { name: "other", backend: "tmux", stableId: "tmux:v1:other" },
            ],
          },
        },
      };
    },
    openChannel,
    resolveOpen(channelId) {
      const resolve = pendingOpens.get(channelId);
      pendingOpens.delete(channelId);
      resolve({ ...channels.get(channelId) });
    },
    cancelOpenChannel(channelId) {
      cancelOpenCalls.push(channelId);
      return pendingOpens.has(channelId);
    },
    subscribeChannel(channelId, listener) {
      const channel = channels.get(channelId);
      channel.listener = listener;
      channel.retainedListener = listener;
      return () => {
        if (channel.listener === listener) {
          channel.listener = null;
        }
      };
    },
    sendChannelMessage(channelId, message) {
      channels.get(channelId)?.sent?.push(message);
    },
    closeChannel(channelId, reason) {
      const channel = channels.get(channelId);
      closedChannelIds.push(channelId);
      if (channel) {
        channel.closed = true;
        channel.closeReason = reason;
      }
    },
    emit(channelId, message) {
      channels.get(channelId)?.listener?.(message);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close() {},
  };
}

test("delayed open + client disconnect cancels once and a late open cannot revive the target", async (t) => {
  const mux = createDeferredFakeMux();
  const terminal = new TerminalPort({ muxClient: mux });
  const port = await startDaemon(t, terminal);

  const client = openTargetSocket(port, "target");
  t.after(() => client.close());

  await waitFor(() => mux.pendingOpenCount >= 1);
  const channelId = mux.lastOpenChannelId;
  client.close();

  await waitFor(() => mux.cancelOpenCalls.length === 1);
  assert.deepEqual(mux.cancelOpenCalls, [channelId]);
  assert.doesNotMatch(client.text(), /event: ready/u);

  mux.resolveOpen(channelId);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(mux.cancelOpenCalls.length, 1, "the late open must not trigger a second cancel");
  assert.equal(mux.closedChannelIds.includes(channelId), true, "the late channel must be closed");
  assert.doesNotMatch(client.text(), /event: ready/u);

  const nextClient = openTargetSocket(port, "target");
  t.after(() => nextClient.close());
  await waitFor(() => mux.pendingOpenCount === 1 && mux.lastOpenChannelId !== channelId);
  const nextChannelId = mux.lastOpenChannelId;
  assert.notEqual(nextChannelId, channelId);

  mux.resolveOpen(nextChannelId);
  await waitFor(() => nextClient.text().includes("event: ready"));
  mux.emit(nextChannelId, {
    type: "buffer-sync",
    payload: {
      revision: 1,
      startIndex: 0,
      endIndex: 1,
      frameStartIndex: 0,
      frameEndIndex: 1,
      frameChunkIndex: 0,
      frameChunkCount: 1,
      cols: 8,
      rows: 1,
      cursor: { rowIndex: 0, col: 0, visible: true },
      lines: [
        {
          index: 0,
          cells: [{ char: "n".codePointAt(0), fg: 256, bg: 256, flags: 0, width: 1 }],
        },
      ],
    },
  });
  await waitFor(() => nextClient.text().includes('"revision":1'));
  assert.equal(mux.cancelOpenCalls.length, 1);
  assert.equal(mux.closedChannelIds.includes(nextChannelId), false);
});

test("one pending HTTP subscriber disconnect keeps the shared open for the other subscriber", async (t) => {
  const mux = createDeferredFakeMux();
  const terminal = new TerminalPort({ muxClient: mux });
  const port = await startDaemon(t, terminal);
  const first = openTargetSocket(port, "target");
  const second = openTargetSocket(port, "target");
  t.after(() => first.close());
  t.after(() => second.close());

  await waitFor(() => mux.pendingOpenCount === 1);
  const entry = terminal.targets.get("tmux:v1:target");
  const channelId = entry.channelId;
  await waitFor(() => entry.subscribers.size === 2);

  first.close();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(mux.cancelOpenCalls, []);
  assert.equal(terminal.targets.get("tmux:v1:target"), entry);
  assert.doesNotMatch(first.text(), /event: ready/u);
  assert.doesNotMatch(second.text(), /event: ready/u);

  mux.resolveOpen(channelId);
  await waitFor(() => second.text().includes("event: ready"));
  mux.emit(channelId, {
    type: "buffer-sync",
    payload: {
      revision: 1,
      startIndex: 0,
      endIndex: 1,
      frameStartIndex: 0,
      frameEndIndex: 1,
      frameChunkIndex: 0,
      frameChunkCount: 1,
      cols: 8,
      rows: 1,
      cursor: { rowIndex: 0, col: 0, visible: true },
      lines: [
        {
          index: 0,
          cells: [{ char: "s".codePointAt(0), fg: 256, bg: 256, flags: 0, width: 1 }],
        },
      ],
    },
  });
  await waitFor(() => second.text().includes('"revision":1'));
  assert.doesNotMatch(first.text(), /event: ready/u, "the disconnected subscriber must stay closed");
  assert.equal(mux.cancelOpenCalls.length, 0, "the shared open must not be cancelled");

  second.close();
  await waitFor(() => mux.closedChannelIds.includes(channelId));
  assert.deepEqual(mux.cancelOpenCalls, []);
  assert.equal(terminal.targets.get("tmux:v1:target"), undefined);
});

test("an established stream closes its subscription exactly once", async (t) => {
  const terminal = createTerminalStub();
  const port = await startDaemon(t, terminal);
  const client = openTargetSocket(port, "normal");
  t.after(() => client.close());

  await waitFor(() => terminal.pending.length === 1);
  const subscription = settledSubscription();
  terminal.pending[0].resolve(subscription);
  await waitFor(() => client.text().includes("event: ready"));
  assert.doesNotMatch(client.text(), /: keepalive/u);

  client.close();
  await waitFor(() => subscription.closed === 1);
  assert.equal(subscription.closed, 1);
});

test("a pending subscription that closes late is closed once without leaking to the shared target", async (t) => {
  const terminal = createTerminalStub();
  const port = await startDaemon(t, terminal);
  const closing = openTargetSocket(port, "shared");
  const staying = openTargetSocket(port, "shared");
  t.after(() => closing.close());
  t.after(() => staying.close());

  await waitFor(() => terminal.pending.length === 2);
  const closedBefore = closing.text();
  closing.close();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const late = settledSubscription();
  terminal.pending[0].resolve(late);
  await waitFor(() => late.closed === 1);
  assert.equal(late.closed, 1);
  assert.doesNotMatch(closing.text(), /event: ready/u);
  assert.doesNotMatch(closing.text(), /: keepalive/u);
  assert.equal(closing.text(), closedBefore, "the closed pending stream must not receive a ready frame");

  const stayingSubscription = settledSubscription();
  terminal.pending[1].resolve(stayingSubscription);
  await waitFor(() => staying.text().includes("event: ready"));
  assert.equal(late.closed, 1, "cancelling one subscriber must not close the other subscriber");

  staying.close();
  await waitFor(() => stayingSubscription.closed === 1);
  assert.equal(stayingSubscription.closed, 1);
});

test("a pending subscription that rejects after client close is contained", async (t) => {
  const terminal = createTerminalStub();
  const port = await startDaemon(t, terminal);
  const client = openTargetSocket(port, "reject");
  t.after(() => client.close());

  await waitFor(() => terminal.pending.length === 1);
  client.close();
  const before = client.text();
  await new Promise((resolve) => setTimeout(resolve, 50));

  terminal.pending[0].reject(new Error("late subscribe failure"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(client.text(), before, "a closed pending stream must not write headers after rejection");
});
