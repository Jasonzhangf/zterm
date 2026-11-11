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

function projectSnapshotMember(member) {
  const runtime = member.runtime ?? null;
  const binding = member.binding ?? null;
  const availability = member.availability ?? null;
  const machineId = runtime?.machineId ?? binding?.machineId ?? "";
  return {
    ...member,
    groupPath: member.groupPath ?? "",
    runtime,
    binding,
    availability,
    status: availability?.status ?? "unknown",
    sessionId: binding?.sessionId ?? "",
    machineId,
    machine: machineId,
  };
}

function projectGoal(goal) {
  if (!goal || typeof goal !== "object") return goal;
  const projected = { ...goal };
  delete projected.name;
  return {
    ...projected,
    title: String(goal.title ?? goal.name ?? ""),
    rawGoal: goal,
  };
}

function projectTicketObservation(observation) {
  if (!observation || typeof observation !== "object") return observation;
  const binding = observation.binding ?? {};
  const ticket = observation.ticket ?? {};
  const done = ticket.done === true;
  return {
    ticketId: String(binding.bindingId ?? ""),
    workspaceId: binding.workspaceId ?? "",
    goalId: binding.goalId ?? "",
    ownerMemberId: binding.ownerMemberId ?? "",
    assigneeId: binding.ownerMemberId ?? "",
    title: String(ticket.title ?? binding.bindingId ?? ""),
    description: String(ticket.description ?? ""),
    priority: ticket.priority ?? null,
    status: done ? "closed" : "open",
    freshness: observation.freshness ?? "unavailable",
    allowedTransitions: Array.isArray(observation.allowedTransitions) ? observation.allowedTransitions : [],
    errorRef: observation.errorRef,
    rawObservation: observation,
  };
}

function daemonTicketStatus(status) {
  if (status === "open" || status === "in-progress" || status === "blocked" || status === "review") {
    return "open";
  }
  return status;
}

function operationError(payload, fallbackCode, fallbackMessage) {
  const operation = payload?.operation;
  const error = new DaemonError({
    code: operation?.errorRef?.code || fallbackCode,
    owningModule: operation?.errorRef?.owningModule,
    operationId: operation?.operationRef?.operationId,
    message: operation?.errorRef?.message || fallbackMessage,
  }, 409);
  error.operation = operation;
  error.operationRef = operation?.operationRef;
  return error;
}

function requireMachineId(machineId) {
  const value = typeof machineId === "string" ? machineId.trim() : "";
  if (value === "") {
    throw new DaemonError({
      code: "MACHINE_ID_REQUIRED",
      message: "A machineId is required.",
    }, 400);
  }
  return value;
}

function machinePath(machineId, suffix) {
  return `/api/machines/${encodeURIComponent(requireMachineId(machineId))}/${suffix}`;
}

function responseMachineId(connection) {
  return connection && typeof connection === "object"
    ? String(connection.machineId ?? "")
    : "";
}

