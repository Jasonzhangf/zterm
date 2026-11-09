// Focused probe: consume the connections-owned public entry
// resolveAuthorizedTerminalDirectory against a real V1 mux fixture and the
// real V1TraversalTransport. Proves the machine-scoped catalog and the terminal
// channel come from one current authorized link. The authorization port is an
// injected dev authorization; the accounts owner entry is a later candidate.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConnectionManager, V1TraversalTransport } from "../../../modules/connections/src/index.ts";
import { resolveAuthorizedTerminalDirectory } from "../../../modules/connections/src/public/index.mjs";
import { createV1MuxFixture } from "../../../modules/terminal/tests/v1-mux-fixture.mjs";

const AUTH_TOKEN = "directory-probe-v1-token";
const MACHINE_ID = "machine-directory-probe";
const DAEMON_HOST_ID = "daemon-directory-probe";
const ROOT = join(tmpdir(), "zterm-connections-directory-probe");

function tmux(socket, args) {
  return execFileSync("tmux", ["-S", socket, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function startTerminalPair() {
  await mkdir(ROOT, { recursive: true });
  const socket = join(ROOT, `${process.pid}.sock`);
  const names = [`directory-probe-${process.pid}-a`, `directory-probe-${process.pid}-b`];
  for (const name of names) {
    tmux(socket, ["new-session", "-d", "-s", name, "-x", "90", "-y", "24"]);
  }
  return {
    socket,
    names,
    close() {
      for (const name of names) {
        try {
          tmux(socket, ["kill-session", "-t", name]);
        } catch {
          // The dedicated session is already gone.
        }
      }
    },
  };
}

function createManager(port) {
  return createConnectionManager({
    authorizationPort: {
      async authorizeMachine(machineId) {
        return {
          machineId,
          daemonHostId: DAEMON_HOST_ID,
          accountId: "account-directory-probe",
          authorizationId: "authorization-directory-probe",
          capabilities: { channelKinds: ["terminal"], transportKind: "websocket" },
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
        };
      },
    },
    transport: new V1TraversalTransport(),
  });
}

const result = {};
let terminal;
let fixture;
try {
  terminal = await startTerminalPair();
  fixture = createV1MuxFixture({
    tmuxSocket: terminal.socket,
    authToken: AUTH_TOKEN,
    daemonHostId: DAEMON_HOST_ID,
  });
  const { host, port } = await fixture.listen();
  assert.equal(host, "127.0.0.1");

  const manager = createManager(port);
  const directory = await resolveAuthorizedTerminalDirectory({
    connectionManager: manager,
    machineId: MACHINE_ID,
  });
  result.machineId = directory.machineId;
  result.linkId = directory.link.id;
  result.linkGeneration = directory.link.generation;
  result.entryCount = directory.entries.length;
  result.entries = directory.entries.map(({ name, backend, stableId }) => ({ name, backend, stableId }));
  result.channelOpensAfterResolve = fixture.recorded.channelOpen.length;
  assert.equal(directory.entries.length, 2);
  assert.equal(fixture.recorded.channelOpen.length, 0, "directory resolution must not open a terminal channel");

  const target = directory.entries[0];
  const channel = await directory.openChannel("terminal", {
    sessionName: target.name,
    backend: target.backend,
    expectedSessionIdentity: target.stableId,
    existingOnly: true,
    bodySubscribed: true,
  });
  result.channelId = channel.id;
  result.channelLinkId = channel.linkId;
  result.channelOpensAfterOpen = fixture.recorded.channelOpen.length;
  assert.equal(fixture.recorded.channelOpen.length, 1);
  assert.equal(fixture.recorded.channelOpen[0].found, true);
  assert.equal(channel.linkId, directory.link.id, "channel must stay bound to the same directory link");

  directory.close();
  result.closed = true;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  try {
    await fixture?.close();
  } catch {
    // Best-effort release.
  }
  try {
    terminal?.close();
  } catch {
    // Best-effort release.
  }
}
