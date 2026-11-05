import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const v2Root = path.resolve(moduleDir, "../../..");
const repoRoot = path.resolve(v2Root, "..");
const daemonMain = path.join(v2Root, "modules/daemon/src/main.mjs");
const v1Root = path.join(repoRoot, "android");
const evidenceDir =
  process.env.ZTERM_EVIDENCE_DIR ||
  path.join(v2Root, "evidence/zterm-v2-bootstrap-1103/rework-r2f");

const v1Token = process.env.ZTERM_V1_AUTH_TOKEN || "r2f-v1-token";
const v2Token = process.env.ZTERM_V2_AUTH_TOKEN || "r2f-v2-token";
const marker = "ZTERM_V2_E2E";
const mobileMarker = "ZTERM_V2_MOBILE_LAYOUT";
const sessionName = process.env.ZTERM_E2E_SESSION || `r2f-real-${process.pid}`;
const bigSessionName = `${sessionName}-big`;
const mobileSessionName = `${sessionName}-mobile`;
const dedicatedHome = process.env.ZTERM_V1_HOME || `/tmp/zterm-r2f-v1home-${process.pid}`;
const tmuxTmpDir = process.env.TMUX_TMPDIR || path.join(dedicatedHome, ".tmux/run");
const uid = typeof process.getuid === "function" ? process.getuid() : 501;
const tmuxSocketPath = path.join(tmuxTmpDir, `tmux-${uid}`, "default");
const dagpipeNative = process.env.ZTERM_DAGPIPE_NATIVE || "";
const v1Port = Number(process.env.ZTERM_V1_PORT || 4400 + (process.pid % 60));
const playwright = loadPlaywright();

