import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "../../../..");
const daemonMain = path.join(repoRoot, "v2/modules/daemon/src/main.mjs");
const evidenceDir =
  process.env.ZTERM_BOOTSTRAP_EVIDENCE_DIR ||
  path.join(repoRoot, "v2/evidence/webui-bootstrap-entry-1107/browser");
const socketName = process.env.ZTERM_BOOTSTRAP_TMUX_SOCKET || "zterm-v2-bootstrap-1107";
const daemonToken = randomBytes(18).toString("base64url");
const playwright = loadPlaywright();

await mkdir(evidenceDir, { recursive: true });
await writeFile(path.join(evidenceDir, "daemon.log"), "");

let daemonProcess;
let browser;

function overflow(page) {
  return page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
}

try {
  daemonProcess = await startDaemonCli({
    socketName,
    logPath: path.join(evidenceDir, "daemon.log"),
    token: daemonToken,
  });
  const baseUrl = `http://127.0.0.1:${daemonProcess.port}`;
  const entry = `${baseUrl}/features/bootstrap/index.html`;

  const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
  assert.equal(health.status, "ok");

  browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto(`${entry}#/setup`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-page="setup"]').waitFor();
  assert.match(await page.locator("h1").first().textContent(), /First-run setup/);

  await page.locator('[data-field="daemon-endpoint"]').fill(baseUrl);
  await page.getByRole("button", { name: "Save endpoint" }).click();
  assert.equal(await page.locator('[data-field="daemon-endpoint"]').inputValue(), baseUrl);

  await page.getByRole("button", { name: "Go to login" }).click();
  await page.locator('[data-page="login"]').waitFor();

  await page.locator('[data-field="credential"]').fill("wrong-token");
  await page.getByRole("button", { name: "Log in" }).click();
  const loginError = page.locator('[data-role="login-error"]');
  await loginError.waitFor();
  assert.match(await loginError.textContent(), /V2_CREDENTIAL_INVALID/);
  assert.equal(await page.locator('[data-role="session-badge"]').textContent().then((text) => text.trim()), "Not authenticated");
  await page.screenshot({ path: path.join(evidenceDir, "desktop-login-error.png"), fullPage: true });

  await page.locator('[data-field="credential"]').fill(daemonToken);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.locator('[data-page="workspaces"]').waitFor();
  assert.equal(
    await page.locator('[data-role="session-badge"]').textContent().then((text) => text.trim()),
    "Authenticated",
  );

  await page.getByTestId("load-workspaces-button").click();
  const workspaceError = page.locator('[data-role="workspaces-error"]');
  await workspaceError.waitFor();
  const workspaceErrorText = await workspaceError.textContent();
  assert.match(workspaceErrorText, /METHOD_NOT_ALLOWED/);
  const workspaceErrorKind = await workspaceError.getAttribute("data-kind");
  assert.equal(workspaceErrorKind, "unavailable");

  const enrollButton = page.getByTestId("enroll-machine-button");
  assert.equal(await enrollButton.isDisabled(), true);
  assert.equal(await enrollButton.getAttribute("data-disabled-reason"), "MACHINE_ENROLLMENT_UNAVAILABLE");
  assert.match(await page.locator('[data-role="machine-enrollment-reason"]').textContent(), /MACHINE_ENROLLMENT_UNAVAILABLE/);

  const desktopOverflow = await overflow(page);
  assert.ok(desktopOverflow.scrollWidth <= desktopOverflow.innerWidth);
  await page.screenshot({ path: path.join(evidenceDir, "desktop-workspaces-unavailable.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${entry}#/setup`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-page="setup"]').waitFor();
  const mobileOverflow = await overflow(page);
  assert.ok(mobileOverflow.scrollWidth <= mobileOverflow.innerWidth);
  assert.ok(mobileOverflow.bodyScrollWidth <= mobileOverflow.innerWidth);
  await page.screenshot({ path: path.join(evidenceDir, "mobile-setup.png"), fullPage: true });

  const summary = {
    status: "PASS",
    publicEntry: `${entry}#/setup`,
    daemon: { port: daemonProcess.port, credentialsConfigured: true },
    checks: {
      setupRouteRendered: true,
      endpointSavedWithoutCredential: true,
      invalidLoginTypedError: "V2_CREDENTIAL_INVALID",
      validLoginAuthenticated: true,
      workspaceDirectoryTypedUnavailable: "METHOD_NOT_ALLOWED",
      machineEnrollmentDisabled: "MACHINE_ENROLLMENT_UNAVAILABLE",
      desktopNoHorizontalOverflow: desktopOverflow,
      mobileNoHorizontalOverflow: mobileOverflow,
    },
    note: "The base daemon at this commit exposes auth/session but not /api/workspaces; the UI reports typed unavailable instead of fabricating a workspace list.",
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
}

async function startDaemonCli({ socketName: tmuxSocket, logPath, token }) {
  const logStream = createWriteStream(logPath, { flags: "a" });
  const child = spawn(
    process.execPath,
    [daemonMain, "--port", "0", "--tmux-socket", tmuxSocket],
    {
      cwd: repoRoot,
      env: { ...process.env, ZTERM_V2_AUTH_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

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
          // Raw stdout is retained in the daemon log.
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
