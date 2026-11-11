import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startDaemon } from "../../../modules/daemon/src/main.mjs";
import { createConnectionMachineTerminal } from "../../../modules/daemon/src/machine-terminal-consumer.mjs";
import { createConnectionManager, V1TraversalTransport } from "../../../modules/connections/src/index.ts";
import {
  createOrganizationService,
  createOrganizationStore,
} from "../../../modules/organization/src/public/index.mjs";
import {
  createBindingStore,
  createMembersService,
} from "../../../modules/members/src/public/index.mjs";
import { createRoutingService } from "../../../modules/routing/src/public/index.mjs";
import { createTmuxHostProbe } from "../../../modules/host-adapters/src/public/index.mjs";

const SEED_TOKEN = "p12-seed-token";
const CALLER_TOKEN = "p12-caller-token";
const MACHINE_ID = "machine-p12";
const INPUT_DATA = `echo P12OUT $(od -An -N4 -tx1 /dev/urandom | tr -d ' \\t\\n')\r`;

const here = dirname(fileURLToPath(import.meta.url));
const fixtureStateFile = process.argv[2] || join(
  "/Volumes/Intel/playground/zterm/.worker-runs/isolated-v1-stream-fixture-1105/runs/latest.json",
);

function readReceiptPath(name) {
  return join(here, name);
}

async function writeReceipt(name, content) {
  await writeFile(readReceiptPath(name), `${content}\n`, "utf8");
}

