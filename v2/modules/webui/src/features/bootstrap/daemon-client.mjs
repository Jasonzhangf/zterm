export class DaemonError extends Error {
  constructor(error = {}, status = 0) {
    super(error.message || "The daemon request failed.");
    this.name = "DaemonError";
    this.code = error.code || "DAEMON_REQUEST_FAILED";
    this.owningModule = error.owningModule;
    this.operationId = error.operationId;
    this.status = status;
  }
}

export function createBootstrapDaemonApi({ baseUrl = "", fetchImpl = fetch } = {}) {
  let currentBaseUrl = String(baseUrl ?? "").replace(/\/+$/, "");
  let csrfToken = "";

  async function request(path, options = {}) {
    const response = await fetchImpl(`${currentBaseUrl}${path}`, {
      cache: "no-store",
      credentials: "same-origin",
      ...options,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new DaemonError(payload.error, response.status);
    }
    return payload;
  }

  return {
    setBaseUrl(value) {
      const next = String(value ?? "").replace(/\/+$/, "");
      if (next !== currentBaseUrl) {
        currentBaseUrl = next;
        csrfToken = "";
      }
      return currentBaseUrl;
    },

    async sessionState() {
      const payload = await request("/api/auth/session");
      if (
        !payload ||
        typeof payload !== "object" ||
        !Object.prototype.hasOwnProperty.call(payload, "account")
      ) {
        throw new DaemonError(
          {
            code: "ACCOUNT_SESSION_UNAVAILABLE",
            message: "The daemon does not expose the browser account-session contract.",
          },
          501,
        );
      }
      csrfToken = typeof payload.csrf === "string" ? payload.csrf : csrfToken;
      return payload;
    },

    async login({ loginName, credential } = {}) {
      const payload = await request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loginName, credential }),
      });
      if (!payload || !payload.account || typeof payload.account !== "object") {
        throw new DaemonError(
          {
            code: "ACCOUNT_SESSION_UNAVAILABLE",
            message: "The daemon did not return a verified browser account session.",
          },
          501,
        );
      }
      csrfToken =
        typeof payload.csrf === "string"
          ? payload.csrf
          : typeof payload.csrfToken === "string"
            ? payload.csrfToken
            : "";
      return payload;
    },

    async logout() {
      await request("/api/auth/logout", {
        method: "POST",
        ...(csrfToken ? { headers: { "x-zterm-csrf": csrfToken } } : {}),
      });
      csrfToken = "";
    },

    async listWorkspaces() {
      const payload = await request("/api/workspaces");
      if (!Array.isArray(payload.workspaces)) {
        throw new DaemonError(
          { code: "WORKSPACES_RESPONSE_INVALID", message: "Daemon returned a malformed workspace list." },
          502,
        );
      }
      return payload.workspaces;
    },

    async getWorkspaceTree({ workspaceId } = {}) {
      if (typeof workspaceId !== "string" || !workspaceId.trim()) {
        throw new DaemonError({ code: "WORKSPACE_ID_REQUIRED", message: "A workspace id is required." }, 400);
      }
      const payload = await request(
        `/api/workspaces/${encodeURIComponent(workspaceId.trim())}/tree`,
      );
      if (!payload.root || typeof payload.root !== "object") {
        throw new DaemonError(
          { code: "WORKSPACE_TREE_RESPONSE_INVALID", message: "Daemon returned a malformed workspace tree." },
          502,
        );
      }
      return payload.root;
    },
  };
}
