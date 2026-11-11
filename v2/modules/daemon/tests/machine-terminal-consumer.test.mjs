import assert from "node:assert/strict";
import { test } from "node:test";

import { createConnectionMachineTerminal } from "../src/machine-terminal-consumer.mjs";

const CATALOG = [
  { name: "alpha", backend: "tmux", stableId: "tmux:v1:alpha" },
  { name: "beta", backend: "tmux", stableId: "tmux:v1:beta" },
];

function createStubManager({
  generation = 7,
  status = "connected",
  freshness = "fresh",
  peerIdentityVerified = true,
  peerIdentity = "daemon-host-x",
  catalog = () => CATALOG,
  observeStaleAsError = false,
} = {}) {
  const calls = { connect: [], listSessions: 0, closeOwnLink: 0 };
  const links = new Map();
  let currentGeneration = generation;
  let currentStatus = status;
  let currentFreshness = freshness;
  let currentPeerIdentityVerified = peerIdentityVerified;
  let currentPeerIdentity = peerIdentity;

  const manager = {
    calls,
    async connect(machineId, callerToken) {
      calls.connect.push({ machineId, callerToken });
      const link = { id: `link:${machineId}`, machineId, generation: currentGeneration };
      links.set(machineId, link);
      return link;
    },
    observeLink(link) {
      if (observeStaleAsError && link.generation !== currentGeneration) {
        throw Object.assign(new Error(`link ${link.id} generation is stale`), {
          code: "stale_generation",
          owningModule: "connections",
        });
      }
      return {
        machineId: link.machineId,
        generation: currentGeneration,
        status: currentStatus,
        freshness: currentFreshness,
        peerIdentityVerified: currentPeerIdentityVerified,
        peerIdentity: currentPeerIdentity,
      };
    },
    async listSessions(link) {
      calls.listSessions += 1;
      const entries = typeof catalog === "function" ? catalog(link.machineId) : catalog;
      return entries.map((entry) => ({ ...entry }));
    },
    closeOwnLink(link) {
      calls.closeOwnLink += 1;
      const current = links.get(link.machineId);
      if (current === link) {
        links.delete(link.machineId);
      }
    },
    setGeneration(value) {
      currentGeneration = value;
    },
    setStatus(value) {
      currentStatus = value;
    },
    setFreshness(value) {
      currentFreshness = value;
    },
  };
  return manager;
}

function createLocalTerminal() {
  const calls = { listSessions: 0, input: [], subscribe: [], close: 0 };
  return {
    calls,
    async listSessions() {
      calls.listSessions += 1;
      return CATALOG.map((entry) => ({ ...entry }));
    },
    async input(target, data) {
      calls.input.push({ target, data });
      return { target, source: "local" };
    },
    subscribe(target, listener, options) {
      calls.subscribe.push({ target, listener, options });
      return { ready: Promise.resolve(), close() {} };
    },
    close() {
      calls.close += 1;
    },
  };
}

function createRemoteFactories({ catalogs = new Map() } = {}) {
  const muxOptions = [];
  const ports = [];
  return {
    muxOptions,
    ports,
    createMuxClient(options) {
      muxOptions.push(options);
      return {
        link: options.link,
        connectionManager: options.connectionManager,
        log: options.log,
      };
    },
    createTerminalPort(options) {
      const machineId = options.muxClient.link.machineId;
      const calls = { listSessions: 0, input: [], subscribe: [], close: 0 };
      const port = {
        options,
        calls,
        async listSessions() {
          calls.listSessions += 1;
          const entries = catalogs.get(machineId) || CATALOG;
          return entries.map((entry) => ({ ...entry }));
        },
        async input(target, data) {
          calls.input.push({ target, data });
          return { target, source: "mux" };
        },
        subscribe(target, listener, optionsArg) {
          calls.subscribe.push({ target, listener, options: optionsArg });
          return { ready: Promise.resolve(), close() {} };
        },
        close() {
          calls.close += 1;
        },
      };
      ports.push(port);
      return port;
    },
  };
}