function tmuxCapture(socket, target) {
  return execFileSync("tmux", ["-S", socket, "capture-pane", "-p", "-t", target], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function tmuxList(socket) {
  return execFileSync("tmux", ["-S", socket, "list-sessions", "-F", "#{session_name}|#{session_id}"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function readFixtureState() {
  const raw = await readFile(fixtureStateFile, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed.statePath) {
    return JSON.parse(await readFile(parsed.statePath, "utf8"));
  }
  return parsed;
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function sseParse() {
  let buffer = "";
  return {
    push(chunk, onEvent) {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const event = { event: null, data: null };
        for (const line of raw.split("\n")) {
          if (line.startsWith("event: ")) event.event = line.slice(7).trim();
          else if (line.startsWith("data: ")) event.data += line.slice(6);
        }
        if (event.event && event.data) {
          try {
            event.parsed = JSON.parse(event.data);
          } catch {
            event.parsed = null;
          }
          onEvent(event);
        }
      }
    },
  };
}

const main = async () => {
  const fixture = await readFixtureState();
  const authToken = fixture.authToken;
  const port = fixture.port;
  const alpha = fixture.alpha;
  const beta = fixture.beta;
  const alphaStableId = fixture.alphaStableId;
  const betaStableId = fixture.betaStableId;
  const socket = fixture.tmuxSocketPath;
  const daemonHostId = (await readFile(join(fixture.homeDir, ".zterm", "daemon-id"), "utf8")).trim();

  assert.equal(fixture.status, "running", "fixture state must be running");
  assert.ok(authToken, "fixture must provide an auth token");

  const catalogListed = tmuxList(socket);
  await writeReceipt("p12-tmux-list-sessions.txt", `socket=${socket}\n${catalogListed}`);

  const rawHostProbeStableId = await (async () => {
    const probe = createTmuxHostProbe({ socketName: "tmux.sock", machineId: MACHINE_ID });
    const observation = await probe.probe({ sessionId: alpha });
    return observation.terminalTarget?.stableId;
  })();

  await writeReceipt("p12-host-probe-vs-catalog-stableid.json", JSON.stringify({
    observedAt: new Date().toISOString(),
    fixtureAlphaSession: alpha,
    fixtureTmuxSocket: socket,
    hostProbeStableId: rawHostProbeStableId,
    catalogAlphaStableId: alphaStableId,
    catalogBetaStableId: betaStableId,
    equal: rawHostProbeStableId === alphaStableId,
  }, null, 2));

  const manager = createConnectionManager({
    authorizationPort: {
      async authorizeMachine(machineId) {
        if (machineId !== MACHINE_ID) {
          throw new Error(`P1-2 probe only authorizes ${MACHINE_ID}`);
        }
        return {
          machineId,
          daemonHostId,
          accountId: "account-p12",
          authorizationId: `authz-${machineId}`,
          capabilities: { channelKinds: ["terminal"], transportKind: "websocket" },
          target: {
            bridgeHost: "127.0.0.1",
            bridgePort: port,
            authToken,
            daemonHostId,
            relayHostId: daemonHostId,
            relayEndpointCandidates: [],
            transportMode: "websocket",
          },
          settings: { transportMode: "websocket" },
        };
      },
    },
    transport: new V1TraversalTransport(),
  });

  let capturedLink = null;
  const counters = { channelOpens: 0, inputWrites: 0, connects: 0 };
  const originalConnect = manager.connect.bind(manager);
  const originalOpenChannel = manager.openChannel.bind(manager);
  const originalSendChannel = manager.sendChannel.bind(manager);
  manager.connect = async (...args) => {
    const link = await originalConnect(...args);
    capturedLink = link;
    counters.connects += 1;
    return link;
  };
  manager.openChannel = (...args) => {
    counters.channelOpens += 1;
    return originalOpenChannel(...args);
  };
  manager.sendChannel = (channel, data) => {
    counters.inputWrites += 1;
    return originalSendChannel(channel, data);
  };

  const root = await mkdtemp(join(tmpdir(), "zterm-p12-real-daemon-"));
  let daemon = null;
  let reader = null;
  try {
    const seedAuth = createRoutingDevAuth({
      accounts: {
        [SEED_TOKEN]: {
          accountId: "acct-p12-seed",
          scopes: ["org:write", "members:read", "members:write", "routing:resolve"],
          workspaces: "*",
        },
      },
    });
    const organization = createOrganizationService({
      store: createOrganizationStore(join(root, "organization.json")),
      auth: seedAuth,
    });
    const members = createMembersService({
      store: createBindingStore(join(root, "members.json")),
      auth: seedAuth,
      organization,
    });
    const workspace = await organization.createWorkspace({ token: SEED_TOKEN, name: "P12" });
    const group = await organization.createGroup({
      token: SEED_TOKEN,
      workspaceId: workspace.workspaceId,
      name: "team",
      expectedRevision: workspace.revision,
    });
    const member = await organization.addMember({
      token: SEED_TOKEN,
      workspaceId: workspace.workspaceId,
      groupId: group.groupId,
      name: "Worker",
      expectedRevision: group.revision,
    });
    await members.configureRuntime({
      token: SEED_TOKEN,
      memberId: member.memberId,
      machineId: MACHINE_ID,
      hostKind: "tmux",
      agentKind: "codex",
      launchProfileRef: "lp-p12",
    });
    const binding = await members.bindSession({
      token: SEED_TOKEN,
      memberId: member.memberId,
      sessionId: "sess-p12",
      anchor: "pane:0",
      expectedGeneration: 0,
      terminalTarget: { backend: "tmux", stableId: alphaStableId },
    });

    const callerAuth = createRoutingDevAuth({
      accounts: {
        [CALLER_TOKEN]: {
          accountId: "acct-p12-caller",
          scopes: ["routing:resolve"],
          workspaces: [workspace.workspaceId],
          members: [member.memberId],
        },
      },
    });
    const routing = createRoutingService({ organization, members, auth: callerAuth });
    const machineTerminal = createConnectionMachineTerminal({ connectionManager: manager });

    daemon = await startDaemon({
      port: 0,
      host: "127.0.0.1",
      v2Token: CALLER_TOKEN,
      admission: {
        auth: callerAuth,
        members,
        routing,
        machineTerminal,
        resolveBindingTarget: members.resolveBindingTarget,
      },
      log: () => {},
    });
    const base = `http://127.0.0.1:${daemon.server.address().port}`;
    const query = new URLSearchParams({
      workspaceId: workspace.workspaceId,
      memberId: member.memberId,
      machineId: MACHINE_ID,
      groupPath: group.path,
      expectedGeneration: String(binding.generation),
      backend: "tmux",
      stableId: alphaStableId,
    });
    const streamResponse = await fetch(`${base}/api/terminal/stream?${query}`, {
      headers: { authorization: `Bearer ${CALLER_TOKEN}` },
    });
    assert.equal(streamResponse.status, 200, `stream status was ${streamResponse.status}`);

    const events = [];
    const parser = sseParse();
    const committedBuffers = [];
    let sawReady = false;
    reader = streamResponse.body.getReader();
    const decoder = new TextDecoder();
    (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }), (event) => {
          events.push(event);
          if (event.event === "ready") sawReady = true;
          if (event.event === "buffer" && event.parsed?.buffer) committedBuffers.push(event.parsed);
        });
      }
    })();

    await waitFor(() => sawReady, 15000, "SSE ready");
    await waitFor(() => committedBuffers.some((frame) => (frame.buffer || "").includes("ALPHA_INITIAL_FRAME")), 15000, "committed ALPHA_INITIAL_FRAME");
    const initialFrame = committedBuffers.find((frame) => (frame.buffer || "").includes("ALPHA_INITIAL_FRAME"));

    const inputResponse = await fetch(`${base}/api/terminal/input`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${CALLER_TOKEN}` },
      body: JSON.stringify({
        workspaceId: workspace.workspaceId,
        memberId: member.memberId,
        machineId: MACHINE_ID,
        groupPath: group.path,
        expectedGeneration: binding.generation,
        target: { backend: "tmux", stableId: alphaStableId },
        data: INPUT_DATA,
      }),
    });
    const inputPayload = await inputResponse.json();
    assert.equal(inputResponse.status, 200, `input status was ${inputResponse.status}`);

    const outputPattern = /P12OUT_([0-9a-f]{8})/;
    await waitFor(() => committedBuffers.some((frame) => outputPattern.test(frame.buffer || "")), 15000, "unique output frame");
    const outputFrame = committedBuffers.find((frame) => outputPattern.test(frame.buffer || ""));
    const uniqueToken = outputPattern.exec(outputFrame.buffer)[1];
    assert.ok(!INPUT_DATA.includes(uniqueToken), "unique output token must not appear in input text");

    const alphaCapture = tmuxCapture(socket, alpha);
    assert.ok(alphaCapture.includes(`P12OUT_${uniqueToken}`), "tmux capture must contain executed output");

    await writeReceipt("p12-committed-initial-buffer.json", JSON.stringify(initialFrame, null, 2));
    await writeReceipt("p12-unique-output-frame.json", JSON.stringify(outputFrame, null, 2));
    await writeReceipt("p12-stream-ready.json", JSON.stringify(events.find((event) => event.event === "ready")?.parsed || {}, null, 2));
    await writeReceipt("p12-input-response.json", JSON.stringify(inputPayload, null, 2));
    await writeReceipt("p12-input-request.txt", INPUT_DATA.replace(/\r$/, "<CR>"));
    await writeReceipt("p12-unique-output.txt", [
      `input_text=${INPUT_DATA.replace(/\r$/, "<CR>")}`,
      `unique_token=${uniqueToken}`,
      `token_in_input_text=${INPUT_DATA.includes(uniqueToken)}`,
      `tmux_capture_has_output=${alphaCapture.includes(`P12OUT_${uniqueToken}`)}`,
      "--- tmux capture (alpha) ---",
      alphaCapture,
    ].join("\n"));
    await writeReceipt("p12-side-effects.txt", JSON.stringify({ afterPositive: counters }, null, 2));

    const result = {
      ok: true,
      supportedEntry: "startDaemon",
      fixture: { port, alpha, alphaStableId, daemonHostId },
      hostProbeStableId: rawHostProbeStableId,
      catalogAlphaStableId: alphaStableId,
      stableIdEqual: rawHostProbeStableId === alphaStableId,
      committedInitialFrame: { target: initialFrame.target, hasAlphaInitialFrame: (initialFrame.buffer || "").includes("ALPHA_INITIAL_FRAME") },
      uniqueOutput: { token: uniqueToken, tokenInInputText: INPUT_DATA.includes(uniqueToken), tmuxCaptureConfirmed: true },
      sideEffectsAfterPositive: counters,
    };
    await writeReceipt("p12-result.json", JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    await writeReceipt("p12-error.txt", error?.stack || String(error));
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (reader) await reader.cancel().catch(() => {});
    if (daemon) {
      daemon.server.close();
      await new Promise((resolve) => daemon.server.close(resolve));
    }
    await rm(root, { recursive: true, force: true });
  }
};
