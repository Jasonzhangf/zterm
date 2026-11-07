import assert from "node:assert/strict";
import { test } from "node:test";
import { createV1MuxClient } from "../src/v1-mux-client.mjs";

const OPEN = 1;

class FakeWebSocket {
  constructor(url, { openDelayMs = 0, handshakeDelayMs = 0 } = {}) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.failSend = null;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this._settled = false;
    this.openDelayMs = openDelayMs;
    this.handshakeDelayMs = handshakeDelayMs;
    queueMicrotask(() => {
      if (!this._settled) {
        this._settled = true;
        this.readyState = OPEN;
        if (this.onopen) {
          this.onopen();
        }
      }
    });
  }

  send(data) {
    if (this.readyState !== OPEN) {
      throw new TypeError("WebSocket is not open");
    }
    const frame = JSON.parse(data);
    this.sent.push(frame);
    if (this.failSend) {
      const error = this.failSend;
      this.failSend = null;
      throw error;
    }
    if (frame.type === "mux-hello") {
      const emitReady = () => this.emit({ type: "mux-ready", payload: { version: 1 } });
      if (this.handshakeDelayMs > 0) {
        setTimeout(emitReady, this.handshakeDelayMs);
      } else {
        queueMicrotask(emitReady);
      }
    } else if (frame.type === "mux-channel-open" && this.openDelayMs >= 0) {
      setTimeout(() => {
        this.emit({
          type: "mux-channel-opened",
          payload: {
            channelId: frame.payload.channelId,
            sessionName: frame.payload.sessionName,
            stableId: `tmux:v1:${frame.payload.channelId}`,
          },
        });
      }, this.openDelayMs);
    }
  }

  emit(frame) {
    if (this.readyState === OPEN && this.onmessage) {
      this.onmessage({ data: JSON.stringify(frame) });
    }
  }

  close(code = 1000) {
    this.readyState = 3;
    if (this.onclose) {
      this.onclose({ code });
    }
  }

  fail(code = 1006) {
    this.readyState = 3;
    if (this.onerror) {
      this.onerror({ code });
    }
    if (this.onclose) {
      this.onclose({ code });
    }
  }
}

function makeClient(options = {}) {
  const ws = new FakeWebSocket("ws://test", options.fake || {});
  function BoundSocket() {
    return ws;
  }
  BoundSocket.OPEN = OPEN;
  const client = createV1MuxClient({
    wsUrl: ws.url,
    WebSocketImpl: BoundSocket,
    requestTimeoutMs: options.requestTimeoutMs ?? 30,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? 50,
    log: () => {},
  });
  return { ws, client };
}

