import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { V1TraversalTransport } from "../../connections/src/public/index.mjs";
import { assembleDaemonConfig, loadStartupConfig } from "../src/startup-config.mjs";
import { createDaemon } from "../src/server.mjs";

const TOKEN = "startup-v2-token";

async function configRoot() {
  return mkdtemp(join(tmpdir(), "zterm-startup-config-"));
}

async function validConfig() {
  const root = await configRoot();
  return {
    server: { host: "127.0.0.1", port: 0 },
    auth: { v2Token: TOKEN },
    terminal: { v1WsUrl: "ws://127.0.0.1:49999/ws", v1Token: "v1-token" },
    accounts: {
      relayBaseUrl: "http://127.0.0.1:49998",
      authorizationStoreFile: join(root, "authorization.json"),
      machineAuthorizationToken: "machine-token",
    },
    organization: { storeFile: join(root, "organization.json") },
    members: { bindingStoreFile: join(root, "members.json") },
    hostAdapter: { backend: "tmux", socketName: "startup-config-socket", machineId: "machine-startup" },
    connections: {
      machineRoutes: {
        "machine-startup": {
          daemonHostId: "daemon-startup",
          capabilities: { transportKind: "websocket", channelKinds: ["terminal"] },
          target: { bridgeHost: "127.0.0.1", bridgePort: 49997, daemonHostId: "daemon-startup", transportMode: "websocket" },
          settings: { transportMode: "websocket" },
        },
      },
    },
  };
}

function stubTransport() {
  return { async open() { throw new Error("transport must not be used in this test"); } };
}

function stubTerminalPort() {
  return {
    async listSessions() { return []; },
    async input() { return {}; },
    async subscribe() { return { close() {} }; },
    async close() {},
  };
}

function expectConfigError(action) {
  assert.throws(action, (error) => {
    assert.equal(error.code, "DAEMON_STARTUP_CONFIG_INVALID", `expected DAEMON_STARTUP_CONFIG_INVALID, got ${error.code}`);
    return true;
  });
}

test("startup config requires every production section", async () => {
  const base = await validConfig();
  for (const section of ["server", "auth", "terminal", "accounts", "organization", "members", "hostAdapter", "connections"]) {
    const config = structuredClone(base);
    delete config[section];
    expectConfigError(() => assembleDaemonConfig(config, { createTransport: stubTransport }));
  }
});

test("startup config defaults to the connections public V1 transport", async () => {
  const config = await validConfig();
  const assembled = assembleDaemonConfig(config, { log: () => {} });
  assert.equal(typeof V1TraversalTransport, "function");
  assert.ok(assembled.daemonOptions.admission.machineTerminal);
});

test("startup config uses an injected transport factory only when supplied", async () => {
  const config = await validConfig();
  let transportCalls = 0;
  assembleDaemonConfig(config, {
    createTransport: () => {
      transportCalls += 1;
      return stubTransport();
    },
    log: () => {},
  });
  assert.equal(transportCalls, 1);
});

test("startup config rejects an explicit non-function transport factory", async () => {
  const config = await validConfig();
  expectConfigError(() => assembleDaemonConfig(config, { createTransport: null }));
});

test("startup config rejects a machine route with mismatched daemon identity", async () => {
  const config = await validConfig();
  config.connections.machineRoutes["machine-startup"].target.daemonHostId = "daemon-other";
  expectConfigError(() => assembleDaemonConfig(config, { createTransport: stubTransport }));
});

test("startup config rejects a machine route with an invalid bridge port", async () => {
  const config = await validConfig();
  config.connections.machineRoutes["machine-startup"].target.bridgePort = 0;
  expectConfigError(() => assembleDaemonConfig(config, { createTransport: stubTransport }));
});