const tmuxEnv = { ...process.env, HOME: dedicatedHome, TMUX_TMPDIR: tmuxTmpDir };
const tmux = (args, extra = {}) =>
  execFileSync("tmux", [...(extra.socket ? ["-S", extra.socket] : []), ...args], {
    encoding: "utf8",
    env: tmuxEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

await mkdir(evidenceDir, { recursive: true });
await mkdir(tmuxTmpDir, { recursive: true });

let browser;
let v1Process;
let v2Process;
let negativeV2Process;
let createdSessions = [];
let v2DaemonSeq = 0;
const results = {};

try {
  await startTmuxSession(sessionName, 90, 24);
  await startTmuxSession(bigSessionName, 240, 700);
  await startTmuxSession(mobileSessionName, 40, 24);
  await fillBigSession(bigSessionName);
  tmux(["send-keys", "-t", mobileSessionName, `echo ${mobileMarker}`, "Enter"]);

  v1Process = await startV1Daemon();
  await writeFile(path.join(evidenceDir, "v1-daemon.log"), v1Process.logText());

  const mux = await muxProbe({
    port: v1Port,
    token: v1Token,
    sessionName: bigSessionName,
    cols: 240,
    rows: 700,
    maxFrames: 12,
    timeoutMs: 8000,
    onChannelOpened: () => {
      try {
        tmux(["send-keys", "-t", bigSessionName, "echo R2F_PROBE_STIMULUS", "Enter"]);
      } catch {
        // The stimulus is best effort; the initial frame still proves the path.
      }
    },
  });
  await writeFile(path.join(evidenceDir, "mux-frames.json"), `${JSON.stringify(mux, null, 2)}\n`);
  assert.ok(mux.ready, "real V1 daemon must reply mux-ready");
  assert.ok(mux.targetList && mux.targetList.sessionCatalog.length > 0, "real V1 daemon must list sessions");
  assert.ok(mux.channelOpened, "real V1 daemon must open a mux channel");
  assert.ok(mux.bufferHeads.length > 0, "real V1 daemon must send buffer-head");
  assert.ok(mux.bufferSyncChunks.length > 0, "real V1 daemon must send buffer-sync");

  const wrongV1 = await muxProbeRaw({
    port: v1Port,
    token: "wrong-v1-token",
    sessionName,
    timeoutMs: 4000,
  });
  await writeFile(path.join(evidenceDir, "v1-auth-negative.json"), `${JSON.stringify(wrongV1, null, 2)}\n`);
  assert.equal(wrongV1.authed, false, "wrong V1 token must be rejected at the WS boundary");

  v2Process = await startV2Daemon({ v2Port: 0, v1Token });
  const baseUrl = `http://127.0.0.1:${v2Process.port}`;
  await writeFile(path.join(evidenceDir, "v2-daemon.log"), v2Process.logText());

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  await writeFile(path.join(evidenceDir, "curl-health.txt"), `GET /api/health -> ${health.status}\n${JSON.stringify(await health.json(), null, 2)}\n`);

  const authHeaders = { authorization: `Bearer ${v2Token}` };
  const sessionsResponse = await fetch(`${baseUrl}/api/sessions`, { headers: authHeaders });
  assert.equal(sessionsResponse.status, 200);
  const sessionsPayload = await sessionsResponse.json();
  assert.ok(sessionsPayload.sessions.some((session) => session.name === sessionName), "browser session must be listed via real V1 mux");
  await writeFile(path.join(evidenceDir, "curl-sessions.json"), `${JSON.stringify(sessionsPayload, null, 2)}\n`);

  const sessionBefore = sessionIdentity(sessionName);
  await writeFile(path.join(evidenceDir, "session-before.json"), `${JSON.stringify(sessionBefore, null, 2)}\n`);

  const captureBefore = capturePane(sessionName);
  await writeFile(path.join(evidenceDir, "capture-before.txt"), captureBefore);

  browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".gate-card").waitFor();
  await page.locator(".gate-card input").fill(v2Token);
  await page.locator(".gate-card button").click();
  await page.locator(`.session-button[data-target="${sessionName}"]`).waitFor({ timeout: 15000 });
  await waitForTerminalText(page, (text) => text.trim().length > 0 && !text.includes("Connecting"));

  const desktopBuffer = await readTerminalText(page);
  assert.equal(normalize(desktopBuffer).length > 0, true, "released wterm renderer must render real pane content");
  assert.equal(normalize(desktopBuffer), normalize(captureBefore), "rendered buffer must match tmux capture");
  const desktopLayout = await collectLayout(page);
  await writeFile(path.join(evidenceDir, "layout-desktop.json"), `${JSON.stringify(desktopLayout, null, 2)}\n`);
  assert.equal(desktopLayout.documentOverflow, false, "desktop must not scroll horizontally");
  assert.equal(desktopLayout.terminalOverflow, false, "desktop terminal must not overflow its surface");
  await page.screenshot({ path: path.join(evidenceDir, "webui-desktop.png"), fullPage: true });
  results.desktopRendered = true;

  await page.locator("#command-input").fill(`echo ${marker}`);
  await page.locator("#send-button").click();
  await waitForCapture(sessionName, marker, 10000);
  await waitForTerminalText(page, (text) => text.includes(marker) && text.split("\n").some((line) => line.trim() === marker));
  const captureAfterInput = capturePane(sessionName);
  assert.ok(captureAfterInput.includes(`echo ${marker}`));
  assert.ok(captureAfterInput.split("\n").some((line) => line.trim() === marker));
  await writeFile(path.join(evidenceDir, "capture-after-input.txt"), captureAfterInput);
  await page.screenshot({ path: path.join(evidenceDir, "webui-after-input.png"), fullPage: true });
  results.inputReachedPane = true;

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`.session-button[data-target="${sessionName}"]`).waitFor({ timeout: 15000 });
  await waitForTerminalText(page, (text) => text.includes(marker));
  const sessionAfter = sessionIdentity(sessionName);
  assert.equal(sessionAfter.id, sessionBefore.id);
  assert.equal(sessionAfter.createdAt, sessionBefore.createdAt);
  await writeFile(path.join(evidenceDir, "session-after-refresh.json"), `${JSON.stringify(sessionAfter, null, 2)}\n`);
  await writeFile(path.join(evidenceDir, "capture-after-refresh.txt"), capturePane(sessionName));
  await page.screenshot({ path: path.join(evidenceDir, "webui-after-refresh.png"), fullPage: true });
  results.refreshPreservedSession = true;

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(`.session-button[data-target="${mobileSessionName}"]`).waitFor({ timeout: 15000 });
  await page.locator(`.session-button[data-target="${mobileSessionName}"]`).click();
  await waitForTerminalText(page, (text) => text.includes(mobileMarker));
  const mobileLayout = await collectLayout(page);
  await writeFile(path.join(evidenceDir, "layout-mobile.json"), `${JSON.stringify(mobileLayout, null, 2)}\n`);
  assert.equal(mobileLayout.documentOverflow, false, "mobile must not scroll horizontally");
  assert.equal(mobileLayout.terminalOverflow, false, "mobile terminal must not overflow its surface");
  assert.ok(mobileLayout.inputRight <= mobileLayout.innerWidth);
  assert.ok(mobileLayout.buttonRight <= mobileLayout.innerWidth);
  await writeFile(path.join(evidenceDir, "capture-mobile.txt"), capturePane(mobileSessionName));
  await page.screenshot({ path: path.join(evidenceDir, "webui-mobile.png"), fullPage: true });
  results.mobileLayout = true;

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(`.session-button[data-target="${sessionName}"]`).waitFor({ timeout: 15000 });
  await waitForTerminalText(page, (text) => text.includes(marker));
  await page.locator("#command-input").fill("top");
  await page.locator("#send-button").click();
  await waitForTerminalText(page, (text) => /top -|Tasks:|load average/i.test(text), 15000);
  await writeFile(path.join(evidenceDir, "capture-tui.txt"), capturePane(sessionName));
  await page.screenshot({ path: path.join(evidenceDir, "webui-tui.png"), fullPage: true });
  await page.locator("#command-input").fill("q");
  await page.locator("#send-button").click();
  results.tuiRendered = true;

  await auditAuthNegatives(baseUrl, authHeaders);

  const subscriberReceipt = await twoSubscribers(baseUrl, authHeaders);
  await writeFile(path.join(evidenceDir, "subscribers.json"), `${JSON.stringify(subscriberReceipt, null, 2)}\n`);
  results.twoSubscribers = true;

  const negativeV2 = await startV2Daemon({ v2Port: 0, v1Token: "wrong-v1-token" });
  negativeV2Process = negativeV2.process;
  const negativeBase = `http://127.0.0.1:${negativeV2.port}`;
  const v1AuthFailure = await fetch(`${negativeBase}/api/sessions`, { headers: authHeaders });
  assert.equal(v1AuthFailure.status, 502);
  const v1AuthFailureBody = await v1AuthFailure.json();
  assert.equal(v1AuthFailureBody.error.code, "V1_CONNECTION_AUTH_FAILED");
  const v1InputFailure = await fetch(`${negativeBase}/api/terminal/input`, {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ target: sessionName, data: "echo ZTERM_SHOULD_NOT_RUN" }),
  });
  assert.equal(v1InputFailure.status, 502);
  assert.ok(!capturePane(sessionName).includes("ZTERM_SHOULD_NOT_RUN"));
  await writeFile(path.join(evidenceDir, "v1-auth-boundary.json"), `${JSON.stringify({
    sessions: { status: v1AuthFailure.status, body: v1AuthFailureBody },
    input: { status: v1InputFailure.status, body: await v1InputFailure.json() },
  }, null, 2)}\n`);
  results.v1AuthBoundary = true;

  const summary = {
    status: "PASS",
    publicEntry: baseUrl,
    tmuxSocket: tmuxSocketPath,
    sessionName,
    gates: results,
    reused: [
      "released @jsonstudio/wtermmod-react@0.1.9 renderer",
      "packages/stream-boundary terminal buffer render runtime",
    ],
    newEvidence: [
      "real V1 daemon listening log",
      "real V1 mux frames (hello/ready/list/open/buffer)",
      "real V2 daemon facade logs and HTTP responses",
      "Playwright desktop/mobile/TUI screenshots",
    ],
    realV1Daemon: true,
  };
  await writeFile(path.join(evidenceDir, "e2e-result.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} finally {
  if (browser) {
    await browser.close().catch(() => {});
  }
  if (negativeV2Process) {
    await stopChild(negativeV2Process);
  }
  if (v2Process) {
    await stopChild(v2Process.process);
  }
  if (v1Process) {
    await stopChild(v1Process.process);
  }
  for (const name of createdSessions.reverse()) {
    try {
      tmux(["kill-session", "-t", name]);
    } catch {
      // The dedicated session is already gone.
    }
  }
  for (const name of [`r2f-daemon-${v1Port}`, `zterm-daemon-${v1Port}`, "zterm", "zterm-daemon-keepalive"]) {
    try {
      tmux(["kill-session", "-t", name]);
    } catch {
      // The daemon-owned session was never created or is already gone.
    }
  }
}

async function startTmuxSession(name, cols, rows) {
  try {
    tmux(["has-session", "-t", name]);
    return;
  } catch {
    tmux(["new-session", "-d", "-s", name, "-x", String(cols), "-y", String(rows)]);
    createdSessions.push(name);
  }
}

async function fillBigSession(name) {
  const fill = Array.from({ length: 700 }, () => "x".repeat(239)).join("\n");
  const file = path.join(dedicatedHome, "fill.txt");
  await writeFile(file, `${fill}\n`);
  tmux(["send-keys", "-t", name, `cat ${file}`, "Enter"]);
  await waitFor(() => capturePane(name).includes("xxxx"), 6000);
}

function startV1Daemon() {
  const tsxBin = path.join(v1Root, "node_modules/.bin/tsx");
  const child = spawn(tsxBin, ["src/server/server.ts"], {
    cwd: v1Root,
    env: {
      ...process.env,
      HOME: dedicatedHome,
      TMUX_TMPDIR: tmuxTmpDir,
      ZTERM_DAGPIPE_NATIVE: dagpipeNative,
      ZTERM_AUTH_TOKEN: v1Token,
      ZTERM_PORT: String(v1Port),
      ZTERM_HOST: "127.0.0.1",
      ZTERM_DAEMON_SESSION: `r2f-daemon-${v1Port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  const onData = (chunk) => {
    text += chunk.toString();
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  return waitForLogText(child, "V1", () => text, (value) => value.includes("listening on ws://")).then(() => ({
    process: child,
    logText: () => text,
  }));
}

function waitForLogText(child, label, readText, predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} daemon did not become ready:\n${readText()}`)), timeoutMs);
    const check = () => {
      if (predicate(readText())) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", check);
    child.stderr.on("data", check);
    check();
  });
}

