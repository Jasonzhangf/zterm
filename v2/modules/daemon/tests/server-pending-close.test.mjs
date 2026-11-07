import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { test } from "node:test";
import { createDaemon } from "../src/server.mjs";

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
    for (const entry of terminal.pending) {
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
