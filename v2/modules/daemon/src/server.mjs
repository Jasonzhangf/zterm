import { createReadStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asTypedError, TypedError } from "../../errors/src/public/index.mjs";
import { observation } from "../../status/src/public/index.mjs";
import { frameToAnsi, frameToText } from "../../terminal/src/public/index.mjs";
import { isTypedError as isControlTypedError } from "../../organization/src/public/typed-error.mjs";
import { MEMBER_ERROR_CODES } from "../../members/src/public/index.mjs";
import { createTerminalAdmission, requireTarget } from "./terminal-admission.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultWebuiDir = path.resolve(moduleDir, "../../webui/src");
const maxBodyBytes = 64 * 1024;
const SESSION_COOKIE = "zterm_v2_session";
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

function daemonError(code, operationId, message, cause) {
  return new TypedError({
    code,
    owningModule: "daemon",
    operationId,
    cause,
    message,
  });
}

export function resolveV1WsUrl(baseUrl, token) {
  const trimmed = typeof baseUrl === "string" ? baseUrl.trim() : "";
  const fallback = process.env.ZTERM_V1_HOST && process.env.ZTERM_V1_PORT
    ? `ws://${process.env.ZTERM_V1_HOST}:${process.env.ZTERM_V1_PORT}/ws`
    : "ws://127.0.0.1:3333/ws";
  const url = new URL(trimmed || fallback);
  if (token && !url.searchParams.has("token")) {
    url.searchParams.set("token", token);
  }
  return url.toString();
}

// Map a TypedError from the v2 errors module or from a module still using the
// organization typed-error contract to the shared HTTP error shape.
function toHttpTypedError(error, operationId) {
  if (isControlTypedError(error) || isComposedTypedError(error)) {
    const cause = error.cause instanceof Error
      ? error.cause.message
      : (error.cause ?? null);
    return {
      code: error.code,
      owningModule: error.owningModule ?? (error.name === "AccountsError" ? "accounts" : undefined),
      operationId: error.operationId ?? operationId,
      cause,
      message: error.message,
      retryDisposition: error.retryDisposition,
      details: error.details,
      operationRef: error.operationRef,
      providerStatus: error.providerStatus,
      freshness: error.freshness,
      observationStartedAt: error.observationStartedAt,
      observationEndedAt: error.observationEndedAt,
    };
  }
  return asTypedError(error, {
    code: "DAEMON_CONTROL_FAILED",
    owningModule: "daemon",
    operationId,
    message: "The daemon control-plane request failed.",
  }).toJSON();
}

function isComposedTypedError(error) {
  return Boolean(
    error
    && typeof error === "object"
    && typeof error.code === "string"
    && (
      error.owningModule === "tickets"
      || error.owningModule === "board"
      || error.owningModule === "goals"
      || error.name === "AccountsError"
    ),
  );
}

function validateNonEmptyString(value, field, operationId) {
  if (typeof value !== "string" || !value.trim()) {
    throw daemonError("CONTROL_INPUT_INVALID", operationId, `${field} must be a non-empty string.`, `${field} must be a non-empty string.`);
  }
  return value;
}

function validateExpectedRevision(value, operationId) {
  if (!Number.isInteger(value)) {
    throw daemonError("CONTROL_INPUT_INVALID", operationId, "expectedRevision must be an integer.");
  }
  return value;
}

function redactWsUrl(value) {
  try {
    const url = new URL(value);
    if (url.searchParams.has("token")) {
      url.searchParams.set("token", "<redacted>");
    }
    return url.toString();
  } catch {
    return "<invalid-url>";
  }
}

export function createDaemon({
  v1WsUrl = process.env.ZTERM_V1_WS_URL || "",
  v1Token = process.env.ZTERM_V1_AUTH_TOKEN || "",
  v2Token = process.env.ZTERM_V2_AUTH_TOKEN || "",
  webuiDir = defaultWebuiDir,
  log = () => {},
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  terminalPort,
  admission = null,
  clientInstanceId,
  workspaceAuth,
  organization,
  members,
  routing,
  memberHostObserver,
  terminalCatalog,
  authService,
  machineService,
  machineAuthorization,
  connectionManager,
  goals,
  tickets,
  board,
  resolveActor,
} = {}) {
  const resolvedV1WsUrl = resolveV1WsUrl(v1WsUrl, v1Token);
  const terminal = terminalPort || createLazyTerminal({
    wsUrl: resolvedV1WsUrl,
    clientInstanceId,
    log,
  });
  const terminalAdmission = admission
    ? createTerminalAdmission({
        auth: admission.auth,
        members: admission.members,
        routing: admission.routing,
        machineTerminal: admission.machineTerminal,
        resolveBindingTarget: admission.resolveBindingTarget,
        terminal,
        log,
      })
    : null;
  const sessions = new Map();
  // Account-scoped machine links owned by this daemon composition.
  const machineLinks = new Map();
  const context = {
    terminal,
    admission: terminalAdmission,
    v2Token,
    webuiDir,
    sessions,
    sessionTtlMs,
    log,
    resolvedV1WsUrl,
    workspaceAuth,
    organization,
    members,
    routing,
    memberHostObserver,
    terminalCatalog,
    authService,
    machineService,
    machineAuthorization,
    connectionManager,
    machineLinks,
    goals,
    tickets,
    board,
    resolveActor,
  };

  const server = createServer((request, response) => {
    handleRequest({ request, response, context }).catch((error) => {
      const typed = asTypedError(error, {
        code: "DAEMON_REQUEST_FAILED",
        owningModule: "daemon",
        operationId: "request",
        message: "The daemon request failed.",
      });
      log({ event: "request.error", path: request.url, error: typed.toJSON() });
      if (!response.headersSent) {
        sendJson(response, statusForError(typed), { error: typed.toJSON() });
      } else {
        response.end();
      }
    });
  });

  server.on("close", () => {
    for (const link of machineLinks.values()) {
      try {
        context.connectionManager?.closeOwnLink(link);
      } catch {
        // The physical link may already be closed or superseded.
      }
    }
    machineLinks.clear();
    void terminal.close?.();
    void context.tickets?.closeStore?.();
  });

  return { server, terminal, resolvedV1WsUrl: redactWsUrl(resolvedV1WsUrl) };
}

function createLazyTerminal({ wsUrl, clientInstanceId, log }) {
  let terminal = null;
  async function ensureTerminal() {
    if (!terminal) {
      const { TerminalPort } = await import("../../terminal/src/public/index.mjs");
      terminal = new TerminalPort({ wsUrl, clientInstanceId, log });
    }
    return terminal;
  }
  return {
    async listSessions() {
      return (await ensureTerminal()).listSessions();
    },
    async subscribe(target, callbacks) {
      return (await ensureTerminal()).subscribe(target, callbacks);
    },
    async input(target, data) {
      return (await ensureTerminal()).input(target, data);
    },
    async close() {
      if (!terminal) return;
      return (await ensureTerminal()).close?.();
    },
  };
}

