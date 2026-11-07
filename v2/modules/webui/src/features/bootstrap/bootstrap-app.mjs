import { renderLoginPage } from "./pages/login.mjs";
import { renderSetupPage } from "./pages/setup.mjs";
import { renderWorkspacesPage } from "./pages/workspaces.mjs";

export const BOOTSTRAP_ROUTES = Object.freeze(["setup", "login", "workspaces"]);
export const DAEMON_ENDPOINT_STORAGE_KEY = "zterm.v2.daemonEndpoint";
export const MACHINE_ENROLLMENT_REASON = Object.freeze({
  code: "MACHINE_ENROLLMENT_UNAVAILABLE",
  message: "Machine enrollment is not exposed by the daemon control plane yet.",
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

export function validateDaemonEndpoint(value) {
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
  return trimmed;
}

function classifyWorkspaceLoadError(error) {
  const status = Number(error?.status) || 0;
  const code = String(error?.code || "DAEMON_REQUEST_FAILED");
  const message = String(error?.message || "The workspace request failed.");
  if (status === 401 || status === 403 || code === "CONTROL_CREDENTIAL_REQUIRED" || code === "CONTROL_AUTH_INVALID") {
    return { kind: "unauthorized", code, message, status };
  }
  if (status === 404 || status === 405 || status === 503 || status === 0 || code === "DAEMON_REQUEST_FAILED") {
    return { kind: "unavailable", code, message, status };
  }
  return { kind: "error", code, message, status };
}

function idleWorkspaces() {
  return { status: "idle", value: null, error: null };
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

  const state = {
    route: parseBootstrapRoute(initialHash ?? initialRoute),
    endpoint: backingStorage.getItem(DAEMON_ENDPOINT_STORAGE_KEY) ?? "",
    endpointError: null,
    accountWorkspaceToken: "",
    session: { authenticated: false, configured: false, csrf: null },
    authError: null,
    loginPending: false,
    workspacesLoadable: idleWorkspaces(),
    selectedWorkspaceId: null,
    machineCandidates: [],
    machineEnrollment: { enabled: false, reason: MACHINE_ENROLLMENT_REASON },
  };

  const app = {
    state,
  };

  app.setDaemonEndpoint = (value) => {
    const endpoint = validateDaemonEndpoint(value);
    state.endpoint = endpoint;
    state.endpointError = null;
    backingStorage.setItem(DAEMON_ENDPOINT_STORAGE_KEY, endpoint);
    return endpoint;
  };

  app.setAccountWorkspaceToken = (value) => {
    state.accountWorkspaceToken = String(value ?? "");
    return state.accountWorkspaceToken;
  };

  app.restoreSession = async () => {
    try {
      const payload = await daemonApi.sessionState();
      state.session = {
        authenticated: Boolean(payload?.authenticated),
        configured: Boolean(payload?.configured),
        csrf: typeof payload?.csrf === "string" ? payload.csrf : null,
      };
    } catch {
      state.session = { authenticated: false, configured: false, csrf: null };
    }
    return state.session;
  };

  app.login = async ({ credential } = {}) => {
    const trimmed = String(credential ?? "").trim();
    if (!trimmed) {
      state.authError = {
        code: "DAEMON_CREDENTIAL_REQUIRED",
        message: "A daemon credential is required to log in.",
        status: 400,
      };
      state.session.authenticated = false;
      return false;
    }
    state.loginPending = true;
    state.authError = null;
    try {
      const payload = await daemonApi.login(trimmed);
      state.session = {
        authenticated: true,
        configured: true,
        csrf: typeof payload?.csrfToken === "string" ? payload.csrfToken : null,
      };
      state.route = "workspaces";
      return true;
    } catch (error) {
      state.session.authenticated = false;
      state.authError = typedFromDaemonError(error, "DAEMON_LOGIN_FAILED");
      return false;
    } finally {
      state.loginPending = false;
    }
  };

  app.logout = async () => {
    try {
      await daemonApi.logout();
    } catch {
      // Logout failure does not keep a browser-side session alive.
    }
    state.session = { authenticated: false, configured: false, csrf: null };
    state.authError = null;
    state.accountWorkspaceToken = "";
    state.workspacesLoadable = idleWorkspaces();
    state.selectedWorkspaceId = null;
    state.machineCandidates = [];
    state.route = "login";
    return true;
  };

  app.loadWorkspaces = async () => {
    state.route = "workspaces";
    state.workspacesLoadable = { status: "loading", value: null, error: null };
    try {
      const workspaces = await daemonApi.listWorkspaces({ accountToken: state.accountWorkspaceToken });
      state.workspacesLoadable = { status: "ready", value: workspaces, error: null };
    } catch (error) {
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
    state.route = "workspaces";
    state.selectedWorkspaceId = workspaceId;
    try {
      const root = await daemonApi.getWorkspaceTree({
        workspaceId,
        accountToken: state.accountWorkspaceToken,
      });
      state.machineCandidates = collectMembers(root);
    } catch (error) {
      state.machineCandidates = [];
      state.workspacesLoadable = {
        status: "unavailable",
        value: null,
        error: classifyWorkspaceLoadError(error),
      };
    }
    return state.machineCandidates;
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
