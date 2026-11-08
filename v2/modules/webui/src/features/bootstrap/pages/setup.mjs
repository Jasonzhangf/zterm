export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderSetupPage(state = {}) {
  const session = state.session || { authenticated: false, configured: false };
  const endpoint = state.endpoint || "";
  const endpointError = state.endpointError;
  return `
    <section class="bootstrap-page" data-page="setup" aria-labelledby="setup-title">
      <header class="page-head">
        <div>
          <h1 id="setup-title">First-run setup</h1>
          <p class="page-sub">Configure the daemon endpoint, then log in explicitly. No privileged authorization runs silently on this page.</p>
        </div>
        <span class="badge ${session.authenticated ? "badge-ok" : "badge-muted"}" data-role="session-badge">
          ${session.authenticated ? "Authenticated" : session.configured ? "Not authenticated" : "Daemon auth not configured"}
        </span>
      </header>

      <form id="setup-form" class="panel" data-role="setup-form" novalidate>
        <label class="field">
          <span>Daemon endpoint</span>
          <input name="daemonEndpoint" data-field="daemon-endpoint" value="${esc(endpoint)}" autocomplete="url" inputmode="url" placeholder="http://127.0.0.1:3334">
        </label>
        ${endpointError ? `<p class="alert" role="alert" data-role="endpoint-error">${esc(endpointError.code)}: ${esc(endpointError.message)}</p>` : ""}
        <div class="actions">
          <button type="submit" data-action="save-endpoint">Save endpoint</button>
          <button type="button" data-action="navigate" data-route="login">Go to login</button>
        </div>
      </form>

      <nav class="page-nav" aria-label="Bootstrap pages">
        <button type="button" data-action="navigate" data-route="login">Login</button>
        <button type="button" data-action="navigate" data-route="workspaces">Workspaces</button>
      </nav>
    </section>
  `;
}