test("assembleDaemonConfig composes the real daemon ports from config", async () => {
  const config = await validConfig();
  const assembled = assembleDaemonConfig(config, { createTransport: stubTransport, log: () => {} });
  assert.equal(assembled.server.host, "127.0.0.1");
  const options = assembled.daemonOptions;
  assert.equal(options.v1WsUrl, config.terminal.v1WsUrl);
  assert.equal(options.v2Token, TOKEN);
  for (const port of [
    "workspaceAuth",
    "organization",
    "members",
    "routing",
    "memberHostObserver",
    "machineService",
    "machineAuthorization",
    "connectionManager",
  ]) {
    assert.ok(options[port], `missing composed port ${port}`);
  }
  assert.equal(typeof options.machineService.listAuthorizedMachines, "function");
  assert.equal(typeof options.machineAuthorization.authorizeMachine, "function");
  assert.equal(typeof options.connectionManager.connect, "function");
  for (const port of ["auth", "members", "routing", "machineTerminal", "resolveBindingTarget"]) {
    assert.ok(options.admission[port], `missing admission port ${port}`);
  }

  const daemon = createDaemon({ ...options, terminalPort: stubTerminalPort() });
  try {
    assert.ok(daemon.server, "the composed daemon must create an HTTP server");
  } finally {
    await new Promise((resolve) => daemon.server.close(resolve));
  }
});

test("startup config leaves work tracking absent without blocking unrelated daemon startup", async () => {
  const config = await validConfig();
  const assembled = assembleDaemonConfig(config, { createTransport: stubTransport, log: () => {} });
  assert.equal(assembled.daemonOptions.goals, null);
  assert.equal(assembled.daemonOptions.tickets, null);
  assert.equal(assembled.daemonOptions.board, null);

  const daemon = createDaemon({ ...assembled.daemonOptions, terminalPort: stubTerminalPort() });
  try {
    assert.ok(daemon.server, "unrelated daemon startup must remain available");
  } finally {
    await new Promise((resolve) => daemon.server.close(resolve));
  }
});

test("startup config composes supplied work tracking through the public facade", async () => {
  const config = await validConfig();
  config.workTracking = {
    goalsStoreFile: join(await configRoot(), "goals.json"),
    ticketsStoreFile: join(await configRoot(), "tickets.sqlite"),
    providerInstances: [],
    workspaceProviders: [],
  };
  const assembled = assembleDaemonConfig(config, {
    createTransport: stubTransport,
    log: () => {},
    actorResolver: {
      async resolve({ account }) {
        return { sessionId: "session-1", accountId: account.accountId, memberId: "member-1", credentialState: "active" };
      },
    },
    credentialProvider: {
      async getCredential() {
        return { token: "unused" };
      },
    },
  });
  assert.equal(typeof assembled.daemonOptions.goals.listGoals, "function");
  assert.equal(typeof assembled.daemonOptions.tickets.resolveActor, "function");
  assert.equal(typeof assembled.daemonOptions.tickets.getInWorkspace, "function");
  assert.equal(typeof assembled.daemonOptions.board.queryManagerBoard, "function");
  try {
    await assembled.daemonOptions.tickets.ready();
  } finally {
    assembled.daemonOptions.tickets.closeStore();
  }
});

test("startup config rejects a supplied malformed work-tracking section before listen", async () => {
  const config = await validConfig();
  config.workTracking = {
    goalsStoreFile: join(await configRoot(), "goals.json"),
    ticketsStoreFile: join(await configRoot(), "tickets.sqlite"),
    workspaceProviders: [],
  };
  expectConfigError(() => assembleDaemonConfig(config, { createTransport: stubTransport }));
});

test("loadStartupConfig rejects unreadable and invalid JSON config files", async () => {
  const root = await configRoot();
  await assert.rejects(
    () => loadStartupConfig(join(root, "missing.json"), { createTransport: stubTransport }),
    (error) => error.code === "DAEMON_STARTUP_CONFIG_INVALID",
  );
  const bad = join(root, "bad.json");
  await writeFile(bad, "{ not json", "utf8");
  await assert.rejects(
    () => loadStartupConfig(bad, { createTransport: stubTransport }),
    (error) => error.code === "DAEMON_STARTUP_CONFIG_INVALID",
  );
});