test("remote input and subscribe use the machine-bound mux terminal port", async (t) => {
  const manager = createStubManager();
  const local = createLocalTerminal();
  const remote = createRemoteFactories();
  const log = () => {};
  const consumer = createConnectionMachineTerminal({
    connectionManager: manager,
    localMachineId: "local-machine",
    terminal: local,
    createMuxClient: remote.createMuxClient,
    createTerminalPort: remote.createTerminalPort,
    log,
  });
  const scoped = await consumer.forMachine({ machineId: "remote-machine" });
  t.after(() => scoped.close());

  assert.equal(remote.muxOptions.length, 1);
  assert.equal(remote.muxOptions[0].connectionManager, manager);
  assert.deepEqual(remote.muxOptions[0].link, {
    id: "link:remote-machine",
    machineId: "remote-machine",
    generation: 7,
  });
  assert.equal(remote.muxOptions[0].log, log);
  assert.equal(remote.ports.length, 1);
  assert.equal(remote.ports[0].options.muxClient.link.machineId, "remote-machine");
  assert.equal(remote.ports[0].options.muxClient.connectionManager, manager);
  assert.equal(remote.ports[0].options.muxClient.log, log);

  await scoped.input("tmux:v1:alpha", "echo HI\r");
  assert.deepEqual(remote.ports[0].calls.input, [{ target: "tmux:v1:alpha", data: "echo HI\r" }]);
  assert.equal(local.calls.input.length, 0);

  const listener = () => {};
  const subscription = scoped.subscribe("tmux:v1:beta", listener, { onError: () => {} });
  assert.equal(remote.ports[0].calls.subscribe.length, 1);
  assert.equal(remote.ports[0].calls.subscribe[0].target, "tmux:v1:beta");
  assert.equal(remote.ports[0].calls.subscribe[0].listener, listener);
  assert.equal(local.calls.subscribe.length, 0);
  subscription.close();
});

test("local machine keeps the injected local terminal and creates no mux adapter", async (t) => {
  const manager = createStubManager();
  const local = createLocalTerminal();
  const remote = createRemoteFactories();
  const consumer = createConnectionMachineTerminal({
    connectionManager: manager,
    localMachineId: "local-machine",
    terminal: local,
    createMuxClient: remote.createMuxClient,
    createTerminalPort: remote.createTerminalPort,
  });
  const scoped = await consumer.forMachine({ machineId: "local-machine" });

  assert.deepEqual(
    (await scoped.listSessions()).map((entry) => entry.stableId),
    ["tmux:v1:alpha", "tmux:v1:beta"],
  );
  await scoped.input("tmux:v1:alpha", "local input\r");
  assert.deepEqual(local.calls.input, [{ target: "tmux:v1:alpha", data: "local input\r" }]);
  assert.equal(remote.muxOptions.length, 0);
  assert.equal(remote.ports.length, 0);

  scoped.close();
  assert.equal(local.calls.close, 0);
});