async function startV2Daemon({ v2Port = 0, v1Token: token }) {
  const logStreamPath = path.join(evidenceDir, `v2-daemon-${v2DaemonSeq++}.log`);
  const logStream = createWriteStream(logStreamPath, { flags: "w" });
  const child = spawn(
    process.execPath,
    [daemonMain, "--port", String(v2Port), "--host", "127.0.0.1", "--v1-ws-url", `ws://127.0.0.1:${v1Port}/ws`],
    {
      cwd: v2Root,
      env: {
        ...process.env,
        ZTERM_V1_AUTH_TOKEN: token,
        ZTERM_V2_AUTH_TOKEN: v2Token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let text = "";
  child.stdout.on("data", (chunk) => {
    text += chunk.toString();
    logStream.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    text += chunk.toString();
    logStream.write(chunk);
  });
  child.once("exit", () => logStream.end());
  const event = await waitForListening(child, "V2", () => text);
  return {
    process: child,
    port: event.port,
    logText: () => text,
  };
}

function waitForListening(child, label, readText) {
  let parsed = null;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} daemon did not report listening:\n${readText()}`)), 15000);
    const inspect = () => {
      const lines = readText().split("\n");
      for (const line of lines) {
        if (!line.trim().startsWith("{")) {
          continue;
        }
        try {
          const event = JSON.parse(line);
          if (event.event === "listening") {
            clearTimeout(timeout);
            parsed = event;
            resolve(event);
            return;
          }
        } catch {
          // Ignore non-JSON log lines.
        }
      }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    inspect();
  }).then((event) => ({ ...event }));
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 4000))]);
}

function sessionIdentity(name) {
  const line = tmux(["list-sessions", "-F", "#{session_id}|#{session_name}|#{session_created}", "-f", `#{==:#{session_name},${name}}`]).trim();
  const [id, , createdRaw] = line.split("|");
  const createdAt = Number(createdRaw);
  return { id, createdAt, createdIso: new Date(createdAt * 1000).toISOString() };
}

function capturePane(name) {
  return tmux(["capture-pane", "-p", "-t", name]);
}

async function waitForCapture(name, expected, timeoutMs) {
  await waitFor(() => capturePane(name).includes(expected), timeoutMs);
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for condition.");
}

async function waitForTerminalText(page, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await readTerminalText(page).catch(() => "");
    if (predicate(String(text || ""))) {
      return;
    }
    await page.waitForTimeout(150);
  }
  throw new Error("Timed out waiting for rendered terminal text.");
}

async function readTerminalText(page) {
  const rows = await page.locator("#terminal-surface .term-row").allTextContents();
  return rows.join("\n");
}

async function collectLayout(page) {
  return page.evaluate(() => {
    const rectOf = (selector) => {
      const element = document.querySelector(selector);
      if (!element) {
        return null;
      }
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const surface = document.querySelector("#terminal-surface");
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      documentOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      terminalOverflow: surface ? surface.scrollWidth > surface.clientWidth + 1 : false,
      inputRight: rectOf("#command-input")?.right ?? 0,
      buttonRight: rectOf("#send-button")?.right ?? 0,
      topbar: rectOf(".topbar"),
      terminalShell: rectOf(".terminal-shell"),
      surface: rectOf("#terminal-surface"),
      terminal: rectOf('#terminal-surface [aria-label="Terminal"]'),
    };
  });
}

async function auditAuthNegatives(baseUrl, authHeaders) {
  const missing = await fetch(`${baseUrl}/api/sessions`);
  assert.equal(missing.status, 401);
  const missingBody = await missing.json();
  assert.equal(missingBody.error.code, "V2_CREDENTIAL_REQUIRED");
  await writeFile(path.join(evidenceDir, "curl-sessions-noauth.json"), `${JSON.stringify(missingBody, null, 2)}\n`);

  const wrong = await fetch(`${baseUrl}/api/sessions`, { headers: { authorization: "Bearer wrong-v2-token" } });
  assert.equal(wrong.status, 401);
  const wrongBody = await wrong.json();
  assert.equal(wrongBody.error.code, "V2_CREDENTIAL_INVALID");
  await writeFile(path.join(evidenceDir, "curl-sessions-wrongauth.json"), `${JSON.stringify(wrongBody, null, 2)}\n`);

  const fresh = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await fresh.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await fresh.locator(".gate-card").waitFor();
  await fresh.locator(".gate-card input").fill("wrong-v2-token");
  await fresh.locator(".gate-card button").click();
  await fresh.locator(".gate-error").waitFor();
  const gateError = await fresh.locator(".gate-error").textContent();
  assert.match(gateError, /V2_CREDENTIAL_INVALID/);
  await fresh.screenshot({ path: path.join(evidenceDir, "webui-failure-auth.png"), fullPage: true });
  await fresh.close();
}

async function twoSubscribers(baseUrl, authHeaders) {
  const url = `${baseUrl}/api/terminal/stream?target=${encodeURIComponent(sessionName)}`;
  const first = await openStream(url, authHeaders);
  const second = await openStream(url, authHeaders);
  await first.waitForBuffer((text) => text.trim().length > 0, 10000);
  await second.waitForBuffer((text) => text.trim().length > 0, 10000);
  first.close();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await fetch(`${baseUrl}/api/terminal/input`, {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ target: sessionName, data: "echo ZTERM_V2_SECOND_SUB" }),
  });
  await second.waitForBuffer((text) => text.includes("ZTERM_V2_SECOND_SUB"), 10000);
  assert.equal(tmux(["has-session", "-t", sessionName]), "");
  second.close();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(tmux(["has-session", "-t", sessionName]), "");
  return {
    bothReceivedInitialBuffer: true,
    survivorReceivedUpdateAfterPeerClose: true,
    tmuxAliveAfterBothClosed: true,
  };
}

