import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TmuxAdapter } from "../../host-adapters/src/tmux/tmux-adapter.mjs";

const require = createRequire(import.meta.url);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "../../../..");
const daemonMain = path.join(repoRoot, "v2/modules/daemon/src/main.mjs");
const evidenceDir = process.env.ZTERM_EVIDENCE_DIR || path.join(repoRoot, "evidence", "i0");
const socketName = process.env.ZTERM_TMUX_SOCKET || "zterm-v2-i0";
const sessionName = process.env.ZTERM_E2E_SESSION || "i0demo";
const marker = "ZTERM_V2_E2E";
const playwright = loadPlaywright();

await mkdir(evidenceDir, { recursive: true });
await writeFile(path.join(evidenceDir, "daemon.log"), "");

const adapter = new TmuxAdapter({ socketName });
const existing = await adapter.listSessions();
if (existing.some((session) => session.name === sessionName)) {
  throw new Error(`Refusing to reuse an existing tmux session named ${sessionName}.`);
}

let daemonProcess;
let browser;
let sessionCreated = false;

try {
  await adapter.createSession(sessionName);
  sessionCreated = true;

  daemonProcess = await startDaemonCli({
    socketName,
    logPath: path.join(evidenceDir, "daemon.log"),
  });
  const baseUrl = `http://127.0.0.1:${daemonProcess.port}`;

  const sessionsResponse = await fetch(`${baseUrl}/api/sessions`);
  const sessionsPayload = await sessionsResponse.json();
  assert.equal(sessionsResponse.status, 200);
  assert.ok(sessionsPayload.sessions.some((session) => session.name === sessionName));
  await writeFile(
    path.join(evidenceDir, "sessions.json"),
    `${JSON.stringify(sessionsPayload, null, 2)}\n`,
  );
  const curlSessions = execFileSync("curl", ["-sS", `${baseUrl}/api/sessions`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  await writeFile(path.join(evidenceDir, "curl-sessions.json"), `${curlSessions}\n`);

  const sessionBefore = sessionsPayload.sessions.find((session) => session.name === sessionName);
  await writeFile(
    path.join(evidenceDir, "session-before.json"),
    `${JSON.stringify(sessionBefore, null, 2)}\n`,
  );

  const captureBefore = await adapter.capture(sessionName);
  await writeFile(path.join(evidenceDir, "capture-before.txt"), captureBefore);

  browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator(`#session-list button[data-target="${sessionName}"]`).waitFor();
  await waitForBuffer(page, sessionName);

  const browserBufferBefore = await page.locator("#terminal-buffer").textContent();
  assert.equal(normalizeBuffer(browserBufferBefore), normalizeBuffer(captureBefore));
  await page.screenshot({ path: path.join(evidenceDir, "webui-before-input.png"), fullPage: true });

  await page.locator("#command-input").fill(`echo ${marker}`);
  await page.locator("#send-button").click();
  await waitForCapture(adapter, sessionName, marker);

  const captureAfterInput = await adapter.capture(sessionName);
  await waitForPageBuffer(page, captureAfterInput);
  const bufferAfterInput = await page.locator("#terminal-buffer").textContent();
  assert.ok(captureAfterInput.includes(`echo ${marker}`));
  assert.ok(captureAfterInput.split("\n").some((line) => line.trim() === marker));
  assert.equal(normalizeBuffer(bufferAfterInput), normalizeBuffer(captureAfterInput));
  await writeFile(path.join(evidenceDir, "capture-after-input.txt"), captureAfterInput);
  await writeFile(path.join(evidenceDir, "webui-buffer-after-input.txt"), bufferAfterInput);
  await page.screenshot({ path: path.join(evidenceDir, "webui-after-input.png"), fullPage: true });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`#session-list button[data-target="${sessionName}"]`).waitFor();
  await waitForBuffer(page, sessionName);
  await page.locator("#terminal-buffer").filter({ hasText: marker }).waitFor();

  const sessionsAfter = await fetch(`${baseUrl}/api/sessions`).then((response) => response.json());
  const sessionAfter = sessionsAfter.sessions.find((session) => session.name === sessionName);
  assert.equal(sessionAfter.id, sessionBefore.id);
  assert.equal(sessionAfter.createdAt, sessionBefore.createdAt);
  await writeFile(
    path.join(evidenceDir, "session-after-refresh.json"),
    `${JSON.stringify(sessionAfter, null, 2)}\n`,
  );

  const captureAfterRefresh = await adapter.capture(sessionName);
  assert.ok(captureAfterRefresh.includes(marker));
  await writeFile(path.join(evidenceDir, "capture-after-refresh.txt"), captureAfterRefresh);
  await page.screenshot({ path: path.join(evidenceDir, "webui-after-refresh.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator(`#session-list button[data-target="${sessionName}"]`).waitFor();
  await waitForBuffer(page, sessionName);
  const mobileLayout = await page.evaluate(() => {
    const input = document.querySelector("#command-input").getBoundingClientRect();
    const button = document.querySelector("#send-button").getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      inputRight: input.right,
      buttonRight: button.right,
    };
  });
  assert.ok(mobileLayout.scrollWidth <= mobileLayout.innerWidth);
  assert.ok(mobileLayout.inputRight <= mobileLayout.innerWidth);
  assert.ok(mobileLayout.buttonRight <= mobileLayout.innerWidth);
  await writeFile(
    path.join(evidenceDir, "mobile-layout.json"),
    `${JSON.stringify(mobileLayout, null, 2)}\n`,
  );
  await page.screenshot({ path: path.join(evidenceDir, "webui-mobile.png"), fullPage: true });

  await page.goto(`${baseUrl}/?target=does-not-exist`, { waitUntil: "domcontentloaded" });
  await page.locator("#error-message").waitFor();
  const pageError = await page.locator("#error-message").textContent();
  assert.match(pageError, /does-not-exist/);
  await page.screenshot({ path: path.join(evidenceDir, "webui-failure.png"), fullPage: true });

  const streamFailure = await fetch(`${baseUrl}/api/terminal/stream?target=does-not-exist`);
  const streamFailurePayload = await streamFailure.json();
  assert.equal(streamFailure.status, 404);
  assert.equal(streamFailurePayload.error.code, "TARGET_NOT_FOUND");
  await writeFile(
    path.join(evidenceDir, "failure-stream.json"),
    `${JSON.stringify({ status: streamFailure.status, body: streamFailurePayload }, null, 2)}\n`,
  );
  const curlFailure = execFileSync("curl", [
    "-sS",
    "-i",
    `${baseUrl}/api/terminal/stream?target=does-not-exist`,
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  await writeFile(path.join(evidenceDir, "curl-failure.txt"), curlFailure);

  const inputFailure = await fetch(`${baseUrl}/api/terminal/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: "does-not-exist", data: "echo SHOULD_NOT_RUN" }),
  });
  const inputFailurePayload = await inputFailure.json();
  assert.equal(inputFailure.status, 404);
  assert.equal(inputFailurePayload.error.code, "TARGET_NOT_FOUND");
  await writeFile(
    path.join(evidenceDir, "failure-input.json"),
    `${JSON.stringify({ status: inputFailure.status, body: inputFailurePayload }, null, 2)}\n`,
  );

  const summary = {
    status: "PASS",
    publicEntry: baseUrl,
    tmuxSocket: socketName,
    sessionName,
    checks: {
      sessionsListed: true,
      browserBufferMatchedCapture: true,
      inputReachedPane: true,
      refreshPreservedSession: true,
      typedFailureReturned: true,
      mobileViewportFits: true,
    },
  };
  await writeFile(path.join(evidenceDir, "e2e-result.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} finally {
  if (browser) {
    await browser.close();
  }
  if (daemonProcess) {
    await daemonProcess.stop();
  }
  if (sessionCreated) {
    execFileSync("tmux", ["-L", socketName, "kill-session", "-t", sessionName], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}

async function startDaemonCli({ socketName: tmuxSocket, logPath }) {
  const logStream = createWriteStream(logPath, { flags: "a" });
  const child = spawn(process.execPath, [
    daemonMain,
    "--port",
    "0",
    "--tmux-socket",
    tmuxSocket,
  ], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let settled = false;
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for daemon startup."));
    }, 5000);

    const parse = (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split("\n");
      stdout = lines.pop() || "";
      for (const line of lines) {
        if (!line) {
          continue;
        }
        try {
          const event = JSON.parse(line);
          if (event.event === "listening") {
            clearTimeout(timeout);
            settled = true;
            resolve(event);
          }
        } catch {
          // The raw stdout is still written to the daemon log.
        }
      }
    };

    child.stdout.on("data", (chunk) => {
      logStream.write(chunk);
      parse(chunk);
    });
    child.stderr.on("data", (chunk) => {
      logStream.write(chunk);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (!settled) {
        reject(new Error(`Daemon exited before startup: code=${code} signal=${signal}`));
      }
    });
  });

  let event;
  try {
    event = await ready;
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    logStream.end();
    throw error;
  }

  return {
    child,
    port: event.port,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await Promise.race([
          once(child, "exit"),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Daemon stop timed out.")), 3000)),
        ]);
      }
      logStream.end();
    },
  };
}

function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    "/opt/homebrew/lib/node_modules/playwright",
    "/usr/local/lib/node_modules/playwright",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // Try the next installed Playwright location.
    }
  }

  throw new Error("Playwright is not installed in an allowed local location.");
}

function normalizeBuffer(value) {
  return String(value || "").replace(/\r\n/g, "\n").replace(/\n+$/g, "");
}

async function waitForBuffer(page, name) {
  await page.waitForFunction((target) => {
    const title = document.querySelector("#terminal-title")?.textContent?.trim();
    const buffer = document.querySelector("#terminal-buffer")?.textContent?.trim();
    return title === target && buffer && buffer !== "Connecting..." && buffer !== "Waiting for buffer.";
  }, name);
}

async function waitForCapture(adapter, target, expected) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await adapter.capture(target)).includes(expected)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${expected} in tmux.`);
}

async function waitForPageBuffer(page, expected) {
  const normalized = normalizeBuffer(expected);
  await page.waitForFunction((value) => {
    const buffer = document.querySelector("#terminal-buffer")?.textContent || "";
    return buffer.replace(/\r\n/g, "\n").replace(/\n+$/g, "") === value;
  }, normalized);
}