async function handleRequest({ request, response, context }) {
  const url = new URL(request.url, "http://127.0.0.1");
  context.log({ event: "request", method: request.method, path: url.pathname });

  if (request.method === "GET" && url.pathname === "/api/health") {
    return sendJson(response, 200, {
      status: "ok",
      observation: observation("daemon", { livenessOnly: true }),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    return login(request, response, context);
  }

  if (request.method === "GET" && url.pathname === "/api/auth/session") {
    return sessionState(request, response, context);
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    return logout(request, response, context);
  }

  if (request.method === "POST" && url.pathname === "/api/accounts/login") {
    return accountsLogin(request, response, context);
  }

  if (request.method === "GET" && url.pathname === "/api/accounts/session") {
    return accountsSession(request, response, context);
  }

  if (request.method === "POST" && url.pathname === "/api/accounts/logout") {
    return accountsLogout(request, response, context);
  }

  if (request.method === "GET" && url.pathname === "/api/sessions") {
    authenticate(request, context);
    const sessions = await context.terminal.listSessions();
    return sendJson(response, 200, {
      sessions,
      observation: observation("v1-mux", { sessions: sessions.length }),
    });
  }

  const machineRoute = matchMachineRoute(url.pathname);
  if (machineRoute) {
    return handleMachineRoute({ request, response, context, route: machineRoute });
  }

  if (request.method === "GET" && url.pathname === "/api/terminal/stream") {
    requireTerminalAdmission(context, "terminal.stream");
    return streamTerminal(
      request,
      response,
      context,
      url,
      accountsSessionHeader(request),
    );
  }

  if (request.method === "POST" && url.pathname === "/api/terminal/input") {
    requireTerminalAdmission(context, "terminal.input");
    return sendTerminalInput(
      request,
      response,
      context,
      accountsSessionHeader(request),
    );
  }

  if (request.method === "GET" && url.pathname === "/api/workspaces") {
    return listWorkspaces(request, response, context);
  }

  const workspaceRoute = matchWorkspaceRoute(url.pathname);
  if (workspaceRoute) {
    return handleWorkspaceRoute({ request, response, context, route: workspaceRoute });
  }

  if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
    return serveStatic(response, context.webuiDir, url.pathname);
  }

  if (["GET", "POST"].includes(request.method) && url.pathname.startsWith("/api/")) {
    return sendJson(response, 405, {
      error: daemonError("METHOD_NOT_ALLOWED", "route", "HTTP method is not allowed for this endpoint.", `${request.method} ${url.pathname}`).toJSON(),
    });
  }

  sendJson(response, 404, {
    error: daemonError("ROUTE_NOT_FOUND", "route", "Route was not found.", url.pathname).toJSON(),
  });
}

function matchMachineRoute(pathname) {
  if (pathname === "/api/machines") {
    return { kind: "machine-list" };
  }
  const prefix = "/api/machines/";
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const parts = pathname.slice(prefix.length).split("/").filter(Boolean);
  if (parts.length !== 2) {
    return null;
  }
  const machineId = decodeURIComponent(parts[0]);
  switch (parts[1]) {
    case "connect":
      return { kind: "machine-connect", machineId };
    case "connection":
      return { kind: "machine-connection", machineId };
    case "recover":
      return { kind: "machine-recover", machineId };
    case "disconnect":
      return { kind: "machine-disconnect", machineId };
    case "sessions":
      return { kind: "machine-sessions", machineId };
    default:
      return null;
  }
}

async function handleMachineRoute({ request, response, context, route }) {
  authenticate(request, context);
  const accountsToken = accountsSessionHeader(request);

  if (route.kind === "machine-list") {
    if (request.method !== "GET") {
      throw daemonError("METHOD_NOT_ALLOWED", "machine.list", "HTTP method is not allowed for this endpoint.", `${request.method} ${request.url}`);
    }
    requireMachineAccountsSession(accountsToken, "machine.list");
    requireMachineService(context, "machine.list");
    let machines;
    try {
      machines = await context.machineService.listAuthorizedMachines(accountsToken);
    } catch (error) {
      throw toControlTypedError(error, "machine.list");
    }
    return sendJson(response, 200, {
      machines,
      observation: observation("accounts", { machines: machines.length }),
    });
  }

  const operationId = `machine.${route.kind.slice("machine-".length)}`;
  requireConnectionManager(context, operationId);
  requireMachineAccountsSession(accountsToken, operationId);
  requireMachineAuthorization(context, operationId);

  if (route.kind === "machine-connect" || route.kind === "machine-recover") {
    if (request.method !== "POST") {
      throw daemonError("METHOD_NOT_ALLOWED", operationId, "HTTP method is not allowed for this endpoint.", `${request.method} ${request.url}`);
    }
    const authorization = await authorizeCallerMachine(
      route.machineId,
      accountsToken,
      context,
      operationId,
    );
    const link = await withTerminalAdmission(
      operationId,
      () => context.connectionManager.connect(
        route.machineId,
        accountsToken,
        authorization,
      ),
    );
    let connection;
    try {
      connection = await withTerminalAdmission(
        operationId,
        () => context.connectionManager.observeLink(link),
      );
    } catch (error) {
      try {
        context.connectionManager.closeOwnLink(link);
      } catch {
        // Preserve the original observation failure.
      }
      throw error;
    }
    context.machineLinks.set(machineLinkKey(authorization, route.machineId), link);
    return sendJson(response, 200, {
      connection,
      observation: observation("connections", {
        machineId: connection.machineId,
        generation: connection.generation,
        status: connection.status,
        freshness: connection.freshness,
      }),
    });
  }

  if (route.kind === "machine-connection") {
    if (request.method !== "GET") {
      throw daemonError("METHOD_NOT_ALLOWED", operationId, "HTTP method is not allowed for this endpoint.", `${request.method} ${request.url}`);
    }
    const authorization = await authorizeCallerMachine(
      route.machineId,
      accountsToken,
      context,
      operationId,
    );
    const link = context.machineLinks.get(
      machineLinkKey(authorization, route.machineId),
    );
    if (!link) {
      return sendJson(response, 200, {
        connection: null,
        status: "unavailable",
        observation: observation("connections", {
          machineId: route.machineId,
          status: "unavailable",
          freshness: "unavailable",
        }),
      });
    }
    const connection = await withTerminalAdmission(
      operationId,
      () => context.connectionManager.observeLink(link),
    );
    return sendJson(response, 200, {
      connection,
      status: connection.status,
      observation: observation("connections", {
        machineId: connection.machineId,
        generation: connection.generation,
        status: connection.status,
        freshness: connection.freshness,
      }),
    });
  }

  if (route.kind === "machine-disconnect") {
    if (request.method !== "POST") {
      throw daemonError("METHOD_NOT_ALLOWED", operationId, "HTTP method is not allowed for this endpoint.", `${request.method} ${request.url}`);
    }
    const authorization = await authorizeCallerMachine(
      route.machineId,
      accountsToken,
      context,
      operationId,
    );
    const linkKey = machineLinkKey(authorization, route.machineId);
    const link = requireCurrentMachineLink(
      linkKey,
      route.machineId,
      context,
      operationId,
    );
    await withTerminalAdmission(
      operationId,
      () => context.connectionManager.closeOwnLink(link),
    );
    context.machineLinks.delete(linkKey);
    return sendJson(response, 200, {
      disconnected: true,
      machineId: route.machineId,
      connection: null,
      status: "unavailable",
      observation: observation("connections", {
        machineId: route.machineId,
        status: "unavailable",
        freshness: "unavailable",
      }),
    });
  }

  if (route.kind === "machine-sessions") {
    if (request.method !== "GET") {
      throw daemonError("METHOD_NOT_ALLOWED", operationId, "HTTP method is not allowed for this endpoint.", `${request.method} ${request.url}`);
    }
    const authorization = await authorizeCallerMachine(
      route.machineId,
      accountsToken,
      context,
      operationId,
    );
    const link = requireCurrentMachineLink(
      machineLinkKey(authorization, route.machineId),
      route.machineId,
      context,
      operationId,
    );
    const sessions = await withTerminalAdmission(
      operationId,
      () => context.connectionManager.listSessions(link),
    );
    return sendJson(response, 200, {
      sessions,
      observation: observation("connections", {
        machineId: route.machineId,
        generation: link.generation,
        sessions: sessions.length,
      }),
    });
  }

  throw daemonError("ROUTE_NOT_FOUND", operationId, "Route was not found.", request.url);
}

function requireMachineService(context, operationId) {
  if (!context.machineService || typeof context.machineService.listAuthorizedMachines !== "function") {
    throw daemonError(
      "MACHINE_SERVICE_UNCONFIGURED",
      operationId,
      "The accounts machine directory port is not configured.",
    );
  }
}

function requireMachineAccountsSession(token, operationId) {
  if (!token) {
    throw daemonError(
      "MACHINE_ACCOUNT_SESSION_REQUIRED",
      operationId,
      "An accounts session credential is required.",
    );
  }
  return token;
}

function requireMachineAuthorization(context, operationId) {
  if (
    !context.machineAuthorization
    || typeof context.machineAuthorization.authorizeCallerMachine !== "function"
    || typeof context.machineAuthorization.authorizeMachine !== "function"
  ) {
    throw daemonError(
      "MACHINE_AUTHORIZATION_UNCONFIGURED",
      operationId,
      "The accounts machine authorization port is not configured.",
    );
  }
}

function requireConnectionManager(context, operationId) {
  if (
    !context.connectionManager
    || typeof context.connectionManager.connect !== "function"
    || typeof context.connectionManager.observeLink !== "function"
    || typeof context.connectionManager.listSessions !== "function"
    || typeof context.connectionManager.closeOwnLink !== "function"
  ) {
    throw daemonError(
      "MACHINE_CONNECTIONS_UNCONFIGURED",
      operationId,
      "The connections manager is not configured.",
    );
  }
}

function requireCurrentMachineLink(linkKey, machineId, context, operationId) {
  const link = context.machineLinks.get(linkKey);
  if (!link) {
    throw daemonError(
      "MACHINE_NOT_CONNECTED",
      operationId,
      "The machine has no current connection in this caller scope.",
      { machineId },
    );
  }
  return link;
}

async function authorizeCallerMachine(machineId, accountsToken, context, operationId) {
  try {
    const authorization = await context.machineAuthorization.authorizeCallerMachine(
      machineId,
      accountsToken,
    );
    const accountId = typeof authorization?.accountId === "string"
      ? authorization.accountId.trim()
      : "";
    if (!accountId) {
      throw daemonError(
        "MACHINE_ACCOUNT_SESSION_REQUIRED",
        operationId,
        "The accounts machine authorization has no account scope.",
      );
    }
    if (authorization.machineId !== machineId) {
      throw daemonError(
        "machine_mismatch",
        operationId,
        "Machine authorization does not match the requested machine.",
        machineId,
      );
    }
    return authorization;
  } catch (error) {
    throw toControlTypedError(error, operationId);
  }
}

function machineLinkKey(authorization, machineId) {
  return JSON.stringify([authorization.accountId, machineId]);
}

function matchWorkspaceRoute(pathname) {
  const prefix = "/api/workspaces/";
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const parts = pathname.slice(prefix.length).split("/").filter(Boolean);
  if (parts.length < 1 || !parts[0]) {
    return null;
  }
  const workspaceId = decodeURIComponent(parts[0]);
  if (parts.length === 2 && parts[1] === "goals") {
    return { kind: "work-goals", workspaceId };
  }
  if (parts.length === 3 && parts[1] === "goals") {
    return { kind: "work-goal", workspaceId, goalId: decodeURIComponent(parts[2]) };
  }
  if (parts.length === 2 && parts[1] === "board") {
    return { kind: "work-board", workspaceId };
  }
  if (parts.length === 2 && parts[1] === "tickets") {
    return { kind: "work-tickets", workspaceId };
  }
  if (parts.length === 3 && parts[1] === "tickets") {
    return { kind: "work-ticket", workspaceId, bindingId: decodeURIComponent(parts[2]) };
  }
  if (parts.length === 4 && parts[1] === "tickets" && parts[3] === "reports") {
    return { kind: "work-ticket-report", workspaceId, bindingId: decodeURIComponent(parts[2]) };
  }
  if (parts.length === 4 && parts[1] === "tickets" && (parts[3] === "close" || parts[3] === "reopen")) {
    return { kind: `work-ticket-${parts[3]}`, workspaceId, bindingId: decodeURIComponent(parts[2]) };
  }
  if (parts.length === 2 && parts[1] === "ticket-operations") {
    return { kind: "work-ticket-operations", workspaceId };
  }
  if (parts.length === 2 && parts[1] === "tree") {
    return { kind: "tree", workspaceId };
  }
  if (parts.length === 2 && parts[1] === "groups") {
    return { kind: "create-group", workspaceId };
  }
  if (parts.length === 2 && parts[1] === "members") {
    return { kind: "create-member", workspaceId };
  }
  if (parts.length === 2 && parts[1] === "resolve") {
    return { kind: "resolve", workspaceId };
  }
  if (parts.length === 4 && parts[1] === "members" && parts[3] === "runtime") {
    return { kind: "member-runtime", workspaceId, memberId: decodeURIComponent(parts[2]) };
  }
  if (parts.length === 4 && parts[1] === "members" && parts[3] === "binding") {
    return { kind: "member-binding", workspaceId, memberId: decodeURIComponent(parts[2]) };
  }
  if (parts.length === 4 && parts[1] === "members" && parts[3] === "restore-binding") {
    return { kind: "member-restore-binding", workspaceId, memberId: decodeURIComponent(parts[2]) };
  }
  return null;
}

async function handleWorkspaceRoute({ request, response, context, route }) {
  const { token, account } = await controlAuth(request, context);
  requireControl(context, route.kind);
  if (route.kind.startsWith("work-")) {
    return handleWorkTrackingRoute({ request, response, context, route, token, account });
  }

  if (route.kind === "create-group") {
    if (request.method !== "POST") {
      throw daemonError("METHOD_NOT_ALLOWED", "workspace.group.create", "HTTP method is not allowed for this endpoint.", `${request.method} ${request.url}`);
    }
    const body = await readJson(request);
    let group;
    try {
      group = await context.organization.createGroup({
        token,
        workspaceId: route.workspaceId,
        name: requireBodyText(body, "name", "workspace.group.create"),
        parentGroupId: body.parentGroupId ?? null,
        expectedRevision: validateExpectedRevision(body.expectedRevision, "workspace.group.create"),
      });
    } catch (error) {
      throw toControlTypedError(error, "workspace.group.create");
    }
    return sendJson(response, 201, { group });
  }

  if (route.kind === "create-member") {
    if (request.method !== "POST") {
      throw daemonError("METHOD_NOT_ALLOWED", "workspace.member.create", "HTTP method is not allowed for this endpoint.", `${request.method} ${request.url}`);
    }
    const body = await readJson(request);
    let member;
    try {
      member = await context.organization.addMember({
        token,
        workspaceId: route.workspaceId,
        groupId: requireBodyText(body, "groupId", "workspace.member.create"),
        name: requireBodyText(body, "name", "workspace.member.create"),
        ...(body.managerMemberId !== undefined ? { managerMemberId: body.managerMemberId } : {}),
        expectedRevision: validateExpectedRevision(body.expectedRevision, "workspace.member.create"),
      });
    } catch (error) {
      throw toControlTypedError(error, "workspace.member.create");
    }
    return sendJson(response, 201, { member });
  }

  if (route.kind === "tree") {
    if (request.method !== "GET") {
      throw daemonError("METHOD_NOT_ALLOWED", "workspace.tree", "HTTP method is not allowed for this endpoint.", `${request.method} ${request.url}`);
    }
    const tree = await listWorkspaceTree(token, route.workspaceId, context);
    return sendJson(response, 200, tree);
  }

  if (route.kind === "member-runtime") {
    if (request.method === "GET") {
      const member = await queryMemberControl(token, route.workspaceId, route.memberId, context);
      return sendJson(response, 200, member);
    }
    if (request.method !== "POST") {
      throw daemonError("METHOD_NOT_ALLOWED", "workspace.member-runtime", "HTTP method is not allowed for this endpoint.", `${request.method} ${request.url}`);
    }
    await findAuthorizedMember(token, route.workspaceId, route.memberId, context, "workspace.member-runtime");
    if (typeof context.members.configureRuntime !== "function") {
      throw daemonError("CONTROL_MEMBERS_UNCONFIGURED", "workspace.member-runtime", "The members runtime write port is not configured.");
    }
    const body = await readJson(request);
    let runtime;
    try {
      runtime = await context.members.configureRuntime({
        token,
        memberId: route.memberId,
        machineId: requireBodyText(body, "machineId", "workspace.member-runtime"),
        hostKind: requireBodyText(body, "hostKind", "workspace.member-runtime"),
        agentKind: requireBodyText(body, "agentKind", "workspace.member-runtime"),
        launchProfileRef: requireBodyText(body, "launchProfileRef", "workspace.member-runtime"),
      });
    } catch (error) {
      throw toControlTypedError(error, "workspace.member-runtime");
    }
    return sendJson(response, 200, { runtime });
  }

  if (route.kind === "member-binding") {
    if (request.method !== "POST") {
      throw daemonError("METHOD_NOT_ALLOWED", "workspace.member-binding", "HTTP method is not allowed for this endpoint.", `${request.method} ${request.url}`);
    }
    await findAuthorizedMember(token, route.workspaceId, route.memberId, context, "workspace.member-binding");
    if (typeof context.members.bindSession !== "function") {
      throw daemonError("CONTROL_MEMBERS_UNCONFIGURED", "workspace.member-binding", "The members binding port is not configured.");
    }
    const body = await readJson(request);
    if (!Number.isInteger(body.expectedGeneration) || body.expectedGeneration < 0) {
      throw daemonError("CONTROL_INPUT_INVALID", "workspace.member-binding", "expectedGeneration must be a non-negative integer.");
    }
    let binding;
    try {
      binding = await context.members.bindSession({
        token,
        memberId: route.memberId,
        sessionId: requireBodyText(body, "sessionId", "workspace.member-binding"),
        anchor: requireBodyText(body, "anchor", "workspace.member-binding"),
        expectedGeneration: body.expectedGeneration,
        ...(body.terminalTarget !== undefined ? { terminalTarget: body.terminalTarget } : {}),
      });
    } catch (error) {
      throw toControlTypedError(error, "workspace.member-binding");
    }
    return sendJson(response, 200, { binding });
  }

  if (route.kind === "member-restore-binding") {
    if (request.method !== "POST") {
      throw daemonError("METHOD_NOT_ALLOWED", "workspace.member-restore-binding", "HTTP method is not allowed for this endpoint.", `${request.method} ${request.url}`);
    }
    await findAuthorizedMember(token, route.workspaceId, route.memberId, context, "workspace.member-restore-binding");
    if (typeof context.members.restoreBinding !== "function") {
      throw daemonError("CONTROL_MEMBERS_UNCONFIGURED", "workspace.member-restore-binding", "The members restore port is not configured.");
    }
    const body = await readJson(request);
    if (!Number.isInteger(body.expectedGeneration) || body.expectedGeneration < 0) {
      throw daemonError("CONTROL_INPUT_INVALID", "workspace.member-restore-binding", "expectedGeneration must be a non-negative integer.");
    }
    let verification;
    try {
      verification = await context.members.restoreBinding({
        token,
        memberId: route.memberId,
        machineId: requireBodyText(body, "machineId", "workspace.member-restore-binding"),
        expectedGeneration: body.expectedGeneration,
      });
    } catch (error) {
      throw toControlTypedError(error, "workspace.member-restore-binding");
    }
    return sendJson(response, 200, { verification });
  }

  if (route.kind === "resolve") {
    if (request.method !== "POST") {
      throw daemonError("METHOD_NOT_ALLOWED", "workspace.resolve", "HTTP method is not allowed for this endpoint.", `${request.method} ${request.url}`);
    }
    const body = await readJson(request);
    const address = buildResolveAddress(body);
    let resolved;
    try {
      resolved = await context.routing.resolve({ token, workspaceId: route.workspaceId, address });
    } catch (error) {
      throw toControlTypedError(error, "workspace.resolve");
    }
    return sendJson(response, 200, {
      resolved,
      observation: observation("routing", { workspaceId: route.workspaceId, memberId: resolved.memberId }),
    });
  }

  throw daemonError("ROUTE_NOT_FOUND", "workspace.route", "Route was not found.", request.url);
}

function requireWorkTracking(context, operationId) {
  if (!context.goals || !context.tickets || !context.board) {
    throw daemonError(
      "WORK_TRACKING_UNCONFIGURED",
      operationId,
      "Goals, tickets, and board are not configured.",
    );
  }
}

async function resolveWorkTrackingActor(context, token, account, workspaceId) {
  const resolver = typeof context.tickets?.resolveActor === "function"
    ? context.tickets.resolveActor.bind(context.tickets)
    : (typeof context.resolveActor === "function" ? context.resolveActor : null);
  if (!resolver) {
    throw daemonError(
      "WORK_TRACKING_ACTOR_UNCONFIGURED",
      "work-tracking.auth",
      "The verified account-to-member resolver is not configured.",
    );
  }
  try {
    return await resolver({ token, account, workspaceId });
  } catch (error) {
    throw toControlTypedError(error, "work-tracking.auth");
  }
}

function parsePositiveInteger(value, field, fallback, operationId) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw daemonError("CONTROL_INPUT_INVALID", operationId, `${field} must be a non-negative integer.`);
  }
  return parsed;
}

