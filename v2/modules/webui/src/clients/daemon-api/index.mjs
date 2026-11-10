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

const ADMISSION_FIELDS = [
  "workspaceId",
  "memberId",
  "machineId",
  "groupPath",
  "expectedGeneration",
  "backend",
  "stableId",
];

function admissionQuery(admission) {
  const query = new URLSearchParams();
  for (const field of ADMISSION_FIELDS) {
    const value = admission?.[field];
    if (value !== undefined && value !== null && value !== "") {
      query.set(field, String(value));
    }
  }
  return query;
}

function flattenTree(root) {
  const members = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") {
      return;
    }
    for (const member of node.members ?? []) {
      members.push({ ...member, groupPath: node.path });
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  visit(root);
  return members;
}

export function createDaemonApi({ baseUrl = "", fetchImpl = fetch } = {}) {
  let csrfToken = "";
  let authToken = "";

  function hasAuthorization() {
    return Boolean(authToken);
  }

  async function request(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (authToken) {
      headers.authorization = `Bearer ${authToken}`;
    }
    const response = await fetchImpl(`${baseUrl}${path}`, {
      cache: "no-store",
      credentials: "same-origin",
      ...options,
      headers,
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
      authToken = typeof token === "string" ? token.trim() : "";
      csrfToken = typeof payload.csrfToken === "string" ? payload.csrfToken : "";
      return payload;
    },

    async logout() {
      try {
        await request("/api/auth/logout", { method: "POST" });
      } finally {
        authToken = "";
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

    async getWorkspaceTree({ workspaceId } = {}) {
      return request(`/api/workspaces/${encodeURIComponent(String(workspaceId))}/tree`);
    },

    async getMemberRuntime({ workspaceId, memberId } = {}) {
      return request(`/api/workspaces/${encodeURIComponent(String(workspaceId))}/members/${encodeURIComponent(String(memberId))}/runtime`);
    },

    async resolveTerminalAdmission(session = {}) {
      const stableId = typeof session.stableId === "string" ? session.stableId : "";
      if (!stableId) {
        return null;
      }
      const workspaces = await this.listWorkspaces();
      for (const workspace of workspaces) {
        const workspaceId = workspace.workspaceId;
        if (!workspaceId) {
          continue;
        }
        const tree = await this.getWorkspaceTree({ workspaceId });
        const members = flattenTree(tree.root);
        for (const member of members) {
          const runtime = await this.getMemberRuntime({ workspaceId, memberId: member.memberId });
          const binding = runtime.binding;
          const target = binding && binding.terminalTarget;
          if (!target || target.stableId !== stableId) {
            continue;
          }
          return {
            workspaceId,
            memberId: member.memberId,
            machineId: runtime.runtime?.machineId ?? binding.machineId ?? "",
            groupPath: member.groupPath ?? "",
            expectedGeneration: binding.generation,
            backend: target.backend,
            stableId: target.stableId,
          };
        }
      }
      return null;
    },

    openTerminalStream(admission, { onReady, onBuffer, onError } = {}) {
      const query = admissionQuery(admission);
      const controller = new AbortController();
      const source = {
        closed: false,
        close() {
          source.closed = true;
          controller.abort();
        },
      };

      const emitError = (error) => {
        if (source.closed) {
          return;
        }
        onError?.(error);
      };

      const dispatch = (chunk) => {
        let eventName = "message";
        const dataLines = [];
        for (const line of chunk.split("\n")) {
          if (line.startsWith(":")) {
            continue;
          }
          if (line.startsWith("event:")) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).replace(/^ /u, ""));
          }
        }
        if (dataLines.length === 0) {
          return;
        }
        const payload = safeJson(dataLines.join("\n"));
        if (eventName === "ready") {
          onReady?.(payload);
        } else if (eventName === "buffer") {
          if (payload) {
            onBuffer?.(payload);
          }
        } else if (eventName === "error") {
          emitError(payload?.error || { code: "TERMINAL_STREAM_UNAVAILABLE", message: "Terminal stream is unavailable." });
          source.close();
        }
      };

      (async () => {
        const headers = authToken ? { authorization: `Bearer ${authToken}` } : {};
        let response;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          try {
            response = await fetchImpl(`${baseUrl}/api/terminal/stream?${query.toString()}`, {
              cache: "no-store",
              credentials: "same-origin",
              headers,
              signal: controller.signal,
            });
          } catch (error) {
            emitError({ code: "TERMINAL_STREAM_UNAVAILABLE", message: error?.message || "Terminal stream request failed." });
            return;
          }
          // The machine-scoped terminal link can take a moment to become
          // fresh after an isolated daemon start; 424 is retryable.
          if (response.status !== 424 || source.closed) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (!response.ok || !response.body) {
          let payload = null;
          try {
            payload = await response.json();
          } catch {
            payload = null;
          }
          emitError(payload?.error || {
            code: "TERMINAL_STREAM_UNAVAILABLE",
            message: `Terminal stream is unavailable (HTTP ${response.status}).`,
          });
          source.close();
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (!source.closed) {
            const { value, done } = await reader.read();
            if (done) {
              break;
            }
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf("\n\n");
            while (boundary >= 0) {
              const chunk = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              dispatch(chunk);
              boundary = buffer.indexOf("\n\n");
            }
          }
        } catch (error) {
          emitError({ code: "TERMINAL_STREAM_FAILED", message: error?.message || "Terminal stream failed." });
        } finally {
          source.closed = true;
        }
      })();

      return source;
    },

    hasAuthorization,
    async sendInput(admission, data, options = {}) {
      const body = {
        workspaceId: admission?.workspaceId,
        memberId: admission?.memberId,
        machineId: admission?.machineId,
        groupPath: admission?.groupPath,
        expectedGeneration: admission?.expectedGeneration,
        target: {
          backend: admission?.backend,
          stableId: admission?.stableId,
        },
        data,
      };
      if (options.raw === true) {
        body.raw = true;
      }
      return request("/api/terminal/input", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(csrfToken ? { "x-zterm-csrf": csrfToken } : {}),
        },
        body: JSON.stringify(body),
      });
    },
  };
}
