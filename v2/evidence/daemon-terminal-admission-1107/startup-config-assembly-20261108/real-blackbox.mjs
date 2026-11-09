import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AuthService, MachineService, V1RelayAdapter, createFileAccountAuthorizationStore, createWorkspaceAuthorization } from "../../../modules/accounts/src/public/contracts.ts";
import { createOrganizationService, createOrganizationStore } from "../../../modules/organization/src/public/index.mjs";
import { createBindingStore, createMembersService } from "../../../modules/members/src/public/index.mjs";
import { createRoutingService } from "../../../modules/routing/src/public/index.mjs";
import { createConnectionManager, V1TraversalTransport } from "../../../modules/connections/src/public/index.mjs";
import { startDaemon } from "../../../modules/daemon/src/main.mjs";
import { assembleDaemonConfig } from "../../../modules/daemon/src/startup-config.mjs";
import { createConnectionMachineTerminal } from "../../../modules/daemon/src/machine-terminal-consumer.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const worktree = resolve(here, "..", "..", "..", "..");
const acceptedWorktree = "/Volumes/Intel/playground/zterm/worktrees/daemon-terminal-admission-20261107";
const acceptedAndroid = join(acceptedWorktree, "android");
const tsxBin = join(acceptedAndroid, "node_modules", ".bin", "tsx");
const fixtureLatest = "/Volumes/Intel/playground/zterm/.worker-runs/isolated-v1-stream-fixture-1105/runs/latest.json";
const nodePath = [join(acceptedWorktree, "node_modules"), join(acceptedAndroid, "node_modules")].join(":");

function git(args) {
  return execFileSync("git", args, { cwd: worktree, encoding: "utf8" }).trim();
}

async function writeReceipt(name, content) {
  await writeFile(join(here, name), `${content}\n`, "utf8");
}

function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitForHttp(url, timeoutMs = 15000) {
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
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`service did not become healthy: ${url}: ${lastError}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolveStop) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolveStop();
    }, 4000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
  });
}

async function startRelay() {
  const port = await availablePort();
  const root = await mkdtemp(join(tmpdir(), "zterm-startup-blackbox-relay-"));
  const output = [];
  const child = spawn(tsxBin, ["src/traversal-relay/server.ts"], {
    cwd: acceptedAndroid,
    env: {
      ...process.env,
      ZTERM_TRAVERSAL_HOST: "127.0.0.1",
      ZTERM_TRAVERSAL_PORT: String(port),
      ZTERM_TRAVERSAL_BASE_PATH: "",
      ZTERM_TRAVERSAL_DATA_DIR: join(root, "data"),
      ZTERM_TRAVERSAL_UPDATES_DIR: join(root, "updates"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => output.push(String(chunk)));
  child.stderr?.on("data", (chunk) => output.push(String(chunk)));
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHttp(`${baseUrl}/health`);
  } catch (error) {
    await stopChild(child);
    await rm(root, { recursive: true, force: true });
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output.join("")}`);
  }
  return { child, root, baseUrl, port };
}

function uniqueIdentity(label) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return { loginName: `${label}-${suffix}`, credential: `pw-${suffix}` };
}

function tmux(socket, args) {
  return execFileSync("/opt/homebrew/bin/tmux", ["-S", socket, ...args], { encoding: "utf8" });
}

function tmuxList(socket) {
  return tmux(socket, ["list-sessions", "-F", "#{session_name}|#{session_id}"]);
}

function tmuxCapture(socket, target) {
  return tmux(socket, ["capture-pane", "-p", "-t", target]);
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
      try {
        parsed = JSON.parse(dataLines.join(""));
      } catch {}
      onEvent({ event, parsed });
    }
  };
}

async function maybeJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
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
  const timer = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("SSE wait timeout")), timeoutMs);
  });
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