function requireSuccessfulOperation(payload, action) {
  if (!payload || payload.operation?.state !== "succeeded") {
    throw operationError(payload, "TICKET_OPERATION_NOT_SUCCEEDED", `${action} did not complete successfully.`);
  }
  return payload;
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

    async listMachines() {
      const payload = await request("/api/machines");
      if (!Array.isArray(payload.machines)) {
        throw new DaemonError({
          code: "MACHINES_RESPONSE_INVALID",
          message: "Daemon returned a malformed machine directory.",
        }, 502);
      }
      return {
        machines: payload.machines,
        observation: payload.observation ?? null,
      };
    },

    async connectMachine({ machineId } = {}) {
      const requestedMachineId = requireMachineId(machineId);
      const payload = await request(machinePath(requestedMachineId, "connect"), { method: "POST" });
      if (responseMachineId(payload?.connection) !== requestedMachineId) {
        throw new DaemonError({
          code: "MACHINE_CONNECTION_RESPONSE_INVALID",
          message: "Daemon returned a connection outside the requested machine scope.",
        }, 502);
      }
      return payload;
    },

    async getMachineConnection({ machineId } = {}) {
      const requestedMachineId = requireMachineId(machineId);
      const payload = await request(machinePath(requestedMachineId, "connection"));
      if (payload?.connection !== null && (typeof payload?.connection !== "object" || Array.isArray(payload.connection))) {
        throw new DaemonError({
          code: "MACHINE_CONNECTION_RESPONSE_INVALID",
          message: "Daemon returned a malformed connection observation.",
        }, 502);
      }
      if (payload?.connection && responseMachineId(payload.connection) !== requestedMachineId) {
        throw new DaemonError({
          code: "MACHINE_CONNECTION_RESPONSE_INVALID",
          message: "Daemon returned a connection outside the requested machine scope.",
        }, 502);
      }
      return payload;
    },

    async recoverMachine({ machineId } = {}) {
      const requestedMachineId = requireMachineId(machineId);
      const payload = await request(machinePath(requestedMachineId, "recover"), { method: "POST" });
      if (responseMachineId(payload?.connection) !== requestedMachineId) {
        throw new DaemonError({
          code: "MACHINE_CONNECTION_RESPONSE_INVALID",
          message: "Daemon returned a connection outside the requested machine scope.",
        }, 502);
      }
      return payload;
    },

    async disconnectMachine({ machineId } = {}) {
      const requestedMachineId = requireMachineId(machineId);
      const payload = await request(machinePath(requestedMachineId, "disconnect"), { method: "POST" });
      if (String(payload?.machineId ?? "") !== requestedMachineId) {
        throw new DaemonError({
          code: "MACHINE_DISCONNECT_RESPONSE_INVALID",
          message: "Daemon returned a disconnect result outside the requested machine scope.",
        }, 502);
      }
      return payload;
    },

    async listMachineSessions({ machineId } = {}) {
      const requestedMachineId = requireMachineId(machineId);
      const payload = await request(machinePath(requestedMachineId, "sessions"));
      if (!Array.isArray(payload?.sessions)) {
        throw new DaemonError({
          code: "MACHINE_SESSIONS_RESPONSE_INVALID",
          message: "Daemon returned a malformed machine session catalog.",
        }, 502);
      }
      return payload;
    },

    async getWorkspaceSnapshot({ workspaceId } = {}) {
      const tree = await this.getWorkspaceTree({ workspaceId });
      if (!tree.workspace || typeof tree.workspace !== "object") {
        throw new DaemonError({ code: "WORKSPACE_TREE_RESPONSE_INVALID", message: "Daemon returned a malformed workspace tree." }, 502);
      }
      if (String(tree.workspace.workspaceId ?? "") !== String(workspaceId)) {
        throw new DaemonError({ code: "WORKSPACE_SCOPE_MISMATCH", message: "Daemon returned a workspace outside the requested scope." }, 502);
      }
      if (!tree.root || typeof tree.root !== "object") {
        throw new DaemonError({ code: "WORKSPACE_TREE_RESPONSE_INVALID", message: "Daemon returned a malformed workspace tree." }, 502);
      }
      let members;
      try {
        members = flattenTree(tree.root);
      } catch {
        throw new DaemonError({ code: "WORKSPACE_TREE_RESPONSE_INVALID", message: "Daemon returned a malformed workspace tree." }, 502);
      }
      for (const member of members) {
        if (!member || typeof member !== "object" || !member.memberId) {
          throw new DaemonError({ code: "WORKSPACE_TREE_RESPONSE_INVALID", message: "Daemon returned a malformed workspace member." }, 502);
        }
        if (String(member.workspaceId ?? "") !== String(workspaceId)) {
          throw new DaemonError({ code: "WORKSPACE_SCOPE_MISMATCH", message: "Daemon returned a member outside the requested workspace." }, 502);
        }
      }
      return { workspace: tree.workspace, members: members.map(projectSnapshotMember) };
    },

    async getWorkspaceTree({ workspaceId } = {}) {
      return request(`/api/workspaces/${encodeURIComponent(String(workspaceId))}/tree`);
    },

    async listGoals({ workspaceId, parentGoalId } = {}) {
      const query = new URLSearchParams();
      if (parentGoalId !== undefined && parentGoalId !== null && parentGoalId !== "") {
        query.set("parentGoalId", String(parentGoalId));
      }
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      const payload = await request(`/api/workspaces/${encodeURIComponent(String(workspaceId))}/goals${suffix}`);
      if (!Array.isArray(payload.goals)) {
        throw new DaemonError({ code: "GOALS_RESPONSE_INVALID", message: "Daemon returned a malformed goal list." }, 502);
      }
      return payload.goals.map(projectGoal);
    },

    async createGoal({ workspaceId, title, ownerMemberId, parentGoalId } = {}) {
      const payload = await request(`/api/workspaces/${encodeURIComponent(String(workspaceId))}/goals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: String(title ?? ""),
          ownerMemberId,
          ...(parentGoalId !== undefined ? { parentGoalId } : {}),
        }),
      });
      if (!payload.goal || typeof payload.goal !== "object") {
        throw new DaemonError({ code: "GOAL_RESPONSE_INVALID", message: "Daemon returned a malformed goal." }, 502);
      }
      return projectGoal(payload.goal);
    },

    async getGoal({ workspaceId, goalId } = {}) {
      const payload = await request(`/api/workspaces/${encodeURIComponent(String(workspaceId))}/goals/${encodeURIComponent(String(goalId))}`);
      if (!payload.goal || typeof payload.goal !== "object") {
        throw new DaemonError({ code: "GOAL_RESPONSE_INVALID", message: "Daemon returned a malformed goal." }, 502);
      }
      return projectGoal(payload.goal);
    },

    async queryManagerBoard({ workspaceId, managerId } = {}) {
      const query = new URLSearchParams({ managerId: String(managerId ?? "") });
      const payload = await request(`/api/workspaces/${encodeURIComponent(String(workspaceId))}/board?${query.toString()}`);
      if (!Array.isArray(payload.goals) || !Array.isArray(payload.memberStatuses)) {
        throw new DaemonError({ code: "BOARD_RESPONSE_INVALID", message: "Daemon returned a malformed manager board." }, 502);
      }
      return {
        ...payload,
        rawBoard: payload,
        goals: payload.goals.map((section) => ({
          ...section,
          goal: { ...section.goal, title: String(section.goal?.title ?? section.goal?.name ?? "") },
          tickets: {
            ...section.tickets,
            items: Array.isArray(section.tickets?.items)
              ? section.tickets.items.map(projectTicketObservation)
              : [],
          },
        })),
      };
    },

    async listTickets({ workspaceId, goalId, status, ownerMemberId, limit, cursor } = {}) {
      const query = new URLSearchParams();
      if (goalId) query.set("goalId", String(goalId));
      if (status) query.set("status", daemonTicketStatus(String(status)));
      if (ownerMemberId) query.set("ownerMemberId", String(ownerMemberId));
      if (limit !== undefined && limit !== null) query.set("limit", String(limit));
      if (cursor) query.set("cursor", String(cursor));
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      const payload = await request(`/api/workspaces/${encodeURIComponent(String(workspaceId))}/tickets${suffix}`);
      if (!Array.isArray(payload.items)) {
        throw new DaemonError({ code: "TICKETS_RESPONSE_INVALID", message: "Daemon returned a malformed ticket list." }, 502);
      }
      const records = payload.items.map(projectTicketObservation);
      records.observation = payload;
      records.freshness = payload.freshness ?? "unavailable";
      records.nextCursor = payload.nextCursor;
      return records;
    },

    async getTicket({ workspaceId, ticketId } = {}) {
      const payload = await request(`/api/workspaces/${encodeURIComponent(String(workspaceId))}/tickets/${encodeURIComponent(String(ticketId))}`);
      return projectTicketObservation(payload);
    },

    async createTicket({ workspaceId, operationId, goalId, ownerMemberId, category, title, description, priority } = {}) {
      const payload = await request(`/api/workspaces/${encodeURIComponent(String(workspaceId))}/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId, goalId, ownerMemberId, category, title, description, priority }),
      });
      requireSuccessfulOperation(payload, "Ticket creation");
      if (payload.ticket) return projectTicketObservation(payload.ticket);
      if (payload.binding?.bindingId) {
        return this.getTicket({ workspaceId, ticketId: payload.binding.bindingId });
      }
      throw new DaemonError({ code: "TICKET_RESPONSE_INVALID", message: "Successful ticket creation returned no authoritative ticket." }, 502);
    },

    async appendReport({ workspaceId, ticketId, operationId, actorMemberId, executingMemberId, reportKind, body } = {}) {
      const payload = await request(`/api/workspaces/${encodeURIComponent(String(workspaceId))}/tickets/${encodeURIComponent(String(ticketId))}/reports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId,
          actorMemberId,
          ...(executingMemberId !== undefined ? { executingMemberId } : {}),
          reportKind,
          body,
        }),
      });
      return requireSuccessfulOperation(payload, "Ticket report");
    },

    async transitionTicket({ workspaceId, ticketId, operationId, transition } = {}) {
      const action = transition === "close" || transition === "closed" || transition === "done"
        ? "close"
        : transition === "reopen" || transition === "open"
          ? "reopen"
          : null;
      if (!action) {
        throw new DaemonError({ code: "TICKET_TRANSITION_INVALID", message: "Ticket transition must be close or reopen." }, 400);
      }
      const payload = await request(`/api/workspaces/${encodeURIComponent(String(workspaceId))}/tickets/${encodeURIComponent(String(ticketId))}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId }),
      });
      requireSuccessfulOperation(payload, "Ticket transition");
      return this.getTicket({ workspaceId, ticketId });
    },

    async listPendingWrites({ workspaceId } = {}) {
      const payload = await request(`/api/workspaces/${encodeURIComponent(String(workspaceId))}/ticket-operations`);
      if (!Array.isArray(payload.operations)) {
        throw new DaemonError({ code: "TICKET_OPERATIONS_RESPONSE_INVALID", message: "Daemon returned a malformed operation list." }, 502);
      }
      return payload.operations;
    },

    async getMemberRuntime({ workspaceId, memberId } = {}) {
      return request(`/api/workspaces/${encodeURIComponent(String(workspaceId))}/members/${encodeURIComponent(String(memberId))}/runtime`);
    },

    async resolveTerminalAdmission(session = {}) {
      const workspaceId = session.workspaceId;
      const memberId = session.memberId;
      const requestedTarget = session.binding?.terminalTarget;
      const requestedBackend = typeof session.backend === "string" && session.backend !== ""
        ? session.backend
        : requestedTarget?.backend;
      const requestedStableId = typeof session.stableId === "string" && session.stableId !== ""
        ? session.stableId
        : requestedTarget?.stableId;
      if (
        typeof workspaceId !== "string"
        || workspaceId.trim() === ""
        || typeof memberId !== "string"
        || memberId.trim() === ""
        || typeof requestedBackend !== "string"
        || requestedBackend === ""
        || typeof requestedStableId !== "string"
        || requestedStableId === ""
      ) {
        return null;
      }

      const memberRuntime = await this.getMemberRuntime({ workspaceId, memberId });
      const member = memberRuntime?.member;
      const requestedGroupPath = typeof session.groupPath === "string" && session.groupPath !== ""
        ? session.groupPath
        : "";
      const responseGroupPath = typeof member?.groupPath === "string" && member.groupPath !== ""
        ? member.groupPath
        : "";
      if (
        !member
        || typeof member !== "object"
        || String(member.memberId ?? "") !== memberId
        || String(member.workspaceId ?? "") !== workspaceId
      ) {
        throw new DaemonError({
          code: "WORKSPACE_SCOPE_MISMATCH",
          message: "Daemon returned a member outside the requested workspace scope.",
        }, 502);
      }

      const binding = memberRuntime.binding;
      const target = binding?.terminalTarget;
      const runtimeMachineId = memberRuntime.runtime?.machineId;
      const bindingMachineId = binding?.machineId;
      if (
        !binding
        || !target
        || typeof target.backend !== "string"
        || target.backend === ""
        || typeof target.stableId !== "string"
        || target.stableId === ""
        || binding.generation == null
        || responseGroupPath === ""
        || typeof runtimeMachineId !== "string"
        || runtimeMachineId === ""
        || typeof bindingMachineId !== "string"
        || bindingMachineId === ""
        || runtimeMachineId !== bindingMachineId
        || (requestedGroupPath !== "" && responseGroupPath !== requestedGroupPath)
        || target.backend !== requestedBackend
        || target.stableId !== requestedStableId
      ) {
        return null;
      }

      return {
        workspaceId,
        memberId,
        machineId: runtimeMachineId,
        groupPath: responseGroupPath,
        expectedGeneration: binding.generation,
        backend: target.backend,
        stableId: target.stableId,
      };
    },

    openTerminalStream(admission, { onReady, onBuffer, onError } = {}) {
      const query = admissionQuery(admission);
      const controller = new AbortController();
      let explicitlyClosed = false;
      const source = {
        closed: false,
        close() {
          explicitlyClosed = true;
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
              if (!explicitlyClosed) {
                emitError({
                  code: "TERMINAL_STREAM_EOF",
                  message: "Terminal stream ended unexpectedly.",
                });
              }
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
