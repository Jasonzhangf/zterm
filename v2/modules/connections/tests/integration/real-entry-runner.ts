import { createRequire } from "node:module";
import { createServer } from "node:http";
import { buildTerminalMuxCapabilities, buildTerminalMuxReady, isTerminalMuxClientFrame } from "@zterm/shared/connection/protocol";
import { V1TraversalTransport } from "../../src/index";
import { createConnectionManager } from "../support/caller-bound-manager";
import type { AuthorizedMachineLink } from "../../src/ports/accounts-authorization";

const cliRequire = createRequire(new URL("../../../../../packages/cli/package.json", import.meta.url));
const { WebSocketServer } = cliRequire("ws") as typeof import("ws");

const TOKEN = process.env.ZTERM_TEST_TOKEN || "test-token-abc";
const DAEMON = process.env.ZTERM_TEST_DAEMON || "daemon-lan-peer";
const MACHINE = process.env.ZTERM_TEST_MACHINE || "machine-lan-peer";
const SESSION = process.env.ZTERM_TEST_SESSION || "known-session";
const BIND = process.env.ZTERM_TEST_BIND || "127.0.0.1";

function authFor(host: string, port: number, token: string, daemon = DAEMON): AuthorizedMachineLink {
  return {
    machineId: MACHINE,
    daemonHostId: daemon,
    accountId: "account-e2e",
    authorizationId: "auth-e2e",
    capabilities: { channelKinds: ["terminal"], transportKind: "ws" },
    target: {
      bridgeHost: host,
      bridgePort: port,
      authToken: token,
      daemonHostId: daemon,
      relayHostId: daemon,
      relayEndpointCandidates: [],
      transportMode: "websocket",
    },
    settings: { transportMode: "websocket" },
  };
}

async function main() {
  const server = createServer();
  const wsServer = new WebSocketServer({ server });
  const openChannels = new Set<string>();
  wsServer.on("connection", (socket, req) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.searchParams.get("token") !== TOKEN) {
      socket.close(4001, "unauthorized");
      return;
    }
    socket.on("message", (raw) => {
      let parsed: unknown;
      try { parsed = JSON.parse(raw.toString()); } catch { return; }
      if (!isTerminalMuxClientFrame(parsed)) return;
      if (parsed.type === "mux-hello") {
        socket.send(JSON.stringify(buildTerminalMuxReady({ capabilities: buildTerminalMuxCapabilities({ reliableInput: { version: 1 } }) })));
        return;
      }
      if (parsed.type === "mux-channel-open" && parsed.payload.sessionName === SESSION) {
        openChannels.add(parsed.payload.channelId);
        socket.send(JSON.stringify({ type: "mux-channel-opened", payload: { channelId: parsed.payload.channelId, sessionName: SESSION, stableId: `stable-${SESSION}` } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, BIND, () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const port = address.port;

  const manager = createConnectionManager({
    authorizationPort: { authorizeMachine: async () => authFor(BIND, port, TOKEN) },
    transport: new V1TraversalTransport(),
  });

  const link = await manager.connect(MACHINE);
  const obs = manager.observeLink(link);
  console.log(JSON.stringify({ step: "connect", link, obs }, null, 2));

  const channel = await manager.openChannel(link, "terminal", { sessionName: SESSION, backend: "tmux" });
  console.log(JSON.stringify({ step: "channel", channel }, null, 2));

  manager.closeOwnLink(link);
  console.log(JSON.stringify({ step: "close", obs: manager.observeLink(link) }, null, 2));

  await new Promise<void>((resolve) => wsServer.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

main().catch((error) => {
  console.error(JSON.stringify({ step: "error", name: error?.name, message: error?.message, code: error?.code }, null, 2));
  process.exit(1);
});
