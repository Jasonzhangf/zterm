import { esc } from "./setup.mjs";

function workspacesBlock(loadable) {
  if (!loadable) {
    return "";
  }
  if (loadable.status === "loading") {
    return `<p class="status-line" data-role="workspaces-status" data-status="loading">Loading server-authorized workspaces...</p>`;
  }
  if (loadable.status === "ready") {
    const workspaces = Array.isArray(loadable.value) ? loadable.value : [];
    if (workspaces.length === 0) {
      return `<p class="status-line" data-role="workspaces-status" data-status="empty">The account has no authorized workspaces.</p>`;
    }
    return `
      <ul class="workspace-list" data-role="workspace-list">
        ${workspaces.map((workspace) => `
          <li>
            <button type="button" data-action="select-workspace" data-workspace-id="${esc(workspace.workspaceId)}" data-testid="workspace-button">
              <span class="workspace-name">${esc(workspace.name || workspace.workspaceId)}</span>
              <span class="workspace-id">${esc(workspace.workspaceId)}</span>
            </button>
          </li>
        `).join("")}
      </ul>
    `;
  }
  const error = loadable.error || { kind: "error", code: "WORKSPACES_UNAVAILABLE", message: "Workspace directory is unavailable." };
  const kind = error.kind === "unauthorized" ? "unauthorized" : error.kind === "unavailable" ? "unavailable" : "error";
  return `
    <p class="alert" role="alert" data-role="workspaces-error" data-kind="${esc(kind)}">
      ${esc(error.code)}: ${esc(error.message)}
    </p>
  `;
}

function machinesBlock(state) {
  const machines = Array.isArray(state.machineCandidates) ? state.machineCandidates : [];
  const enrollment = state.machineEnrollment || { enabled: false, reason: { code: "MACHINE_ENROLLMENT_UNAVAILABLE", message: "" } };
  return `
    <section class="panel" aria-labelledby="machines-title">
      <div class="panel-head">
        <h2 id="machines-title">Machines</h2>
        <button type="button" data-action="enroll-machine" data-disabled-reason="${esc(enrollment.reason.code)}" ${enrollment.enabled ? "" : "disabled"} data-testid="enroll-machine-button">Enroll machine</button>
      </div>
      ${enrollment.enabled ? "" : `<p class="status-line" data-role="machine-enrollment-reason" data-code="${esc(enrollment.reason.code)}">${esc(enrollment.reason.code)}: ${esc(enrollment.reason.message)}</p>`}
      <ul class="machine-list" data-role="machine-list">
        ${machines.map((machine) => `
          <li data-machine-id="${esc(machine.memberId)}">
            <span class="machine-name">${esc(machine.name || machine.memberId)}</span>
            <span class="machine-id">${esc(machine.memberId)}</span>
          </li>
        `).join("")}
      </ul>
    </section>
  `;
}

export function renderWorkspacesPage(state = {}) {
  const loadable = state.workspacesLoadable || { status: "idle" };
  const session = state.session || { authenticated: false, configured: false };
  return `
    <section class="bootstrap-page" data-page="workspaces" aria-labelledby="workspaces-title">
      <header class="page-head">
        <div>
          <h1 id="workspaces-title">Workspaces</h1>
          <p class="page-sub">Only server-authorized workspaces are listed. Workspace, group, and member configuration stays read-only until daemon endpoints are integrated.</p>
        </div>
        <span class="badge ${session.authenticated ? "badge-ok" : "badge-muted"}" data-role="session-badge">
          ${session.authenticated ? "Authenticated" : "Not authenticated"}
        </span>
        <button type="button" data-action="load-workspaces" data-testid="load-workspaces-button">Load workspaces</button>
      </header>

      <section class="panel" aria-labelledby="directory-title">
        <div class="panel-head">
          <h2 id="directory-title">Authorized directory</h2>
        </div>
        ${workspacesBlock(loadable)}
      </section>

      ${machinesBlock(state)}

      <nav class="page-nav" aria-label="Bootstrap pages">
        <button type="button" data-action="navigate" data-route="setup">Setup</button>
        <button type="button" data-action="navigate" data-route="login">Login</button>
      </nav>
    </section>
  `;
}