test("two machines keep catalogs and terminal ports isolated", async (t) => {
  const catalogs = new Map([
    ["machine-a", [{ name: "same-name", backend: "tmux", stableId: "tmux:v1:alpha" }]],
    ["machine-b", [{ name: "same-name", backend: "tmux", stableId: "tmux:v1:beta" }]],
  ]);
  const manager = createStubManager({ catalog: (machineId) => catalogs.get(machineId) || [] });
  const local = createLocalTerminal();
  const remote = createRemoteFactories({ catalogs });
  const consumer = createConnectionMachineTerminal({
    connectionManager: manager,
    localMachineId: "local-machine",
    terminal: local,
    createMuxClient: remote.createMuxClient,
    createTerminalPort: remote.createTerminalPort,
  });

  const first = await consumer.forMachine({ machineId: "machine-a" });
  const second = await consumer.forMachine({ machineId: "machine-b" });
  t.after(() => first.close());
  t.after(() => second.close());

  assert.deepEqual((await first.listSessions()).map((entry) => entry.stableId), ["tmux:v1:alpha"]);
  assert.deepEqual((await second.listSessions()).map((entry) => entry.stableId), ["tmux:v1:beta"]);
  await first.input("tmux:v1:alpha", "a");
  await second.input("tmux:v1:beta", "b");
  assert.equal(remote.ports[0].calls.input[0].data, "a");
  assert.equal(remote.ports[1].calls.input[0].data, "b");
  assert.equal(remote.ports[0].options.muxClient.link.machineId, "machine-a");
  assert.equal(remote.ports[1].options.muxClient.link.machineId, "machine-b");
});

test("catalog reads are explicit and are not reused as a consumer cache", async (t) => {
  let catalogReads = 0;
  const manager = createStubManager({
    catalog() {
      catalogReads += 1;
      return CATALOG;
    },
  });
  const local = createLocalTerminal();
  const remote = createRemoteFactories();
  const consumer = createConnectionMachineTerminal({
    connectionManager: manager,
    localMachineId: "local-machine",
    terminal: local,
    createMuxClient: remote.createMuxClient,
    createTerminalPort: remote.createTerminalPort,
  });
  const scoped = await consumer.forMachine({ machineId: "machine-a" });
  t.after(() => scoped.close());

  const first = await scoped.listSessions();
  const second = await scoped.listSessions();
  assert.deepEqual(first.map((entry) => entry.stableId), ["tmux:v1:alpha", "tmux:v1:beta"]);
  assert.deepEqual(second.map((entry) => entry.stableId), ["tmux:v1:alpha", "tmux:v1:beta"]);
  assert.equal(manager.calls.listSessions, 1);
  assert.equal(remote.ports[0].calls.listSessions, 2);
});

test("factory requires a local terminal only when localMachineId is configured", () => {
  const manager = createStubManager();
  assert.doesNotThrow(() => createConnectionMachineTerminal({ connectionManager: manager }));
  assert.throws(
    () => createConnectionMachineTerminal({ connectionManager: manager, localMachineId: "local-machine" }),
    /terminal port/,
  );
  assert.throws(
    () => createConnectionMachineTerminal({
      connectionManager: manager,
      localMachineId: "local-machine",
      terminal: {},
    }),
    /terminal port/,
  );
});

test("forMachine checks machine authorization before terminal access", async () => {
  const calls = [];
  const manager = createStubManager();
  const local = createLocalTerminal();
  const authorizationPort = {
    async authorizeCallerMachine(machineId, accountsToken) {
      calls.push({ machineId, accountsToken });
      return { machineId, accountId: "account-current" };
    },
  };
  const consumer = createConnectionMachineTerminal({
    connectionManager: manager,
    authorizationPort,
    localMachineId: "local-machine",
    terminal: local,
    createMuxClient: createRemoteFactories().createMuxClient,
    createTerminalPort: createRemoteFactories().createTerminalPort,
  });
  await consumer.forMachine({
    machineId: "remote-machine",
    accountsToken: "caller-token",
  });
  assert.deepEqual(calls, [
    { machineId: "remote-machine", accountsToken: "caller-token" },
  ]);
  assert.equal(manager.calls.connect.length, 1);
  assert.equal(local.calls.input.length, 0);
});