async function openStream(url, headers) {
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames = [];
  let frameWaiters = [];

  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          let event = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) {
              event = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              data += line.slice(5).trim();
            }
          }
          if (data && event === "buffer") {
            const payload = JSON.parse(data);
            frames.push(payload.buffer);
            frameWaiters = frameWaiters.filter((waiter) => !waiter(payload.buffer));
          }
        }
      }
    } catch {
      // Expected when the test closes the stream.
    }
  })();

  return {
    waitForBuffer(predicate, timeoutMs) {
      const existing = frames.find(predicate);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const waiter = (text) => {
          if (predicate(text)) {
            clearTimeout(timer);
            resolve(text);
            return true;
          }
          return false;
        };
        const timer = setTimeout(() => {
          frameWaiters = frameWaiters.filter((candidate) => candidate !== waiter);
          reject(new Error("Timed out waiting for a buffer frame."));
        }, timeoutMs);
        frameWaiters.push(waiter);
      });
    },
    close() {
      reader.cancel().catch(() => {});
    },
  };
}

function muxProbe({ port, token, sessionName: targetName, cols, rows, maxFrames, timeoutMs, onChannelOpened }) {
  return new Promise((resolve) => {
    const { WebSocket } = require("ws");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    const out = {
      sentHello: true,
      ready: null,
      targetList: null,
      channelOpened: null,
      bufferHeads: [],
      bufferSyncChunks: [],
    };
    let finished = false;
    let headRequested = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      try {
        ws.close();
      } catch {}
      resolve(out);
    };
    const timer = setTimeout(finish, timeoutMs);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "mux-hello", payload: { version: 1, clientInstanceId: "r2f-probe" } }));
    });
    ws.on("message", (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (frame.type === "mux-ready") {
        out.ready = frame.payload;
        ws.send(JSON.stringify({
          type: "mux-target-message",
          payload: { requestId: "r2f-list", message: { type: "list-sessions", payload: { terminalBackend: "tmux" } } },
        }));
        return;
      }
      if (
        frame.type === "mux-target-message"
        && frame.payload.requestId === "r2f-list"
        && frame.payload.message
        && frame.payload.message.type === "sessions"
      ) {
        out.targetList = frame.payload.message.payload;
        const entry = out.targetList.sessionCatalog.find((candidate) => candidate.name === targetName);
        if (!entry) {
          clearTimeout(timer);
          finish();
          return;
        }
        ws.send(JSON.stringify({
          type: "mux-channel-open",
          payload: {
            channelId: "r2f-probe-channel",
            sessionName: entry.name,
            backend: entry.backend,
            expectedSessionIdentity: entry.stableId,
            existingOnly: true,
            bodySubscribed: true,
            widthMode: "mirror-fixed",
            cols,
            rows,
          },
        }));
        return;
      }
      if (frame.type === "mux-channel-opened") {
        out.channelOpened = frame.payload;
        ws.send(JSON.stringify({
          type: "mux-channel-message",
          payload: {
            channelId: "r2f-probe-channel",
            message: { type: "body-subscription", payload: { version: 1, subscribed: true } },
          },
        }));
        if (typeof onChannelOpened === "function") {
          try {
            onChannelOpened();
          } catch {
            // Ignore stimulus failures.
          }
        }
        return;
      }
      if (frame.type === "mux-channel-message") {
        const message = frame.payload.message;
        if (message.type === "buffer-head") {
          out.bufferHeads.push(message.payload);
        } else if (message.type === "buffer-sync") {
          if (!headRequested) {
            headRequested = true;
            ws.send(JSON.stringify({
              type: "mux-channel-message",
              payload: {
                channelId: "r2f-probe-channel",
                message: { type: "buffer-head-request" },
              },
            }));
          }
          const payload = message.payload;
          out.bufferSyncChunks.push({
            revision: payload.revision,
            frameChunkIndex: payload.frameChunkIndex,
            frameChunkCount: payload.frameChunkCount,
            frameStartIndex: payload.frameStartIndex,
            frameEndIndex: payload.frameEndIndex,
            startIndex: payload.startIndex,
            endIndex: payload.endIndex,
            lineCount: payload.lines.length,
          });
          if (out.bufferSyncChunks.length >= maxFrames) {
            clearTimeout(timer);
            ws.send(JSON.stringify({ type: "mux-channel-close", payload: { channelId: "r2f-probe-channel", reason: "probe done" } }));
            finish();
          }
        }
      }
    });
    ws.on("error", () => finish());
    ws.on("close", () => {
      clearTimeout(timer);
      finish();
    });
  });
}

function muxProbeRaw({ port, token, sessionName: targetName, timeoutMs }) {
  return new Promise((resolve) => {
    const { WebSocket } = require("ws");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    const out = { authed: false, ready: false, error: "", closeCode: null };
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve(out);
    }, timeoutMs);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "mux-hello", payload: { version: 1, clientInstanceId: "r2f-negative" } }));
    });
    ws.on("message", (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch { return; }
      if (frame.type === "mux-ready") {
        out.authed = true;
        out.ready = true;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve(out);
      }
      if (frame.type === "error") {
        out.error = frame.payload?.message || frame.payload?.code || "error";
      }
    });
    ws.on("close", (code) => {
      clearTimeout(timer);
      out.closeCode = code;
      resolve(out);
    });
    ws.on("error", () => {});
  });
}

function loadPlaywright() {
  const candidate = process.env.PLAYWRIGHT_MODULE || "/tmp/pw/node_modules/playwright";
  return require(candidate);
}

function normalize(value) {
  return String(value || "").replace(/\r\n/g, "\n").replace(/\s+$/u, "");
}
