const MODULE = "daemon";

// Typed failures owned by the public routing/members/organization ports that the
// daemon may surface unchanged. Unknown-member handling is narrower: a directed
// routing miss becomes MEMBER_NOT_FOUND below.
const PASS_THROUGH_CODES = new Set([
  "UNAUTHENTICATED",
  "ROUTE_FORBIDDEN",
  "ROUTE_AMBIGUOUS",
  "VALIDATION",
  "MEMBER_BINDING_NOT_FOUND",
  "MEMBER_RUNTIME_NOT_CONFIGURED",
  "MEMBER_BINDING_INVALID",
  "BINDING_GENERATION_STALE",
]);

function admissionError(code, operationId, message, cause, owningModule = MODULE) {
  const error = new Error(message);
  error.name = "TypedError";
  error.code = code;
  error.owningModule = owningModule;
  error.operationId = operationId;
  error.cause = cause;
  return error;
}

function fail(code, operationId, message, cause) {
  throw admissionError(code, operationId, message, cause);
}

function requireText(value, field, operationId) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    fail("VALIDATION", operationId, `${field} must be a non-empty string.`, { field });
  }
  return text;
}

function requireGeneration(value, operationId) {
  if (!Number.isInteger(value) || value < 0) {
    fail("VALIDATION", operationId, "expectedGeneration must be a non-negative integer.", {
      expectedGeneration: value ?? null,
    });
  }
  return value;
}

export function requireTarget(target, operationId) {
  const backend = target && typeof target === "object" && !Array.isArray(target) ? target.backend : undefined;
  const stableId = target && typeof target === "object" && !Array.isArray(target) ? target.stableId : undefined;
  const backendText = typeof backend === "string" ? backend.trim() : "";
  const stableIdText = typeof stableId === "string" ? stableId.trim() : "";
  if (!backendText || !stableIdText) {
    fail(
      "TERMINAL_TARGET_IDENTITY_REQUIRED",
      operationId,
      "Terminal target identity requires backend and stableId.",
      { backend: backendText || null, stableId: stableIdText || null },
    );
  }
  return { backend: backendText, stableId: stableIdText };
}

function normalizeBindingTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const backend = typeof value.backend === "string" ? value.backend.trim() : "";
  const stableId = typeof value.stableId === "string" ? value.stableId.trim() : "";
  if (!backend || !stableId) {
    return null;
  }
  return { backend, stableId };
}

export function translateAdmissionError(error, operationId) {
  const code = error && typeof error.code === "string" ? error.code : "";
  const cause = {
    sourceCode: code || null,
    sourceModule: error && typeof error.owningModule === "string" ? error.owningModule : null,
    details: error && error.details ? error.details : null,
    message: error && error.message ? error.message : null,
  };
  if (code === "ROUTE_NOT_FOUND") {
    return admissionError(
      "MEMBER_NOT_FOUND",
      operationId,
      "The target member was not found at the authorized workspace address.",
      cause,
    );
  }
  if (error && error.name === "TypedError" && error.toRecord) {
    const record = error.toRecord();
    return admissionError(
      code,
      record.operationId || operationId,
      error.message || code,
      cause,
      typeof error.owningModule === "string" ? error.owningModule : MODULE,
    );
  }
  if (PASS_THROUGH_CODES.has(code)) {
    return admissionError(
      code,
      operationId,
      error.message || code,
      cause,
      error && typeof error.owningModule === "string" ? error.owningModule : MODULE,
    );
  }
  if (error && error.name === "AccountsError" && code) {
    return admissionError(code, operationId, error.message || code, cause, "accounts");
  }
  return error;
}

/**
 * Production admission gate for the V2 daemon terminal routes.
 *
 * The daemon owns the HTTP admission order. Authorization, member selection,
 * runtime binding, and generation checks stay in the public routing service,
 * which consumes the public organization and members readers. The daemon never
 * copies organization/members truth and never accepts a terminal name as a
 * substitute for the catalog backend + stableId.
 */