test("forMachine uses the caller-bound machine authorization and rejects a missing accounts session", async () => {
  const calls = [];
  const manager = createStubManager();
  const consumer = createConnectionMachineTerminal({
    connectionManager: manager,
    authorizationPort: {
      async authorizeCallerMachine(machineId, accountsToken) {
        calls.push({ machineId, accountsToken });
        return { machineId, accountId: "account-current" };
      },
      async authorizeMachine() {
        throw new Error("service authorization must not be used");
      },
    },
  });

  await consumer.forMachine({ machineId: "remote-machine", accountsToken: "caller-token" });
  assert.deepEqual(calls, [
    { machineId: "remote-machine", accountsToken: "caller-token" },
  ]);

  await assert.rejects(
    () => consumer.forMachine({ machineId: "remote-machine" }),
    (error) => {
      assert.equal(error.code, "MACHINE_ACCOUNT_SESSION_REQUIRED");
      assert.equal(error.owningModule, "daemon");
      return true;
    },
  );
});

test("machine terminal state is scoped by the caller accounts session", async () => {
  const manager = createStubManager();
  const remote = createRemoteFactories();
  const consumer = createConnectionMachineTerminal({
    connectionManager: manager,
    authorizationPort: {
      async authorizeCallerMachine(machineId, accountsToken) {
        return {
          machineId,
          accountId: accountsToken === "caller-token-a" ? "account-a" : "account-b",
        };
      },
    },
    createMuxClient: remote.createMuxClient,
    createTerminalPort: remote.createTerminalPort,
  });

  const first = await consumer.forMachine({
    machineId: "remote-machine",
    accountsToken: "caller-token-a",
  });
  const second = await consumer.forMachine({
    machineId: "remote-machine",
    accountsToken: "caller-token-b",
  });

  assert.deepEqual(manager.calls.connect, [
    { machineId: "remote-machine", callerToken: "caller-token-a" },
    { machineId: "remote-machine", callerToken: "caller-token-b" },
  ]);
  assert.equal(remote.ports.length, 2);

  first.close();
  second.close();
});

test("forMachine surfaces accounts-owned authorization refusal without terminal side effects", async () => {
  const manager = createStubManager();
  const local = createLocalTerminal();
  const authorizationPort = {
    async authorizeCallerMachine() {
      throw Object.assign(new Error("machine revoked"), { code: "MACHINE_REVOKED" });
    },
  };
  const consumer = createConnectionMachineTerminal({
    connectionManager: manager,
    authorizationPort,
    localMachineId: "local-machine",
    terminal: local,
  });
  await assert.rejects(
    () => consumer.forMachine({
      machineId: "remote-machine",
      accountsToken: "caller-token",
    }),
    (error) => {
      assert.equal(error.code, "MACHINE_REVOKED");
      assert.equal(error.owningModule, "accounts");
      return true;
    },
  );
  assert.equal(manager.calls.connect.length, 0);
  assert.equal(local.calls.input.length, 0);
});

test("forMachine rejects an unverified peer identity and releases the link", async () => {
  const manager = createStubManager({ peerIdentityVerified: false, peerIdentity: null });
  const remote = createRemoteFactories();
  const consumer = createConnectionMachineTerminal({
    connectionManager: manager,
    createMuxClient: remote.createMuxClient,
    createTerminalPort: remote.createTerminalPort,
  });
  await assert.rejects(
    () => consumer.forMachine({ machineId: "remote-machine" }),
    (error) => error.code === "peer_identity_mismatch",
  );
  assert.equal(manager.calls.closeOwnLink, 1);
  assert.equal(remote.ports.length, 0);
});

test("generation change makes an old scoped handle fail without fallback or reconnect", async (t) => {
  const manager = createStubManager();
  const local = createLocalTerminal();
  const remote = createRemoteFactories();
  const consumer = createConnectionMachineTerminal({
    connectionManager: manager,
    localMachineId: "local-machine",
    terminal: local,
    createMuxClient: remote.createMuxClient,
    createTerminalPort: remote.createTerminalPort,
  });
  const scoped = await consumer.forMachine({ machineId: "remote-machine" });
  t.after(() => scoped.close());

  manager.setGeneration(8);
  await assert.rejects(
    () => scoped.input("tmux:v1:alpha", "stale\r"),
    (error) => {
      assert.equal(error.code, "stale_generation");
      assert.equal(error.owningModule, "daemon");
      assert.deepEqual(error.cause, {
        machineId: "remote-machine",
        expectedGeneration: 7,
        actualGeneration: 8,
      });
      return true;
    },
  );
  assert.equal(local.calls.input.length, 0);
  assert.equal(remote.ports[0].calls.input.length, 0);
  assert.equal(manager.calls.connect.length, 1);
  assert.equal(manager.calls.closeOwnLink, 1);
});

