import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import {
  AuthService,
  MachineService,
  V1RelayAdapter,
  createAccountsAuthorizationPort,
  createFileAccountAuthorizationStore,
  createWorkspaceAuthorization,
} from "../../../modules/accounts/src/public/contracts.ts";

const here = dirname(fileURLToPath(import.meta.url));
const worktree = join(here, "..", "..", "..", "..");
const androidRoot = join(worktree, "android");
const tsxBin = join(androidRoot, "node_modules", ".bin", "tsx");
const fixtureLatestFile = process.argv[2]
  || "/Volumes/Intel/playground/zterm/.worker-runs/isolated-v1-stream-fixture-1105/runs/latest.json";

async function writeReceipt(name, content) {
  await writeFile(join(here, name), `${content}\n`, "utf8");
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to reserve a relay port")));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`relay did not become healthy: ${lastError}`);
}

async function stopRelay(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 4000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function readFixtureState() {
  const latest = JSON.parse(await readFile(fixtureLatestFile, "utf8"));
  const statePath = latest.statePath || latest;
  return JSON.parse(await readFile(typeof statePath === "string" ? statePath : fixtureLatestFile, "utf8"));
}

async function startRelay() {
  const port = await availablePort();
  const tempRoot = await mkdtemp(join(tmpdir(), "zterm-p13-relay-"));
  const output = [];
  const child = spawn(tsxBin, ["src/traversal-relay/server.ts"], {
    cwd: androidRoot,
    env: {
      ...process.env,
      ZTERM_TRAVERSAL_HOST: "127.0.0.1",
      ZTERM_TRAVERSAL_PORT: String(port),
      ZTERM_TRAVERSAL_BASE_PATH: "",
      ZTERM_TRAVERSAL_DATA_DIR: join(tempRoot, "data"),
      ZTERM_TRAVERSAL_UPDATES_DIR: join(tempRoot, "updates"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => output.push(String(chunk)));
  child.stderr?.on("data", (chunk) => output.push(String(chunk)));
  child.once("error", (error) => output.push(`spawn-error: ${error.message}`));
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(`${baseUrl}/health`);
    return { child, tempRoot, baseUrl, output };
  } catch (error) {
    await stopRelay(child);
    await rm(tempRoot, { recursive: true, force: true });
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output.join("")}`);
  }
}

function uniqueIdentity(label) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return { loginName: `${label}-${suffix}`, credential: `pw-${suffix}` };
}

function sseParser(onEvent) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      let event = null;
      const dataLines = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
      }
      if (!event) continue;
      let parsed = null;
      try { parsed = JSON.parse(dataLines.join("")); } catch {}
      onEvent({ event, parsed });
    }
  };
}

async function readSseUntil(response, matcher, timeoutMs = 15000) {
  assert.equal(response.status, 200, `SSE status was ${response.status}`);
  const events = [];
  let matched = false;
  let match = null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = sseParser((event) => {
    events.push(event);
    if (!matched && matcher(event)) {
      matched = true;
      match = event;
      reader.cancel().catch(() => {});
    }
  });
  const timer = new Promise((_, reject) => setTimeout(() => reject(new Error("SSE wait timeout")), timeoutMs));
  try {
    await Promise.race([
      (async () => {
        while (!matched) {
          const { done, value } = await reader.read();
          if (done) break;
          parser(decoder.decode(value, { stream: true }));
        }
      })(),
      timer,
    ]);
  } finally {
    reader.cancel().catch(() => {});
  }
  return { events, matched, match };
}

const main = async () => {
  const fixture = await readFixtureState();
  const authToken = fixture.authToken;
  const fixturePort = fixture.port;
  const alpha = fixture.alpha;
  const alphaStableId = fixture.alphaStableId;
  const socket = fixture.tmuxSocketPath;
  const daemonHostId = (await readFile(join(fixture.homeDir, ".zterm", "daemon-id"), "utf8")).trim();
  assert.equal(fixture.status, "running", "fixture must be running");
  process.env.TMUX_TMPDIR = fixture.tempRoot;

  // Public host-observability producer identity vs the live V1 catalog identity.
  const hostProbe = createTmuxHostProbe({ socketName: "tmux.sock", machineId: "pending-machine-p13" });
  const hostObservation = await hostProbe.probe({ sessionId: alpha, anchor: "%0" });
  const hostProbeStableId = hostObservation.terminalTarget?.stableId || null;
  await writeReceipt("p13-host-probe-vs-catalog-stableid.json", JSON.stringify({
    observedAt: new Date().toISOString(),
    fixtureAlphaSession: alpha,
    fixtureTmuxSocket: socket,
    hostProbeAvailable: hostObservation.available === true,
    hostProbeAnchorPresent: hostObservation.anchorPresent,
    hostProbeStableId,
    catalogAlphaStableId: alphaStableId,
    equal: hostProbeStableId === alphaStableId,
  }, null, 2));

  const relay = await startRelay();
  const root = await mkdtemp(join(tmpdir(), "zterm-p13-accounts-"));
  let daemon = null;
  let link = null;
  let closeOwnedLink = () => {};
  const sideEffects = { connects: 0, channelOpens: 0, inputWrites: 0 };
  try {
    const relayAdapter = new V1RelayAdapter({ baseUrl: relay.baseUrl });
    const authService = new AuthService({ authority: relayAdapter });
    const machineService = new MachineService({
      machineReg: relayAdapter,
      verifySession: (token) => authService.verifySession(token),
    });
    const identity = uniqueIdentity("p13-owner");
    const registered = await authService.register(identity);
    const login = await authService.login(identity);
    const token = login.token;
    const accountId = registered.accountId;
    const enrolled = await machineService.enrollMachine(token, {
      deviceId: `p13-device-${Date.now()}`,
      deviceToken: `p13-proof-${Date.now()}`,
      displayName: "P13 Fixture Machine",
    });
    const machineId = enrolled.machineId;

    const authorizationStore = createFileAccountAuthorizationStore(join(root, "authorization.json"));
    const grant = await authorizationStore.putGrant({
      accountId,
      scopes: ["org:read", "org:write", "members:read", "members:write", "routing:resolve"],
      allWorkspaces: true,
      workspaceIds: [],
      machineIds: [machineId],
      memberIds: [],
      updatedAt: new Date().toISOString(),
    });
    const workspaceAuth = createWorkspaceAuthorization({ authService, store: authorizationStore });
    const routes = {
      async get(requested) {
        if (requested !== machineId) return undefined;
        return {
          machineId,
          daemonHostId,
          capabilities: { transportKind: "websocket", channelKinds: ["terminal"] },
          target: {
            bridgeHost: "127.0.0.1",
            bridgePort: fixturePort,
            authToken,
            daemonHostId,
            relayHostId: daemonHostId,
            relayEndpointCandidates: [],
            transportMode: "websocket",
          },
          settings: { transportMode: "websocket" },
        };
      },
    };
    const authorizationPort = createAccountsAuthorizationPort({
      token,
      authService,
      machineService,
      routes,
    });
    const manager = createConnectionManager({
      authorizationPort,
      transport: new V1TraversalTransport(),
    });
    const originalConnect = manager.connect.bind(manager);
    const originalOpenChannel = manager.openChannel.bind(manager);
    const originalSendChannel = manager.sendChannel.bind(manager);
    manager.connect = async (...args) => {
      const current = await originalConnect(...args);
      link = current;
      sideEffects.connects += 1;
      closeOwnedLink = () => manager.closeOwnLink(current);
      return current;
    };
    manager.openChannel = (...args) => {
      sideEffects.channelOpens += 1;
      return originalOpenChannel(...args);
    };
    manager.sendChannel = (channel, data) => {
      sideEffects.inputWrites += 1;
      return originalSendChannel(channel, data);
    };

    const organization = createOrganizationService({
      store: createOrganizationStore(join(root, "organization.json")),
      auth: workspaceAuth,
    });
    const membersStorePath = join(root, "members.json");
    const members = createMembersService({
      store: createBindingStore(membersStorePath),
      auth: workspaceAuth,
      organization,
      hostProbe: createTmuxHostProbe({ socketName: "tmux.sock", machineId }),
    });
    // The host-probe-injected service can only persist the probe's observed
    // socketPath-carrying stableId. The live V1 catalog omits socketPath, so a
    // catalog-conformant assertion is refused by bindSession. Keep a second
    // service on the same store without a host probe so the positive revocation
    // fixture can persist the catalog identity. The host-producer mismatch is
    // recorded separately as an architecture finding; this second service is a
    // test harness for the revocation path, not a production binding producer.
    const membersNoProbe = createMembersService({
      store: createBindingStore(membersStorePath),
      auth: workspaceAuth,
      organization,
      hostProbe: null,
    });
    const workspace = await organization.createWorkspace({ token, name: "P13" });
    const group = await organization.createGroup({
      token,
      workspaceId: workspace.workspaceId,
      name: "team",
      expectedRevision: workspace.revision,
    });
    const member = await organization.addMember({
      token,
      workspaceId: workspace.workspaceId,
      groupId: group.groupId,
      name: "Worker",
      expectedRevision: group.revision,
    });
    await members.configureRuntime({
      token,
      memberId: member.memberId,
      machineId,
      hostKind: "tmux",
      agentKind: "codex",
      launchProfileRef: "lp-p13",
    });

    const routing = createRoutingService({ organization, members: membersNoProbe, auth: workspaceAuth });
    const machineTerminal = createConnectionMachineTerminal({
      connectionManager: manager,
      authorizationPort,
    });
    daemon = await startDaemon({
      port: 0,
      host: "127.0.0.1",
      v2Token: token,
      admission: {
        auth: workspaceAuth,
        members: membersNoProbe,
        routing,
        machineTerminal,
        resolveBindingTarget: membersNoProbe.resolveBindingTarget,
      },
      log: () => {},
    });
    const base = `http://127.0.0.1:${daemon.server.address().port}`;
    const headers = { authorization: `Bearer ${token}` };
    const streamQuery = (binding) => new URLSearchParams({
      workspaceId: workspace.workspaceId,
      memberId: member.memberId,
      machineId,
      groupPath: group.path,
      expectedGeneration: String(binding.generation),
      backend: "tmux",
      stableId: binding.terminalTarget?.stableId || alphaStableId,
    });
    const streamRequest = (binding) => fetch(`${base}/api/terminal/stream?${streamQuery(binding)}`, { headers });
    const inputRequest = (binding, data) => fetch(`${base}/api/terminal/input`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.workspaceId,
        memberId: member.memberId,
        machineId,
        groupPath: group.path,
        expectedGeneration: binding.generation,
        target: binding.terminalTarget,
        data,
      }),
    });
    const recordResponse = async (name, response) => {
      let body;
      const contentType = response.headers.get("content-type") || "";
      if (response.status === 200 && contentType.includes("text/event-stream")) {
        // A successful stream is SSE and never ends; read only until the first
        // authoritative event, then cancel so the receipt can be written.
        const sse = await readSseUntil(
          response,
          (event) => event.event === "ready" || event.event === "buffer",
        );
        body = { sse: true, matched: sse.matched, events: sse.events };
      } else {
        body = await response.json().catch(() => null);
      }
      const record = { status: response.status, body, sideEffects: { ...sideEffects } };
      await writeReceipt(name, JSON.stringify(record, null, 2));
      return record;
    };

    // Host-producer binding: persist the observed target through the
    // host-probe-injected members service, then try the real supported daemon
    // stream. The public producer identity includes socketPath while the live
    // V1 catalog omits it, so the exact-match resolver is expected to refuse.
    // Record that typed refusal as expected evidence and continue the probe.
    let hostBinding = null;
    let hostStream = null;
    try {
      hostBinding = await members.bindSession({
        token,
        memberId: member.memberId,
        sessionId: hostObservation.sessionId,
        anchor: "%0",
        expectedGeneration: 0,
        terminalTarget: hostObservation.terminalTarget,
      });
      hostStream = await recordResponse("p13-host-producer-stream.json", await streamRequest(hostBinding));
    } catch (error) {
      hostStream = {
        expectedRefusal: true,
        stage: "host-producer-binding",
        name: error?.name || null,
        code: error?.code || null,
        status: error?.status || null,
        owningModule: error?.owningModule || null,
        message: error?.message || String(error),
      };
      await writeReceipt("p13-host-producer-stream.json", JSON.stringify(hostStream, null, 2));
    }
    const expectedCatalogGeneration = hostBinding ? hostBinding.generation : 0;

    // Rebind to the live V1 catalog identity to establish the positive path.
    // membersNoProbe persists the asserted catalog target without a host
    // observation, because the host-probe-injected service cannot produce a
    // catalog-conformant stableId (recorded above as an architecture finding).
    const catalogBinding = await membersNoProbe.bindSession({
      token,
      memberId: member.memberId,
      sessionId: alpha,
      anchor: "%0",
      expectedGeneration: expectedCatalogGeneration,
      terminalTarget: { backend: "tmux", stableId: alphaStableId },
    });
    const positiveStream = await streamRequest(catalogBinding);
    const positiveEvents = await readSseUntil(
      positiveStream,
      (event) => event.event === "ready" || event.event === "buffer",
    );
    await writeReceipt("p13-positive-stream.json", JSON.stringify({
      status: positiveStream.status,
      events: positiveEvents.events,
      sideEffects: { ...sideEffects },
    }, null, 2));
    const positiveInput = await recordResponse(
      "p13-positive-input.json",
      await inputRequest(catalogBinding, "echo P13_POSITIVE\r"),
    );

    // Revoke the accounts grant while the live machine transport stays connected.
    const linkBeforeRevoke = manager.observeLink(link);
    const revoked = await authorizationStore.deleteGrant(accountId);
    assert.ok(revoked, "grant must exist before revocation");
    const linkAfterRevoke = manager.observeLink(link);
    await writeReceipt("p13-live-link-after-grant-revoke.json", JSON.stringify({
      beforeRevoke: linkBeforeRevoke,
      afterRevoke: linkAfterRevoke,
      transportStayedConnected: linkAfterRevoke.status === "connected"
        && linkAfterRevoke.freshness === "fresh",
    }, null, 2));

    const grantRevokedStream = await recordResponse(
      "p13-grant-revoked-stream.json",
      await streamRequest(catalogBinding),
    );
    const grantRevokedInput = await recordResponse(
      "p13-grant-revoked-input.json",
      await inputRequest(catalogBinding, "echo P13_REVOKED\r"),
    );

    // Direct admission receipt: the same owners throw the accounts-owned typed
    // error at the admission boundary even when the HTTP mapper collapses it.
    let directAdmissionError = null;
    try {
      const { createTerminalAdmission } = await import("../../../modules/daemon/src/terminal-admission.mjs");
      const admission = createTerminalAdmission({
        auth: workspaceAuth,
        members: membersNoProbe,
        routing,
        machineTerminal,
        resolveBindingTarget: membersNoProbe.resolveBindingTarget,
        terminal: { listSessions: async () => [], input: async () => ({}) },
        log: () => {},
      });
      await admission.admit({
        callerToken: token,
        workspaceId: workspace.workspaceId,
        memberId: member.memberId,
        machineId,
        groupPath: group.path,
        expectedGeneration: catalogBinding.generation,
        target: catalogBinding.terminalTarget,
      });
    } catch (error) {
      directAdmissionError = {
        name: error?.name || null,
        code: error?.code || null,
        status: error?.status || null,
        owningModule: error?.owningModule || null,
        message: error?.message || String(error),
      };
    }
    await writeReceipt("p13-grant-revoked-direct-admission.json", JSON.stringify(directAdmissionError, null, 2));

    // Restore the grant, then revoke the machine at the relay while the same
    // live link is still connected.
    await authorizationStore.putGrant({
      ...grant,
      updatedAt: new Date().toISOString(),
    });
    const machineRevoked = await machineService.revokeMachine(token, { machineId });
    const linkAfterMachineRevoke = manager.observeLink(link);
    await writeReceipt("p13-live-link-after-machine-revoke.json", JSON.stringify({
      revokedMachine: {
        machineId: machineRevoked.machineId,
        status: machineRevoked.status || null,
        deviceName: machineRevoked.deviceName || null,
      },
      observation: linkAfterMachineRevoke,
      transportStayedConnected: linkAfterMachineRevoke.status === "connected"
        && linkAfterMachineRevoke.freshness === "fresh",
    }, null, 2));
    const machineRevokedStream = await recordResponse(
      "p13-machine-revoked-stream.json",
      await streamRequest(catalogBinding),
    );
    const machineRevokedInput = await recordResponse(
      "p13-machine-revoked-input.json",
      await inputRequest(catalogBinding, "echo P13_MACHINE_REVOKED\r"),
    );

    const result = {
      ok: true,
      probe: "p13-revocation-probe",
      supportedEntry: "startDaemon",
      fixture: { port: fixturePort, alpha, alphaStableId, daemonHostId },
      account: { accountId, machineId },
      hostProducer: {
        hostBindingSucceeded: hostBinding !== null,
        stableId: hostProbeStableId,
        catalogStableId: alphaStableId,
        equal: hostProbeStableId === alphaStableId,
        streamStatus: hostStream?.status ?? null,
        streamError: hostStream?.body?.error ?? (hostStream?.expectedRefusal ? hostStream : null),
        acceptedByDaemon: hostStream?.status === 200,
      },
      positive: {
        streamStatus: positiveStream.status,
        inputStatus: positiveInput.status,
      },
      grantRevocation: {
        liveTransportStayedConnected: linkAfterRevoke.status === "connected"
          && linkAfterRevoke.freshness === "fresh",
        streamStatus: grantRevokedStream.status,
        streamError: grantRevokedStream.body?.error || null,
        inputStatus: grantRevokedInput.status,
        inputError: grantRevokedInput.body?.error || null,
        directAdmissionError,
        sideEffectsAfterRevoke: grantRevokedInput.sideEffects,
      },
      machineRevocation: {
        liveTransportStayedConnected: linkAfterMachineRevoke.status === "connected"
          && linkAfterMachineRevoke.freshness === "fresh",
        streamStatus: machineRevokedStream.status,
        streamError: machineRevokedStream.body?.error || null,
        inputStatus: machineRevokedInput.status,
        inputError: machineRevokedInput.body?.error || null,
        sideEffectsAfterRevoke: machineRevokedInput.sideEffects,
      },
    };
    await writeReceipt("p13-result.json", JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    await writeReceipt("p13-error.txt", error?.stack || String(error));
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (daemon) {
      try { closeOwnedLink(); } catch {}
      daemon.server.close();
      await new Promise((resolve) => daemon.server.close(resolve));
    }
    await stopRelay(relay.child);
    await rm(relay.tempRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
