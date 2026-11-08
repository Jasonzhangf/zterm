import assert from "node:assert/strict";
import { test } from "node:test";

import { createConnectionMachineTerminal } from "../src/machine-terminal-consumer.mjs";

const CATALOG = [
  { name: "alpha", backend: "tmux", stableId: "tmux:v1:alpha" },
  { name: "beta", backend: "tmux", stableId: "tmux:v1:beta" },
];

function createStubManager({
  status = "connected",
  freshness = "fresh",
  peerIdentityVerified = true,
  peerIdentity = "daemon-host-x",
  generation = 7,
  catalog = CATALOG,
  withListSessions = true,
} = {}) {
  const calls = { connect: 0, openChannel: [], sendChannel: [], closeChannel: [], onChannelMessage: 0, closeOwnLink: 0 };
  const channelHandlers = new Map();
  let seq = 0;
  const manager = {
    calls,
    emit(channelId, message) {
      const handlers = channelHandlers.get(channelId);
      assert.ok(handlers, `channel ${channelId} has no message handler`);
      for (const handler of handlers) {
        handler({
          kind: "terminal",
          channelId,
          linkId: "link-1",
          data: JSON.stringify(message),
        });
      }
    },
    async connect(machineId) {
      calls.connect += 1;
      return { id: "link-1", machineId, generation };
    },
    observeLink(link) {
      return {
        machineId: link.machineId,
        generation: link.generation,
        status,
        freshness,
        peerIdentityVerified,
        peerIdentity,
      };
    },
    async openChannel(link, kind, target) {
      calls.openChannel.push({ linkId: link.id, kind, target });
      seq += 1;
      return { id: `ch-${seq}`, linkId: link.id, kind, sessionName: target.sessionName };
    },
    sendChannel(channel, data) {
      calls.sendChannel.push({ channelId: channel.id, data });
    },
    onChannelMessage(channel, handler) {
      calls.onChannelMessage += 1;
      const handlers = channelHandlers.get(channel.id) ?? new Set();
      handlers.add(handler);
      channelHandlers.set(channel.id, handlers);
      return () => {
        handlers.delete(handler);
      };
    },
    closeChannel(channel) {
      calls.closeChannel.push(channel.id);
    },
    closeOwnLink() {
      calls.closeOwnLink += 1;
    },
  };
  if (withListSessions) {
    manager.listSessions = async () => catalog.map((entry) => ({ ...entry }));
  }
  return manager;
}

test("forMachine projects the verified connections link", async () => {
  const manager = createStubManager();
  const consumer = createConnectionMachineTerminal({ connectionManager: manager });
  const scoped = await consumer.forMachine({ machineId: "mac-1", memberId: "m-1", bindingGeneration: 3 });
  assert.equal(scoped.machineId, "mac-1");
  assert.equal(scoped.status, "connected");
  assert.equal(scoped.freshness, "fresh");
  assert.equal(scoped.peerIdentityVerified, true);
  assert.equal(scoped.daemonHostId, "daemon-host-x");
  assert.equal(scoped.linkGeneration, 7);
  assert.deepEqual(scoped.listSessions().map((entry) => entry.stableId), ["tmux:v1:alpha", "tmux:v1:beta"]);
});

test("forMachine fails closed when the connections catalog edge is missing", async () => {
  const manager = createStubManager({ withListSessions: false });
  const consumer = createConnectionMachineTerminal({ connectionManager: manager });
  await assert.rejects(
    () => consumer.forMachine({ machineId: "mac-1" }),
    (error) => error.code === "TERMINAL_ADMISSION_UNAVAILABLE",
  );
});

test("forMachine rejects an unverified peer identity and closes the link", async () => {
  const manager = createStubManager({ peerIdentityVerified: false, peerIdentity: null });
  const consumer = createConnectionMachineTerminal({ connectionManager: manager });
  await assert.rejects(
    () => consumer.forMachine({ machineId: "mac-1" }),
    (error) => error.code === "peer_identity_mismatch",
  );
  assert.equal(manager.calls.closeOwnLink, 1);
});

test("input maps stableId to an exact-existing terminal channel and forwards raw bytes", async () => {
  const manager = createStubManager();
  const consumer = createConnectionMachineTerminal({ connectionManager: manager });
  const scoped = await consumer.forMachine({ machineId: "mac-1" });
  await scoped.input("tmux:v1:alpha", "echo HI\r");
  assert.equal(manager.calls.openChannel.length, 1);
  assert.equal(manager.calls.openChannel[0].kind, "terminal");
  assert.deepEqual(manager.calls.openChannel[0].target, {
    sessionName: "alpha",
    backend: "tmux",
    expectedSessionIdentity: "tmux:v1:alpha",
    existingOnly: true,
    bodySubscribed: true,
  });
  assert.deepEqual(manager.calls.sendChannel, [{ channelId: "ch-1", data: "echo HI\r" }]);
});

test("input rejects a stableId that is not in the current catalog", async () => {
  const manager = createStubManager();
  const consumer = createConnectionMachineTerminal({ connectionManager: manager });
  const scoped = await consumer.forMachine({ machineId: "mac-1" });
  await assert.rejects(
    () => scoped.input("tmux:v1:missing", "x"),
    (error) => error.code === "TARGET_NOT_FOUND",
  );
  assert.equal(manager.calls.openChannel.length, 0);
  assert.equal(manager.calls.sendChannel.length, 0);
});

