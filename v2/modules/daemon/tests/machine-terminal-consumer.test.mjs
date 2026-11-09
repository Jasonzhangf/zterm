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
} = {}) {
  const calls = { connect: 0, listSessions: 0, closeOwnLink: 0 };
  const manager = {
    calls,
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
    async listSessions(link) {
      calls.listSessions += 1;
      return catalog.map((entry) => ({ ...entry }));
    },
    closeOwnLink() {
      calls.closeOwnLink += 1;
    },
  };
  return manager;
}

function createStubTerminal() {
  const calls = { input: [], subscribe: [] };
  const terminal = {
    calls,
    async input(target, data) {
      calls.input.push({ target, data });
      return { accepted: true, target };
    },
    subscribe(target, listener, options) {
      calls.subscribe.push({ target, listener, options });
      return {
        ready: Promise.resolve(),
        close() {},
      };
    },
  };
  return terminal;
}

test("forMachine projects the verified connections link and exact catalog", async () => {
  const manager = createStubManager();
  const terminal = createStubTerminal();
  const consumer = createConnectionMachineTerminal({ connectionManager: manager, terminal });
  const scoped = await consumer.forMachine({ machineId: "mac-1", memberId: "m-1", bindingGeneration: 3 });
  assert.equal(scoped.machineId, "mac-1");
  assert.equal(scoped.status, "connected");
  assert.equal(scoped.freshness, "fresh");
  assert.equal(scoped.peerIdentityVerified, true);
  assert.equal(scoped.daemonHostId, "daemon-host-x");
  assert.equal(scoped.linkGeneration, 7);
  assert.deepEqual(scoped.listSessions().map((entry) => entry.stableId), ["tmux:v1:alpha", "tmux:v1:beta"]);
});

test("factory rejects a manager or terminal that lacks the required public edges", () => {
  assert.throws(
    () => createConnectionMachineTerminal({ connectionManager: {}, terminal: createStubTerminal() }),
    /connections manager/,
  );
  assert.throws(
    () => createConnectionMachineTerminal({ connectionManager: createStubManager(), terminal: {} }),
    /terminal port/,
  );
  assert.throws(
    () => createConnectionMachineTerminal({
      connectionManager: createStubManager(),
      authorizationPort: {},
      terminal: createStubTerminal(),
    }),
    /authorization port/,
  );
});

test("forMachine checks machine authorization before terminal access", async () => {
  const calls = [];
  const manager = createStubManager();
  const terminal = createStubTerminal();
  const authorizationPort = {
    async authorizeMachine(machineId) {
      calls.push(machineId);
    },
  };
  const consumer = createConnectionMachineTerminal({ connectionManager: manager, authorizationPort, terminal });
  await consumer.forMachine({ machineId: "mac-1" });
  assert.deepEqual(calls, ["mac-1"]);
  assert.equal(manager.calls.connect, 1);
  assert.equal(terminal.calls.input.length, 0);
});

test("forMachine surfaces accounts-owned authorization refusal without terminal side effects", async () => {
  const manager = createStubManager();
  const terminal = createStubTerminal();
  const authorizationPort = {
    async authorizeMachine() {
      throw Object.assign(new Error("machine revoked"), { code: "MACHINE_REVOKED" });
    },
  };
  const consumer = createConnectionMachineTerminal({ connectionManager: manager, authorizationPort, terminal });
  await assert.rejects(
    () => consumer.forMachine({ machineId: "mac-1" }),
    (error) => {
      assert.equal(error.code, "MACHINE_REVOKED");
      assert.equal(error.owningModule, "accounts");
      return true;
    },
  );
  assert.equal(manager.calls.connect, 0);
  assert.equal(terminal.calls.input.length, 0);
});

test("forMachine rejects an unverified peer identity and closes the link", async () => {
  const manager = createStubManager({ peerIdentityVerified: false, peerIdentity: null });
  const consumer = createConnectionMachineTerminal({ connectionManager: manager, terminal: createStubTerminal() });
  await assert.rejects(
    () => consumer.forMachine({ machineId: "mac-1" }),
    (error) => error.code === "peer_identity_mismatch",
  );
  assert.equal(manager.calls.closeOwnLink, 1);
});

test("input maps stableId to the terminal public input edge", async () => {
  const manager = createStubManager();
  const terminal = createStubTerminal();
  const consumer = createConnectionMachineTerminal({ connectionManager: manager, terminal });
  const scoped = await consumer.forMachine({ machineId: "mac-1" });
  await scoped.input("tmux:v1:alpha", "echo HI\r");
  assert.deepEqual(terminal.calls.input, [{ target: "tmux:v1:alpha", data: "echo HI\r" }]);
});

test("input rejects a stableId that is not in the current catalog", async () => {
  const manager = createStubManager();
  const terminal = createStubTerminal();
  const consumer = createConnectionMachineTerminal({ connectionManager: manager, terminal });
  const scoped = await consumer.forMachine({ machineId: "mac-1" });
  await assert.rejects(
    () => scoped.input("tmux:v1:missing", "x"),
    (error) => error.code === "TARGET_NOT_FOUND",
  );
  assert.equal(terminal.calls.input.length, 0);
});

test("subscribe delegates to the terminal public stream edge", async () => {
  const manager = createStubManager();
  const terminal = createStubTerminal();
  const listener = () => {};
  const consumer = createConnectionMachineTerminal({ connectionManager: manager, terminal });
  const scoped = await consumer.forMachine({ machineId: "mac-1" });
  const subscription = scoped.subscribe("tmux:v1:beta", listener, { onError: () => {} });
  assert.equal(terminal.calls.subscribe.length, 1);
  assert.deepEqual(terminal.calls.subscribe[0].target, "tmux:v1:beta");
  assert.equal(terminal.calls.subscribe[0].listener, listener);
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
        generation: link.generation,
        status: "connected",
        freshness: "fresh",
        peerIdentityVerified: true,
        peerIdentity: "daemon-host-x",
      };
    },
    async listSessions(link) {
      return catalogs.get(link.machineId) ?? [];
    },
    closeOwnLink() {},
  };
  const consumer = createConnectionMachineTerminal({ connectionManager: manager, terminal: createStubTerminal() });
  const first = await consumer.forMachine({ machineId: "mac-a" });
  const second = await consumer.forMachine({ machineId: "mac-b" });
  await consumer.forMachine({ machineId: "mac-a" });
  assert.deepEqual(first.listSessions().map((entry) => entry.stableId), ["tmux:v1:alpha"]);
  assert.deepEqual(second.listSessions().map((entry) => entry.stableId), ["tmux:v1:beta"]);
  assert.equal(connects.filter((entry) => entry === "mac-a").length, 1);
});
