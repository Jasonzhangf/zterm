import { execFileSync } from "node:child_process";

import { createConnectionManager, V1TraversalTransport } from "../../../modules/connections/src/index.ts";
import { createV1MuxFixture } from "../../../modules/terminal/tests/v1-mux-fixture.mjs";

// Read-only probe for the composition success path. It runs the real
// connections public entry over the local V1 mux fixture and records whether
// the fixture handshake satisfies the accepted terminal-mux contract.
const AUTH_TOKEN = "composition-protocol-token";
const DAEMON_HOST_ID = "daemon-composition-protocol";
const MACHINE_ID = "machine-composition-protocol";

const socket = `/tmp/zterm-composition-protocol-${process.pid}.sock`;
const session = `composition-protocol-${process.pid}`;
const result = {
  fixture: { session },
  connect: { ok: false },
  observation: null,
  checks: null,
};

execFileSync("tmux", ["-S", socket, "new-session", "-d", "-s", session, "-x", "90", "-y", "24"]);
const fixture = createV1MuxFixture({
  tmuxSocket: socket,
  authToken: AUTH_TOKEN,
  daemonHostId: DAEMON_HOST_ID,
});

try {
  const { port } = await fixture.listen();
  result.fixture.bridgePort = port;

  const manager = createConnectionManager({
    authorizationPort: {
      authorizeMachine: async () => ({
        machineId: MACHINE_ID,
        daemonHostId: DAEMON_HOST_ID,
        accountId: "account-composition-protocol",
        authorizationId: "authorization-composition-protocol",
        capabilities: { channelKinds: ["terminal"], transportKind: "ws" },
        target: {
          bridgeHost: "127.0.0.1",
          bridgePort: port,
          authToken: AUTH_TOKEN,
          daemonHostId: DAEMON_HOST_ID,
          relayHostId: DAEMON_HOST_ID,
          relayEndpointCandidates: [],
          transportMode: "websocket",
        },
        settings: { transportMode: "websocket" },
      }),
    },
    transport: new V1TraversalTransport(),
  });

  try {
    const link = await manager.connect(MACHINE_ID);
    result.connect.ok = true;
    const observation = manager.observeLink(link);
    result.observation = {
      status: observation.status,
      freshness: observation.freshness,
      peerIdentity: observation.peerIdentity,
      peerIdentityVerified: observation.peerIdentityVerified,
      peerChannelKinds: observation.peerChannelKinds,
    };
    result.checks = {
      connected: observation.status === "connected" && observation.freshness === "fresh",
      peerIdentityVerified: observation.peerIdentityVerified === true,
      peerIdentityMatches: observation.peerIdentity === DAEMON_HOST_ID,
    };
    manager.closeOwnLink(link);
  } catch (error) {
    result.connect.error = {
      code: error?.code ?? null,
      message: error?.message ?? String(error),
      cause: error?.cause ?? null,
    };
  }
} finally {
  fixture.close();
  try {
    execFileSync("tmux", ["-S", socket, "kill-session", "-t", session]);
  } catch {
    // The dedicated session is already gone.
  }
}

console.log(JSON.stringify(result, null, 2));

const passed = result.checks !== null && Object.values(result.checks).every(Boolean);
process.exitCode = passed ? 0 : 1;