test("a fresh explicit forMachine creates a new generation adapter and keeps the old handle stale", async (t) => {
  const manager = createStubManager();
  const local = createLocalTerminal();
  const remote = createRemoteFactories();
  const consumer = createConnectionMachineTerminal({
    connectionManager: manager,
    localMachineId: "local-machine",
    terminal: local,
    createMuxClient: remote.createMuxClient,
    createTerminalPort: remote.createTerminalPort,
  });
  const oldScoped = await consumer.forMachine({ machineId: "remote-machine" });

  manager.setGeneration(8);
  const newScoped = await consumer.forMachine({ machineId: "remote-machine" });
  t.after(() => oldScoped.close());
  t.after(() => newScoped.close());
  assert.equal(newScoped.linkGeneration, 8);
  assert.equal(manager.calls.connect.length, 2);
  assert.equal(remote.ports.length, 2);

  await newScoped.input("tmux:v1:alpha", "new\r");
  assert.deepEqual(remote.ports[1].calls.input, [{ target: "tmux:v1:alpha", data: "new\r" }]);
  await assert.rejects(
    () => oldScoped.input("tmux:v1:alpha", "old\r"),
    (error) => error.code === "stale_generation",
  );
  assert.equal(remote.ports[0].calls.input.length, 0);
  assert.equal(local.calls.input.length, 0);
});

test("a cached stale observation is discarded before resolving the current authorized link", async (t) => {
  const manager = createStubManager({ observeStaleAsError: true });
  const remote = createRemoteFactories();
  const consumer = createConnectionMachineTerminal({
    connectionManager: manager,
    createMuxClient: remote.createMuxClient,
    createTerminalPort: remote.createTerminalPort,
  });
  const cached = await consumer.forMachine({ machineId: "remote-machine" });
  assert.equal(cached.linkGeneration, 7);

  manager.setGeneration(8);
  const supersedingLink = await manager.connect("remote-machine");
  assert.equal(supersedingLink.generation, 8);

  const refreshed = await consumer.forMachine({ machineId: "remote-machine" });
  t.after(() => refreshed.close());
  assert.equal(refreshed.linkGeneration, 8);
  assert.equal(manager.calls.connect.length, 3);
  assert.equal(manager.calls.closeOwnLink, 1);

  await refreshed.input("tmux:v1:alpha", "fresh\r");
  assert.deepEqual(remote.ports[1].calls.input, [{ target: "tmux:v1:alpha", data: "fresh\r" }]);
  await assert.rejects(
    () => cached.input("tmux:v1:alpha", "stale\r"),
    (error) => error.code === "stale_generation",
  );
  assert.equal(remote.ports[0].calls.input.length, 0);
});

test("close releases an owned remote adapter and link but never the shared local terminal", async () => {
  const manager = createStubManager();
  const local = createLocalTerminal();
  const remote = createRemoteFactories();
  const consumer = createConnectionMachineTerminal({
    connectionManager: manager,
    localMachineId: "local-machine",
    terminal: local,
    createMuxClient: remote.createMuxClient,
    createTerminalPort: remote.createTerminalPort,
  });
  const scoped = await consumer.forMachine({ machineId: "remote-machine" });

  scoped.close();
  assert.equal(remote.ports[0].calls.close, 1);
  assert.equal(manager.calls.closeOwnLink, 1);
  assert.equal(local.calls.close, 0);
});
