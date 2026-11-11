import assert from "node:assert/strict";
import { test } from "node:test";
import { createConnectionManager } from "../../connections/src/public/link-port.ts";
import { createTerminalMuxClient } from "../../connections/src/public/terminal-mux-client.ts";
import { TerminalPort } from "../src/terminal-port.mjs";

function authFor(machineId) {
  return {
    machineId,
    daemonHostId: `daemon-${machineId}`,
    accountId: "account-1",
    authorizationId: "auth-1",
    capabilities: { channelKinds: ["terminal"], transportKind: "ws" },
    target: {
      bridgeHost: "127.0.0.1",
      bridgePort: 47001,
      daemonHostId: `daemon-${machineId}`,
      relayHostId: `daemon-${machineId}`,
      relayEndpointCandidates: [],
      transportMode: "websocket",
    },
    settings: { transportMode: "websocket" },
  };
}

function fakeTransport() {
  const state = {
    sent: [],
    opened: [],
    channelMessageHandlers: new Set(),
    channelCloseHandlers: new Set(),
  };
  const handle = {
    path: "direct",
    transportKind: "ws-direct",
    peerIdentity: "daemon-machine-a",
    peerIdentityVerified: true,
    peerChannelKinds: ["terminal"],
    bufferedBytes: 0,
    listSessions: async () => [
      { name: "session-1", backend: "tmux", stableId: "stable-1" },
    ],
    openChannel: async (request) => {
      state.opened.push(request);
      return { sessionName: request.target?.sessionName };
    },
    sendChannel: (channelId, data) => {
      state.sent.push({ channelId, data });
    },
    closeChannel: () => undefined,
    close: () => undefined,
    onChannelMessage: (handler) => {
      state.channelMessageHandlers.add(handler);
      return () => state.channelMessageHandlers.delete(handler);
    },
    onClose: () => undefined,
    onChannelClosed: (handler) => {
      state.channelCloseHandlers.add(handler);
      return () => state.channelCloseHandlers.delete(handler);
    },
    onChannelCloseFailure: () => () => undefined,
    retryLateOpenClose: () => undefined,
  };
  return {
    handle,
    state,
    emitChannelClosed(channelId, info) {
      for (const handler of [...state.channelCloseHandlers]) handler(channelId, info);
    },
    emitChannelMessage(channelId, message) {
      const data = JSON.stringify(message);
      for (const handler of [...state.channelMessageHandlers]) handler(channelId, data);
    },
  };
}

test("TerminalPort consumes a connections LinkRef adapter without a second physical link", async (t) => {
  const fake = fakeTransport();
  const manager = createConnectionManager({
    authorizationPort: { authorizeMachine: async () => authFor("machine-a") },
    transport: { open: async () => fake.handle },
  });
  const link = await manager.connect("machine-a", undefined, authFor("machine-a"));
  const muxClient = createTerminalMuxClient({ connectionManager: manager, link });
  const terminal = new TerminalPort({ muxClient, log: () => {} });
  t.after(() => terminal.close());

  const sessions = await terminal.listSessions();
  assert.deepEqual(sessions.map((session) => session.name), ["session-1"]);

  const frames = [];
  const errors = [];
  const subscription = await terminal.subscribe("session-1", {
    onFrame: (frame) => frames.push(frame),
    onError: (error) => errors.push(error),
  });
  t.after(() => subscription.close());
  await subscription.ready;

  const openedChannelId = fake.state.opened[0].channelId;
  fake.emitChannelMessage(openedChannelId, {
    type: "buffer-sync",
    payload: {
      revision: 1,
      startIndex: 0,
      endIndex: 1,
      frameStartIndex: 0,
      frameEndIndex: 1,
      frameChunkIndex: 0,
      frameChunkCount: 1,
      cols: 1,
      rows: 1,
      generatedAt: 1,
      lines: [{
        index: 0,
        cells: [{ char: "A", fg: 0, bg: 0, flags: 0, width: 1 }],
      }],
    },
  });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].revision, 1);
  assert.equal(frames[0].lines[0].cells[0].char, "A");

  await terminal.input("session-1", "printf CONNECTIONS_MUX_OK\r\n");
  assert.equal(fake.state.opened.length, 1);
  assert.equal(fake.state.sent.length, 2);
  assert.deepEqual(JSON.parse(fake.state.sent[0].data), {
    type: "buffer-head-request",
  });
  assert.deepEqual(JSON.parse(fake.state.sent[1].data), {
    type: "input",
    payload: "printf CONNECTIONS_MUX_OK\r\n",
  });

  fake.emitChannelClosed(openedChannelId, {
    reason: "session ended",
    code: "remote_closed",
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "TERMINAL_CHANNEL_CLOSED");
});
