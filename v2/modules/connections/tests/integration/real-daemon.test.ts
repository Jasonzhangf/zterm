import { describe, expect, it } from "vitest";
import { V1TraversalTransport } from "../../src/index";
import { createConnectionManager } from "../support/caller-bound-manager";
import type { AuthorizedMachineLink } from "../../src/ports/accounts-authorization";

// Real V1 daemon black-box evidence. Skipped unless explicitly pointed at a
// live daemon. It proves the module talks to the actual product daemon, not a
// local loopback fixture.
const ENABLED = process.env.ZTERM_REAL_DAEMON === "1";
const HOST = process.env.ZTERM_REAL_DAEMON_HOST || "192.168.0.3";
const PORT = Number(process.env.ZTERM_REAL_DAEMON_PORT || "3333");
const TOKEN = process.env.ZTERM_REAL_DAEMON_TOKEN || "";
const DAEMON = process.env.ZTERM_REAL_DAEMON_ID || "mac-studio";
const MACHINE = process.env.ZTERM_REAL_DAEMON_MACHINE || "machine-lan-real";

function authFor(): AuthorizedMachineLink {
  return {
    machineId: MACHINE,
    daemonHostId: DAEMON,
    accountId: "account-real",
    authorizationId: "auth-real",
    capabilities: { channelKinds: ["terminal"], transportKind: "ws" },
    target: {
      bridgeHost: HOST,
      bridgePort: PORT,
      authToken: TOKEN,
      daemonHostId: DAEMON,
      relayHostId: DAEMON,
      relayEndpointCandidates: [],
      transportMode: "websocket",
    },
    settings: { transportMode: "websocket" },
  };
}

describe.skipIf(!ENABLED)("connections real V1 daemon (read-only handshake + open/ack)", () => {
  it("rejects the real daemon when mux-ready omits canonical identity", async () => {
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor() },
      transport: new V1TraversalTransport(),
    });
    await expect(manager.connect(MACHINE)).rejects.toMatchObject({ code: "peer_identity_mismatch" });
    const obs = manager.observeLink({ id: `link:${MACHINE}`, machineId: MACHINE, generation: 1 });
    expect(obs.status).toBe("rejected");
    expect(obs.freshness).toBe("stale");
  });

  it("rejects the real daemon when the token is wrong", async () => {
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor() },
      transport: new V1TraversalTransport(),
    });
    const bad = { ...authFor(), target: { ...authFor().target, authToken: "wrong-token" } };
    await expect(manager.connect(MACHINE, bad)).rejects.toMatchObject({ code: "unauthorized" });
  });
});
