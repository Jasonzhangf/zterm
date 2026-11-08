import test from "node:test";
import assert from "node:assert/strict";
import {
  createConnectionManager,
  ConnectionError,
  resolveAuthorizedTerminalDirectory,
} from "../../src/public/index.mjs";

function authFor(machineId, daemonHostId = `daemon-${machineId}`) {
  return {
    machineId,
    daemonHostId,
    accountId: "account-1",
    authorizationId: "auth-1",
    capabilities: { channelKinds: ["terminal"], transportKind: "ws" },
    target: {
      bridgeHost: "127.0.0.1",
      bridgePort: 47001,
      daemonHostId,
      relayHostId: daemonHostId,
      relayEndpointCandidates: [],
      transportMode: "websocket",
    },
    settings: { transportMode: "websocket" },
  };
}

function makeFakeTransport({
  path = "direct",
  peerIdentity = "daemon-machine-a",
  peerIdentityVerified = true,
  channelKinds = ["terminal"],
  catalog = [{ name: "session-1", backend: "tmux", stableId: "stable-1" }],
} = {}) {
  const state = { opened: [], catalogRequests: 0, sent: [], closed: [] };
  const handle = {
    path,
    transportKind: "ws-direct",
    peerIdentity,
    peerIdentityVerified,
    peerChannelKinds: channelKinds,
    bufferedBytes: 0,
    listSessions: async () => {
      state.catalogRequests += 1;
      return catalog;
    },
    openChannel: async (request) => {
      state.opened.push(request);
      return request.kind === "terminal"
        ? { sessionName: request.target?.sessionName ?? "session-1" }
        : {};
    },
    sendChannel: () => undefined,
    closeChannel: (id) => { state.closed.push(id); },
    close: () => undefined,
    onChannelMessage: () => () => undefined,
    onClose: () => undefined,
    onChannelClosed: () => () => undefined,
    onChannelCloseFailure: () => () => undefined,
    retryLateOpenClose: () => undefined,
  };
  return { handle, state };
}

function managerFor(handle) {
  return createConnectionManager({
    authorizationPort: {
      authorizeMachine: async () => {
        throw new ConnectionError("unauthorized", "no injected authorization");
      },
    },
    transport: { open: async () => handle },
  });
}

test("returns a machine-scoped directory from the current authorized link without opening a channel", async () => {
  const fake = makeFakeTransport({ peerIdentity: "daemon-machine-a" });
  const manager = managerFor(fake.handle);

  const dir = await resolveAuthorizedTerminalDirectory({
    connectionManager: manager,
    machineId: "machine-a",
    verifiedAuthorization: authFor("machine-a", "daemon-machine-a"),
  });

  assert.equal(dir.machineId, "machine-a");
  assert.equal(dir.link.machineId, "machine-a");
  assert.deepEqual(dir.entries, [
    { name: "session-1", backend: "tmux", stableId: "stable-1" },
  ]);
  assert.equal(fake.state.catalogRequests, 1);
  assert.equal(fake.state.opened.length, 0);

  const channel = await dir.openChannel("terminal", { sessionName: "s1" });
  assert.equal(channel.sessionName, "s1");
  assert.equal(fake.state.opened.length, 1);
});

test("rejects a link whose peer daemon does not match the verified daemonHostId", async () => {
  const fake = makeFakeTransport({ peerIdentity: "other-daemon" });
  const manager = managerFor(fake.handle);

  await assert.rejects(
    resolveAuthorizedTerminalDirectory({
      connectionManager: manager,
      machineId: "machine-a",
      verifiedAuthorization: authFor("machine-a", "expected-daemon"),
    }),
    (err) => err instanceof ConnectionError && err.code === "peer_identity_mismatch",
  );
});

test("rejects an authorization written for a different machine", async () => {
  const fake = makeFakeTransport({ peerIdentity: "daemon-machine-b" });
  const manager = managerFor(fake.handle);

  await assert.rejects(
    resolveAuthorizedTerminalDirectory({
      connectionManager: manager,
      machineId: "machine-a",
      verifiedAuthorization: authFor("machine-b"),
    }),
    (err) => err instanceof ConnectionError && err.code === "machine_mismatch",
  );
});

test("fences a superseded link so the old directory cannot open a terminal channel", async () => {
  const first = makeFakeTransport({ peerIdentity: "daemon-machine-a" });
  const second = makeFakeTransport({ peerIdentity: "daemon-machine-a" });
  const handles = [first.handle, second.handle];
  const manager = createConnectionManager({
    authorizationPort: { authorizeMachine: async () => authFor("machine-a", "daemon-machine-a") },
    transport: { open: async () => handles.shift() },
  });

  const dir = await resolveAuthorizedTerminalDirectory({
    connectionManager: manager,
    machineId: "machine-a",
  });
  await manager.connect("machine-a", authFor("machine-a", "daemon-machine-a"));

  await assert.rejects(
    dir.openChannel("terminal", { sessionName: "stale" }),
    (err) => err instanceof ConnectionError && err.code === "stale_generation",
  );
});

test("rejects directory operations after the current link is revoked", async () => {
  const fake = makeFakeTransport({ peerIdentity: "daemon-machine-a" });
  const manager = managerFor(fake.handle);

  const dir = await resolveAuthorizedTerminalDirectory({
    connectionManager: manager,
    machineId: "machine-a",
    verifiedAuthorization: authFor("machine-a", "daemon-machine-a"),
  });
  dir.close();

  await assert.rejects(
    dir.openChannel("terminal", { sessionName: "after-close" }),
    (err) => err instanceof ConnectionError && err.code === "link_closed",
  );
});

test("preserves the cause of a typed directory rejection", async () => {
  const root = new Error("grant revoked");
  const fake = makeFakeTransport({ peerIdentity: "daemon-machine-a" });
  const manager = createConnectionManager({
    authorizationPort: {
      authorizeMachine: async () => {
        throw new ConnectionError("directory_rejected", "machine not authorized", {
          machineId: "machine-a",
          cause: root,
        });
      },
    },
    transport: { open: async () => fake.handle },
  });

  await assert.rejects(
    resolveAuthorizedTerminalDirectory({
      connectionManager: manager,
      machineId: "machine-a",
    }),
    (err) =>
      err instanceof ConnectionError &&
      err.code === "directory_rejected" &&
      err.cause === root,
  );
});