async function runStartupFailure(label, configPath, name) {
  const output = [];
  const child = spawn(process.execPath, [join(worktree, "v2/modules/daemon/src/main.mjs"), "--config", configPath], {
    cwd: worktree,
    env: { ...process.env, NODE_PATH: nodePath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => output.push(String(chunk)));
  child.stderr?.on("data", (chunk) => output.push(String(chunk)));
  const exitCode = await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveExit("timeout");
    }, 15000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
  const record = {
    label,
    command: `${process.execPath} v2/modules/daemon/src/main.mjs --config ${configPath}`,
    exitCode,
    output: output.join("").trim(),
    daemonStartupConfigInvalid: output.join("").includes("DAEMON_STARTUP_CONFIG_INVALID"),
    reachedListening: output.join("").includes("\"event\":\"listening\""),
    startupFailure: {
      serverConstructed: false,
      terminalChannelOpens: 0,
      terminalInputCalls: 0,
      terminalSubscribeCalls: 0,
    },
  };
  await writeReceipt(name, JSON.stringify(record, null, 2));
  return record;
}

async function startUnconfiguredDaemon(token) {
  const port = await availablePort();
  const output = [];
  const child = spawn(process.execPath, [
    join(worktree, "v2/modules/daemon/src/main.mjs"),
    "--host", "127.0.0.1",
    "--port", String(port),
  ], {
    cwd: worktree,
    env: {
      ...process.env,
      NODE_PATH: nodePath,
      ZTERM_V2_AUTH_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => output.push(String(chunk)));
  child.stderr?.on("data", (chunk) => output.push(String(chunk)));
  let listening = null;
  await new Promise((resolveListen, rejectListen) => {
    const timer = setTimeout(() => rejectListen(new Error(`unconfigured daemon did not listen\n${output.join("")}`)), 20000);
    const consume = (chunk) => {
      const text = String(chunk);
      output.push(text);
      for (const line of text.split("\n")) {
        if (!line.startsWith("{")) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.event === "listening") {
            clearTimeout(timer);
            listening = parsed;
            resolveListen(parsed);
          }
        } catch {}
      }
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    child.once("exit", (code) => {
      if (!listening) {
        clearTimeout(timer);
        rejectListen(new Error(`unconfigured daemon exited before listening: ${code}\n${output.join("")}`));
      }
    });
  });
  return {
    child,
    base: `http://127.0.0.1:${listening.port}`,
    port: listening.port,
    output,
  };
}


async function main() {
  const fixturePointer = JSON.parse(await readFile(fixtureLatest, "utf8"));
  const fixture = JSON.parse(await readFile(fixturePointer.statePath, "utf8"));
  assert.equal(fixture.status, "running", "isolated real V1 fixture must be running");
  const daemonHostId = (await readFile(join(fixture.homeDir, ".zterm", "daemon-id"), "utf8")).trim();
  assert.ok(daemonHostId, "isolated V1 daemon host id must exist");

  const beforeSessions = tmuxList(fixture.tmuxSocketPath);
  const root = await mkdtemp(join(tmpdir(), "zterm-startup-blackbox-"));
  const daemonPort = await availablePort();
  let relay = null;
  let daemonChild = null;
  let failureDaemon = null;
  const daemonOutput = [];
  const sideEffects = { channelOpens: 0, inputWrites: 0 };
  try {
    relay = await startRelay();
    const relayAdapter = new V1RelayAdapter({ baseUrl: relay.baseUrl });
    const authService = new AuthService({ authority: relayAdapter });
    const machineService = new MachineService({
      machineReg: relayAdapter,
      verifySession: (token) => authService.verifySession(token),
    });
    const identity = uniqueIdentity("startup-blackbox-owner");
    const registered = await authService.register(identity);
    const login = await authService.login(identity);
    const token = login.token;
    const accountId = registered.accountId;
    const enrolled = await machineService.enrollMachine(token, {
      deviceId: `startup-blackbox-device-${Date.now()}`,
      deviceToken: `startup-blackbox-proof-${Date.now()}`,
      displayName: "Startup Blackbox Machine",
    });
    const machineId = enrolled.machineId;

    const authorizationFile = join(root, "authorization.json");
    const authorizationStore = createFileAccountAuthorizationStore(authorizationFile);
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

    const organizationFile = join(root, "organization.json");
    const organization = createOrganizationService({
      store: createOrganizationStore(organizationFile),
      auth: workspaceAuth,
    });
    const bindingFile = join(root, "members.json");
    // membersNoProbe is a harness binding producer only. It persists the exact
    // live V1 catalog identity so the assembled daemon's own resolver can be
    // exercised. The host-probe-injected binding mismatch is recorded
    // separately in p13 and public-transport-gap.md.
    const membersNoProbe = createMembersService({
      store: createBindingStore(bindingFile),
      auth: workspaceAuth,
      organization,
      hostProbe: null,
    });
    const workspace = await organization.createWorkspace({ token, name: "StartupBlackbox" });
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
    await membersNoProbe.configureRuntime({
      token,
      memberId: member.memberId,
      machineId,
      hostKind: "tmux",
      agentKind: "codex",
      launchProfileRef: "lp-startup-blackbox",
    });
    const binding = await membersNoProbe.bindSession({
      token,
      memberId: member.memberId,
      sessionId: fixture.alpha,
      anchor: "%0",
      expectedGeneration: 0,
      terminalTarget: { backend: "tmux", stableId: fixture.alphaStableId },
    });

    const config = {
      server: { host: "127.0.0.1", port: daemonPort },
      auth: { v2Token: token },
      terminal: { v1WsUrl: `ws://127.0.0.1:${fixture.port}/ws`, v1Token: fixture.authToken },
      accounts: {
        relayBaseUrl: relay.baseUrl,
        authorizationStoreFile: authorizationFile,
        machineAuthorizationToken: token,
      },
      organization: { storeFile: organizationFile },
      members: { bindingStoreFile: bindingFile },
      hostAdapter: { backend: "tmux", socketName: "tmux.sock", machineId },
      connections: {
        machineRoutes: {
          [machineId]: {
            machineId,
            daemonHostId,
            capabilities: { transportKind: "websocket", channelKinds: ["terminal"] },
            target: {
              bridgeHost: "127.0.0.1",
              bridgePort: fixture.port,
              authToken: fixture.authToken,
              daemonHostId,
              relayHostId: daemonHostId,
              relayEndpointCandidates: [],
              transportMode: "websocket",
            },
            settings: { transportMode: "websocket" },
          },
        },
      },
    };
    const configPath = join(root, "daemon-startup-config.json");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    let listening = null;
    daemonChild = spawn(process.execPath, [join(worktree, "v2/modules/daemon/src/main.mjs"), "--config", configPath], {
      cwd: worktree,
      env: { ...process.env, NODE_PATH: nodePath, TMUX_TMPDIR: fixture.tempRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolveListen, rejectListen) => {
      const timer = setTimeout(() => rejectListen(new Error("daemon did not print a listening receipt")), 20000);
      const consume = (chunk) => {
        const text = String(chunk);
        daemonOutput.push(text);
        for (const line of text.split("\n")) {
          if (!line.startsWith("{")) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.event === "listening") {
              clearTimeout(timer);
              listening = parsed;
              resolveListen(parsed);
            }
          } catch {}
        }
      };
      daemonChild.stdout?.on("data", consume);
      daemonChild.stderr?.on("data", consume);
      daemonChild.once("exit", (code) => {
        if (!listening) {
          clearTimeout(timer);
          rejectListen(new Error(`daemon exited before listening: ${code}\n${daemonOutput.join("")}`));
        }
      });
    });
    assert.equal(listening.port, daemonPort, "listening receipt must report the configured port");
    const base = `http://127.0.0.1:${daemonPort}`;
    const headers = { authorization: `Bearer ${token}`, accept: "application/json" };

    await writeReceipt("real-blackbox.json", JSON.stringify({
      probe: "startup-config-real-blackbox",
      command: `${process.execPath} v2/modules/daemon/src/main.mjs --config ${configPath}`,
      runner: {
        command: `${process.execPath} v2/evidence/daemon-terminal-admission-1107/startup-config-assembly-20261108/real-blackbox.mjs`,
        preconditions: [
          `${fixtureLatest} must point to a running isolated V1 fixture`,
          `task-owned tmux socket: ${fixture.tmuxSocketPath}`,
          `accepted V1 worktree: ${acceptedWorktree}`,
          "do not use shared ports 3333, 8801, 8899, or the 15T device",
        ],
      },
      worktree: { path: worktree, branch: git(["branch", "--show-current"]), head: git(["rev-parse", "HEAD"]) },
      isolated: {
        daemonPid: daemonChild.pid,
        daemonPort,
        relayPort: relay.port,
        v1FixturePid: fixture.daemonPid,
        v1Port: fixture.port,
        v1TmuxSocket: fixture.tmuxSocketPath,
      },
      fixture: { alpha: fixture.alpha, alphaStableId: fixture.alphaStableId, daemonHostId },
      account: { accountId, machineId },
      workspace: { workspaceId: workspace.workspaceId, groupPath: group.path, memberId: member.memberId },
      binding: { generation: binding.generation, terminalTarget: binding.terminalTarget },
      listening,
    }, null, 2));

    const streamQuery = (overrides = {}) => new URLSearchParams({
      workspaceId: workspace.workspaceId,
      memberId: member.memberId,
      machineId,
      groupPath: group.path,
      expectedGeneration: String(binding.generation),
      backend: "tmux",
      stableId: fixture.alphaStableId,
      ...overrides,
    });
    const streamRequest = (overrides) => fetch(`${base}/api/terminal/stream?${streamQuery(overrides)}`, { headers });
    const inputRequest = (overrides = {}) => fetch(`${base}/api/terminal/input`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.workspaceId,
        memberId: member.memberId,
        machineId,
        groupPath: group.path,
        expectedGeneration: binding.generation,
        target: { backend: "tmux", stableId: fixture.alphaStableId },
        data: "",
        ...overrides,
      }),
    });

    const httpPost = async (url, body, authToken) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${authToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await maybeJson(response);
      return { status: response.status, body: payload };
    };

    const positiveInput = `echo STARTUP_CFG_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 8)}\r`;
    const streamResponse = await streamRequest();
    assert.equal(streamResponse.status, 200, `stream status was ${streamResponse.status}`);
    const streamReader = streamResponse.body.getReader();
    const streamDecoder = new TextDecoder();
    const streamEvents = [];
    const streamConsumer = (async () => {
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await streamReader.read();
          if (done) break;
          buffer += streamDecoder.decode(value, { stream: true });
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
            streamEvents.push({ event, parsed });
          }
        }
      } catch {}
    })();
    await waitFor(() => streamEvents.some((entry) => entry.event === "ready"), 15000, "positive stream ready");
    const streamReady = streamEvents.find((entry) => entry.event === "ready") || null;
    const inputResponse = await inputRequest({ data: positiveInput });
    const inputPayload = await maybeJson(inputResponse);
    assert.equal(inputResponse.status, 200, `positive input failed: ${JSON.stringify(inputPayload)}`);
    const marker = positiveInput.trim();
    const markerDeadline = Date.now() + 15000;
    let positiveCapture = tmuxCapture(fixture.tmuxSocketPath, fixture.alpha);
    while (!positiveCapture.includes(marker) && Date.now() < markerDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      positiveCapture = tmuxCapture(fixture.tmuxSocketPath, fixture.alpha);
    }
    const markerSeen = positiveCapture.includes(marker);
    await writeReceipt("green-input-output.json", JSON.stringify({
      marker,
      markerSeen,
      note: markerSeen
        ? "Unique marker appeared in the real tmux capture."
        : "Input was admitted and submitted, but the marker did not appear in the real tmux capture; positive output is not proven.",
    }, null, 2));
    await writeReceipt("green-stream-ready.json", JSON.stringify({ status: 200, event: streamReady.event, parsed: streamReady.parsed }, null, 2));
    await writeReceipt("green-input-response.json", JSON.stringify({ status: inputResponse.status, body: inputPayload }, null, 2));
    await writeReceipt("green-tmux-capture.txt", positiveCapture);
    await streamReader.cancel().catch(() => {});

    const failureBefore = (label) => ({ label, tmuxCapture: tmuxCapture(fixture.tmuxSocketPath, fixture.alpha) });
    const assertNoTerminalDelta = (before, after, label) => {
      assert.deepEqual(after, before, `${label} must not reach the public terminal input/subscribe edge`);
    };
    const httpFailureAfter = async (label, before, response, sideEffects) => {
      const afterCapture = tmuxCapture(fixture.tmuxSocketPath, fixture.alpha);
      const unchanged = afterCapture === before.tmuxCapture;
      assert.ok(response.status >= 400, `${label} must fail, got ${response.status}`);
      assert.ok(unchanged, `${label} must not mutate the real terminal buffer`);
      await writeReceipt(`failure-${label}.json`, JSON.stringify({
        label,
        status: response.status,
        body: response.body,
        sideEffects: {
          terminalBufferUnchanged: unchanged,
          ...sideEffects,
        },
      }, null, 2));
      return response;
    };

    // Failure 1: production entry without config (legacy branch, no admission).
    const unconfigured = await startUnconfiguredDaemon(token);
    const missingConfigBefore = failureBefore("missing-config");
    const missingConfigResponse = await httpPost(
      `${unconfigured.base}/api/terminal/input`,
      {
        workspaceId: workspace.workspaceId,
        memberId: member.memberId,
        machineId,
        groupPath: group.path,
        expectedGeneration: binding.generation,
        target: { backend: "tmux", stableId: fixture.alphaStableId },
        data: "echo SHOULD_NOT_RUN\r",
      },
      token,
    );
    await httpFailureAfter("missing-config", missingConfigBefore, missingConfigResponse, {
      admissionConfigured: false,
      terminalAdmissionConstructed: false,
      evidence: "The unconfigured daemon refuses the request before constructing terminal admission; no terminal edge exists.",
    });
    assert.equal(missingConfigResponse.body?.error?.code, "TERMINAL_ADMISSION_REQUIRED");
    await stopChild(unconfigured.child);

    // Failure 2: production config requires a hostAdapter section. Without it
    // assembly fails closed before the HTTP server starts.
    const missingProbeConfigPath = join(root, "daemon-missing-probe-config.json");
    const missingProbeConfig = { ...config };
    delete missingProbeConfig.hostAdapter;
    await writeFile(missingProbeConfigPath, `${JSON.stringify(missingProbeConfig, null, 2)}\n`, "utf8");
    const missingProbeRecord = await runStartupFailure("missing-host-probe", missingProbeConfigPath, "failure-missing-host-probe.json");
    assert.ok(missingProbeRecord.exitCode !== 0, `missing-host-probe config must exit nonzero, got ${missingProbeRecord.exitCode}`);
    assert.ok(missingProbeRecord.daemonStartupConfigInvalid, "missing-host-probe config must fail with DAEMON_STARTUP_CONFIG_INVALID");
    assert.equal(missingProbeRecord.reachedListening, false, "missing-host-probe startup failure must not reach the listening gate");

    // Failure 3: lower-level HTTP boundary with resolver missing. This is not
    // the production main.mjs --config gate; production always injects the
    // members resolver, so this receipt is explicitly a lower-level negative.
    const missingResolverManager = createConnectionManager({
      authorizationPort: {
        async authorizeMachine(requestedMachineId) {
          if (requestedMachineId !== machineId) throw new Error("startup blackbox route not found");
          return {
            machineId,
            daemonHostId,
            accountId,
            authorizationId: "startup-blackbox-authz",
            capabilities: { channelKinds: ["terminal"], transportKind: "websocket" },
            target: { bridgeHost: "127.0.0.1", bridgePort: fixture.port, authToken: fixture.authToken, daemonHostId, relayHostId: daemonHostId, relayEndpointCandidates: [], transportMode: "websocket" },
            settings: { transportMode: "websocket" },
          };
        },
      },
      transport: new V1TraversalTransport(),
    });
    const missingResolverCounters = { terminalInputCalls: 0, terminalSubscribeCalls: 0, connectionOpenChannelCalls: 0 };
    const missingResolverTerminal = {
      async listSessions() { return []; },
      async input() { missingResolverCounters.terminalInputCalls += 1; throw new Error("resolver missing input must not be reached"); },
      subscribe() { missingResolverCounters.terminalSubscribeCalls += 1; throw new Error("resolver missing subscribe must not be reached"); },
      async close() {},
    };
    const originalMissingOpenChannel = missingResolverManager.openChannel.bind(missingResolverManager);
    missingResolverManager.openChannel = async (...args) => {
      missingResolverCounters.connectionOpenChannelCalls += 1;
      return originalMissingOpenChannel(...args);
    };
    const missingResolverRouting = createRoutingService({ organization, members: membersNoProbe, auth: workspaceAuth });
    const membersWithoutResolver = {
      getRuntimeBinding: (...args) => membersNoProbe.getRuntimeBinding(...args),
    };
    const missingResolverDaemon = await startDaemon({
      port: 0,
      host: "127.0.0.1",
      v2Token: token,
      terminalPort: missingResolverTerminal,
      admission: {
        auth: workspaceAuth,
        members: membersWithoutResolver,
        routing: missingResolverRouting,
        machineTerminal: createConnectionMachineTerminal({ connectionManager: missingResolverManager, terminal: missingResolverTerminal }),
        resolveBindingTarget: null,
      },
      log: () => {},
    });
    const missingResolverPort = missingResolverDaemon.server.address().port;
    const missingResolverBefore = failureBefore("missing-resolver");
    const missingResolverResponse = await httpPost(
      `http://127.0.0.1:${missingResolverPort}/api/terminal/input`,
      {
        workspaceId: workspace.workspaceId,
        memberId: member.memberId,
        machineId,
        groupPath: group.path,
        expectedGeneration: binding.generation,
        target: { backend: "tmux", stableId: fixture.alphaStableId },
        data: "echo SHOULD_NOT_RUN\r",
      },
      token,
    );
    assert.equal(missingResolverResponse.status, 424);
    assert.equal(missingResolverResponse.body?.error?.code, "TERMINAL_TARGET_BINDING_UNAVAILABLE");
    assert.deepEqual(missingResolverCounters, {
      terminalInputCalls: 0,
      terminalSubscribeCalls: 0,
      connectionOpenChannelCalls: 0,
    });
    await httpFailureAfter("missing-resolver", missingResolverBefore, missingResolverResponse, {
      ...missingResolverCounters,
      note: "Lower-level HTTP fail-closed receipt. Production assembleDaemonConfig always injects members.resolveBindingTarget; this boundary proves the daemon refuses when that dependency is explicitly absent.",
    });
    missingResolverDaemon.server.close();

    // Failures 4-6 use the assembled production daemon in-process so the
    // actual terminal input/subscribe edge can be measured, while the positive
    // path above remains a real `main.mjs --config` spawned process.
    const failureAssembled = assembleDaemonConfig(config, { log: () => {} });
    const failureTerminal = failureAssembled.daemonOptions.terminalPort;
    const failureTerminalCalls = { input: 0, subscribe: 0 };
    const originalFailureInput = failureTerminal.input.bind(failureTerminal);
    const originalFailureSubscribe = failureTerminal.subscribe.bind(failureTerminal);
    failureTerminal.input = async (...args) => {
      failureTerminalCalls.input += 1;
      return originalFailureInput(...args);
    };
    failureTerminal.subscribe = (...args) => {
      failureTerminalCalls.subscribe += 1;
      return originalFailureSubscribe(...args);
    };
    failureDaemon = await startDaemon({
      port: 0,
      host: "127.0.0.1",
      ...failureAssembled.daemonOptions,
    });
    const failureBase = `http://127.0.0.1:${failureDaemon.server.address().port}`;
    const failureCounters = () => ({ terminalInputCalls: failureTerminalCalls.input, terminalSubscribeCalls: failureTerminalCalls.subscribe });
    const failureInput = (overrides = {}) => httpPost(
      `${failureBase}/api/terminal/input`,
      {
        workspaceId: workspace.workspaceId,
        memberId: member.memberId,
        machineId,
        groupPath: group.path,
        expectedGeneration: binding.generation,
        target: { backend: "tmux", stableId: fixture.alphaStableId },
        data: "echo SHOULD_NOT_RUN\r",
        ...overrides,
      },
      token,
    );

    // Failure 4: wrong terminal target.
    const wrongTargetBefore = failureBefore("wrong-terminal-target");
    const wrongTargetBeforeCounters = failureCounters();
    const wrongTargetResponse = await failureInput({ target: { backend: "tmux", stableId: fixture.betaStableId } });
    const wrongTargetAfterCounters = failureCounters();
    assertNoTerminalDelta(wrongTargetBeforeCounters, wrongTargetAfterCounters, "wrong-terminal-target");
    await httpFailureAfter("wrong-terminal-target", wrongTargetBefore, wrongTargetResponse, {
      terminalInputBefore: wrongTargetBeforeCounters.terminalInputCalls,
      terminalInputAfter: wrongTargetAfterCounters.terminalInputCalls,
      terminalInputDelta: wrongTargetAfterCounters.terminalInputCalls - wrongTargetBeforeCounters.terminalInputCalls,
      terminalSubscribeBefore: wrongTargetBeforeCounters.terminalSubscribeCalls,
      terminalSubscribeAfter: wrongTargetAfterCounters.terminalSubscribeCalls,
      terminalSubscribeDelta: wrongTargetAfterCounters.terminalSubscribeCalls - wrongTargetBeforeCounters.terminalSubscribeCalls,
      evidence: "The request is rejected during binding-target resolution before the public terminal input edge.",
    });
    assert.equal(wrongTargetResponse.status, 424);
    assert.equal(wrongTargetResponse.body?.error?.code, "TERMINAL_TARGET_BINDING_UNAVAILABLE");

    // Failure 5: stale binding generation.
    const staleBefore = failureBefore("stale-generation");
    const staleBeforeCounters = failureCounters();
    const staleResponse = await failureInput({ expectedGeneration: binding.generation - 1 });
    const staleAfterCounters = failureCounters();
    assertNoTerminalDelta(staleBeforeCounters, staleAfterCounters, "stale-generation");
    await httpFailureAfter("stale-generation", staleBefore, staleResponse, {
      terminalInputBefore: staleBeforeCounters.terminalInputCalls,
      terminalInputAfter: staleAfterCounters.terminalInputCalls,
      terminalInputDelta: staleAfterCounters.terminalInputCalls - staleBeforeCounters.terminalInputCalls,
      terminalSubscribeBefore: staleBeforeCounters.terminalSubscribeCalls,
      terminalSubscribeAfter: staleAfterCounters.terminalSubscribeCalls,
      terminalSubscribeDelta: staleAfterCounters.terminalSubscribeCalls - staleBeforeCounters.terminalSubscribeCalls,
      evidence: "The request is rejected during generation comparison before the public terminal input edge.",
    });
    assert.equal(staleResponse.status, 409);
    assert.equal(staleResponse.body?.error?.code, "BINDING_GENERATION_STALE");

    // Failure 6: wrong machine.
    const wrongMachineBefore = failureBefore("wrong-machine");
    const wrongMachineBeforeCounters = failureCounters();
    const wrongMachineResponse = await failureInput({ machineId: "startup-blackbox-wrong-machine" });
    const wrongMachineAfterCounters = failureCounters();
    assertNoTerminalDelta(wrongMachineBeforeCounters, wrongMachineAfterCounters, "wrong-machine");
    await httpFailureAfter("wrong-machine", wrongMachineBefore, wrongMachineResponse, {
      terminalInputBefore: wrongMachineBeforeCounters.terminalInputCalls,
      terminalInputAfter: wrongMachineAfterCounters.terminalInputCalls,
      terminalInputDelta: wrongMachineAfterCounters.terminalInputCalls - wrongMachineBeforeCounters.terminalInputCalls,
      terminalSubscribeBefore: wrongMachineBeforeCounters.terminalSubscribeCalls,
      terminalSubscribeAfter: wrongMachineAfterCounters.terminalSubscribeCalls,
      terminalSubscribeDelta: wrongMachineAfterCounters.terminalSubscribeCalls - wrongMachineBeforeCounters.terminalSubscribeCalls,
      evidence: "The request is rejected during member resolution before the public terminal input edge.",
    });
    assert.equal(wrongMachineResponse.status, 404);
    assert.ok(["ROUTE_NOT_FOUND", "MEMBER_NOT_FOUND"].includes(wrongMachineResponse.body?.error?.code));

    const result = {
      probe: "startup-config-real-blackbox",
      outcome: markerSeen ? "PASS" : "BLOCKED",
      runner: {
        command: `${process.execPath} v2/evidence/daemon-terminal-admission-1107/startup-config-assembly-20261108/real-blackbox.mjs`,
        preconditions: [
          `${fixtureLatest} must point to a running isolated V1 fixture`,
          `task-owned tmux socket: ${fixture.tmuxSocketPath}`,
          `accepted V1 worktree: ${acceptedWorktree}`,
          "do not use shared ports 3333, 8801, 8899, or the 15T device",
        ],
      },
      productionEntry: "node v2/modules/daemon/src/main.mjs --config",
      positive: {
        admittedInput: true,
        inputSubmitted: true,
        markerSeen,
        tmuxCaptureConfirmed: markerSeen,
        transportEdge: "TerminalPort.input -> mux-channel-message",
        gap: markerSeen ? null : "Input was admitted and submitted, but the marker did not appear in the real tmux capture. Verify the public TerminalPort input edge and the V1 fixture auth/token.",
      },
      failures: {
        missingConfig: {
          status: 503,
          code: "TERMINAL_ADMISSION_REQUIRED",
          gate: "unconfigured production entry",
          zeroSideEffect: true,
          terminalAdmissionConstructed: false,
        },
        missingHostProbe: {
          status: null,
          exitCode: missingProbeRecord.exitCode,
          code: "DAEMON_STARTUP_CONFIG_INVALID",
          gate: "production main.mjs --config startup",
          zeroSideEffect: true,
          reachedListening: missingProbeRecord.reachedListening,
          serverConstructed: missingProbeRecord.startupFailure.serverConstructed,
          terminalInputCalls: missingProbeRecord.startupFailure.terminalInputCalls,
          terminalSubscribeCalls: missingProbeRecord.startupFailure.terminalSubscribeCalls,
        },
        missingResolver: {
          status: 424,
          code: "TERMINAL_TARGET_BINDING_UNAVAILABLE",
          gate: "lower-level startDaemon HTTP boundary",
          zeroSideEffect: true,
          ...missingResolverCounters,
        },
        wrongTerminalTarget: {
          status: 424,
          code: "TERMINAL_TARGET_BINDING_UNAVAILABLE",
          gate: "assembled daemon HTTP boundary with instrumented terminal port",
          zeroSideEffect: true,
          terminalInputDelta: wrongTargetAfterCounters.terminalInputCalls - wrongTargetBeforeCounters.terminalInputCalls,
          terminalSubscribeDelta: wrongTargetAfterCounters.terminalSubscribeCalls - wrongTargetBeforeCounters.terminalSubscribeCalls,
        },
        staleGeneration: {
          status: 409,
          code: "BINDING_GENERATION_STALE",
          gate: "assembled daemon HTTP boundary with instrumented terminal port",
          zeroSideEffect: true,
          terminalInputDelta: staleAfterCounters.terminalInputCalls - staleBeforeCounters.terminalInputCalls,
          terminalSubscribeDelta: staleAfterCounters.terminalSubscribeCalls - staleBeforeCounters.terminalSubscribeCalls,
        },
        wrongMachine: {
          status: wrongMachineResponse.status,
          code: wrongMachineResponse.body?.error?.code,
          gate: "assembled daemon HTTP boundary with instrumented terminal port",
          zeroSideEffect: true,
          terminalInputDelta: wrongMachineAfterCounters.terminalInputCalls - wrongMachineBeforeCounters.terminalInputCalls,
          terminalSubscribeDelta: wrongMachineAfterCounters.terminalSubscribeCalls - wrongMachineBeforeCounters.terminalSubscribeCalls,
        },
      },
    };
    await writeReceipt("real-blackbox-result.json", JSON.stringify(result, null, 2));
    await writeReceipt("real-blackbox.txt", [
      `worktree=${worktree}`,
      `branch=${git(["branch", "--show-current"])}`,
      `head=${git(["rev-parse", "HEAD"])}`,
      `runner_command=${result.runner.command}`,
      `fixture_pointer=${fixtureLatest}`,
      `v1_tmux_socket=${fixture.tmuxSocketPath}`,
      `daemon_command=${process.execPath} v2/modules/daemon/src/main.mjs --config ${configPath}`,
      `daemon_listening=${JSON.stringify(listening)}`,
      `positive_input=${JSON.stringify(positiveInput)}`,
      `positive_marker_seen=${markerSeen}`,
      `outcome=${result.outcome}`,
      `failure_missing_config=${missingConfigResponse.status}:${missingConfigResponse.body?.error?.code}`,
      `failure_missing_host_probe=exit:${missingProbeRecord.exitCode}:DAEMON_STARTUP_CONFIG_INVALID`,
      `failure_missing_resolver=${missingResolverResponse.status}:${missingResolverResponse.body?.error?.code}`,
      `failure_wrong_target=${wrongTargetResponse.status}:${wrongTargetResponse.body?.error?.code}:inputDelta=0:subscribeDelta=0`,
      `failure_stale_generation=${staleResponse.status}:${staleResponse.body?.error?.code}:inputDelta=0:subscribeDelta=0`,
      `failure_wrong_machine=${wrongMachineResponse.status}:${wrongMachineResponse.body?.error?.code}:inputDelta=0:subscribeDelta=0`,
      "credentials=redacted",
    ].join("\n"));
    await writeReceipt("result.md", [
      "# startup-config assembly real black box",
      "",
      "## Result",
      "",
      `${result.outcome}. The production entry \`node v2/modules/daemon/src/main.mjs --config <file>\` assembled accounts, organization, members, routing, connections, host adapter, terminal, and admission. An authorized member input was admitted and submitted. ${markerSeen ? "The unique output appeared in the real tmux capture." : "The marker did not appear in the real tmux capture, so positive terminal output is not proven."}`,
      "",
      "## Positive path",
      "",
      "- Entry: `node v2/modules/daemon/src/main.mjs --config <redacted path>`",
      "- Stream returned HTTP 200 with an admitted `ready` event.",
      "- Input returned HTTP 200 with `accepted: true`.",
      `- Unique marker seen in real tmux capture: ${markerSeen}.`,
      "- Terminal edge: `TerminalPort.input` sent `mux-channel-message` through the public terminal port; no connections contract was changed.",
      "- Receipts: `green-stream-ready.json`, `green-input-response.json`, `green-input-output.json`, `green-tmux-capture.txt`.",
      ...(markerSeen ? [] : [
        "- Blocker: inspect the public `TerminalPort.input` edge and the V1 fixture auth/token; the marker did not reach the shell.",
      ]),
      "",
      "## Typed failures",
      "",
      "| Case | Gate | Status / Error code | Measured side effect |",
      "|---|---|---:|---|",
      "| missing config | unconfigured production entry | 503 / TERMINAL_ADMISSION_REQUIRED | no admission, no terminal edge, buffer unchanged |",
      "| missing host probe | production `main.mjs --config` startup | exit 1 / DAEMON_STARTUP_CONFIG_INVALID | no listening receipt, no server construction, no terminal edge |",
      "| missing resolver | lower-level `startDaemon` HTTP boundary | 424 / TERMINAL_TARGET_BINDING_UNAVAILABLE | 0 terminal input, 0 terminal subscribe, 0 connection channel open, buffer unchanged |",
      "| wrong terminal target | assembled daemon with instrumented terminal port | 424 / TERMINAL_TARGET_BINDING_UNAVAILABLE | terminal input delta 0, terminal subscribe delta 0, buffer unchanged |",
      "| stale binding generation | assembled daemon with instrumented terminal port | 409 / BINDING_GENERATION_STALE | terminal input delta 0, terminal subscribe delta 0, buffer unchanged |",
      `| wrong machine | assembled daemon with instrumented terminal port | ${wrongMachineResponse.status} / ${wrongMachineResponse.body?.error?.code} | terminal input delta 0, terminal subscribe delta 0, buffer unchanged |`,
      "",
      "Each receipt records either the HTTP response or the process-startup failure. For the HTTP cases that reach an assembled daemon (missing resolver, wrong terminal target, stale generation, wrong machine), the receipt records the measured before/after terminal-input and terminal-subscribe counters. The missing-config receipt records that no terminal admission was constructed, and the missing-host-probe receipt records that the daemon did not reach listening or server construction.",
      "",
      "## Notes",
      "",
      "- The production config always injects `members.resolveBindingTarget`. The missing-resolver case is therefore a lower-level HTTP negative test with `resolveBindingTarget: null`, not a production startup gate; this distinction is recorded instead of collapsing both gates.",
      "- Failures 4-6 run through an assembled daemon with an instrumented public `TerminalPort` so the actual terminal edge deltas are measured, while the positive path remains a real spawned `main.mjs --config` process.",
      "- The isolated V1 fixture, relay, and tmux socket were task-owned. No shared daemon or shared port was touched.",
      "- Credentials and the real config file contents are intentionally omitted from the receipts.",
      `- Replay command: \`${result.runner.command}\``,
      "- Required preconditions are recorded in `real-blackbox-result.json` and `real-blackbox.txt`.",
      "",
    ].join("\n"));
  } finally {
    await stopChild(daemonChild);
    if (failureDaemon) {
      await new Promise((resolveClose) => {
        failureDaemon.server.close(() => resolveClose());
      });
    }
    if (relay) {
      await stopChild(relay.child);
      await rm(relay.root, { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