export function createTerminalAdmission({
  auth,
  members,
  routing,
  terminal,
  machineTerminal = null,
  resolveBindingTarget = null,
  log = () => {},
} = {}) {
  if (!auth || typeof auth.verify !== "function") {
    throw new TypeError("terminal admission requires an auth port with verify(token)");
  }
  if (!members || typeof members.getRuntimeBinding !== "function") {
    throw new TypeError("terminal admission requires a members port with getRuntimeBinding(memberId)");
  }
  if (!routing || typeof routing.resolve !== "function") {
    throw new TypeError("terminal admission requires a routing service with resolve()");
  }
  if (!terminal || typeof terminal.listSessions !== "function" || typeof terminal.input !== "function") {
    throw new TypeError("terminal admission requires a terminal port with listSessions() and input()");
  }
  if (machineTerminal !== null && typeof machineTerminal.forMachine !== "function") {
    throw new TypeError("terminal admission requires machineTerminal.forMachine(machineId) when provided");
  }
  // The members-owned read-only binding adapter is the default resolver. An
  // explicit resolver may be injected only when it comes from the same public
  // contract shape; a caller that supplies neither still fails closed.
  const bindingResolver = resolveBindingTarget === null
    ? (typeof members.resolveBindingTarget === "function" ? members.resolveBindingTarget : null)
    : resolveBindingTarget;
  if (bindingResolver !== null && typeof bindingResolver !== "function") {
    throw new TypeError("terminal admission requires resolveBindingTarget(binding) to be a function or null");
  }

  async function authenticate(callerToken, operationId) {
    try {
      return await auth.verify(callerToken);
    } catch (error) {
      throw translateAdmissionError(error, operationId);
    }
  }

  // The catalog and the dispatch must come from one machine-scoped terminal
  // consumer owned by the connections authorization link. A global terminal
  // port is never accepted as a substitute once a machine context is needed.
  async function requireMachineTerminal({ machineId, memberId, bindingGeneration, operationId }) {
    if (!machineTerminal) {
      fail(
        "TERMINAL_TARGET_BINDING_UNAVAILABLE",
        operationId,
        "The daemon has no connections-authorized machine terminal consumer.",
        { reason: "machine-terminal-missing", memberId, machineId },
      );
    }
    let scoped;
    try {
      scoped = await machineTerminal.forMachine({ machineId, memberId, bindingGeneration });
    } catch (error) {
      throw translateAdmissionError(error, operationId);
    }
    if (!scoped || typeof scoped !== "object") {
      fail(
        "TERMINAL_TARGET_BINDING_UNAVAILABLE",
        operationId,
        "The machine terminal consumer is unavailable.",
        { reason: "machine-terminal-unavailable", memberId, machineId },
      );
    }
    if (scoped.machineId !== machineId) {
      fail(
        "MEMBER_BINDING_INVALID",
        operationId,
        "The machine terminal consumer belongs to another machine.",
        { memberId, resolvedMachineId: machineId, scopedMachineId: scoped.machineId ?? null },
      );
    }
    if (scoped.status !== "connected" || scoped.freshness !== "fresh") {
      fail(
        "TERMINAL_TARGET_BINDING_UNAVAILABLE",
        operationId,
        "The authorized machine link is not fresh and connected.",
        {
          reason: "link-unavailable",
          memberId,
          machineId,
          status: scoped.status ?? null,
          freshness: scoped.freshness ?? null,
        },
      );
    }
    if (
      scoped.peerIdentityVerified !== true
      || typeof scoped.daemonHostId !== "string"
      || scoped.daemonHostId.trim() === ""
    ) {
      fail(
        "TERMINAL_TARGET_BINDING_UNAVAILABLE",
        operationId,
        "The authorized machine link has no verified daemon host identity.",
        { reason: "daemon-identity-unverified", memberId, machineId },
      );
    }
    if (!Number.isInteger(scoped.linkGeneration) || scoped.linkGeneration < 0) {
      fail(
        "TERMINAL_TARGET_BINDING_UNAVAILABLE",
        operationId,
        "The authorized machine link has no usable generation.",
        { reason: "link-generation-missing", memberId, machineId },
      );
    }
    if (
      typeof scoped.listSessions !== "function"
      || typeof scoped.input !== "function"
      || typeof scoped.subscribe !== "function"
    ) {
      fail(
        "TERMINAL_TARGET_BINDING_UNAVAILABLE",
        operationId,
        "The machine terminal consumer is missing catalog, input, or subscribe.",
        { reason: "machine-terminal-invalid", memberId, machineId },
      );
    }
    return scoped;
  }

  async function admit({
    callerToken,
    workspaceId,
    memberId,
    machineId,
    groupPath,
    expectedGeneration,
    target,
    operationId = "terminal.admission",
  } = {}) {
    // 1. Authenticate the caller before any workspace or binding read.
    await authenticate(callerToken, operationId);

    const resolvedWorkspaceId = requireText(workspaceId, "workspaceId", operationId);
    const resolvedMemberId = requireText(memberId, "memberId", operationId);
    const resolvedMachineId = requireText(machineId, "machineId", operationId);
    const resolvedGroupPath = requireText(groupPath, "groupPath", operationId);
    const generation = requireGeneration(expectedGeneration, operationId);
    const exactTarget = requireTarget(target, operationId);

    // 2-3. Workspace authorization and member resolution use the public routing
    // port. The current runtime binding comes from the public members reader.
    let resolution;
    try {
      resolution = await routing.resolve({
        token: callerToken,
        workspaceId: resolvedWorkspaceId,
        address: {
          machineId: resolvedMachineId,
          groupPath: resolvedGroupPath,
          memberId: resolvedMemberId,
        },
      });
    } catch (error) {
      throw translateAdmissionError(error, operationId);
    }

    let currentBinding;
    try {
      currentBinding = await members.getRuntimeBinding(resolution.memberId);
    } catch (error) {
      throw translateAdmissionError(error, operationId);
    }
    if (!currentBinding) {
      fail("MEMBER_BINDING_NOT_FOUND", operationId, "The member has no current runtime binding.", {
        memberId: resolution.memberId,
      });
    }
    if (currentBinding.machineId !== resolution.machineId) {
      fail("MEMBER_BINDING_INVALID", operationId, "The member binding does not match the resolved runtime.", {
        memberId: resolution.memberId,
        resolvedMachineId: resolution.machineId,
        bindingMachineId: currentBinding.machineId ?? null,
      });
    }

    // 4. Reject a generation that is not the current public members truth.
    if (currentBinding.bindingGeneration !== generation) {
      fail(
        "BINDING_GENERATION_STALE",
        operationId,
        `binding generation ${currentBinding.bindingGeneration} != expected ${generation}`,
        {
          memberId: resolution.memberId,
          expectedGeneration: generation,
          currentGeneration: currentBinding.bindingGeneration,
        },
      );
    }
    resolution = Object.freeze({
      ...resolution,
      bindingGeneration: currentBinding.bindingGeneration,
      sessionId: currentBinding.sessionId,
      anchor: currentBinding.anchor,
    });

    // 5. The public binding owner must resolve this member to one exact native
    // terminal identity. The daemon never infers it from a session name and
    // never opens a target the binding did not authorize.
    if (typeof bindingResolver !== "function") {
      fail(
        "TERMINAL_TARGET_BINDING_UNAVAILABLE",
        operationId,
        "The member runtime binding does not expose a public native terminal target resolver.",
        {
          reason: "resolver-missing",
          memberId: resolution.memberId,
          bindingSessionId: currentBinding.sessionId ?? null,
          bindingAnchor: currentBinding.anchor ?? null,
          requested: exactTarget,
          publicContractGap: "members.getRuntimeBinding exposes sessionId and anchor, but no public port maps that binding to terminal backend/stableId.",
        },
      );
    }

    const scopedTerminal = await requireMachineTerminal({
      machineId: resolution.machineId,
      memberId: resolution.memberId,
      bindingGeneration: resolution.bindingGeneration,
      operationId,
    });
    let sessions;
    try {
      sessions = await scopedTerminal.listSessions();
    } catch (error) {
      throw translateAdmissionError(error, operationId);
    }
    let boundTarget;
    try {
      boundTarget = normalizeBindingTarget(await bindingResolver({
        binding: currentBinding,
        catalog: sessions,
      }));
    } catch (error) {
      fail(
        "TERMINAL_TARGET_BINDING_UNAVAILABLE",
        operationId,
        "The public binding-to-terminal resolver failed.",
        {
          reason: "resolver-failed",
          memberId: resolution.memberId,
          bindingSessionId: currentBinding.sessionId ?? null,
          bindingAnchor: currentBinding.anchor ?? null,
          requested: exactTarget,
          cause: error && error.message ? error.message : null,
        },
      );
    }
    if (!boundTarget) {
      fail(
        "TERMINAL_TARGET_BINDING_UNAVAILABLE",
        operationId,
        "The member runtime binding does not resolve to a native terminal target.",
        {
          reason: "binding-target-unresolved",
          memberId: resolution.memberId,
          bindingSessionId: currentBinding.sessionId ?? null,
          bindingAnchor: currentBinding.anchor ?? null,
          requested: exactTarget,
        },
      );
    }

    // 6. The target must be an exact live catalog entry. A name or synthesized
    // identity is not accepted.
    const session = sessions.find((candidate) => (
      candidate.backend === exactTarget.backend
      && candidate.stableId === exactTarget.stableId
    ));
    if (!session) {
      fail(
        "TERMINAL_TARGET_IDENTITY_MISMATCH",
        operationId,
        "The exact terminal target is not in the current catalog.",
        { backend: exactTarget.backend, stableId: exactTarget.stableId },
      );
    }
    if (
      boundTarget.backend !== exactTarget.backend
      || boundTarget.stableId !== exactTarget.stableId
    ) {
      fail(
        "TERMINAL_TARGET_BINDING_UNAVAILABLE",
        operationId,
        "The requested terminal target is not the member's bound terminal target.",
        {
          reason: "binding-target-mismatch",
          memberId: resolution.memberId,
          bindingSessionId: currentBinding.sessionId ?? null,
          bindingAnchor: currentBinding.anchor ?? null,
          requested: exactTarget,
          boundTarget,
        },
      );
    }

    log({
      event: "terminal.admission.accepted",
      memberId: resolution.memberId,
      machineId: resolution.machineId,
      bindingGeneration: resolution.bindingGeneration,
      backend: exactTarget.backend,
      stableId: exactTarget.stableId,
    });
    return {
      resolution,
      session,
      target: exactTarget,
      terminal: scopedTerminal,
      linkGeneration: scopedTerminal.linkGeneration,
      daemonHostId: scopedTerminal.daemonHostId,
    };
  }

  async function requireCurrent(admitted, operationId) {
    const { resolution, daemonHostId, linkGeneration } = admitted;
    const currentScoped = await requireMachineTerminal({
      machineId: resolution.machineId,
      memberId: resolution.memberId,
      bindingGeneration: resolution.bindingGeneration,
      operationId,
    });
    let currentBinding;
    try {
      currentBinding = await members.getRuntimeBinding(resolution.memberId);
    } catch (error) {
      throw translateAdmissionError(error, operationId);
    }
    if (!currentBinding) {
      fail("MEMBER_BINDING_NOT_FOUND", operationId, "The member binding disappeared before dispatch.", {
        memberId: resolution.memberId,
      });
    }
    if (currentBinding.bindingGeneration !== resolution.bindingGeneration) {
      fail(
        "BINDING_GENERATION_STALE",
        operationId,
        "The member was rebound after admission but before dispatch.",
        {
          memberId: resolution.memberId,
          admittedGeneration: resolution.bindingGeneration,
          currentGeneration: currentBinding.bindingGeneration,
        },
      );
    }
    if (currentScoped.linkGeneration !== linkGeneration) {
      fail(
        "stale_generation",
        operationId,
        "The authorized machine link changed after admission but before dispatch.",
        {
          memberId: resolution.memberId,
          admittedLinkGeneration: linkGeneration,
          currentLinkGeneration: currentScoped.linkGeneration,
        },
      );
    }
    if (currentScoped.daemonHostId !== daemonHostId) {
      fail(
        "peer_identity_mismatch",
        operationId,
        "The authorized machine daemon identity changed after admission.",
        {
          memberId: resolution.memberId,
          admittedDaemonHostId: daemonHostId,
          currentDaemonHostId: currentScoped.daemonHostId,
        },
      );
    }
    return currentScoped;
  }

  async function forwardInput(input = {}) {
    const operationId = input.operationId || "terminal.admission.input";
    const admitted = await admit({ ...input, operationId });
    const { resolution, session, linkGeneration } = admitted;
    const currentScoped = await requireCurrent(admitted, operationId);
    if (typeof input.data !== "string" || input.data.length === 0) {
      fail("INPUT_INVALID", operationId, "Terminal input must be a non-empty string.", null);
    }
    let receipt;
    try {
      receipt = await currentScoped.input(session.stableId, input.data);
    } catch (error) {
      if (error && error.code === "TARGET_NOT_FOUND") {
        fail(
          "TERMINAL_TARGET_IDENTITY_MISMATCH",
          operationId,
          "The exact terminal target disappeared before the channel opened.",
          { backend: session.backend, stableId: session.stableId },
        );
      }
      throw error;
    }
    return {
      resolution,
      session,
      target: { backend: session.backend, stableId: session.stableId },
      receipt,
      terminal: currentScoped,
      linkGeneration,
    };
  }

  return Object.freeze({
    admit,
    forwardInput,
    requireCurrent,
  });
}
