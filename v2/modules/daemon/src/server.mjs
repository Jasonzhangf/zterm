import { createReadStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asTypedError, TypedError } from "../../errors/src/typed-error.mjs";
import { observation } from "../../status/src/observation.mjs";
import { TerminalPort } from "../../terminal/src/terminal-port.mjs";
import { frameToAnsi, frameToText } from "../../terminal/src/terminal-ansi-serializer.mjs";

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
  clientInstanceId,
} = {}) {
  const resolvedV1WsUrl = resolveV1WsUrl(v1WsUrl, v1Token);
  const terminal = terminalPort || new TerminalPort({
    wsUrl: resolvedV1WsUrl,
    clientInstanceId,
    log,
  });
  const sessions = new Map();
  const context = {
    terminal,
    v2Token,
    webuiDir,
    sessions,
    sessionTtlMs,
    log,
    resolvedV1WsUrl,
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
    void terminal.close?.();
  });

  return { server, terminal, resolvedV1WsUrl: redactWsUrl(resolvedV1WsUrl) };
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

  if (request.method === "GET" && url.pathname === "/api/sessions") {
    authenticate(request, context);
    const sessions = await context.terminal.listSessions();
    return sendJson(response, 200, {
      sessions,
      observation: observation("v1-mux", { sessions: sessions.length }),
    });
  }

  if (request.method === "GET" && url.pathname === "/api/terminal/stream") {
    authenticate(request, context);
    return streamTerminal(request, response, context, url);
  }

  if (request.method === "POST" && url.pathname === "/api/terminal/input") {
    authenticate(request, context, { requireCsrf: true });
    return sendTerminalInput(request, response, context);
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

async function streamTerminal(request, response, context, url) {
  const target = url.searchParams.get("target");
  if (!target) {
    throw daemonError("TARGET_REQUIRED", "terminal.stream", "A terminal target is required.", "Missing target query parameter.");
  }

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
    subscription = await context.terminal.subscribe(target, {
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
    target,
    source: "v1-mux",
    observedAt: new Date().toISOString(),
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

async function sendTerminalInput(request, response, context) {
  const body = await readJson(request);
  if (typeof body.target !== "string" || typeof body.data !== "string") {
    throw daemonError("INPUT_INVALID", "terminal.input", "Terminal input is invalid.", "Expected string fields: target, data.");
  }
  const data = body.raw === true
    ? body.data
    : (body.data.endsWith("\r") ? body.data : `${body.data}\r`);
  const receipt = await context.terminal.input(body.target, data);
  sendJson(response, 200, {
    accepted: true,
    receipt,
    observation: observation("v1-mux", { target: body.target, inputSubmitted: true }),
  });
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
  switch (error.code) {
    case "V2_AUTH_UNCONFIGURED":
      return 503;
    case "V2_CREDENTIAL_REQUIRED":
    case "V2_CREDENTIAL_INVALID":
    case "V2_SESSION_EXPIRED":
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
    case "REQUEST_TOO_LARGE":
      return 413;
    default:
      if (String(error.code || "").startsWith("V1_") || String(error.code || "").startsWith("TERMINAL_")) {
        return 502;
      }
      return 500;
  }
}
