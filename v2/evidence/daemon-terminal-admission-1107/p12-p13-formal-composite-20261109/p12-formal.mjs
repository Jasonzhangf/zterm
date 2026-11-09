import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startDaemon } from "../../../modules/daemon/src/main.mjs";
import { createConnectionMachineTerminal } from "../../../modules/daemon/src/machine-terminal-consumer.mjs";
import { createConnectionManager, V1TraversalTransport } from "../../../modules/connections/src/public/index.mjs";
import { TerminalPort } from "../../../modules/terminal/src/public/index.mjs";
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
  const tempRoot = await mkdtemp(join(tmpdir(), "zterm-p12-relay-"));
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
    return { child, tempRoot, baseUrl, port, output };
  } catch (error) {
    await stopRelay(child);
    await rm(tempRoot, { recursive: true, force: true });
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output.join("")}`);
  }
}

function tmux(socket, args) {
  return execFileSync("tmux", ["-S", socket, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function tmuxCapture(socket, target) {
  return tmux(socket, ["capture-pane", "-p", "-t", target]);
}

function tmuxList(socket) {
  return tmux(socket, ["list-sessions", "-F", "#{session_name}|#{session_id}|#{pid}"]);
}

function tmuxServerPid(socket) {
  return tmux(socket, ["display-message", "-p", "#{pid}"]).trim();
}

function uniqueIdentity(label) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return { loginName: `${label}-${suffix}`, credential: `pw-${suffix}` };
}

function createSseReader(response) {
  assert.equal(response.status, 200, `SSE status was ${response.status}`);
  const events = [];
  const waiters = new Set();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let pumpError = null;

  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
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
          try {
            parsed = JSON.parse(dataLines.join("\n"));
          } catch {}
          const entry = { event, parsed, raw };
          events.push(entry);
          for (const waiter of [...waiters]) {
            if (waiter.predicate(entry)) {
              waiters.delete(waiter);
              clearTimeout(waiter.timer);
              waiter.resolve(entry);
            }
          }
        }
      }
    } catch (error) {
      pumpError = error;
      for (const waiter of [...waiters]) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
  })();

  function waitFor(predicate, timeoutMs, label) {
    const existing = events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`timeout waiting for ${label} after ${timeoutMs}ms`));
      }, timeoutMs);
      const waiter = { predicate, resolve, reject, timer };
      waiters.add(waiter);
    });
  }

  async function close() {
    try {
      await reader.cancel();
    } catch {}
    await pump;
    if (pumpError) throw pumpError;
  }

  return { events, waitFor, close };
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
}

const main = async () => {
  const startedAt = new Date().toISOString();
  const fixture = await readFixtureState();
  const authToken = fixture.authToken;
  const fixturePort = fixture.port;
  const alpha = fixture.alpha;
  const alphaStableId = fixture.alphaStableId;
  const socket = fixture.tmuxSocketPath;
  const daemonHostId = (await readFile(join(fixture.homeDir, ".zterm", "daemon-id"), "utf8")).trim();
  assert.equal(fixture.status, "running", "fixture must be running");
  assert.ok(authToken, "fixture must provide an auth token");
  assert.ok(alphaStableId, "fixture must provide the catalog stableId");
  assert.ok(socket, "fixture must provide a dedicated tmux socket");

  process.env.TMUX_TMPDIR = fixture.tempRoot;
  await writeReceipt("p12-command.txt", [
    `startedAt=${startedAt}`,
    `fixtureLatest=${fixtureLatestFile}`,
    `argv=${JSON.stringify(process.argv)}`,
    `node=${process.version}`,
    `cwd=${process.cwd()}`,
  ].join("\n"));

  const relay = await startRelay();
  const root = await mkdtemp(join(tmpdir(), "zterm-p12-accounts-"));
  let daemon = null;
  let sse = null;
  let link = null;
  let closeOwnedLink = () => {};
  let terminal = null;
  const sideEffects = { connects: 0, channelOpens: 0, inputWrites: 0 };
  try {
    const relayAdapter = new V1RelayAdapter({ baseUrl: relay.baseUrl });
    const authService = new AuthService({ authority: relayAdapter });
    const machineService = new MachineService({
      machineReg: relayAdapter,
      verifySession: (token) => authService.verifySession(token),
    });
    const identity = uniqueIdentity("p12-owner");
    const registered = await authService.register(identity);
    const login = await authService.login(identity);
    const token = login.token;
    const accountId = registered.accountId;
    const verified = await authService.verifySession(token);
    await writeReceipt("p12-auth-debug.json", JSON.stringify({
      tokenType: typeof token,
      tokenLength: typeof token === "string" ? token.length : null,
      accountId,
      verifiedAccountId: verified.accountId,
      verifiedSessionIdLength: typeof verified.sessionId === "string" ? verified.sessionId.length : null,
      relayBaseUrl: relay.baseUrl,
    }, null, 2));
    const enrolled = await machineService.enrollMachine(token, {
      deviceId: `p12-device-${Date.now()}`,
      deviceToken: `p12-proof-${Date.now()}`,
      displayName: "P12 Fixture Machine",
    });
    const machineId = enrolled.machineId;

    const authorizationStore = createFileAccountAuthorizationStore(join(root, "authorization.json"));
    await authorizationStore.putGrant({
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
    terminal = new TerminalPort({
      wsUrl: `ws://127.0.0.1:${fixturePort}/ws?token=${encodeURIComponent(authToken)}`,
      clientInstanceId: `p12-formal-${Date.now()}`,
      log: () => {},
    });
    const terminalInput = terminal.input.bind(terminal);
    const terminalSubscribe = terminal.subscribe.bind(terminal);
    terminal.input = async (...args) => {
      sideEffects.inputWrites += 1;
      return terminalInput(...args);
    };
    terminal.subscribe = (...args) => {
      sideEffects.channelOpens += 1;
      return terminalSubscribe(...args);
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
    const membersNoProbe = createMembersService({
      store: createBindingStore(membersStorePath),
      auth: workspaceAuth,
      organization,
      hostProbe: null,
    });
    const workspace = await organization.createWorkspace({ token, name: "P12" });
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
      launchProfileRef: "lp-p12",
    });
    const binding = await membersNoProbe.bindSession({
      token,
      memberId: member.memberId,
      sessionId: alpha,
      anchor: "%0",
      expectedGeneration: 0,
      terminalTarget: { backend: "tmux", stableId: alphaStableId },
    });
    const routing = createRoutingService({ organization, members: membersNoProbe, auth: workspaceAuth });
    const machineTerminal = createConnectionMachineTerminal({
      connectionManager: manager,
      authorizationPort,
      terminal,
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
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object", "daemon must expose a listening address");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { authorization: `Bearer ${token}` };
    const query = new URLSearchParams({
      workspaceId: workspace.workspaceId,
      memberId: member.memberId,
      machineId,
      groupPath: group.path,
      expectedGeneration: String(binding.generation),
      backend: "tmux",
      stableId: alphaStableId,
    });

    const processReceipt = {
      probe: "p12-committed-frame-probe",
      supportedEntry: "startDaemon",
      startedAt,
      probePid: process.pid,
      v2Daemon: {
        pid: process.pid,
        host: address.address,
        port: address.port,
        listening: daemon.server.listening === true,
      },
      fixture: {
        daemonPid: fixture.daemonPid,
        port: fixturePort,
        tmuxSocketPath: socket,
        tmuxServerPid: tmuxServerPid(socket),
        alpha,
        alphaStableId,
        daemonHostId,
      },
      relay: {
        pid: relay.child.pid,
        port: relay.port,
        baseUrl: relay.baseUrl,
        health: "200",
      },
      tmuxSessions: tmuxList(socket).trim().split("\n").filter(Boolean),
    };
    await writeReceipt("p12-process-receipt.json", JSON.stringify(processReceipt, null, 2));
    await writeReceipt("p12-config-sanitized.json", JSON.stringify({
      fixture: {
        port: fixturePort,
        tmuxSocketPath: socket,
        alpha,
        alphaStableId,
        daemonHostId,
      },
      relay: { baseUrl: relay.baseUrl, port: relay.port },
      v2Daemon: { host: address.address, port: address.port },
      auth: "bearer token redacted",
      binding: {
        backend: binding.terminalTarget?.backend,
        stableId: binding.terminalTarget?.stableId,
        generation: binding.generation,
      },
    }, null, 2));

    const streamResponse = await fetch(`${base}/api/terminal/stream?${query}`, { headers });
    if (streamResponse.status !== 200) {
      const body = await streamResponse.text().catch(() => "");
      await writeReceipt("p12-stream-error.json", JSON.stringify({
        status: streamResponse.status,
        body,
      }, null, 2));
      throw new Error(`stream status was ${streamResponse.status}: ${body}`);
    }
    sse = createSseReader(streamResponse);
    const ready = await sse.waitFor((event) => event.event === "ready", 15000, "SSE ready");
    let initialFrame = null;
    try {
      initialFrame = await sse.waitFor(
        (event) => event.event === "buffer"
          && typeof event.parsed?.buffer === "string"
          && event.parsed.buffer.length > 0,
        3000,
        "initial committed terminal body frame",
      );
    } catch {}

    const nonce = `p12${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const command = `printf 'P12OUT_${nonce}_'; od -An -N4 -tx1 /dev/urandom | tr -d ' \\n'; printf '\\n'`;
    const inputText = `${command}\r`;
    assert.equal(Buffer.from(inputText).subarray(-1).toString("hex"), "0d", "input must end with a real CR byte");
    const inputResponse = await fetch(`${base}/api/terminal/input`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.workspaceId,
        memberId: member.memberId,
        machineId,
        groupPath: group.path,
        expectedGeneration: binding.generation,
        target: binding.terminalTarget,
        data: inputText,
      }),
    });
    const inputPayload = await inputResponse.json().catch(() => null);
    assert.equal(inputResponse.status, 200, `input status was ${inputResponse.status}`);

    const markerPattern = new RegExp(`P12OUT_${nonce}_([0-9a-f]{8})`);
    const outputFrame = await sse.waitFor(
      (event) => event.event === "buffer"
        && typeof event.parsed?.buffer === "string"
        && markerPattern.test(event.parsed.buffer),
      20000,
      "unique output committed terminal body frame",
    );
    const match = markerPattern.exec(outputFrame.parsed.buffer);
    assert.ok(match, "output frame must contain the unique marker");
    const uniqueToken = match[1];
    assert.ok(!inputText.includes(uniqueToken), "unique output token must not be present in input text");
    const outputMarker = `P12OUT_${nonce}_${uniqueToken}`;
    const alphaCapture = tmuxCapture(socket, alpha);
    assert.ok(alphaCapture.includes(outputMarker), "tmux capture must contain the executed output");

    await writeReceipt("p12-stream-ready.json", JSON.stringify(ready, null, 2));
    if (initialFrame) {
      await writeReceipt("p12-initial-committed-frame.json", JSON.stringify(initialFrame, null, 2));
    }
    await writeReceipt("p12-input-request.txt", [
      `input_text=${inputText.replace(/\r$/, "<CR>")}`,
      `last_byte_hex=${Buffer.from(inputText).subarray(-1).toString("hex")}`,
      `nonce=${nonce}`,
      `unique_token_in_input_text=${inputText.includes(uniqueToken)}`,
    ].join("\n"));
    await writeReceipt("p12-input-response.json", JSON.stringify(inputPayload, null, 2));
    await writeReceipt("p12-unique-output-frame.json", JSON.stringify(outputFrame, null, 2));
    await writeReceipt("p12-unique-output.txt", [
      `input_text=${inputText.replace(/\r$/, "<CR>")}`,
      `output_marker=${outputMarker}`,
      `unique_token=${uniqueToken}`,
      `token_in_input_text=${inputText.includes(uniqueToken)}`,
      `stream_frame_has_output=${outputFrame.parsed.buffer.includes(outputMarker)}`,
      `tmux_capture_has_output=${alphaCapture.includes(outputMarker)}`,
      "--- tmux capture (alpha) ---",
      alphaCapture,
    ].join("\n"));
    await writeReceipt("p12-sse-events.json", JSON.stringify(sse.events, null, 2));
    await writeReceipt("p12-side-effects.json", JSON.stringify({
      afterPositive: sideEffects,
      linkObserved: link ? manager.observeLink(link) : null,
    }, null, 2));

    const result = {
      ok: true,
      probe: "p12-committed-frame-probe",
      supportedEntry: "startDaemon",
      fixture: { port: fixturePort, alpha, alphaStableId, daemonHostId },
      stream: {
        readySeen: true,
        committedInitialFrameObserved: initialFrame !== null,
        committedOutputFrameObserved: true,
      },
      input: {
        lastByteHex: Buffer.from(inputText).subarray(-1).toString("hex"),
        crReal: Buffer.from(inputText).subarray(-1).toString("hex") === "0d",
      },
      uniqueOutput: {
        marker: outputMarker,
        token: uniqueToken,
        tokenInInputText: inputText.includes(uniqueToken),
        streamFrameConfirmed: true,
        tmuxCaptureConfirmed: true,
      },
      sideEffectsAfterPositive: sideEffects,
      completedAt: new Date().toISOString(),
    };
    await writeReceipt("p12-result.json", JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (sse) {
      try {
        await writeReceipt("p12-sse-events-on-error.json", JSON.stringify(sse.events, null, 2));
      } catch {}
    }
    try {
      await writeReceipt("p12-tmux-capture-on-error.txt", tmuxCapture(socket, alpha));
    } catch {}
    await writeReceipt("p12-side-effects-on-error.json", JSON.stringify(sideEffects, null, 2));
    await writeReceipt("p12-error.txt", error?.stack || String(error));
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (sse) {
      try { await sse.close(); } catch {}
    }
    if (terminal) {
      try { terminal.close(); } catch {}
    }
    if (daemon) {
      try { closeOwnedLink(); } catch {}
      await closeServer(daemon.server);
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