function optionalQueryText(url, name) {
  const value = url.searchParams.get(name);
  return value === null || value === "" ? undefined : value;
}

function requireBodyText(body, field, operationId) {
  return validateNonEmptyString(body?.[field], field, operationId);
}

function projectTicketObservation(observation, allowedTransitions = []) {
  if (!observation || typeof observation !== "object") return observation;
  return {
    ...observation,
    allowedTransitions,
  };
}

async function handleWorkTrackingRoute({ request, response, context, route, token, account }) {
  requireWorkTracking(context, route.kind);
  const url = new URL(request.url, "http://127.0.0.1");
  const operationId = route.kind;

  if (route.kind === "work-goals") {
    if (request.method === "GET") {
      const parentGoalId = optionalQueryText(url, "parentGoalId");
      let goals;
      try {
        goals = await context.goals.listGoals({
          token,
          workspaceId: route.workspaceId,
          ...(parentGoalId ? { parentGoalId } : {}),
        });
      } catch (error) {
        throw toControlTypedError(error, operationId);
      }
      return sendJson(response, 200, { goals });
    }
    if (request.method === "POST") {
      const body = await readJson(request);
      let goal;
      try {
        goal = await context.goals.createGoal({
          token,
          workspaceId: route.workspaceId,
          name: requireBodyText(body, "name", operationId),
          ownerMemberId: requireBodyText(body, "ownerMemberId", operationId),
          ...(body.parentGoalId !== undefined ? { parentGoalId: body.parentGoalId } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
        });
      } catch (error) {
        throw toControlTypedError(error, operationId);
      }
      return sendJson(response, 200, { goal });
    }
    throw daemonError("METHOD_NOT_ALLOWED", operationId, "HTTP method is not allowed for this endpoint.", `${request.method} ${request.url}`);
  }

  if (route.kind === "work-goal") {
    if (request.method !== "GET") {
      throw daemonError("METHOD_NOT_ALLOWED", operationId, "HTTP method is not allowed for this endpoint.", `${request.method} ${request.url}`);
    }
    let goal;
    try {
      goal = await context.goals.getGoal({
        token,
        workspaceId: route.workspaceId,
        goalId: route.goalId,
      });
    } catch (error) {
      throw toControlTypedError(error, operationId);
    }
    return sendJson(response, 200, { goal });
  }

  if (route.kind === "work-board") {
    if (request.method !== "GET") {
      throw daemonError("METHOD_NOT_ALLOWED", operationId, "HTTP method is not allowed for this endpoint.", `${request.method} ${request.url}`);
    }
    const managerId = requireBodyText({ managerId: url.searchParams.get("managerId") }, "managerId", operationId);
    let result;
    try {
      result = await context.board.queryManagerBoard({
        token,
        workspaceId: route.workspaceId,
        managerId,
      });
    } catch (error) {
      throw toControlTypedError(error, operationId);
    }
    return sendJson(response, 200, result);
  }

  const actor = await resolveWorkTrackingActor(context, token, account, route.workspaceId);

  if (route.kind === "work-tickets") {
    if (request.method === "GET") {
      const status = optionalQueryText(url, "status") || "all";
      if (status !== "all" && status !== "open" && status !== "closed") {
        throw daemonError("CONTROL_INPUT_INVALID", operationId, "status must be all, open, or closed.");
      }
      let result;
      try {
        result = await context.tickets.list(actor, {
          workspaceId: route.workspaceId,
          ...(optionalQueryText(url, "goalId") ? { goalId: optionalQueryText(url, "goalId") } : {}),
          status,
          ...(optionalQueryText(url, "ownerMemberId") ? { ownerMemberId: optionalQueryText(url, "ownerMemberId") } : {}),
          limit: parsePositiveInteger(url.searchParams.get("limit"), "limit", 50, operationId),
          ...(optionalQueryText(url, "cursor") ? { cursor: optionalQueryText(url, "cursor") } : {}),
        });
      } catch (error) {
        throw toControlTypedError(error, operationId);
      }
      const items = await Promise.all(result.items.map(async (item) => projectTicketObservation(
        item,
        await context.tickets.authorizedTransitions(actor, item),
      )));
      return sendJson(response, 200, { ...result, items });
    }
    if (request.method === "POST") {
      const body = await readJson(request);
      if (!["requirement", "bug", "report", "other"].includes(body.category)) {
        throw daemonError("CONTROL_INPUT_INVALID", operationId, "category must be requirement, bug, report, or other.");
      }
      if (!Number.isSafeInteger(body.priority)) {
        throw daemonError("CONTROL_INPUT_INVALID", operationId, "priority must be an integer.");
      }
      let result;
      try {
        result = await context.tickets.create(actor, {
          operationId: requireBodyText(body, "operationId", operationId),
          workspaceId: route.workspaceId,
          goalId: requireBodyText(body, "goalId", operationId),
          ownerMemberId: requireBodyText(body, "ownerMemberId", operationId),
          category: body.category,
          title: requireBodyText(body, "title", operationId),
          description: typeof body.description === "string" ? body.description : "",
          priority: body.priority,
        });
        if (result.operation?.state === "succeeded" && result.binding?.bindingId) {
          const authoritative = await context.tickets.get(actor, { bindingId: result.binding.bindingId });
          result = {
            ...result,
            ticket: projectTicketObservation(
              authoritative,
              await context.tickets.authorizedTransitions(actor, authoritative),
            ),
          };
        }
      } catch (error) {
        throw toControlTypedError(error, operationId);
      }
      return sendJson(response, 200, result);
    }
    throw daemonError("METHOD_NOT_ALLOWED", operationId, "HTTP method is not allowed for this endpoint.", `${request.method} ${request.url}`);
  }

  if (route.kind === "work-ticket") {
    if (request.method !== "GET") {
      throw daemonError("METHOD_NOT_ALLOWED", operationId, "HTTP method is not allowed for this endpoint.", `${request.method} ${request.url}`);
    }
    let observation;
    try {
      observation = await context.tickets.getInWorkspace(actor, route.workspaceId, route.bindingId);
    } catch (error) {
      throw toControlTypedError(error, operationId);
    }
    return sendJson(response, 200, projectTicketObservation(
      observation,
      await context.tickets.authorizedTransitions(actor, observation),
    ));
  }

  if (route.kind === "work-ticket-report") {
    if (request.method !== "POST") {
      throw daemonError("METHOD_NOT_ALLOWED", operationId, "HTTP method is not allowed for this endpoint.", `${request.method} ${request.url}`);
    }
    const body = await readJson(request);
    if (!["status", "result", "blocker", "note"].includes(body.reportKind)) {
      throw daemonError("CONTROL_INPUT_INVALID", operationId, "reportKind must be status, result, blocker, or note.");
    }
    let result;
    try {
      const input = {
        operationId: requireBodyText(body, "operationId", operationId),
        bindingId: route.bindingId,
        actorMemberId: requireBodyText(body, "actorMemberId", operationId),
        ...(body.executingMemberId !== undefined ? { executingMemberId: body.executingMemberId } : {}),
        reportKind: body.reportKind,
        body: requireBodyText(body, "body", operationId),
      };
      result = await context.tickets.appendReportInWorkspace(actor, route.workspaceId, input);
    } catch (error) {
      throw toControlTypedError(error, operationId);
    }
    return sendJson(response, 200, result);
  }

  if (route.kind === "work-ticket-close" || route.kind === "work-ticket-reopen") {
    if (request.method !== "POST") {
      throw daemonError("METHOD_NOT_ALLOWED", operationId, "HTTP method is not allowed for this endpoint.", `${request.method} ${request.url}`);
    }
    const body = await readJson(request);
    let result;
    try {
      const method = route.kind === "work-ticket-close" ? "close" : "reopen";
      result = await context.tickets[`${method}InWorkspace`](actor, route.workspaceId, {
        operationId: requireBodyText(body, "operationId", operationId),
        bindingId: route.bindingId,
      });
    } catch (error) {
      throw toControlTypedError(error, operationId);
    }
    return sendJson(response, 200, result);
  }

  if (route.kind === "work-ticket-operations") {
    if (request.method !== "GET") {
      throw daemonError("METHOD_NOT_ALLOWED", operationId, "HTTP method is not allowed for this endpoint.", `${request.method} ${request.url}`);
    }
    let operations;
    try {
      operations = await context.tickets.listPendingWrites(actor, route.workspaceId);
    } catch (error) {
      throw toControlTypedError(error, operationId);
    }
    return sendJson(response, 200, { operations: context.tickets.operationsView(operations) });
  }

  throw daemonError("ROUTE_NOT_FOUND", operationId, "Route was not found.", request.url);
}

async function controlAuth(request, context) {
  if (!requestOriginAllowed(request)) {
    throw daemonError("ORIGIN_NOT_ALLOWED", "control.auth", "Cross-origin request is not allowed.");
  }
  if (!context.workspaceAuth || typeof context.workspaceAuth.verify !== "function") {
    throw daemonError("CONTROL_AUTH_UNCONFIGURED", "control.auth", "The control-plane workspace authorization adapter is not configured.");
  }
  const token = accountsSessionHeader(request) || controlToken(request);
  if (!token) {
    throw daemonError("CONTROL_CREDENTIAL_REQUIRED", "control.auth", "A control-plane credential is required.");
  }
  let account;
  try {
    account = await context.workspaceAuth.verify(token);
  } catch (error) {
    throw toControlTypedError(error, "control.auth");
  }
  if (!account || typeof account !== "object") {
    throw daemonError("CONTROL_AUTH_INVALID", "control.auth", "The workspace authorization adapter returned an invalid account context.");
  }
  return { token, account };
}

function requireControl(context, operationId) {
  if (String(operationId).startsWith("work-")) {
    return;
  }
  if (operationId === "resolve") {
    if (!context.routing || typeof context.routing.resolve !== "function") {
      throw daemonError("CONTROL_ROUTING_UNCONFIGURED", operationId, "The routing port is not configured.");
    }
    return;
  }
  if (operationId === "create-group") {
    if (!context.organization || typeof context.organization.createGroup !== "function") {
      throw daemonError("CONTROL_ORGANIZATION_UNCONFIGURED", operationId, "The organization createGroup port is not configured.");
    }
    return;
  }
  if (operationId === "create-member") {
    if (!context.organization || typeof context.organization.addMember !== "function") {
      throw daemonError("CONTROL_ORGANIZATION_UNCONFIGURED", operationId, "The organization addMember port is not configured.");
    }
    return;
  }
  if (!context.organization || typeof context.organization.queryTree !== "function") {
    throw daemonError("CONTROL_ORGANIZATION_UNCONFIGURED", operationId, "The organization tree port is not configured.");
  }
  if (!context.members
    || typeof context.members.queryRuntime !== "function"
    || typeof context.members.queryBindingState !== "function") {
    throw daemonError("CONTROL_MEMBERS_UNCONFIGURED", operationId, "The members runtime/binding port is not configured.");
  }
  if (operationId === "member-binding" || operationId === "member-restore-binding") {
    if (typeof context.members.hasHostProbe !== "function" || !context.members.hasHostProbe()) {
      throw daemonError("CONTROL_HOST_PROBE_UNCONFIGURED", operationId, "The members host probe is not configured.");
    }
  }
}

async function listWorkspaces(request, response, context) {
  const { token } = await controlAuth(request, context);
  if (!context.organization || typeof context.organization.listWorkspaces !== "function") {
    throw daemonError("CONTROL_ORGANIZATION_UNCONFIGURED", "workspace.list", "The organization listWorkspaces port is not configured.");
  }
  let workspaces;
  try {
    workspaces = await context.organization.listWorkspaces({ token });
  } catch (error) {
    throw toControlTypedError(error, "workspace.list");
  }
  sendJson(response, 200, {
    workspaces,
    observation: observation("organization", { workspaces: workspaces.length }),
  });
}

async function listWorkspaceTree(token, workspaceId, context) {
  let tree;
  try {
    tree = await context.organization.queryTree({ token, workspaceId });
  } catch (error) {
    throw toControlTypedError(error, "workspace.tree");
  }
  const groups = collectGroups(tree.root);
  const members = groups.flatMap((group) => group.members ?? []);
  const controls = new Map();
  for (const member of members) {
    controls.set(member.memberId, await projectMemberControl(token, member, context, { preserveUnbound: true }));
  }
  for (const member of members) {
    const control = controls.get(member.memberId);
    Object.assign(member, {
      availability: control.availability,
      runtime: control.runtime,
      binding: control.binding,
    });
  }
  // Terminal catalog entries are never projected as organization members. The
  // composed view reports any target that has no organization member as
  // unassigned so detection is explicit rather than a silent drop.
  const terminalCatalog = await observeTerminalCatalog(context);
  const organizationTargets = new Set(
    members.flatMap((member) => [member.memberId, member.name].filter(Boolean)),
  );
  const unassignedTerminalTargets = terminalCatalog.status === "observed"
    ? terminalCatalog.sessions
    .map((session) => session.name ?? session.id ?? session.target ?? null)
    .filter((target) => target !== null && !organizationTargets.has(target))
    : null;
  return {
    workspace: tree.workspace,
    root: tree.root,
    observation: observation("daemon-control-plane", {
      workspaceId,
      memberCount: members.length,
      unassignedTerminalTargets,
      terminalCatalog: {
        status: terminalCatalog.status,
        reason: terminalCatalog.reason ?? null,
        ...(terminalCatalog.error ? { error: terminalCatalog.error } : {}),
      },
    }),
  };
}

async function observeTerminalCatalog(context) {
  if (!context.terminalCatalog || typeof context.terminalCatalog.listSessions !== "function") {
    return { status: "unknown", reason: "terminal_catalog_unconfigured", sessions: null };
  }
  let sessions;
  try {
    sessions = await context.terminalCatalog.listSessions();
  } catch (error) {
    return {
      status: "unknown",
      reason: "terminal_catalog_unavailable",
      sessions: null,
      error: toControlErrorRecord(error, "workspace.tree.terminal-catalog"),
    };
  }
  if (!Array.isArray(sessions)) {
    return {
      status: "unknown",
      reason: "terminal_catalog_invalid",
      sessions: null,
      error: toControlErrorRecord(
        daemonError(
          "TERMINAL_CATALOG_INVALID",
          "workspace.tree.terminal-catalog",
          "The terminal catalog port returned an invalid observation.",
        ),
        "workspace.tree.terminal-catalog",
      ),
    };
  }
  return { status: "observed", reason: null, sessions };
}

function toControlErrorRecord(error, operationId) {
  const payload = toHttpTypedError(error, operationId);
  return {
    code: payload.code,
    owningModule: payload.owningModule,
    operationId: payload.operationId ?? operationId,
    cause: payload.cause ?? null,
    message: payload.message,
    retryDisposition: payload.retryDisposition ?? error?.retryDisposition ?? "terminal",
    details: payload.details ?? null,
  };
}

function collectGroups(node, result = []) {
  if (!node) return result;
  result.push(node);
  for (const child of node.children ?? []) {
    collectGroups(child, result);
  }
  return result;
}

async function queryMemberControl(token, workspaceId, memberId, context, options = {}) {
  const { member, group } = await findAuthorizedMember(token, workspaceId, memberId, context, "workspace.member-runtime");
  return projectMemberControl(token, { ...member, groupPath: group.path }, context, options);
}

async function findAuthorizedMember(token, workspaceId, memberId, context, operationId) {
  let tree;
  try {
    tree = await context.organization.queryTree({ token, workspaceId });
  } catch (error) {
    throw toControlTypedError(error, operationId);
  }
  const group = collectGroups(tree.root)
    .find((candidate) => (candidate.members ?? []).some((member) => member.memberId === memberId));
  const member = group?.members?.find((candidate) => candidate.memberId === memberId);
  if (!group || !member) {
    throw daemonError("CONTROL_MEMBER_NOT_FOUND", operationId, "The member is not in the requested workspace.", `${memberId} in ${workspaceId}`);
  }
  return { member, group };
}

async function projectMemberControl(token, member, context, options = {}) {
  let runtime = null;
  let binding = null;
  let availability = null;
  let bindingGeneration = 0;
  const memberId = member.memberId;
  try {
    runtime = await context.members.queryRuntime({ token, memberId });
  } catch (error) {
    if (isControlTypedError(error) && error.code === MEMBER_ERROR_CODES.MEMBER_FORBIDDEN_MEMBER) {
      throw toControlTypedError(error, "workspace.member-runtime");
    }
    if (!isControlTypedError(error) || error.code !== MEMBER_ERROR_CODES.MEMBER_RUNTIME_NOT_CONFIGURED) {
      throw toControlTypedError(error, "workspace.member-runtime");
    }
  }
  if (runtime) {
    try {
      const bindingState = await context.members.queryBindingState({ token, memberId });
      bindingGeneration = bindingState.generation;
      binding = bindingState.binding ?? null;
    } catch (error) {
      if (isControlTypedError(error) && error.code === MEMBER_ERROR_CODES.MEMBER_FORBIDDEN_MEMBER) {
        throw toControlTypedError(error, "workspace.member-runtime");
      }
      throw toControlTypedError(error, "workspace.member-runtime");
    }
  }
  if (binding) {
    availability = await observeMemberAvailability(context, { memberId, runtime, binding });
  } else {
    availability = {
      status: "unavailable",
      reason: "binding_not_found",
      unbound: options.preserveUnbound === true,
      observedAt: new Date().toISOString(),
      bindingGeneration: null,
      sessionId: null,
      anchor: null,
    };
  }

  return {
    member: { ...member },
    runtime,
    binding,
    availability,
    bindingGeneration,
    agentCapabilities: MEMBER_AGENT_CAPABILITIES,
  };
}

const MEMBER_AGENT_CAPABILITIES = Object.freeze({
  start: "unsupported",
  resume: "unsupported",
});

async function observeMemberAvailability(context, { memberId, runtime, binding }) {
  if (!context.memberHostObserver || typeof context.memberHostObserver.observe !== "function") {
    return {
      status: "unknown",
      reason: "host_observation_unavailable",
      observedAt: new Date().toISOString(),
      bindingGeneration: binding.generation ?? binding.bindingGeneration ?? null,
      sessionId: binding.sessionId ?? null,
      anchor: binding.anchor ?? null,
      machineId: runtime.machineId ?? null,
    };
  }
  try {
    const observation = await context.memberHostObserver.observe({ memberId, runtime, binding });
    return {
      status: observation.available === false ? "unavailable" : "bound",
      reason: observation.available === false ? observation.reason ?? "host_unavailable" : "host_observed",
      observedAt: observation.observedAt ?? new Date().toISOString(),
      bindingGeneration: binding.generation ?? binding.bindingGeneration ?? null,
      sessionId: observation.sessionId ?? binding.sessionId ?? null,
      anchor: observation.anchor ?? binding.anchor ?? null,
      machineId: observation.machineId ?? runtime.machineId ?? null,
    };
  } catch (error) {
    return {
      status: "unavailable",
      reason: isControlTypedError(error) ? error.code : "host_observation_failed",
      observedAt: new Date().toISOString(),
      bindingGeneration: binding.generation ?? binding.bindingGeneration ?? null,
      sessionId: binding.sessionId ?? null,
      anchor: binding.anchor ?? null,
      machineId: runtime.machineId ?? null,
    };
  }
}

function toControlTypedError(error, operationId) {
  const payload = toHttpTypedError(error, operationId);
  const typed = daemonError(payload.code, payload.operationId ?? operationId, payload.message, payload.cause);
  typed.owningModule = payload.owningModule;
  typed.retryDisposition = payload.retryDisposition;
  typed.details = payload.details;
  typed.operationRef = payload.operationRef;
  typed.providerStatus = payload.providerStatus;
  typed.toJSON = () => Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined),
  );
  if (Number.isInteger(error?.status)) {
    typed.status = error.status;
  }
  return typed;
}

