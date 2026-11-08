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

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function createDaemonApi({ baseUrl = "", fetchImpl = fetch } = {}) {
  let csrfToken = "";

  async function request(path, options = {}) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
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
    async sessionState() {
      const payload = await request("/api/auth/session");
      csrfToken = typeof payload.csrf === "string" ? payload.csrf : csrfToken;
      return payload;
    },

    async login(token) {
      const payload = await request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      csrfToken = typeof payload.csrfToken === "string" ? payload.csrfToken : "";
      return payload;
    },

    async logout() {
      try {
        await request("/api/auth/logout", { method: "POST" });
      } finally {
        csrfToken = "";
      }
    },

    async listSessions() {
      return request("/api/sessions");
    },

    async listWorkspaces() {
      const payload = await request("/api/workspaces");
      if (!Array.isArray(payload.workspaces)) {
        throw new DaemonError({ code: "WORKSPACES_RESPONSE_INVALID", message: "Daemon returned a malformed workspace list." }, 502);
      }
      return payload.workspaces;
    },

    async getWorkspace({ workspaceId } = {}) {
      const payload = await request(`/api/workspaces/${encodeURIComponent(String(workspaceId))}`);
      if (!payload.workspace || typeof payload.workspace !== "object") {
        throw new DaemonError({ code: "WORKSPACE_RESPONSE_INVALID", message: "Daemon returned a malformed workspace." }, 502);
      }
      return payload.workspace;
    },

    async listWorkspaceMembers({ workspaceId } = {}) {
      const payload = await request(`/api/workspaces/${encodeURIComponent(String(workspaceId))}/members`);
      if (!Array.isArray(payload.members)) {
        throw new DaemonError({ code: "MEMBERS_RESPONSE_INVALID", message: "Daemon returned a malformed member list." }, 502);
      }
      return payload.members;
    },

    openTerminalStream(target, { onReady, onBuffer, onError } = {}) {
      const query = new URLSearchParams({ target });
      const source = new EventSource(`${baseUrl}/api/terminal/stream?${query.toString()}`);
      source.addEventListener("ready", (event) => {
        onReady?.(safeJson(event.data));
      });
      source.addEventListener("buffer", (event) => {
        const payload = safeJson(event.data);
        if (payload) {
          onBuffer?.(payload);
        }
      });
      source.addEventListener("error", (event) => {
        const payload = event.data ? safeJson(event.data) : null;
        onError?.(payload?.error || { code: "TERMINAL_STREAM_UNAVAILABLE", message: "Terminal stream is unavailable." });
        source.close();
      });
      return source;
    },

    async sendInput(target, data, options = {}) {
      return request("/api/terminal/input", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(csrfToken ? { "x-zterm-csrf": csrfToken } : {}),
        },
        body: JSON.stringify({ target, data, ...(options.raw === true ? { raw: true } : {}) }),
      });
    },
  };
}
