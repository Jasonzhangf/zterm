import { renderLoginPage } from "./pages/login.mjs";
import { renderSetupPage } from "./pages/setup.mjs";
import { renderWorkspacesPage } from "./pages/workspaces.mjs";

export const BOOTSTRAP_ROUTES = Object.freeze(["setup", "login", "workspaces"]);
export const DAEMON_ENDPOINT_STORAGE_KEY = "zterm.v2.daemonEndpoint";
export const MACHINE_ENROLLMENT_REASON = Object.freeze({
  code: "MACHINE_ENROLLMENT_UNAVAILABLE",
  message: "Machine enrollment is not exposed by the daemon control plane yet.",
});
export const MACHINE_SELECTION_REASON = Object.freeze({
  code: "MACHINE_SELECTION_UNAVAILABLE",
  message: "Machine selection requires the member runtime and resolve edge; this surface does not infer machine identity from member display names.",
});

export class BootstrapError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "BootstrapError";
    this.code = code;
    this.status = status;
  }
}

export function parseBootstrapRoute(value, fallbackRoute = "setup") {
  const raw = String(value ?? "");
  const segment = raw.replace(/^#?\/?/, "").split("?")[0].split("/")[0];
  return BOOTSTRAP_ROUTES.includes(segment) ? segment : fallbackRoute;
}

export function bootstrapRouteUrl(route) {
  return `#/${BOOTSTRAP_ROUTES.includes(route) ? route : "setup"}`;
}

export function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

export function validateDaemonEndpoint(value, { pageOrigin = globalThis.location?.origin } = {}) {
  const trimmed = String(value ?? "").trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BootstrapError("DAEMON_ENDPOINT_INVALID", "A valid daemon endpoint URL is required.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BootstrapError("DAEMON_ENDPOINT_INVALID", "A daemon endpoint must use http or https.");
  }
  if (pageOrigin && pageOrigin !== "null" && parsed.origin !== pageOrigin) {
    throw new BootstrapError(
      "DAEMON_ENDPOINT_CROSS_ORIGIN_UNAVAILABLE",
      "The browser account session is only available from the WebUI origin; cross-origin daemon endpoints are not supported.",
    );
  }
  return trimmed.replace(/\/+$/, "");
}

function classifyWorkspaceLoadError(error) {
  const status = Number(error?.status) || 0;
  const code = String(error?.code || "DAEMON_REQUEST_FAILED");
  const message = String(error?.message || "The workspace request failed.");
  if (status === 401 || status === 403 || code === "AUTHENTICATION_REQUIRED" || code === "AUTHORIZATION_REQUIRED") {
    return { kind: "unauthorized", code, message, status };
  }
  if (
    status === 404 ||
    status === 405 ||
    status === 501 ||
    status === 503 ||
    status === 0 ||
    code === "DAEMON_REQUEST_FAILED"
  ) {
    return { kind: "unavailable", code, message, status };
  }
  return { kind: "error", code, message, status };
}

function idleWorkspaces() {
  return { status: "idle", value: null, error: null };
}

function emptySession(error = null) {
  return {
    authenticated: false,
    configured: false,
    account: null,
    csrf: null,
    error,
  };
}

function sessionFromPayload(payload) {
  const account = payload?.account && typeof payload.account === "object" ? payload.account : null;
  return {
    authenticated: Boolean(payload?.authenticated || account),
    configured: Boolean(payload?.configured ?? true),
    account,
    csrf:
      typeof payload?.csrf === "string"
        ? payload.csrf
        : typeof payload?.csrfToken === "string"
          ? payload.csrfToken
          : null,
    error: null,
  };
}

function typedFromDaemonError(error, fallbackCode) {
  if (error && typeof error.code === "string") {
    return {
      code: error.code,
      message: String(error.message || ""),
      status: Number(error.status) || 0,
    };
  }
  return {
    code: fallbackCode,
    message: String(error?.message || "The bootstrap request failed."),
    status: 0,
  };
}

function collectMembers(node, out = []) {
  if (!node || typeof node !== "object") {
    return out;
  }
  for (const member of Array.isArray(node.members) ? node.members : []) {
    if (member && typeof member === "object" && member.memberId) {
      out.push(member);
    }
  }
  for (const child of Array.isArray(node.children) ? node.children : []) {
    collectMembers(child, out);
  }
  return out;
}

export function createBootstrapApp({
  daemonApi,
  storage = null,
  initialRoute = "setup",
  initialHash = null,
} = {}) {
  if (!daemonApi || typeof daemonApi.login !== "function") {
    throw new BootstrapError("DAEMON_API_REQUIRED", "A daemon API client is required.");
  }

  const browserStorage =
    typeof window !== "undefined" && window.localStorage && typeof window.localStorage.getItem === "function"
      ? window.localStorage
      : null;
  const backingStorage = storage ?? browserStorage ?? memoryStorage();
  const pageOrigin = globalThis.location?.origin;
  let authRevision = 0;
  let sessionRequestId = 0;
  let workspaceListRequestId = 0;
  let workspaceTreeRequestId = 0;

  const state = {
    route: parseBootstrapRoute(initialHash ?? initialRoute),
    endpoint: backingStorage.getItem(DAEMON_ENDPOINT_STORAGE_KEY) ?? "",
    endpointError: null,
    session: emptySession(),
    authError: null,
    loginPending: false,
    logoutPending: false,
    logoutError: null,
    workspacesLoadable: idleWorkspaces(),
    workspaceTreeLoadable: idleWorkspaces(),
    selectedWorkspaceId: null,
    memberCandidates: [],
    machineSelection: { available: false, reason: MACHINE_SELECTION_REASON },
    machineEnrollment: { enabled: false, reason: MACHINE_ENROLLMENT_REASON },
  };

  const app = {
    state,
  };

  function resetWorkspaceState() {
    workspaceListRequestId += 1;
    workspaceTreeRequestId += 1;
    state.workspacesLoadable = idleWorkspaces();
    state.workspaceTreeLoadable = idleWorkspaces();
    state.selectedWorkspaceId = null;
    state.memberCandidates = [];
  }

  function applyEndpointToApi() {
    daemonApi.setBaseUrl?.(state.endpoint);
  }

  app.setDaemonEndpoint = (value) => {
    const endpoint = validateDaemonEndpoint(value, { pageOrigin });
    const changed = endpoint !== state.endpoint;
    if (changed) {
      authRevision += 1;
      sessionRequestId += 1;
      state.session = emptySession();
      state.authError = null;
      state.logoutError = null;
      resetWorkspaceState();
    }
    state.endpoint = endpoint;
    state.endpointError = null;
    backingStorage.setItem(DAEMON_ENDPOINT_STORAGE_KEY, endpoint);
    applyEndpointToApi();
    return endpoint;
  };

  app.restoreSession = async () => {
    if (!state.endpoint) {
      state.session = emptySession();
      return state.session;
    }
    applyEndpointToApi();
    const requestId = ++sessionRequestId;
    const revision = authRevision;
    try {
      const payload = await daemonApi.sessionState();
      if (requestId !== sessionRequestId || revision !== authRevision) {
        return state.session;
      }
      state.session = sessionFromPayload(payload);
      if (state.session.authenticated && (state.route === "setup" || state.route === "login")) {
        state.route = "workspaces";
        await app.loadWorkspaces();
      }
    } catch (error) {
      if (requestId !== sessionRequestId || revision !== authRevision) {
        return state.session;
      }
      const typed = typedFromDaemonError(error, "ACCOUNT_SESSION_UNAVAILABLE");
      state.session = emptySession(typed);
      state.authError = typed;
    }
    return state.session;
  };

  app.login = async ({ loginName, credential } = {}) => {
    const normalizedLoginName = String(loginName ?? "").trim();
    const normalizedCredential = String(credential ?? "");
    if (!normalizedLoginName || !normalizedCredential) {
      state.authError = {
        code: "ACCOUNT_LOGIN_REQUIRED",
        message: "A login name and credential are required to start an account session.",
        status: 400,
      };
      state.session.authenticated = false;
      return false;
    }
    applyEndpointToApi();
    const requestId = ++sessionRequestId;
    const revision = ++authRevision;
    state.loginPending = true;
    state.authError = null;
    state.logoutError = null;
    resetWorkspaceState();
    try {
      const payload = await daemonApi.login({
        loginName: normalizedLoginName,
        credential: normalizedCredential,
      });
      if (requestId !== sessionRequestId || revision !== authRevision) {
        return false;
      }
      state.session = sessionFromPayload(payload);
      state.route = "workspaces";
      return true;
    } catch (error) {
      if (requestId !== sessionRequestId || revision !== authRevision) {
        return false;
      }
      const typed = typedFromDaemonError(error, "ACCOUNT_LOGIN_FAILED");
      state.session = emptySession(typed);
      state.authError = typed;
      return false;
    } finally {
      if (requestId === sessionRequestId) {
        state.loginPending = false;
      }
    }
  };

  app.logout = async () => {
    applyEndpointToApi();
    const requestId = ++sessionRequestId;
    const revision = ++authRevision;
    state.logoutPending = true;
    state.logoutError = null;
    try {
      await daemonApi.logout();
      if (requestId !== sessionRequestId || revision !== authRevision) {
        return { ok: false, stale: true };
      }
      state.session = emptySession();
      state.authError = null;
      resetWorkspaceState();
      state.route = "login";
      return { ok: true };
    } catch (error) {
      if (requestId !== sessionRequestId || revision !== authRevision) {
        return { ok: false, stale: true };
      }
      const typed = typedFromDaemonError(error, "ACCOUNT_LOGOUT_FAILED");
      state.logoutError = typed;
      return { ok: false, error: typed };
    } finally {
      if (requestId === sessionRequestId) {
        state.logoutPending = false;
      }
    }
  };

  app.loadWorkspaces = async () => {
    const requestId = ++workspaceListRequestId;
    const revision = authRevision;
    const endpoint = state.endpoint;
    state.route = "workspaces";
    state.workspacesLoadable = { status: "loading", value: null, error: null };
    try {
      const workspaces = await daemonApi.listWorkspaces();
      if (
        requestId !== workspaceListRequestId ||
        revision !== authRevision ||
        endpoint !== state.endpoint
      ) {
        return state.workspacesLoadable;
      }
      state.workspacesLoadable = { status: "ready", value: workspaces, error: null };
    } catch (error) {
      if (
        requestId !== workspaceListRequestId ||
        revision !== authRevision ||
        endpoint !== state.endpoint
      ) {
        return state.workspacesLoadable;
      }
      const typed = classifyWorkspaceLoadError(error);
      state.workspacesLoadable = {
        status: typed.kind === "unauthorized" ? "error" : typed.kind,
        value: null,
        error: typed,
      };
    }
    return state.workspacesLoadable;
  };

  app.selectWorkspace = async (workspaceId) => {
    const normalizedWorkspaceId = String(workspaceId ?? "").trim();
    if (!normalizedWorkspaceId) {
      throw new BootstrapError("WORKSPACE_ID_REQUIRED", "A workspace id is required.");
    }
    const requestId = ++workspaceTreeRequestId;
    const revision = authRevision;
    const endpoint = state.endpoint;
    state.route = "workspaces";
    state.selectedWorkspaceId = normalizedWorkspaceId;
    state.workspaceTreeLoadable = { status: "loading", value: null, error: null };
    state.memberCandidates = [];
    try {
      const root = await daemonApi.getWorkspaceTree({ workspaceId: normalizedWorkspaceId });
      if (
        requestId !== workspaceTreeRequestId ||
        revision !== authRevision ||
        endpoint !== state.endpoint ||
        state.selectedWorkspaceId !== normalizedWorkspaceId
      ) {
        return state.memberCandidates;
      }
      state.workspaceTreeLoadable = { status: "ready", value: root, error: null };
      state.memberCandidates = collectMembers(root);
    } catch (error) {
      if (
        requestId !== workspaceTreeRequestId ||
        revision !== authRevision ||
        endpoint !== state.endpoint ||
        state.selectedWorkspaceId !== normalizedWorkspaceId
      ) {
        return state.memberCandidates;
      }
      const typed = classifyWorkspaceLoadError(error);
      state.workspaceTreeLoadable = {
        status: typed.kind === "unavailable" ? "unavailable" : "error",
        value: null,
        error: typed,
      };
      state.memberCandidates = [];
    }
    return state.memberCandidates;
  };

  app.navigate = (route) => {
    state.route = parseBootstrapRoute(route, state.route);
    return state.route;
  };

  app.render = () => {
    switch (state.route) {
      case "login":
        return renderLoginPage(state);
      case "workspaces":
        return renderWorkspacesPage(state);
      default:
        return renderSetupPage(state);
    }
  };

  return app;
}