function buildResolveAddress(body) {
  const address = {};
  address.machineId = validateNonEmptyString(body?.machineId, "machineId", "workspace.resolve");
  address.groupPath = validateNonEmptyString(body?.groupPath, "groupPath", "workspace.resolve");
  if (body.memberId !== undefined) {
    address.memberId = validateNonEmptyString(body.memberId, "memberId", "workspace.resolve");
  }
  if (body.memberName !== undefined) {
    address.memberName = validateNonEmptyString(body.memberName, "memberName", "workspace.resolve");
  }
  if (body.expectedGeneration !== undefined) {
    if (!Number.isInteger(body.expectedGeneration) || body.expectedGeneration < 0) {
      throw daemonError("CONTROL_INPUT_INVALID", "workspace.resolve", "expectedGeneration must be a non-negative integer.");
    }
    address.expectedGeneration = body.expectedGeneration;
  }
  return address;
}

function requestOriginAllowed(request) {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !origin) {
    return true;
  }
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function parseCookies(header) {
  const cookies = {};
  if (typeof header !== "string" || !header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = part.slice(0, index).trim();
    if (key) {
      cookies[key] = decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return cookies;
}

function credentialHeader(request) {
  const bearer = request.headers.authorization;
  if (typeof bearer === "string" && bearer.toLowerCase().startsWith("bearer ")) {
    return bearer.slice(7).trim();
  }
  const headerToken = request.headers["x-zterm-v2-token"];
  if (typeof headerToken === "string" && headerToken.trim()) {
    return headerToken.trim();
  }
  return "";
}

function accountsSessionHeader(request) {
  const value = request.headers["x-zterm-accounts-session"];
  return typeof value === "string" ? value.trim() : "";
}

function controlToken(request) {
  const bearer = request.headers.authorization;
  if (typeof bearer === "string" && bearer.toLowerCase().startsWith("bearer ")) {
    return bearer.slice(7).trim();
  }
  return "";
}

function readSession(request, context) {
  const sid = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (!sid) {
    return null;
  }
  const session = context.sessions.get(sid);
  if (!session) {
    return { expired: true };
  }
  if (session.expiresAt <= Date.now()) {
    context.sessions.delete(sid);
    return { expired: true };
  }
  return { sid, ...session };
}

function createSession(context) {
  const sid = randomBytes(24).toString("base64url");
  const csrf = randomBytes(18).toString("base64url");
  const expiresAt = Date.now() + context.sessionTtlMs;
  context.sessions.set(sid, { csrf, expiresAt });
  return { sid, csrf, expiresAt };
}

function sessionCookieValue(sid, context) {
  const maxAge = Math.max(1, Math.floor(context.sessionTtlMs / 1000));
  return `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

function authenticate(request, context, options = {}) {
  if (!context.v2Token) {
    throw daemonError("V2_AUTH_UNCONFIGURED", "auth", "V2 credential is not configured.");
  }
  const provided = credentialHeader(request);
  if (provided) {
    if (!constantTimeEqual(provided, context.v2Token)) {
      throw daemonError("V2_CREDENTIAL_INVALID", "auth", "V2 credential is invalid.");
    }
    return { kind: "header" };
  }
  const session = readSession(request, context);
  if (session && session.expired) {
    throw daemonError("V2_SESSION_EXPIRED", "auth", "V2 session has expired.");
  }
  if (!session) {
    throw daemonError("V2_CREDENTIAL_REQUIRED", "auth", "A V2 credential is required.");
  }
  if (!requestOriginAllowed(request)) {
    throw daemonError("ORIGIN_NOT_ALLOWED", "auth", "Cross-origin request is not allowed.");
  }
  if (options.requireCsrf) {
    const csrf = request.headers["x-zterm-csrf"];
    if (typeof csrf !== "string" || !constantTimeEqual(csrf, session.csrf)) {
      throw daemonError("CSRF_REQUIRED", "auth", "A valid CSRF header is required.");
    }
  }
  return { kind: "cookie", sid: session.sid };
}

async function login(request, response, context) {
  if (!context.v2Token) {
    throw daemonError("V2_AUTH_UNCONFIGURED", "auth.login", "V2 credential is not configured.");
  }
  if (!requestOriginAllowed(request)) {
    throw daemonError("ORIGIN_NOT_ALLOWED", "auth.login", "Cross-origin login is not allowed.");
  }
  const body = await readJson(request);
  const provided = typeof body.token === "string" && body.token.trim()
    ? body.token.trim()
    : credentialHeader(request);
  if (!provided) {
    throw daemonError("V2_CREDENTIAL_REQUIRED", "auth.login", "A V2 credential is required.");
  }
  if (!constantTimeEqual(provided, context.v2Token)) {
    throw daemonError("V2_CREDENTIAL_INVALID", "auth.login", "V2 credential is invalid.");
  }
  const session = createSession(context);
  response.setHeader("set-cookie", sessionCookieValue(session.sid, context));
  sendJson(response, 200, {
    ok: true,
    csrfToken: session.csrf,
    expiresAt: new Date(session.expiresAt).toISOString(),
  });
}

function sessionState(request, response, context) {
  if (!context.v2Token) {
    return sendJson(response, 200, { authenticated: false, configured: false });
  }
  const session = readSession(request, context);
  const authenticated = Boolean(session && !session.expired);
  sendJson(response, 200, {
    authenticated,
    configured: true,
    ...(authenticated ? { csrf: session.csrf } : {}),
  });
}

function logout(request, response, context) {
  const session = readSession(request, context);
  if (session && session.sid) {
    context.sessions.delete(session.sid);
  }
  response.setHeader("set-cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  sendJson(response, 200, { ok: true });
}

function requireAccountsAuthService(context, operationId) {
  if (
    !context.authService
    || typeof context.authService.login !== "function"
    || typeof context.authService.verifySession !== "function"
    || typeof context.authService.logout !== "function"
  ) {
    throw daemonError(
      "ACCOUNTS_SERVICE_UNCONFIGURED",
      operationId,
      "The accounts session service is not configured.",
    );
  }
}

async function accountsLogin(request, response, context) {
  authenticate(request, context);
  if (!requestOriginAllowed(request)) {
    throw daemonError("ORIGIN_NOT_ALLOWED", "accounts.login", "Cross-origin login is not allowed.");
  }
  requireAccountsAuthService(context, "accounts.login");
  const body = await readJson(request);
  const loginName = validateNonEmptyString(
    body.loginName,
    "loginName",
    "accounts.login",
  );
  const credential = validateNonEmptyString(
    body.credential,
    "credential",
    "accounts.login",
  );
  let result;
  try {
    result = await context.authService.login({ loginName, credential });
  } catch (error) {
    throw toControlTypedError(error, "accounts.login");
  }
  return sendJson(response, 200, {
    token: result.token,
    account: {
      accountId: result.authContext.accountId,
      loginName: result.authContext.loginName,
    },
  });
}

async function accountsSession(request, response, context) {
  authenticate(request, context);
  requireAccountsAuthService(context, "accounts.session");
  let authContext;
  try {
    authContext = await context.authService.verifySession(
      accountsSessionHeader(request),
    );
  } catch (error) {
    throw toControlTypedError(error, "accounts.session");
  }
  return sendJson(response, 200, {
    account: {
      accountId: authContext.accountId,
      loginName: authContext.loginName,
    },
  });
}

async function accountsLogout(request, response, context) {
  authenticate(request, context);
  requireAccountsAuthService(context, "accounts.logout");
  const token = accountsSessionHeader(request);
  let authContext;
  try {
    authContext = await context.authService.verifySession(token);
  } catch (error) {
    throw toControlTypedError(error, "accounts.logout");
  }
  await closeAccountMachineLinks(authContext.accountId, context, "accounts.logout");
  try {
    await context.authService.logout(token);
  } catch (error) {
    throw toControlTypedError(error, "accounts.logout");
  }
  return sendJson(response, 200, { ok: true });
}

async function closeAccountMachineLinks(accountId, context, operationId) {
  const accountLinks = [];
  for (const [key, link] of context.machineLinks) {
    if (machineLinkAccountId(key) === accountId) {
      accountLinks.push({ key, link });
    }
  }
  for (const { key, link } of accountLinks) {
    await withTerminalAdmission(
      operationId,
      () => context.connectionManager.closeOwnLink(link),
    );
    context.machineLinks.delete(key);
  }
}

function machineLinkAccountId(key) {
  const [accountId] = JSON.parse(key);
  return accountId;
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a[index] ^ b[index];
  }
  return diff === 0;
}

async function streamTerminal(request, response, context, url, callerToken) {
  let streamSession = null;
  let streamResolution = null;
  let target = null;
  requireTerminalAdmission(context, "terminal.stream");
  authenticate(request, context);
  requireMachineAccountsSession(callerToken, "terminal.stream");
  streamResolution = await withTerminalAdmission("terminal.stream", () => context.admission.admit({
    callerToken,
    workspaceId: url.searchParams.get("workspaceId"),
    memberId: url.searchParams.get("memberId"),
    machineId: url.searchParams.get("machineId"),
    groupPath: url.searchParams.get("groupPath"),
    expectedGeneration: parseOptionalInteger(url.searchParams.get("expectedGeneration")),
    target: requireTarget(
      {
        backend: url.searchParams.get("backend"),
        stableId: url.searchParams.get("stableId"),
      },
      "terminal.stream",
    ),
  }));
  streamSession = streamResolution.session;
  target = streamSession.stableId;
  streamResolution = {
    ...streamResolution,
    terminal: await withTerminalAdmission("terminal.stream", () => (
      context.admission.requireCurrent(streamResolution, "terminal.stream")
    )),
  };

  let closed = false;
  let subscription = null;
  let started = false;
  let heartbeat = null;
  const pending = [];
  const send = (event, data) => {
    if (closed || response.writableEnded || response.destroyed) {
      return;
    }
    if (!started) {
      pending.push([event, data]);
      return;
    }
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  function finish() {
    if (closed) {
      return;
    }
    closed = true;
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    try {
      subscription?.close();
    } catch {}
    if (!response.writableEnded && !response.destroyed) {
      response.end();
    }
  }

  request.on("close", finish);
  response.on("close", finish);

  try {
    const terminal = streamResolution?.terminal || context.terminal;
    subscription = await terminal.subscribe(target, {
      onFrame: (frame, meta) => {
        send("buffer", {
          target: meta.target,
          source: "v1-mux",
          observedAt: meta.observedAt,
          frame,
          ansi: frameToAnsi(frame),
          buffer: frameToText(frame),
        });
      },
      onError: (error) => {
        send("error", {
          error: asTypedError(error, {
            code: "TERMINAL_STREAM_FAILED",
            owningModule: "daemon",
            operationId: "terminal.stream",
            message: "The terminal stream failed.",
          }).toJSON(),
        });
        finish();
      },
    });
    if (!closed && subscription?.ready) {
      await subscription.ready;
    }
  } catch (error) {
    if (closed) {
      context.log({
        event: "terminal.stream.subscriber_closed_before_ready",
        target,
        error: asTypedError(error, {
          code: "TERMINAL_STREAM_FAILED",
          owningModule: "daemon",
          operationId: "terminal.stream",
          message: "The terminal stream failed.",
        }).toJSON(),
      });
      return;
    }
    throw error;
  }

  if (closed) {
    try {
      subscription.close();
    } catch {}
    return;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  started = true;
  send("ready", {
    target: streamSession ? streamSession.name : target,
    source: "v1-mux",
    observedAt: new Date().toISOString(),
    ...(streamSession ? {
      backend: streamSession.backend,
      stableId: streamSession.stableId,
      memberId: streamResolution.resolution.memberId,
      bindingGeneration: streamResolution.resolution.bindingGeneration,
    } : {}),
  });
  const flush = pending.splice(0, pending.length);
  for (const [event, data] of flush) {
    send(event, data);
  }

  heartbeat = setInterval(() => {
    if (!closed && !response.writableEnded) {
      response.write(": keepalive\n\n");
    }
  }, 15000);
}

async function sendTerminalInput(request, response, context, callerToken) {
  requireTerminalAdmission(context, "terminal.input");
  authenticate(request, context);
  requireMachineAccountsSession(callerToken, "terminal.input");
  const body = await readJson(request);
  const result = await withTerminalAdmission("terminal.input", () => context.admission.forwardInput({
    callerToken,
    workspaceId: body.workspaceId,
    memberId: body.memberId,
    machineId: body.machineId,
    groupPath: body.groupPath,
    expectedGeneration: body.expectedGeneration,
    target: requireTarget(body.target, "terminal.input"),
    data: body.data,
  }));
  return sendJson(response, 200, {
    accepted: true,
    receipt: result.receipt,
    admission: {
      memberId: result.resolution.memberId,
      bindingGeneration: result.resolution.bindingGeneration,
      backend: result.target.backend,
      stableId: result.target.stableId,
    },
    observation: observation("v1-mux", { target: result.session.name, inputSubmitted: true }),
  });
}

function requireTerminalAdmission(context, operationId) {
  if (!context.admission) {
    throw daemonError(
      "TERMINAL_ADMISSION_REQUIRED",
      operationId,
      "Terminal admission is not configured; the token-only legacy path is disabled.",
      { reason: "admission-missing" },
    );
  }
}

async function withTerminalAdmission(operationId, action) {
  try {
    return await action();
  } catch (error) {
    if (error && error.name === "ConnectionError" && typeof error.code === "string") {
      throw new TypedError({
        code: error.code,
        owningModule: "connections",
        operationId,
        cause: {
          message: error.message || error.code,
          machineId: error.machineId ?? null,
          channelId: error.channelId ?? null,
          cause: error.cause ?? null,
        },
        message: error.message || error.code,
      });
    }
    if (error && error.name === "TypedError" && typeof error.code === "string") {
      throw new TypedError({
        code: error.code,
        owningModule: typeof error.owningModule === "string" && error.owningModule.length > 0
          ? error.owningModule
          : "daemon",
        operationId: error.operationId || operationId,
        cause: error.cause ?? error.details ?? null,
        message: error.message || error.code,
      });
    }
    throw error;
  }
}

function parseOptionalInteger(value) {
  if (value === null || value.trim() === "") {
    return undefined;
  }
  return Number(value);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw daemonError("REQUEST_TOO_LARGE", "request.body", "Request body is too large.", `Body exceeds ${maxBodyBytes} bytes.`);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch (error) {
    throw daemonError("REQUEST_INVALID_JSON", "request.body", "Request body must be valid JSON.", error.message);
  }
}

async function serveStatic(response, webuiDir, pathname) {
  const relative = pathname === "/" ? "features/terminal/index.html" : pathname.replace(/^\/+/u, "");
  const root = path.resolve(webuiDir);
  const resolved = path.resolve(root, relative);
  const withinRoot = resolved === root || resolved.startsWith(`${root}${path.sep}`);
  if (!withinRoot) {
    throw daemonError("ROUTE_NOT_FOUND", "static", "Route was not found.", pathname);
  }
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw daemonError("ROUTE_NOT_FOUND", "static", "Route was not found.", pathname);
  }
  if (!info.isFile()) {
    throw daemonError("ROUTE_NOT_FOUND", "static", "Route was not found.", pathname);
  }
  response.writeHead(200, {
    "content-type": contentTypes[path.extname(resolved)] || "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(resolved).pipe(response);
}

function sendJson(response, status, payload) {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function statusForError(error) {
  if (Number.isInteger(error.status)) {
    return error.status;
  }
  switch (error.code) {
    case "CONTROL_CREDENTIAL_REQUIRED":
    case "CONTROL_AUTH_INVALID":
    case "UNAUTHENTICATED":
      return 401;
    case "CONTROL_AUTH_UNCONFIGURED":
    case "CONTROL_ORGANIZATION_UNCONFIGURED":
    case "CONTROL_MEMBERS_UNCONFIGURED":
    case "CONTROL_ROUTING_UNCONFIGURED":
    case "CONTROL_HOST_PROBE_UNCONFIGURED":
      return 503;
    case "CONTROL_INPUT_INVALID":
    case "VALIDATION":
    case "GOAL_INVALID_NAME":
    case "GOAL_PARENT_INVALID":
    case "GOAL_OWNER_INVALID":
    case "BOARD_INVALID_REQUEST":
    case "INVALID_REQUEST":
    case "PROVIDER_VALIDATION_FAILED":
      return 400;
    case "TICKET_SCOPE_FORBIDDEN":
    case "TICKET_REPORT_DELEGATION_FORBIDDEN":
    case "GOAL_FORBIDDEN":
    case "BOARD_SCOPE_FORBIDDEN":
    case "BOARD_UNAUTHORIZED":
    case "PROVIDER_UNAUTHORIZED": {
      return error.code === "BOARD_UNAUTHORIZED" || error.code === "PROVIDER_UNAUTHORIZED" ? 401 : 403;
    }
    case "GOAL_WORKSPACE_NOT_FOUND":
    case "GOAL_NOT_FOUND":
    case "BOARD_NOT_FOUND":
    case "PROVIDER_NOT_FOUND":
      return 404;
    case "GOAL_NAME_CONFLICT":
    case "GOAL_NOT_EMPTY":
    case "GOAL_REFERENCED":
    case "GROUP_NAME_CONFLICT":
    case "MEMBER_NAME_CONFLICT":
    case "BINDING_CONFLICT":
    case "OPERATION_CONFLICT":
    case "OPERATION_SUPERSEDED":
    case "WRITE_OUTCOME_UNKNOWN":
      return 409;
    case "GOAL_REFERENCE_UNAVAILABLE":
    case "PROVIDER_UNAVAILABLE":
    case "WORK_TRACKING_UNCONFIGURED":
    case "WORK_TRACKING_ACTOR_UNCONFIGURED":
      return 503;
    case "BOARD_INVALID_RESPONSE":
      return 502;
    case "ORGANIZATION_FORBIDDEN":
    case "ROUTE_FORBIDDEN":
    case "MEMBER_FORBIDDEN_SCOPE":
    case "MEMBER_FORBIDDEN_WORKSPACE":
    case "MEMBER_FORBIDDEN_MEMBER":
      return 403;
    case "WORKSPACE_NOT_FOUND":
    case "GROUP_NOT_FOUND":
    case "MEMBER_NOT_FOUND":
    case "ROUTE_NOT_FOUND":
    case "CONTROL_MEMBER_NOT_FOUND":
      return 404;
    case "ROUTE_AMBIGUOUS":
    case "ORGANIZATION_REVISION_STALE":
    case "BINDING_GENERATION_STALE":
    case "MEMBER_BINDING_INVALID":
    case "BINDING_HOST_MISMATCH":
      return 409;
    case "MEMBER_BINDING_NOT_FOUND":
      return 404;
    case "MEMBER_RUNTIME_NOT_CONFIGURED":
    case "BINDING_HOST_UNAVAILABLE":
    case "BINDING_HOST_IDENTITY_UNAVAILABLE":
      return 503;
    case "V2_AUTH_UNCONFIGURED":
    case "ACCOUNTS_SERVICE_UNCONFIGURED":
    case "TERMINAL_ADMISSION_REQUIRED":
      return 503;
    case "V2_CREDENTIAL_REQUIRED":
    case "V2_CREDENTIAL_INVALID":
    case "V2_SESSION_EXPIRED":
    case "MACHINE_ACCOUNT_SESSION_REQUIRED":
      return 401;
    case "CSRF_REQUIRED":
    case "ORIGIN_NOT_ALLOWED":
      return 403;
    case "V1_CONNECTION_AUTH_FAILED":
      return 502;
    case "TARGET_NOT_FOUND":
      return 404;
    case "TARGET_REQUIRED":
    case "INPUT_INVALID":
    case "REQUEST_INVALID_JSON":
      return 400;
    case "UNAUTHENTICATED":
      return 401;
    case "ROUTE_FORBIDDEN":
      return 403;
    case "MEMBER_NOT_FOUND":
    case "TERMINAL_TARGET_IDENTITY_MISMATCH":
      return 404;
    case "MEMBER_BINDING_NOT_FOUND":
    case "MEMBER_RUNTIME_NOT_CONFIGURED":
    case "MEMBER_BINDING_INVALID":
    case "BINDING_GENERATION_STALE":
      return 409;
    case "TERMINAL_TARGET_BINDING_UNAVAILABLE":
      return 424;
    case "WORKSPACE_AUTHORIZATION_REQUIRED":
    case "WORKSPACE_FORBIDDEN":
    case "MACHINE_REVOKED":
      return 403;
    case "MACHINE_NOT_CONNECTED":
      return 409;
    case "MACHINE_NOT_FOUND":
      return 404;
    case "MACHINE_SERVICE_UNCONFIGURED":
    case "MACHINE_AUTHORIZATION_UNCONFIGURED":
    case "MACHINE_CONNECTIONS_UNCONFIGURED":
      return 503;
    case "unauthorized":
    case "peer_identity_mismatch":
      return 401;
    case "directory_rejected":
      return 403;
    case "machine_mismatch":
    case "stale_generation":
      return 409;
    case "link_not_found":
    case "link_closed":
    case "unreachable":
    case "unsupported_channel":
    case "channel_close_failed":
      return 424;
    case "invalid_input":
      return 400;
    case "unknown":
      return 502;
    case "VALIDATION":
    case "TERMINAL_TARGET_IDENTITY_REQUIRED":
      return 400;
    case "REQUEST_TOO_LARGE":
      return 413;
    default:
      if (String(error.code || "").startsWith("V1_") || String(error.code || "").startsWith("TERMINAL_")) {
        return 502;
      }
      return 500;
  }
}
