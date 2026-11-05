import assert from "node:assert/strict";
import { test } from "node:test";
import { createV1MuxClient } from "../src/v1-mux-client.mjs";

const OPEN = 1;

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.failSend = null;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this._settled = false;
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
      queueMicrotask(() => this.emit({ type: "mux-ready", payload: { version: 1 } }));
    }
  }

  emit(frame) {
    if (this.readyState === OPEN && this.onmessage) {
      this.onmessage({ data: JSON.stringify(frame) });
    }
  }

  close() {
    this.readyState = 3;
    if (this.onclose) {
      this.onclose({ code: 1000 });
    }
  }
}

function makeClient(options = {}) {
  const ws = new FakeWebSocket("ws://test");
  function BoundSocket() {
    return ws;
  }
  BoundSocket.OPEN = OPEN;
  const client = createV1MuxClient({
    wsUrl: ws.url,
    WebSocketImpl: BoundSocket,
    requestTimeoutMs: options.requestTimeoutMs ?? 25,
    log: () => {},
  });
  return { ws, client };
}

async function opened(client, ws, sessionName) {
  const promise = client.openChannel({ sessionName, backend: "tmux", bodySubscribed: true });
  const frame = ws.sent[ws.sent.length - 1];
  assert.equal(frame.type, "mux-channel-open");
  ws.emit({
    type: "mux-channel-opened",
    payload: { channelId: frame.payload.channelId, sessionName, stableId: "tmux:v1:unit" },
  });
  return promise;
}

test("closeChannel rejects an unknown channel with a typed error", () => {
  const { client } = makeClient({ requestTimeoutMs: 1000 });
  assert.throws(
    () => client.closeChannel("missing"),
    (error) => error && error.code === "V1_CHANNEL_CLOSED",
    "unknown channel close must not silently succeed",
  );
});

test("open timeout releases a late mux-channel-opened without affecting the transport", async (t) => {
  const { ws, client } = makeClient({ requestTimeoutMs: 30 });
  t.after(() => client.close());
  await client.connect();
  const pending = client.openChannel({ sessionName: "late", backend: "tmux", bodySubscribed: true });
  const openFrame = ws.sent[ws.sent.length - 1];
  assert.equal(openFrame.type, "mux-channel-open");
  const channelId = openFrame.payload.channelId;

  await assert.rejects(
    pending,
    (error) => error && error.code === "V1_CHANNEL_OPEN_TIMEOUT",
    "timed out open must be rejected",
  );

  ws.emit({
    type: "mux-channel-opened",
    payload: { channelId, sessionName: "late", stableId: "tmux:v1:late" },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const closeFrames = ws.sent.filter(
    (frame) => frame.type === "mux-channel-close" && frame.payload.channelId === channelId,
  );
  assert.equal(closeFrames.length, 1, "late opened channel must be released");
  assert.equal(client.getState(), "ready");
});

test("late opened close failure stays retryable and exposes a typed error", async (t) => {
  const { ws, client } = makeClient({ requestTimeoutMs: 30 });
  t.after(() => client.close());
  await client.connect();
  const errors = [];
  assert.equal(typeof client.onChannelCloseFailure, "function");
  client.onChannelCloseFailure((error) => errors.push(error));

  const pending = client.openChannel({ sessionName: "late-failure", backend: "tmux", bodySubscribed: true });
  const openFrame = ws.sent[ws.sent.length - 1];
  const channelId = openFrame.payload.channelId;
  await assert.rejects(
    pending,
    (error) => error && error.code === "V1_CHANNEL_OPEN_TIMEOUT",
  );

  const other = await opened(client, ws, "other");
  const receivedOther = [];
  client.subscribeChannel(other.channelId, (value) => receivedOther.push(value));

  ws.failSend = new Error("late close write failed");
  ws.emit({
    type: "mux-channel-opened",
    payload: { channelId, sessionName: "late-failure", stableId: "tmux:v1:late-failure" },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "V1_CHANNEL_CLOSE_FAILED");
  assert.equal(errors[0].channelId, channelId, "close failure must carry a structured channelId");
  assert.equal(typeof client.retryLateOpenClose, "function");

  assert.equal(client.retryLateOpenClose(channelId), true);
  const closeAttempts = ws.sent.filter(
    (frame) => frame.type === "mux-channel-close" && frame.payload.channelId === channelId,
  );
  assert.equal(closeAttempts.length, 2);

  ws.emit({
    type: "mux-channel-opened",
    payload: { channelId, sessionName: "late-failure", stableId: "tmux:v1:late-failure" },
  });
  assert.equal(
    ws.sent.filter((frame) => frame.type === "mux-channel-close" && frame.payload.channelId === channelId).length,
    2,
    "a released late-open id must not send another close",
  );

  ws.emit({
    type: "mux-channel-message",
    payload: { channelId: other.channelId, message: { type: "buffer-head", payload: { sessionId: "other" } } },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(receivedOther.length, 1, "the failed late close must not affect another subscriber");
});

test("closeChannel send failure is typed, keeps the record, and does not leak to another subscriber", async (t) => {
  const { ws, client } = makeClient({ requestTimeoutMs: 1000 });
  t.after(() => client.close());
  await client.connect();

  const first = await opened(client, ws, "first");
  const second = await opened(client, ws, "second");
  const receivedFirst = [];
  const receivedSecond = [];
  client.subscribeChannel(first.channelId, (value) => receivedFirst.push(value));
  client.subscribeChannel(second.channelId, (value) => receivedSecond.push(value));

  ws.failSend = new Error("transport write failed");
  assert.throws(
    () => client.closeChannel(first.channelId),
    (error) => error && error.code === "V1_CHANNEL_CLOSE_FAILED",
    "close send failure must be a typed rejection",
  );

  await client.closeChannel(first.channelId);
  assert.equal(ws.sent.filter((frame) => frame.type === "mux-channel-close" && frame.payload.channelId === first.channelId).length, 2);
  assert.equal(receivedFirst.length, 0, "failed close must not notify another subscriber");
  assert.equal(receivedSecond.length, 0);

  ws.emit({
    type: "mux-channel-message",
    payload: { channelId: second.channelId, message: { type: "buffer-head", payload: { sessionId: "s" } } },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(receivedSecond.length, 1);
});