function makeSequencedClient(socketFactory, options = {}) {
  function BoundSocket() {
    return socketFactory();
  }
  BoundSocket.OPEN = OPEN;
  const client = createV1MuxClient({
    wsUrl: "ws://test",
    WebSocketImpl: BoundSocket,
    requestTimeoutMs: options.requestTimeoutMs ?? 30,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? 50,
    log: () => {},
  });
  return { client };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openChannel(client, ws, sessionName = "s", options = {}) {
  const promise = client.openChannel({
    sessionName,
    backend: "tmux",
    bodySubscribed: true,
    ...options,
  });
  const frame = ws.sent[ws.sent.length - 1];
  assert.equal(frame.type, "mux-channel-open", "open frame must be sent");
  return {
    promise,
    channelId: frame.payload.channelId,
    frame,
  };
}

test("default bounded open still rejects on timeout and releases via late close", async (t) => {
  const { ws, client } = makeClient({ requestTimeoutMs: 20, fake: { openDelayMs: -1 } });
  t.after(() => client.close());
  await client.connect();

  const { promise, channelId } = openChannel(client, ws, "bounded");
  await assert.rejects(
    promise,
    (error) => error && error.code === "V1_CHANNEL_OPEN_TIMEOUT" && error.channelId === channelId,
    "bounded timeout must reject the original operation",
  );

  ws.emit({
    type: "mux-channel-opened",
    payload: { channelId, sessionName: "late", stableId: "tmux:v1:late" },
  });
  await sleep(0);

  const closeFrames = ws.sent.filter(
    (frame) => frame.type === "mux-channel-close" && frame.payload.channelId === channelId,
  );
  assert.equal(closeFrames.length, 1, "late bounded open must be released by close");
  assert.equal(client.getState(), "ready", "transport must remain ready");

  ws.openDelayMs = 0;
  const { promise: otherPromise, channelId: otherChannelId } = openChannel(client, ws, "other");
  assert.notEqual(otherChannelId, channelId);
  const otherChannel = await otherPromise;
  assert.equal(otherChannel.channelId, otherChannelId);
});

test("persistent open wait boundary does not reject or send late close", async (t) => {
  const { ws, client } = makeClient({
    requestTimeoutMs: 20,
    handshakeTimeoutMs: 50,
    fake: { openDelayMs: -1 },
  });
  t.after(() => client.close());
  await client.connect();

  let boundarySeen = false;
  client.onOpenStatus((error) => {
    if (error && error.code === "V1_OPEN_WAIT_BOUNDARY_REACHED") {
      boundarySeen = true;
    }
  });

  const { promise, channelId } = openChannel(client, ws, "persistent", {
    waitMode: "persistent",
  });
  promise.catch(() => {});

  await sleep(60);
  assert.equal(boundarySeen, true, "wait boundary must be reported");
  assert.equal(
    ws.sent.filter(
      (frame) => frame.type === "mux-channel-close" && frame.payload.channelId === channelId,
    ).length,
    0,
    "persistent boundary must not close the channel",
  );
  assert.equal(client.getState(), "ready", "transport must remain ready");

  let settled = null;
  promise.then(() => { settled = "resolved"; }).catch(() => { settled = "rejected"; });
  await sleep(20);
  assert.equal(settled, null, "open promise must remain pending after boundary");

  ws.emit({
    type: "mux-channel-opened",
    payload: { channelId, sessionName: "persistent", stableId: "tmux:v1:persistent" },
  });
  const channel = await promise;
  assert.equal(channel.channelId, channelId, "delayed legal open still belongs to original operation");
});

test("persistent open can be cancelled by user and late open is ignored", async (t) => {
  const { ws, client } = makeClient({
    requestTimeoutMs: 200,
    handshakeTimeoutMs: 50,
    fake: { openDelayMs: -1 },
  });
  t.after(() => client.close());
  await client.connect();

  const { promise, channelId } = openChannel(client, ws, "cancelable", {
    waitMode: "persistent",
  });
  promise.catch(() => {});

  await sleep(60);
  const cancelled = client.cancelOpenChannel(channelId);
  assert.equal(cancelled, true, "cancel must accept the pending open identity");

  await assert.rejects(
    promise,
    (error) => error && error.code === "V1_CHANNEL_OPEN_CANCELLED" && error.channelId === channelId,
    "cancelled open must reject with typed cancel error",
  );

  const cancelCloseFrames = ws.sent.filter(
    (frame) => frame.type === "mux-channel-close" && frame.payload.channelId === channelId,
  );
  assert.equal(cancelCloseFrames.length, 1, "explicit cancel must release the channel on wire");

  ws.emit({
    type: "mux-channel-opened",
    payload: { channelId, sessionName: "late-after-cancel", stableId: "tmux:v1:stale" },
  });
  await sleep(0);
  assert.throws(
    () => client.subscribeChannel(channelId, () => {}),
    (error) => error && error.code === "V1_CHANNEL_CLOSED",
    "late open after cancel must not resurrect the channel",
  );

  ws.openDelayMs = 0;
  const { promise: otherPromise, channelId: otherChannelId } = openChannel(client, ws, "other");
  assert.notEqual(otherChannelId, channelId);
  const received = [];
  const otherChannel = await otherPromise;
  client.subscribeChannel(otherChannelId, (message) => received.push(message));
  ws.emit({
    type: "mux-channel-message",
    payload: { channelId: otherChannelId, message: { type: "buffer-head", payload: {} } },
  });
  await sleep(0);
  assert.equal(received.length, 1, "other channel must be unaffected");
});

test("real socket failure rejects persistent open without faking success", async (t) => {
  const { ws, client } = makeClient({
    requestTimeoutMs: 1000,
    handshakeTimeoutMs: 50,
    fake: { openDelayMs: -1 },
  });
  t.after(() => client.close());
  await client.connect();

  const { promise } = openChannel(client, ws, "failing", {
    waitMode: "persistent",
  });
  promise.catch(() => {});

  ws.close();
  await assert.rejects(
    promise,
    (error) => error && error.code === "TRANSPORT_CLOSED",
    "real socket failure must reject the pending open",
  );
  assert.equal(client.getState(), "failed", "socket failure must enter terminal transport state");
});

test("stale late open/close/message do not resurrect a closed channel or affect new channel", async (t) => {
  const { ws, client } = makeClient({ requestTimeoutMs: 1000, handshakeTimeoutMs: 50 });
  t.after(() => client.close());
  await client.connect();

  const firstChannel = await openChannel(client, ws, "first").promise;
  const secondChannel = await openChannel(client, ws, "second").promise;
  const received = [];
  client.subscribeChannel(secondChannel.channelId, (message) => received.push(message));

  await client.closeChannel(firstChannel.channelId);
  ws.emit({
    type: "mux-channel-closed",
    payload: { channelId: firstChannel.channelId, reason: "closed" },
  });
  ws.emit({
    type: "mux-channel-message",
    payload: { channelId: secondChannel.channelId, message: { type: "buffer-head", payload: {} } },
  });
  await sleep(0);
  assert.equal(received.length, 1, "closing one channel must not affect another channel");

  ws.emit({
    type: "mux-channel-opened",
    payload: { channelId: firstChannel.channelId, sessionName: "stale", stableId: "tmux:v1:stale" },
  });
  await sleep(0);
  assert.throws(
    () => client.subscribeChannel(firstChannel.channelId, () => {}),
    (error) => error && error.code === "V1_CHANNEL_CLOSED",
    "stale late open must not resurrect a closed channel",
  );

  ws.emit({
    type: "mux-channel-closed",
    payload: { channelId: 9999, reason: "stale" },
  });
  await sleep(0);

  ws.emit({
    type: "mux-channel-message",
    payload: { channelId: firstChannel.channelId, message: { type: "buffer-head", payload: { stale: true } } },
  });
  await sleep(0);
  assert.equal(received.length, 1, "stale message for closed channel must not reach the other channel");
});

test("late callbacks from an old socket cannot shutdown or mutate a new socket generation", async (t) => {
  let socketCount = 0;
  let firstWs = null;
  let secondWs = null;
  const { client } = makeSequencedClient(
    () => {
      socketCount += 1;
      if (socketCount === 1) {
        firstWs = new FakeWebSocket("ws://test", { openDelayMs: -1 });
        return firstWs;
      }
      secondWs = new FakeWebSocket("ws://test");
      return secondWs;
    },
    { requestTimeoutMs: 1000, handshakeTimeoutMs: 50 },
  );
  t.after(() => client.close());

  await client.connect();
  const oldOpen = openChannel(client, firstWs, "old", { waitMode: "persistent" });
  oldOpen.promise.catch(() => {});
  firstWs.close();
  await assert.rejects(
    oldOpen.promise,
    (error) => error && error.code === "TRANSPORT_CLOSED",
  );
  assert.equal(client.getState(), "failed");

  await client.connect();
  assert.equal(client.getState(), "ready");
  const newChannel = await openChannel(client, secondWs, "new").promise;
  const received = [];
  client.subscribeChannel(newChannel.channelId, (message) => received.push(message));

  firstWs.readyState = OPEN;
  firstWs.onmessage({
    data: JSON.stringify({
      type: "mux-channel-closed",
      payload: { channelId: newChannel.channelId, reason: "stale old socket" },
    }),
  });
  await sleep(0);
  assert.equal(client.getState(), "ready", "stale close frame must not shutdown the new socket");
  assert.equal(received.length, 0, "stale close frame must not notify the new channel listener");

  secondWs.emit({
    type: "mux-channel-message",
    payload: { channelId: newChannel.channelId, message: { type: "buffer-head", payload: {} } },
  });
  await sleep(0);
  assert.equal(received.length, 1, "new channel must remain usable");

  firstWs.onclose({ code: 1006 });
  await sleep(0);
  assert.equal(client.getState(), "ready", "late old socket close must not shutdown the new socket");
});
