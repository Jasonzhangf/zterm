import assert from "node:assert/strict";
import { test } from "node:test";
import { createV1MuxClient } from "../src/v1-mux-client.mjs";
import { TerminalPort } from "../src/terminal-port.mjs";

const OPEN = 1;

class FakeWebSocket {
  constructor(url, { sessions = ["target"], autoOpen = true } = {}) {
    this.url = url;
    this.sessions = sessions;
    this.autoOpen = autoOpen;
    this.readyState = 0;
    this.sent = [];
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
    if (frame.type === "mux-hello") {
      queueMicrotask(() => this.emit({ type: "mux-ready", payload: { version: 1 } }));
    } else if (frame.type === "mux-channel-open" && this.autoOpen) {
      queueMicrotask(() => this.emit({
        type: "mux-channel-opened",
        payload: {
          channelId: frame.payload.channelId,
          sessionName: frame.payload.sessionName,
          stableId: `tmux:v1:${frame.payload.sessionName}`,
        },
      }));
    } else if (frame.type === "mux-target-message") {
      const requestId = frame.payload && frame.payload.requestId;
      queueMicrotask(() => this.emit({
        type: "mux-target-message",
        payload: {
          requestId,
          message: {
            type: "sessions",
            payload: {
              sessions: this.sessions,
              sessionCatalog: this.sessions.map((name) => ({
                name,
                backend: "tmux",
                stableId: `tmux:v1:${name}`,
              })),
            },
          },
        },
      }));
    }
  }

  emit(frame) {
    if (this.readyState === OPEN && this.onmessage) {
      this.onmessage({ data: JSON.stringify(frame) });
    }
  }

  close(code = 1000) {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    if (this.onclose) {
      this.onclose({ code });
    }
  }
}

function makePort(options = {}) {
  const ws = new FakeWebSocket("ws://test", options.fake || {});
  function BoundSocket() {
    return ws;
  }
  BoundSocket.OPEN = OPEN;
  const client = createV1MuxClient({
    wsUrl: ws.url,
    WebSocketImpl: BoundSocket,
    requestTimeoutMs: 100,
    handshakeTimeoutMs: 100,
    log: () => {},
  });
  const port = new TerminalPort({ muxClient: client, log: () => {} });
  return { ws, client, port };
}

async function subscribeToOpenChannel(port, target) {
  const errors = [];
  const subscription = await port.subscribe(target, {
    onFrame: () => {},
    onError: (error) => errors.push(error),
  });
  await subscription.ready;
  return { subscription, errors };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("physical V1 transport close delivers one typed TRANSPORT_CLOSED to an active subscriber", async (t) => {
  const { ws, client, port } = makePort();
  t.after(() => client.close());
  await client.connect();
  const { subscription, errors } = await subscribeToOpenChannel(port, "target");
  t.after(() => subscription.close());

  ws.close();
  await flush();

  assert.equal(errors.length, 1, "an active subscriber must receive exactly one terminal error");
  assert.equal(errors[0].code, "TRANSPORT_CLOSED");
  assert.equal(errors[0].owningModule, "terminal");
  assert.notEqual(errors[0].code, "TERMINAL_CHANNEL_CLOSED");
});

test("ordinary peer mux-channel-closed stays TERMINAL_CHANNEL_CLOSED and is not remapped", async (t) => {
  const { ws, client, port } = makePort({ fake: { sessions: ["peer"] } });
  t.after(() => client.close());
  await client.connect();
  const { subscription, errors } = await subscribeToOpenChannel(port, "peer");
  t.after(() => subscription.close());

  const entry = port.targets.get("tmux:v1:peer");
  ws.emit({
    type: "mux-channel-closed",
    payload: { channelId: entry.channel.channelId, reason: "session ended" },
  });
  await flush();

  assert.equal(errors.length, 1, "a peer channel close notifies the subscriber exactly once");
  assert.equal(errors[0].code, "TERMINAL_CHANNEL_CLOSED");
  assert.notEqual(errors[0].code, "TRANSPORT_CLOSED");
});

test("transport close before the channel opens notifies a pending subscriber once", async (t) => {
  const { ws, client, port } = makePort({ fake: { sessions: ["pending"], autoOpen: false } });
  t.after(() => client.close());
  await client.connect();

  const errors = [];
  const subscription = await port.subscribe("pending", {
    onFrame: () => {},
    onError: (error) => errors.push(error),
  });
  subscription.ready.catch(() => {});

  ws.close();
  await flush();

  assert.equal(errors.length, 1, "a pending subscriber must receive exactly one terminal error");
  assert.equal(errors[0].code, "TRANSPORT_CLOSED");
});