test("subscribe opens one channel and returns an unsubscribe that closes it", async () => {
  const manager = createStubManager();
  const consumer = createConnectionMachineTerminal({ connectionManager: manager });
  const scoped = await consumer.forMachine({ machineId: "mac-1" });
  const subscription = await scoped.subscribe("tmux:v1:beta", () => {});
  assert.equal(manager.calls.openChannel.length, 1);
  assert.equal(manager.calls.onChannelMessage, 1);
  subscription.close();
  subscription.close();
  assert.equal(manager.calls.closeChannel.length, 1);
});

test("subscribe accepts object listeners and emits committed terminal frames", async () => {
  const manager = createStubManager();
  const consumer = createConnectionMachineTerminal({ connectionManager: manager });
  const scoped = await consumer.forMachine({ machineId: "mac-1" });
  const frames = [];
  const subscription = await scoped.subscribe("tmux:v1:beta", {
    onFrame: (frame, meta) => frames.push({ frame, meta }),
    onError: (error) => {
      throw error;
    },
  });
  manager.emit("ch-1", {
    type: "buffer-sync",
    payload: {
      revision: 1,
      frameStartIndex: 0,
      frameEndIndex: 2,
      frameChunkIndex: 0,
      frameChunkCount: 1,
      startIndex: 0,
      endIndex: 2,
      generatedAt: 1,
      cols: 2,
      rows: 2,
      cursor: { rowIndex: 0, col: 0, visible: true },
      lines: [
        { index: 0, cells: [{ char: 65, fg: 256, bg: 256, flags: 0, width: 1 }] },
        { index: 1, cells: [{ char: 66, fg: 256, bg: 256, flags: 0, width: 1 }] },
      ],
    },
  });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].frame.revision, 1);
  assert.equal(frames[0].meta.target, "beta");
  assert.deepEqual(frames[0].frame.lines.map((line) => line.cells[0].char), [65, 66]);
  subscription.close();
});

test("subscribe emits only after all frame chunks are assembled", async () => {
  const manager = createStubManager();
  const consumer = createConnectionMachineTerminal({ connectionManager: manager });
  const scoped = await consumer.forMachine({ machineId: "mac-1" });
  const frames = [];
  const subscription = await scoped.subscribe("tmux:v1:beta", {
    onFrame: (frame) => frames.push(frame),
    onError: (error) => {
      throw error;
    },
  });
  const base = {
    revision: 2,
    frameStartIndex: 0,
    frameEndIndex: 2,
    frameChunkCount: 2,
    generatedAt: 2,
    cols: 1,
    rows: 2,
    cursor: { rowIndex: 0, col: 0, visible: true },
  };
  manager.emit("ch-1", {
    type: "buffer-sync",
    payload: {
      ...base,
      frameChunkIndex: 0,
      startIndex: 0,
      endIndex: 1,
      lines: [{ index: 0, cells: [{ char: 65, fg: 256, bg: 256, flags: 0, width: 1 }] }],
    },
  });
  assert.equal(frames.length, 0);
  manager.emit("ch-1", {
    type: "buffer-sync",
    payload: {
      ...base,
      frameChunkIndex: 1,
      startIndex: 1,
      endIndex: 2,
      lines: [{ index: 1, cells: [{ char: 66, fg: 256, bg: 256, flags: 0, width: 1 }] }],
    },
  });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].revision, 2);
  assert.deepEqual(frames[0].lines.map((line) => line.cells[0].char), [65, 66]);
  subscription.close();
});

test("forMachine reuses one link per machine and keeps catalogs machine-scoped", async () => {
  const connects = [];
  const catalogs = new Map([
    ["mac-a", [{ name: "alpha", backend: "tmux", stableId: "tmux:v1:alpha" }]],
    ["mac-b", [{ name: "beta", backend: "tmux", stableId: "tmux:v1:beta" }]],
  ]);
  const manager = {
    async connect(machineId) {
      connects.push(machineId);
      return {
        id: `link:${machineId}`,
        machineId,
        generation: connects.filter((entry) => entry === machineId).length,
      };
    },
    observeLink(link) {
      return {
        machineId: link.machineId,
        status: "connected",
        freshness: "fresh",
        peerIdentityVerified: true,
        peerIdentity: `daemon-${link.machineId}`,
      };
    },
    async listSessions(link) {
      return catalogs.get(link.machineId).map((entry) => ({ ...entry }));
    },
    async openChannel() {
      return { id: "unused" };
    },
    sendChannel() {},
    closeChannel() {},
    onChannelMessage() {
      return () => {};
    },
    closeOwnLink() {},
  };
  const consumer = createConnectionMachineTerminal({ connectionManager: manager });
  const firstA = await consumer.forMachine({ machineId: "mac-a" });
  const secondA = await consumer.forMachine({ machineId: "mac-a" });
  const onlyB = await consumer.forMachine({ machineId: "mac-b" });

  assert.deepEqual(connects, ["mac-a", "mac-b"]);
  assert.equal(firstA.linkGeneration, secondA.linkGeneration);
  assert.deepEqual(firstA.listSessions().map((entry) => entry.name), ["alpha"]);
  assert.deepEqual(onlyB.listSessions().map((entry) => entry.name), ["beta"]);
});
