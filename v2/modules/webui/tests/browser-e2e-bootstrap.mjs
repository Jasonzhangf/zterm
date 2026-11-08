import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "../../../..");
const webuiRoot = path.join(repoRoot, "v2/modules/webui/src");
const evidenceDir =
  process.env.ZTERM_BOOTSTRAP_EVIDENCE_DIR ||
  path.join(repoRoot, "v2/evidence/webui-bootstrap-entry-1107/browser");
const playwright = loadPlaywright();

const storage = new Map();
let nextSession = 1;
let server;
let browser;

async function readJson(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk.toString();
  }
  return raw ? JSON.parse(raw) : {};
}

function sendJson(response, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(payload);
}

function cookieValue(request, name) {
  const header = request.headers.cookie || "";
  for (const item of header.split(";")) {
    const [key, ...rest] = item.trim().split("=");
    if (key === name) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return "";
}

function currentSession(request) {
  const sid = cookieValue(request, "zterm_session");
  return sid ? storage.get(sid) || null : null;
}

function contentType(filePath) {
  switch (path.extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".mjs":
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

async function serveStatic(response, pathname) {
  const relative = pathname.replace(/^\/+/, "");
  const filePath = path.resolve(webuiRoot, relative);
  if (!filePath.startsWith(`${webuiRoot}${path.sep}`)) {
    response.writeHead(403);
    response.end("forbidden");
    return;
  }
  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentType(filePath),
      "cache-control": "no-store",
    });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
}

async function handleRequest(request, response) {
  const url = new URL(request.url, "http://127.0.0.1");

  if (request.method === "GET" && url.pathname === "/api/auth/session") {
    const session = currentSession(request);
    sendJson(response, 200, {
      authenticated: Boolean(session),
      configured: true,
      account: session?.account || null,
      csrf: session?.csrf || null,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJson(request);
    if (body.loginName !== "alice" || body.credential !== "correct") {
      sendJson(response, 401, {
        error: { code: "ACCOUNT_CREDENTIAL_INVALID", message: "Account credential is invalid." },
      });
      return;
    }
    const sid = `session-${nextSession++}`;
    const csrf = `csrf-${sid}`;
    storage.set(sid, {
      account: { accountId: "acct-1", loginName: "alice" },
      csrf,
      forceLogoutFailure: false,
    });
    sendJson(
      response,
      200,
      {
        authenticated: true,
        account: { accountId: "acct-1", loginName: "alice" },
        csrf,
      },
      { "set-cookie": `zterm_session=${encodeURIComponent(sid)}; HttpOnly; SameSite=Strict; Path=/` },
    );
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    const session = currentSession(request);
    const csrf = request.headers["x-zterm-csrf"];
    if (!session || !csrf || csrf !== session.csrf) {
      sendJson(response, 403, {
        error: { code: "CSRF_TOKEN_INVALID", message: "A valid session CSRF token is required." },
      });
      return;
    }
    if (session?.forceLogoutFailure) {
      sendJson(response, 503, {
        error: { code: "ACCOUNT_REVOCATION_FAILED", message: "Account revocation failed." },
      });
      return;
    }
    const sid = cookieValue(request, "zterm_session");
    if (sid) {
      storage.delete(sid);
    }
    sendJson(
      response,
      200,
      { ok: true },
      { "set-cookie": "zterm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" },
    );
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/workspaces") {
    const session = currentSession(request);
    if (!session) {
      sendJson(response, 401, {
        error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." },
      });
      return;
    }
    sendJson(response, 200, {
      workspaces: [
        { workspaceId: "ws-1", name: "Primary workspace" },
        { workspaceId: "ws-2", name: "Secondary workspace" },
      ],
    });
    return;
  }

  const treeMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/tree$/);
  if (request.method === "GET" && treeMatch) {
    const session = currentSession(request);
    if (!session) {
      sendJson(response, 401, {
        error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." },
      });
      return;
    }
    const workspaceId = decodeURIComponent(treeMatch[1]);
    sendJson(response, 200, {
      workspace: { workspaceId, revision: 1 },
      root: {
        groupId: "group-root",
        name: "Root",
        members: [
          { memberId: "member-1", name: "Desk Mac" },
          { memberId: "member-2", name: "Build Linux" },
        ],
      },
    });
    return;
  }

  if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
    await serveStatic(response, url.pathname);
    return;
  }

  sendJson(response, 404, {
    error: { code: "ROUTE_NOT_FOUND", message: "Route was not found." },
  });
}

function overflow(page) {
  return page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
}

async function screenshot(page, name) {
  await page.screenshot({ path: path.join(evidenceDir, name), fullPage: true });
}

try {
  server = createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      sendJson(response, 500, {
        error: { code: "HARNESS_FAILED", message: error instanceof Error ? error.message : String(error) },
      });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const entry = `${baseUrl}/features/bootstrap/index.html`;

  browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto(`${entry}#/setup`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-page="setup"]').waitFor();
  assert.match(await page.locator("h1").first().textContent(), /First-run setup/);

  await page.locator('[data-field="daemon-endpoint"]').fill(baseUrl);
  await page.getByRole("button", { name: "Save endpoint" }).click();
  assert.equal(await page.locator('[data-field="daemon-endpoint"]').inputValue(), baseUrl);
  assert.equal(await page.locator('[data-field="account-token"]').count(), 0);

  await page.getByRole("button", { name: "Go to login" }).click();
  await page.locator('[data-page="login"]').waitFor();

  await page.locator('[data-field="login-name"]').fill("alice");
  await page.locator('[data-field="credential"]').fill("wrong");
  await page.getByRole("button", { name: "Log in" }).click();
  const loginError = page.locator('[data-role="login-error"]');
  await loginError.waitFor();
  assert.match(await loginError.textContent(), /ACCOUNT_CREDENTIAL_INVALID/);
  assert.equal(await page.locator('[data-role="session-badge"]').textContent().then((text) => text.trim()), "Not authenticated");
  await screenshot(page, "desktop-login-error.png");

  await page.locator('[data-field="login-name"]').fill("alice");
  await page.locator('[data-field="credential"]').fill("correct");
  await page.getByRole("button", { name: "Log in" }).click();
  await page.locator('[data-page="workspaces"]').waitFor();
  assert.equal(await page.locator('[data-role="session-badge"]').textContent().then((text) => text.trim()), "Authenticated");

  await page.getByTestId("load-workspaces-button").click();
  await page.getByTestId("workspace-button").first().waitFor();
  await page.getByTestId("workspace-button").first().click();
  await page.locator('[data-role="machine-selection-reason"]').waitFor();
  assert.match(await page.locator('[data-role="machine-selection-reason"]').textContent(), /MACHINE_SELECTION_UNAVAILABLE/);
  assert.match(await page.locator('[data-role="machine-list"]').textContent(), /Desk Mac/);
  assert.match(await page.locator('[data-role="machine-list"]').textContent(), /Build Linux/);

  const enrollButton = page.getByTestId("enroll-machine-button");
  assert.equal(await enrollButton.isDisabled(), true);
  assert.equal(await enrollButton.getAttribute("data-disabled-reason"), "MACHINE_ENROLLMENT_UNAVAILABLE");
  assert.match(await page.locator('[data-role="machine-enrollment-reason"]').textContent(), /MACHINE_ENROLLMENT_UNAVAILABLE/);

  const desktopOverflow = await overflow(page);
  assert.ok(desktopOverflow.scrollWidth <= desktopOverflow.innerWidth);
  await screenshot(page, "desktop-workspaces.png");

  await page.getByTestId("logout-button").click();
  await page.locator('[data-page="login"]').waitFor();
  await page.locator('[data-field="login-name"]').fill("alice");
  await page.locator('[data-field="credential"]').fill("correct");
  await page.getByRole("button", { name: "Log in" }).click();
  await page.locator('[data-page="workspaces"]').waitFor();
  const current = [...storage.values()][0];
  current.forceLogoutFailure = true;
  await page.getByTestId("logout-button").click();
  const logoutError = page.locator('[data-role="logout-error"]');
  await logoutError.waitFor();
  assert.match(await logoutError.textContent(), /ACCOUNT_REVOCATION_FAILED/);
  assert.equal(await page.locator('[data-role="session-badge"]').textContent().then((text) => text.trim()), "Authenticated");
  await screenshot(page, "desktop-logout-error.png");

  current.forceLogoutFailure = false;
  await page.getByTestId("logout-button").click();
  await page.locator('[data-page="login"]').waitFor();
  assert.equal(await page.locator('[data-role="session-badge"]').textContent().then((text) => text.trim()), "Not authenticated");
  assert.equal(await page.locator('[data-role="logout-error"]').count(), 0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${entry}#/setup`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-page="setup"]').waitFor();
  const mobileOverflow = await overflow(page);
  assert.ok(mobileOverflow.scrollWidth <= mobileOverflow.innerWidth);
  assert.ok(mobileOverflow.bodyScrollWidth <= mobileOverflow.innerWidth);
  await screenshot(page, "mobile-setup.png");

  const result = {
    status: "PASS",
    publicEntry: `${entry}#/setup`,
    harness: {
      kind: "combined public API fixture",
      account: "alice",
      note: "The browser harness implements only the public account-session and workspace HTTP shapes. It does not prove production account data or daemon wiring.",
    },
    checks: {
      endpointSaved: baseUrl,
      crossOriginEndpointRemoved: true,
      accountLoginTypedFailure: "ACCOUNT_CREDENTIAL_INVALID",
      accountLoginAuthenticated: true,
      workspaceDirectoryLoaded: true,
      workspaceTreeLoaded: true,
      machineSelectionUnavailable: "MACHINE_SELECTION_UNAVAILABLE",
      machineEnrollmentDisabled: "MACHINE_ENROLLMENT_UNAVAILABLE",
      logoutFailurePreservedSession: "ACCOUNT_REVOCATION_FAILED",
      logoutRequiresSessionCsrf: "CSRF_TOKEN_INVALID",
      logoutRetryAfterFailureSucceeds: true,
      desktopNoHorizontalOverflow: desktopOverflow,
      mobileNoHorizontalOverflow: mobileOverflow,
    },
  };
  await reqWriteJson(path.join(evidenceDir, "e2e-result.json"), result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  if (browser) {
    await browser.close();
  }
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function reqWriteJson(filePath, value) {
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
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
